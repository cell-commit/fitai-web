// Apple Health import (design doc §5E, §3 HealthImportSummary).
//
// Pure-TS parser for the "Health Auto Export" iPhone app's JSON and CSV
// exports — NO DOM/File deps in the parse/build/summarize layer so it is fully
// unit-testable. Only importHealthFile() touches the File API + storage.
//
// Apple's own Health export.xml is explicitly OUT OF SCOPE (routinely
// 100MB–1GB+, infeasible to parse in the browser) — the UI says so.
//
// The parser is deliberately LIBERAL: field names vary across HAE versions
// (qty vs Avg; activeEnergyBurned as {qty,units} or a bare number; workout
// duration in seconds or minutes; energy in kJ or kcal). Unknown metrics are
// ignored rather than throwing.

import type { HealthImportSummary } from '../types';
import { MODELS, callClaudeText } from './claude';
import { saveHealthSummary } from './storage';

// ─────────────────────────────────────────────────────────────
// Shapes
// ─────────────────────────────────────────────────────────────

export interface DayWorkout {
  name: string;
  minutes: number;
  kcal?: number;
}

export interface HealthDayRow {
  date: string; // YYYY-MM-DD
  sleepHours?: number;
  steps?: number;
  activeKcal?: number;
  restingHR?: number;
  workouts: DayWorkout[];
}

/** HealthImportSummary without the LLM-generated narrative (added later). */
export type HealthSummaryDraft = Omit<HealthImportSummary, 'summaryText'>;

export type HealthSource =
  | 'health-auto-export-json'
  | 'health-auto-export-csv';

// ─────────────────────────────────────────────────────────────
// Small numeric / date helpers
// ─────────────────────────────────────────────────────────────

const KJ_PER_KCAL = 4.184;

/** Extract a YYYY-MM-DD day key from an assortment of HAE date strings. */
export function extractDate(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  // Handles "2026-07-01", "2026-07-01 07:30:00 +0000", ISO, etc.
  const m = raw.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  // US-style "7/1/2026" fallback.
  const us = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (us) {
    const mm = us[1].padStart(2, '0');
    const dd = us[2].padStart(2, '0');
    return `${us[3]}-${mm}-${dd}`;
  }
  return null;
}

function num(v: unknown): number | undefined {
  if (typeof v === 'number' && isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = parseFloat(v.replace(/,/g, ''));
    if (isFinite(n)) return n;
  }
  return undefined;
}

/** Normalize an energy value to kcal given its units string (kJ → kcal). */
function toKcal(value: number, units: string | undefined): number {
  if (units && /kj/i.test(units)) return value / KJ_PER_KCAL;
  return value; // already kcal (or unitless — assume kcal)
}

/** Normalize a sleep value to hours given its units string (min → hr). */
function toHours(value: number, units: string | undefined): number {
  if (units && /\bmin/i.test(units)) return value / 60;
  return value; // already hours
}

// ─────────────────────────────────────────────────────────────
// Per-day accumulator
// ─────────────────────────────────────────────────────────────

interface Acc {
  sleepHours: number;
  hasSleep: boolean;
  steps: number;
  hasSteps: boolean;
  activeKcal: number;
  hasKcal: boolean;
  rhrSum: number;
  rhrCount: number;
  workouts: DayWorkout[];
}

function emptyAcc(): Acc {
  return {
    sleepHours: 0,
    hasSleep: false,
    steps: 0,
    hasSteps: false,
    activeKcal: 0,
    hasKcal: false,
    rhrSum: 0,
    rhrCount: 0,
    workouts: [],
  };
}

function accFor(map: Map<string, Acc>, date: string): Acc {
  let a = map.get(date);
  if (!a) {
    a = emptyAcc();
    map.set(date, a);
  }
  return a;
}

function finalizeRows(map: Map<string, Acc>): HealthDayRow[] {
  const rows: HealthDayRow[] = [];
  for (const [date, a] of map) {
    const row: HealthDayRow = { date, workouts: a.workouts };
    if (a.hasSleep) row.sleepHours = round(a.sleepHours, 2);
    if (a.hasSteps) row.steps = Math.round(a.steps);
    if (a.hasKcal) row.activeKcal = Math.round(a.activeKcal);
    if (a.rhrCount > 0) row.restingHR = Math.round(a.rhrSum / a.rhrCount);
    rows.push(row);
  }
  rows.sort((x, y) => x.date.localeCompare(y.date));
  return rows;
}

function round(n: number, dp: number): number {
  const f = Math.pow(10, dp);
  return Math.round(n * f) / f;
}

// ─────────────────────────────────────────────────────────────
// Metric classification (liberal name matching)
// ─────────────────────────────────────────────────────────────

type MetricKind = 'sleep' | 'steps' | 'energy' | 'rhr' | null;

function classifyMetric(name: string): MetricKind {
  const n = name.toLowerCase();
  if (n.includes('sleep')) return 'sleep';
  if (n.includes('step')) return 'steps';
  if (n.includes('active') && n.includes('energy')) return 'energy';
  if (n.includes('resting') && n.includes('heart')) return 'rhr';
  return null;
}

/** Pull the first numeric value from a metric data point, by kind. */
function pointValue(pt: Record<string, unknown>, kind: MetricKind): number | undefined {
  const keysByKind: Record<string, string[]> = {
    sleep: ['asleep', 'totalSleep', 'qty', 'value', 'Avg'],
    steps: ['qty', 'value', 'Avg', 'sum'],
    energy: ['qty', 'value', 'Avg', 'sum'],
    rhr: ['Avg', 'avg', 'qty', 'value'],
  };
  const keys = kind ? keysByKind[kind] : ['qty', 'value', 'Avg'];
  for (const k of keys) {
    const v = num(pt[k]);
    if (v !== undefined) return v;
  }
  return undefined;
}

// ─────────────────────────────────────────────────────────────
// Workout normalization
// ─────────────────────────────────────────────────────────────

/**
 * Minutes from a HAE workout duration. HAE JSON usually exports seconds, but
 * be liberal: a number ≥ 600 is treated as seconds, otherwise minutes; an
 * object {qty, units} is unit-aware; an ISO-8601 "PT1H30M" string is parsed.
 */
export function workoutMinutes(raw: unknown): number {
  if (raw == null) return 0;
  if (typeof raw === 'object') {
    const o = raw as Record<string, unknown>;
    const q = num(o.qty ?? o.value);
    if (q === undefined) return 0;
    const units = typeof o.units === 'string' ? o.units : '';
    if (/\bs(ec)?\b/i.test(units)) return Math.round(q / 60);
    if (/\bh(our|r)?\b/i.test(units)) return Math.round(q * 60);
    return Math.round(q); // assume minutes
  }
  if (typeof raw === 'string') {
    const iso = raw.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/i);
    if (iso && (iso[1] || iso[2] || iso[3])) {
      const h = parseInt(iso[1] ?? '0', 10);
      const m = parseInt(iso[2] ?? '0', 10);
      const s = parseInt(iso[3] ?? '0', 10);
      return Math.round(h * 60 + m + s / 60);
    }
    const n = num(raw);
    if (n !== undefined) return n >= 600 ? Math.round(n / 60) : Math.round(n);
    return 0;
  }
  if (typeof raw === 'number') {
    return raw >= 600 ? Math.round(raw / 60) : Math.round(raw);
  }
  return 0;
}

/** kcal from a HAE energy field: bare number (kcal) or {qty, units}. */
export function workoutKcal(raw: unknown): number | undefined {
  if (raw == null) return undefined;
  if (typeof raw === 'number') return isFinite(raw) ? Math.round(raw) : undefined;
  if (typeof raw === 'object') {
    const o = raw as Record<string, unknown>;
    const q = num(o.qty ?? o.value);
    if (q === undefined) return undefined;
    const units = typeof o.units === 'string' ? o.units : undefined;
    return Math.round(toKcal(q, units));
  }
  const n = num(raw);
  return n === undefined ? undefined : Math.round(n);
}

function workoutName(w: Record<string, unknown>): string {
  const cand = w.name ?? w.type ?? w.workoutType ?? w.activityType ?? w.activityName;
  if (typeof cand === 'string' && cand.trim()) return cand.trim();
  return 'Workout';
}

function workoutDate(w: Record<string, unknown>): string | null {
  return (
    extractDate(w.start) ??
    extractDate(w.startDate) ??
    extractDate(w.date) ??
    extractDate(w.end) ??
    null
  );
}

// ─────────────────────────────────────────────────────────────
// JSON parser
// ─────────────────────────────────────────────────────────────

export function parseHealthAutoExportJson(text: string): HealthDayRow[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('Could not parse the file as JSON.');
  }

  const root = parsed as Record<string, unknown>;
  // HAE nests under `data`; tolerate a top-level shape too.
  const data = (root.data ?? root) as Record<string, unknown>;
  const metrics = Array.isArray(data.metrics) ? data.metrics : [];
  const workouts = Array.isArray(data.workouts) ? data.workouts : [];

  const map = new Map<string, Acc>();

  for (const raw of metrics) {
    if (!raw || typeof raw !== 'object') continue;
    const metric = raw as Record<string, unknown>;
    const name = typeof metric.name === 'string' ? metric.name : '';
    const kind = classifyMetric(name);
    if (!kind) continue; // unknown metric — ignored

    const units = typeof metric.units === 'string' ? metric.units : undefined;
    const points = Array.isArray(metric.data) ? metric.data : [];

    for (const p of points) {
      if (!p || typeof p !== 'object') continue;
      const pt = p as Record<string, unknown>;
      const date = extractDate(pt.date ?? pt.Date ?? pt.startDate);
      if (!date) continue;
      const value = pointValue(pt, kind);
      if (value === undefined) continue;

      const acc = accFor(map, date);
      if (kind === 'sleep') {
        acc.sleepHours += toHours(value, units); // sum segments per date
        acc.hasSleep = true;
      } else if (kind === 'steps') {
        acc.steps += value;
        acc.hasSteps = true;
      } else if (kind === 'energy') {
        acc.activeKcal += toKcal(value, units);
        acc.hasKcal = true;
      } else if (kind === 'rhr') {
        acc.rhrSum += value;
        acc.rhrCount += 1;
      }
    }
  }

  for (const raw of workouts) {
    if (!raw || typeof raw !== 'object') continue;
    const w = raw as Record<string, unknown>;
    const date = workoutDate(w);
    if (!date) continue;
    const acc = accFor(map, date);
    const kcal = workoutKcal(w.activeEnergyBurned ?? w.activeEnergy ?? w.totalEnergy);
    acc.workouts.push({
      name: workoutName(w),
      minutes: workoutMinutes(w.duration ?? w.durationMinutes),
      ...(kcal !== undefined ? { kcal } : {}),
    });
  }

  return finalizeRows(map);
}

// ─────────────────────────────────────────────────────────────
// CSV parser
// ─────────────────────────────────────────────────────────────

/** Split one CSV line into fields, honoring double-quoted values. */
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

interface CsvCol {
  kind: MetricKind | 'date';
  isKj: boolean;
  isMin: boolean;
}

function classifyHeader(header: string): CsvCol {
  const h = header.toLowerCase();
  const isKj = /\bkj\b/i.test(header);
  const isMin = /\(\s*min|\bmin\b/i.test(header);
  if (h.includes('date') || h.trim() === 'date') return { kind: 'date', isKj, isMin };
  const kind = classifyMetric(header);
  return { kind: kind ?? null, isKj, isMin };
}

export function parseHealthAutoExportCsv(text: string): HealthDayRow[] {
  const lines = text
    .split(/\r\n|\r|\n/)
    .filter((l) => l.trim().length > 0);
  if (lines.length < 2) return [];

  const headers = splitCsvLine(lines[0]).map((h) => h.trim());
  const cols = headers.map(classifyHeader);
  const dateIdx = cols.findIndex((c) => c.kind === 'date');
  if (dateIdx < 0) return [];

  const map = new Map<string, Acc>();

  for (let r = 1; r < lines.length; r++) {
    const fields = splitCsvLine(lines[r]);
    const date = extractDate(fields[dateIdx]);
    if (!date) continue;
    const acc = accFor(map, date);

    for (let c = 0; c < cols.length; c++) {
      const col = cols[c];
      if (col.kind === 'date' || col.kind === null) continue;
      const value = num(fields[c]);
      if (value === undefined) continue;
      const units = col.isKj ? 'kJ' : col.isMin ? 'min' : undefined;
      if (col.kind === 'sleep') {
        acc.sleepHours += toHours(value, units);
        acc.hasSleep = true;
      } else if (col.kind === 'steps') {
        acc.steps += value;
        acc.hasSteps = true;
      } else if (col.kind === 'energy') {
        acc.activeKcal += toKcal(value, units);
        acc.hasKcal = true;
      } else if (col.kind === 'rhr') {
        acc.rhrSum += value;
        acc.rhrCount += 1;
      }
    }
  }

  return finalizeRows(map);
}

// ─────────────────────────────────────────────────────────────
// Summary rollup
// ─────────────────────────────────────────────────────────────

function makeId(): string {
  try {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  } catch {
    /* ignore */
  }
  return `health_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export function buildHealthImportSummary(
  rows: HealthDayRow[],
  source: HealthSource
): HealthSummaryDraft {
  const sorted = [...rows].sort((a, b) => a.date.localeCompare(b.date));
  const from = sorted.length ? sorted[0].date : '';
  const to = sorted.length ? sorted[sorted.length - 1].date : '';
  return {
    id: makeId(),
    importedAt: Date.now(),
    source,
    dateRange: { from, to },
    days: sorted.map((r) => ({
      date: r.date,
      ...(r.sleepHours !== undefined ? { sleepHours: r.sleepHours } : {}),
      ...(r.steps !== undefined ? { steps: r.steps } : {}),
      ...(r.activeKcal !== undefined ? { activeKcal: r.activeKcal } : {}),
      ...(r.restingHR !== undefined ? { restingHR: r.restingHR } : {}),
      workouts: r.workouts,
    })),
  };
}

// ─────────────────────────────────────────────────────────────
// Aggregate stats (used by both the template + the pane's result card)
// ─────────────────────────────────────────────────────────────

export interface HealthStats {
  days: number;
  avgSleep: number | null;
  avgSteps: number | null;
  avgActiveKcal: number | null;
  avgRestingHR: number | null;
  workoutCount: number;
}

export function computeStats(summary: HealthSummaryDraft): HealthStats {
  const d = summary.days;
  const avg = (pick: (x: HealthImportSummary['days'][number]) => number | undefined) => {
    const vals = d.map(pick).filter((v): v is number => typeof v === 'number');
    if (vals.length === 0) return null;
    return vals.reduce((s, v) => s + v, 0) / vals.length;
  };
  return {
    days: d.length,
    avgSleep: avg((x) => x.sleepHours),
    avgSteps: avg((x) => x.steps),
    avgActiveKcal: avg((x) => x.activeKcal),
    avgRestingHR: avg((x) => x.restingHR),
    workoutCount: d.reduce((s, x) => s + x.workouts.length, 0),
  };
}

// ─────────────────────────────────────────────────────────────
// Coach summary (Haiku) with deterministic template fallback
// ─────────────────────────────────────────────────────────────

function fmt1(n: number | null): string {
  return n === null ? '—' : (Math.round(n * 10) / 10).toString();
}

/**
 * Deterministic summary used when no API key is set or the call fails, so a
 * health import always yields a usable summaryText for coach context.
 */
export function buildTemplateSummary(summary: HealthSummaryDraft): string {
  const s = computeStats(summary);
  const { from, to } = summary.dateRange;
  const range = from && to ? (from === to ? from : `${from} to ${to}`) : 'the imported period';
  const parts: string[] = [];
  parts.push(`Apple Health import covering ${s.days} day${s.days === 1 ? '' : 's'} (${range}).`);
  if (s.avgSleep !== null) parts.push(`Average sleep ${fmt1(s.avgSleep)} h/night.`);
  if (s.avgSteps !== null) parts.push(`Average ${Math.round(s.avgSteps).toLocaleString()} steps/day.`);
  if (s.avgActiveKcal !== null) parts.push(`Average ${Math.round(s.avgActiveKcal)} kcal active energy/day.`);
  if (s.avgRestingHR !== null) parts.push(`Resting HR ~${Math.round(s.avgRestingHR)} bpm.`);
  parts.push(
    s.workoutCount > 0
      ? `${s.workoutCount} workout${s.workoutCount === 1 ? '' : 's'} logged.`
      : 'No workouts logged in this file.'
  );
  if (s.avgSleep !== null && s.avgSleep < 6.5) {
    parts.push('Sleep is on the low side — watch recovery load.');
  }
  return parts.join(' ');
}

/** Compact per-metric digest fed to Haiku (keeps the prompt cheap). */
function digestForPrompt(summary: HealthSummaryDraft): string {
  const s = computeStats(summary);
  const lines = [
    `Date range: ${summary.dateRange.from} to ${summary.dateRange.to} (${s.days} days).`,
    `Avg sleep: ${fmt1(s.avgSleep)} h/night.`,
    `Avg steps: ${s.avgSteps === null ? '—' : Math.round(s.avgSteps)}/day.`,
    `Avg active energy: ${s.avgActiveKcal === null ? '—' : Math.round(s.avgActiveKcal)} kcal/day.`,
    `Avg resting HR: ${s.avgRestingHR === null ? '—' : Math.round(s.avgRestingHR)} bpm.`,
    `Workouts logged: ${s.workoutCount}.`,
  ];
  // A few recent day rows for trend context (cap to keep tokens small).
  const recent = summary.days.slice(-7);
  if (recent.length) {
    lines.push('Recent days:');
    for (const r of recent) {
      const bits: string[] = [];
      if (r.sleepHours !== undefined) bits.push(`sleep ${fmt1(r.sleepHours)}h`);
      if (r.steps !== undefined) bits.push(`${r.steps} steps`);
      if (r.activeKcal !== undefined) bits.push(`${r.activeKcal}kcal`);
      if (r.restingHR !== undefined) bits.push(`RHR ${r.restingHR}`);
      if (r.workouts.length) bits.push(`${r.workouts.length} workout(s)`);
      lines.push(`- ${r.date}: ${bits.join(', ') || 'no data'}`);
    }
  }
  return lines.join('\n');
}

/**
 * One cheap Claude call producing a ≤120-word coach-facing narrative (sleep
 * trend, activity load, training-relevant flags). Falls back to a deterministic
 * template on ANY failure (no key, network, refusal) so import never blocks.
 */
export async function summarizeForCoach(summary: HealthSummaryDraft): Promise<string> {
  const template = buildTemplateSummary(summary);
  try {
    const text = await callClaudeText({
      model: MODELS.cheap,
      system:
        "You summarize a user's imported Apple Health data for their strength coach. Write a single tight paragraph, at most 120 words, covering: sleep trend, overall activity load, and any training-relevant flags (poor sleep, low activity, elevated resting HR, heavy workout volume). Be concrete and use the numbers. No headings, no lists, no preamble — just the paragraph.",
      messages: [
        {
          role: 'user',
          content: `Summarize this health data for the coach:\n\n${digestForPrompt(summary)}`,
        },
      ],
      maxTokens: 512,
    });
    const trimmed = text.trim();
    return trimmed || template;
  } catch {
    return template;
  }
}

// ─────────────────────────────────────────────────────────────
// End-to-end file import (the only side-effectful entry point)
// ─────────────────────────────────────────────────────────────

function detectSource(fileName: string, text: string): HealthSource {
  const name = fileName.toLowerCase();
  if (name.endsWith('.json')) return 'health-auto-export-json';
  if (name.endsWith('.csv')) return 'health-auto-export-csv';
  // Sniff: JSON starts with { or [ once trimmed.
  const t = text.trimStart();
  return t.startsWith('{') || t.startsWith('[')
    ? 'health-auto-export-json'
    : 'health-auto-export-csv';
}

/**
 * Read a picked File, parse it (JSON or CSV, detected by extension + sniff),
 * roll it up, generate a coach summary, and persist via storage.saveHealthSummary
 * (which caps the stored list at 6). Returns the full saved summary.
 *
 * `deps` is injectable so tests can supply a fake persist without a real store.
 */
export async function importHealthFile(
  file: File,
  deps?: {
    save?: (summary: HealthImportSummary) => Promise<void>;
  }
): Promise<HealthImportSummary> {
  const text = await file.text();
  const source = detectSource(file.name, text);

  const rows =
    source === 'health-auto-export-json'
      ? parseHealthAutoExportJson(text)
      : parseHealthAutoExportCsv(text);

  if (rows.length === 0) {
    throw new Error(
      'No recognizable health data found in that file. Export sleep, steps, active energy, resting heart rate, or workouts from Health Auto Export as JSON or CSV.'
    );
  }

  const draft = buildHealthImportSummary(rows, source);
  const summaryText = await summarizeForCoach(draft);
  const full: HealthImportSummary = { ...draft, summaryText };

  const save = deps?.save ?? saveHealthSummary;
  await save(full);
  return full;
}
