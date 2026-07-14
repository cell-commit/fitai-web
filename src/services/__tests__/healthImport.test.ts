import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import {
  parseHealthAutoExportJson,
  parseHealthAutoExportCsv,
  buildHealthImportSummary,
  computeStats,
  buildTemplateSummary,
  summarizeForCoach,
  importHealthFile,
  workoutMinutes,
  extractDate,
} from '../healthImport';
import { MODELS, type ClaudeResponse } from '../claude';
import { saveSettings, getHealthSummaries } from '../storage';

// ─────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────

// qty variant + kJ energy + multi-segment sleep + a workout (duration in s)
const JSON_QTY = JSON.stringify({
  data: {
    metrics: [
      {
        name: 'sleep_analysis',
        units: 'hr',
        data: [
          { date: '2026-07-01 06:00:00 +0000', asleep: 4.0 },
          { date: '2026-07-01 14:00:00 +0000', asleep: 1.5 }, // nap — same day, summed
          { date: '2026-07-02 06:30:00 +0000', asleep: 7.2 },
        ],
      },
      {
        name: 'step_count',
        units: 'count',
        data: [
          { date: '2026-07-01', qty: 8000 },
          { date: '2026-07-02', qty: 10500 },
        ],
      },
      {
        name: 'active_energy',
        units: 'kJ',
        data: [
          { date: '2026-07-01', qty: 8368 }, // → 2000 kcal
          { date: '2026-07-02', qty: 4184 }, // → 1000 kcal
        ],
      },
      // Unknown metric — must be ignored.
      { name: 'blood_glucose', units: 'mg/dL', data: [{ date: '2026-07-01', qty: 99 }] },
    ],
    workouts: [
      {
        name: 'Traditional Strength Training',
        start: '2026-07-01 17:00:00 +0000',
        duration: 3600, // seconds → 60 min
        activeEnergyBurned: { qty: 450, units: 'kcal' },
      },
    ],
  },
});

// Avg variant (resting HR), bare-number workout energy, duration in minutes
const JSON_AVG = JSON.stringify({
  data: {
    metrics: [
      {
        name: 'resting_heart_rate',
        units: 'bpm',
        data: [
          { date: '2026-07-01', Avg: 52 },
          { date: '2026-07-01', Avg: 56 }, // → averaged to 54
        ],
      },
      { name: 'active_energy', units: 'kcal', data: [{ date: '2026-07-01', qty: 500 }] },
    ],
    workouts: [
      { type: 'Running', start: '2026-07-01', duration: 45, activeEnergyBurned: 300 },
    ],
  },
});

const CSV_FIXTURE = [
  'Date,Sleep Analysis [asleep] (hr),Step Count (count),Active Energy (kJ),Resting Heart Rate (bpm)',
  '2026-07-01,7.5,8000,8368,52',
  '2026-07-02,6.0,10000,4184,55',
].join('\n');

// ─────────────────────────────────────────────────────────────
// helpers
// ─────────────────────────────────────────────────────────────

function claudeText(text: string): ClaudeResponse {
  return {
    id: 'msg_1',
    model: MODELS.cheap,
    content: [{ type: 'text', text }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 1, output_tokens: 1 },
  };
}
function okResponse(obj: ClaudeResponse) {
  return { ok: true, status: 200, text: async () => JSON.stringify(obj), json: async () => obj };
}

// ─────────────────────────────────────────────────────────────
// JSON parser
// ─────────────────────────────────────────────────────────────

describe('parseHealthAutoExportJson', () => {
  it('aggregates sleep segments per date, normalizes kJ→kcal, tolerates unknown metrics', () => {
    const rows = parseHealthAutoExportJson(JSON_QTY);
    expect(rows.map((r) => r.date)).toEqual(['2026-07-01', '2026-07-02']);

    const d1 = rows[0];
    expect(d1.sleepHours).toBe(5.5); // 4.0 + 1.5 summed
    expect(d1.steps).toBe(8000);
    expect(d1.activeKcal).toBe(2000); // 8368 kJ / 4.184
    expect(d1.workouts).toHaveLength(1);
    expect(d1.workouts[0]).toEqual({
      name: 'Traditional Strength Training',
      minutes: 60,
      kcal: 450,
    });

    const d2 = rows[1];
    expect(d2.sleepHours).toBe(7.2);
    expect(d2.activeKcal).toBe(1000);
    expect(d2.workouts).toEqual([]);
  });

  it('averages resting HR per date and reads bare-number / minute variants', () => {
    const rows = parseHealthAutoExportJson(JSON_AVG);
    expect(rows).toHaveLength(1);
    const d = rows[0];
    expect(d.restingHR).toBe(54); // (52 + 56) / 2
    expect(d.activeKcal).toBe(500);
    expect(d.workouts[0]).toEqual({ name: 'Running', minutes: 45, kcal: 300 });
  });

  it('tolerates missing metrics / empty data without throwing', () => {
    expect(parseHealthAutoExportJson('{"data":{"metrics":[],"workouts":[]}}')).toEqual([]);
    expect(parseHealthAutoExportJson('{}')).toEqual([]);
  });

  it('throws a friendly error on invalid JSON', () => {
    expect(() => parseHealthAutoExportJson('not json')).toThrow(/parse/i);
  });
});

// ─────────────────────────────────────────────────────────────
// CSV parser
// ─────────────────────────────────────────────────────────────

describe('parseHealthAutoExportCsv', () => {
  it('maps metric columns and normalizes kJ→kcal', () => {
    const rows = parseHealthAutoExportCsv(CSV_FIXTURE);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      date: '2026-07-01',
      sleepHours: 7.5,
      steps: 8000,
      activeKcal: 2000,
      restingHR: 52,
      workouts: [],
    });
    expect(rows[1].activeKcal).toBe(1000);
    expect(rows[1].restingHR).toBe(55);
  });

  it('returns [] when there is no Date column or no rows', () => {
    expect(parseHealthAutoExportCsv('Foo,Bar\n1,2')).toEqual([]);
    expect(parseHealthAutoExportCsv('Date,Steps')).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────
// workoutMinutes heuristic
// ─────────────────────────────────────────────────────────────

describe('workoutMinutes', () => {
  it('treats large numbers as seconds and small numbers as minutes', () => {
    expect(workoutMinutes(3600)).toBe(60);
    expect(workoutMinutes(45)).toBe(45);
  });
  it('honors {qty, units} and ISO-8601 durations', () => {
    expect(workoutMinutes({ qty: 1800, units: 's' })).toBe(30);
    expect(workoutMinutes({ qty: 1.5, units: 'hr' })).toBe(90);
    expect(workoutMinutes('PT1H30M')).toBe(90);
  });
});

describe('extractDate', () => {
  it('pulls YYYY-MM-DD from assorted formats', () => {
    expect(extractDate('2026-07-01 06:00:00 +0000')).toBe('2026-07-01');
    expect(extractDate('2026-07-01')).toBe('2026-07-01');
    expect(extractDate('7/1/2026')).toBe('2026-07-01');
    expect(extractDate(123)).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────
// Rollup
// ─────────────────────────────────────────────────────────────

describe('buildHealthImportSummary', () => {
  it('rolls rows into a summary with date range and source, sorted by date', () => {
    const rows = parseHealthAutoExportJson(JSON_QTY);
    const draft = buildHealthImportSummary(rows, 'health-auto-export-json');
    expect(draft.source).toBe('health-auto-export-json');
    expect(draft.dateRange).toEqual({ from: '2026-07-01', to: '2026-07-02' });
    expect(draft.days).toHaveLength(2);
    expect(draft.id).toBeTruthy();
    expect(typeof draft.importedAt).toBe('number');
    // summaryText intentionally absent on the draft.
    expect('summaryText' in draft).toBe(false);
  });

  it('computeStats averages present metrics and counts workouts', () => {
    const draft = buildHealthImportSummary(
      parseHealthAutoExportJson(JSON_QTY),
      'health-auto-export-json'
    );
    const stats = computeStats(draft);
    expect(stats.days).toBe(2);
    expect(stats.avgSleep).toBeCloseTo(6.35, 2); // (5.5 + 7.2) / 2
    expect(stats.avgActiveKcal).toBe(1500);
    expect(stats.workoutCount).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────
// Summaries
// ─────────────────────────────────────────────────────────────

describe('summarizeForCoach', () => {
  let mockFetch: Mock;
  beforeEach(async () => {
    localStorage.clear();
    await saveSettings({
      calorieTarget: 2000,
      proteinTarget: 150,
      name: '',
      anthropicApiKey: 'test-key',
    });
    mockFetch = vi.fn();
    globalThis.fetch = mockFetch as unknown as typeof fetch;
  });

  it('uses the Claude narrative when the call succeeds', async () => {
    mockFetch.mockResolvedValueOnce(okResponse(claudeText('Sleep dipped mid-week; solid activity.')));
    const draft = buildHealthImportSummary(
      parseHealthAutoExportJson(JSON_QTY),
      'health-auto-export-json'
    );
    const text = await summarizeForCoach(draft);
    expect(text).toBe('Sleep dipped mid-week; solid activity.');
    expect(mockFetch).toHaveBeenCalledOnce();
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.model).toBe(MODELS.cheap);
    expect(body.max_tokens).toBe(512);
  });

  it('falls back to the deterministic template when the call fails', async () => {
    mockFetch.mockRejectedValueOnce(new Error('network down'));
    const draft = buildHealthImportSummary(
      parseHealthAutoExportJson(JSON_QTY),
      'health-auto-export-json'
    );
    const text = await summarizeForCoach(draft);
    expect(text).toBe(buildTemplateSummary(draft));
    expect(text).toMatch(/Apple Health import covering 2 days/);
  });

  it('template includes sleep, steps, energy and workout facts', () => {
    const draft = buildHealthImportSummary(
      parseHealthAutoExportJson(JSON_QTY),
      'health-auto-export-json'
    );
    const t = buildTemplateSummary(draft);
    expect(t).toMatch(/Average sleep 6\.4 h/); // (5.5+7.2)/2 = 6.35 → 6.4 (1dp)
    expect(t).toMatch(/1 workout logged/);
  });
});

// ─────────────────────────────────────────────────────────────
// End-to-end file import
// ─────────────────────────────────────────────────────────────

describe('importHealthFile', () => {
  let mockFetch: Mock;
  beforeEach(async () => {
    localStorage.clear();
    await saveSettings({
      calorieTarget: 2000,
      proteinTarget: 150,
      name: '',
      anthropicApiKey: 'test-key',
    });
    mockFetch = vi.fn();
    globalThis.fetch = mockFetch as unknown as typeof fetch;
  });

  it('parses JSON, summarizes via Claude, and persists to storage', async () => {
    mockFetch.mockResolvedValueOnce(okResponse(claudeText('Coach-ready health summary.')));
    const file = new File([JSON_QTY], 'HealthAutoExport.json', {
      type: 'application/json',
    });
    const saved = await importHealthFile(file);

    expect(saved.source).toBe('health-auto-export-json');
    expect(saved.summaryText).toBe('Coach-ready health summary.');
    expect(saved.days).toHaveLength(2);

    const stored = await getHealthSummaries();
    expect(stored).toHaveLength(1);
    expect(stored[0].id).toBe(saved.id);
  });

  it('detects CSV by extension and falls back to template when no key is set', async () => {
    localStorage.clear(); // remove the api key → callClaude throws → template fallback
    const file = new File([CSV_FIXTURE], 'export.csv', { type: 'text/csv' });
    const saved = await importHealthFile(file, { save: async () => {} });
    expect(saved.source).toBe('health-auto-export-csv');
    expect(saved.summaryText).toMatch(/Apple Health import covering 2 days/);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('throws when the file has no recognizable data', async () => {
    const file = new File(['{"data":{"metrics":[]}}'], 'empty.json');
    await expect(importHealthFile(file, { save: async () => {} })).rejects.toThrow(
      /no recognizable health data/i
    );
  });
});
