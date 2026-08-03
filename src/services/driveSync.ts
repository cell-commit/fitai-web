// Drive sync bridge client (design doc §1.3).
//
// Talks to the Google Apps Script web app (see docs/apps-script/) that
// reads/writes Jason's three canonical training files on Google Drive.
// Offline-first: a local cache of each file plus a FIFO write queue live in
// localStorage, so the gym UI never blocks on the network. Writes are POSTed
// with a text/plain body (Apps Script convention; also keeps the request a CORS
// "simple request" so no preflight is needed); the browser fetch follows the
// 302 redirect to script.googleusercontent.com automatically — we never
// inspect the first-hop status.
//
// Consistency rules of use (design doc §1.3 / §9.7):
//   • append to the history log (never conflicts),
//   • make targeted str-replace edits to training-status via op:'write' with
//     a baseModifiedTime so a stale overwrite is caught as a conflict.

import { kv } from './kv';
import { getSettings } from './storage';

// ─────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────

export type DriveFileName =
  | 'training-status.md'
  | 'training-history-log.md'
  | 'CLAUDE.md';

export const DRIVE_FILES: DriveFileName[] = [
  'training-status.md',
  'training-history-log.md',
  'CLAUDE.md',
];

export interface CachedFile {
  name: DriveFileName;
  content: string;
  modifiedTime: string; // ISO string from the server (Drive getLastUpdated)
  fetchedAt: number;
}

export interface PendingWrite {
  id: string;
  file: DriveFileName;
  op: 'write' | 'append';
  content: string;
  baseModifiedTime?: string;
  createdAt: number;
  attempts: number;
  // Surfaced states (not sent to the server):
  conflicted?: boolean; // op:'write' rejected because the server copy moved on
  parked?: boolean; // gave up after MAX_ATTEMPTS network failures
  lastError?: string;
}

export interface SyncStatus {
  configured: boolean;
  queueLength: number;
  lastSyncAt: number | null;
  lastError: string | null;
  conflicts: PendingWrite[];
}

interface ListedFile {
  name: string;
  modifiedTime?: string;
  error?: string;
}

// ─────────────────────────────────────────────────────────────
// Storage keys + tunables
// ─────────────────────────────────────────────────────────────

const CACHE_KEY = '@fitai/drive_cache';
const QUEUE_KEY = '@fitai/sync_queue';
const META_KEY = '@fitai/sync_meta';

const MAX_ATTEMPTS = 20;
const LIST_SENTINEL = '__list__';

/** Thrown when the app tries to reach Drive before Settings are configured. */
export class SyncNotConfiguredError extends Error {
  constructor() {
    super('Sync not configured. Add the Apps Script URL and token in Settings.');
    this.name = 'SyncNotConfiguredError';
  }
}

// ─────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────

interface SyncConfig {
  url: string;
  token: string;
}

async function getConfig(): Promise<SyncConfig | null> {
  const settings = await getSettings();
  const url = settings.appsScriptUrl?.trim();
  const token = settings.appsScriptToken?.trim();
  if (!url || !token) return null;
  return { url, token };
}

export async function isConfigured(): Promise<boolean> {
  return (await getConfig()) !== null;
}

async function requireConfig(): Promise<SyncConfig> {
  const config = await getConfig();
  if (!config) throw new SyncNotConfiguredError();
  return config;
}

// ─────────────────────────────────────────────────────────────
// Cache
// ─────────────────────────────────────────────────────────────

type Cache = Partial<Record<DriveFileName, CachedFile>>;

async function readCache(): Promise<Cache> {
  try {
    const data = await kv.getItem(CACHE_KEY);
    return data ? (JSON.parse(data) as Cache) : {};
  } catch {
    return {};
  }
}

async function writeCacheEntry(entry: CachedFile): Promise<void> {
  const cache = await readCache();
  cache[entry.name] = entry;
  await kv.setItem(CACHE_KEY, JSON.stringify(cache));
}

export async function getCached(name: DriveFileName): Promise<CachedFile | null> {
  const cache = await readCache();
  return cache[name] ?? null;
}

/**
 * Optimistically overwrite the cached content of a file without touching the
 * server, preserving the last-known modifiedTime. Used by the coach's
 * edit_training_status handler so successive edits in a conversation match
 * against the already-applied text while the real write drains through the
 * queue (the eventual server response reconciles modifiedTime).
 */
export async function setCachedContent(
  name: DriveFileName,
  content: string
): Promise<void> {
  const existing = await getCached(name);
  await writeCacheEntry({
    name,
    content,
    modifiedTime: existing?.modifiedTime ?? new Date().toISOString(),
    fetchedAt: Date.now(),
  });
}

// ─────────────────────────────────────────────────────────────
// Queue
// ─────────────────────────────────────────────────────────────

async function readQueue(): Promise<PendingWrite[]> {
  try {
    const data = await kv.getItem(QUEUE_KEY);
    return data ? (JSON.parse(data) as PendingWrite[]) : [];
  } catch {
    return [];
  }
}

async function saveQueue(queue: PendingWrite[]): Promise<void> {
  await kv.setItem(QUEUE_KEY, JSON.stringify(queue));
}

// ─────────────────────────────────────────────────────────────
// Meta (last sync time / last error)
// ─────────────────────────────────────────────────────────────

interface SyncMeta {
  lastSyncAt?: number;
  lastError?: string | null;
}

async function readMeta(): Promise<SyncMeta> {
  try {
    const data = await kv.getItem(META_KEY);
    return data ? (JSON.parse(data) as SyncMeta) : {};
  } catch {
    return {};
  }
}

async function patchMeta(patch: SyncMeta): Promise<void> {
  const meta = await readMeta();
  await kv.setItem(META_KEY, JSON.stringify({ ...meta, ...patch }));
}

// ─────────────────────────────────────────────────────────────
// GET — fetch a single file, update the cache
// ─────────────────────────────────────────────────────────────

interface FileResponse {
  name?: string;
  content?: string;
  modifiedTime?: string;
  error?: string;
}

async function parseJson<T>(response: Response): Promise<T> {
  // Read as text then parse: Apps Script sometimes returns HTML on error, and
  // we want a clear failure rather than an opaque .json() reject.
  const text = await response.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`Unexpected response from sync bridge: ${text.slice(0, 200)}`);
  }
}

export async function fetchFile(name: DriveFileName): Promise<CachedFile> {
  const { url, token } = await requireConfig();
  const getUrl = `${url}?token=${encodeURIComponent(token)}&file=${encodeURIComponent(
    name
  )}`;

  const response = await fetch(getUrl, { method: 'GET' });
  const data = await parseJson<FileResponse>(response);

  if (data.error) throw new Error(data.error);
  if (typeof data.content !== 'string' || typeof data.modifiedTime !== 'string') {
    throw new Error('Malformed file response from sync bridge.');
  }

  const cached: CachedFile = {
    name,
    content: data.content,
    modifiedTime: data.modifiedTime,
    fetchedAt: Date.now(),
  };
  await writeCacheEntry(cached);
  await patchMeta({ lastSyncAt: Date.now(), lastError: null });
  return cached;
}

export interface RefreshAllResult {
  /** False when at least one file failed to fetch — the cache is now stale. */
  ok: boolean;
  /** First failure's message, or null. */
  error: string | null;
}

/**
 * Pull all three files. Tolerant of individual failures — a single file that
 * errors doesn't abort the others. No-ops when sync isn't configured (so
 * foreground-refresh hooks can call it unconditionally).
 *
 * The outcome is RETURNED as well as recorded in meta: a failed refresh leaves
 * the previous cached copy in place, and a caller that cannot tell "refreshed"
 * from "tried and failed" will show a stale copy as if it were current. That is
 * exactly the bug this return value exists to prevent — do not go back to
 * swallowing it.
 */
export async function refreshAll(): Promise<RefreshAllResult> {
  if (!(await isConfigured())) return { ok: true, error: null };
  const results = await Promise.allSettled(DRIVE_FILES.map((f) => fetchFile(f)));
  const firstError = results.find(
    (r): r is PromiseRejectedResult => r.status === 'rejected'
  );
  if (firstError) {
    const reason = firstError.reason;
    const error = reason instanceof Error ? reason.message : String(reason);
    await patchMeta({ lastError: error });
    return { ok: false, error };
  }
  return { ok: true, error: null };
}

// ─────────────────────────────────────────────────────────────
// Test connection — list mode
// ─────────────────────────────────────────────────────────────

export interface ConnectionFile {
  name: string;
  modifiedTime?: string;
  error?: string;
}

interface ListResponse {
  files?: ListedFile[];
  error?: string;
}

/** Hit the bridge's list mode; returns each file's name + modified time. */
export async function testConnection(): Promise<ConnectionFile[]> {
  const { url, token } = await requireConfig();
  const getUrl = `${url}?token=${encodeURIComponent(token)}&file=${encodeURIComponent(
    LIST_SENTINEL
  )}`;

  const response = await fetch(getUrl, { method: 'GET' });
  const data = await parseJson<ListResponse>(response);

  if (data.error) throw new Error(data.error);
  if (!Array.isArray(data.files)) {
    throw new Error('Malformed list response from sync bridge.');
  }
  await patchMeta({ lastSyncAt: Date.now(), lastError: null });
  return data.files;
}

// ─────────────────────────────────────────────────────────────
// Write queue
// ─────────────────────────────────────────────────────────────

function makeId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Enqueue a write and attempt a flush. Always queues, even when sync isn't
 * configured yet (the write is held offline; a later flush drains it). Never
 * throws for the not-configured case.
 */
export async function queueWrite(
  w: Pick<PendingWrite, 'file' | 'op' | 'content' | 'baseModifiedTime'>
): Promise<void> {
  const queue = await readQueue();
  queue.push({
    id: makeId(),
    file: w.file,
    op: w.op,
    content: w.content,
    baseModifiedTime: w.baseModifiedTime,
    createdAt: Date.now(),
    attempts: 0,
  });
  await saveQueue(queue);
  await flushQueue();
}

interface PostResponse {
  ok?: boolean;
  modifiedTime?: string;
  content?: string;
  error?: string;
}

async function postWrite(
  config: SyncConfig,
  w: PendingWrite
): Promise<PostResponse> {
  const response = await fetch(config.url, {
    method: 'POST',
    // Apps Script convention — avoids CORS preflight / body-parsing quirks.
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({
      token: config.token,
      file: w.file,
      op: w.op,
      content: w.content,
      baseModifiedTime: w.baseModifiedTime,
    }),
  });
  return parseJson<PostResponse>(response);
}

// Module-level in-flight guard so concurrent flushes don't double-send.
let flushing = false;

/**
 * Drain the queue FIFO. Stops on the first network/server failure (leaving the
 * queue intact so ordering is preserved for the next trigger). On a write
 * conflict, refreshes the cache with the server's copy and leaves the write in
 * the queue marked `conflicted` for the UI to surface. Silently no-ops when
 * sync isn't configured.
 */
export async function flushQueue(): Promise<void> {
  if (flushing) return;
  const config = await getConfig();
  if (!config) return;

  flushing = true;
  try {
    const queue = await readQueue();
    let i = 0;

    while (i < queue.length) {
      const w = queue[i];

      // Already surfaced to the UI — don't auto-retry, just step past so
      // anything queued behind it can still flush.
      if (w.conflicted || w.parked) {
        i += 1;
        continue;
      }

      let res: PostResponse;
      try {
        res = await postWrite(config, w);
      } catch (netErr) {
        // Network failure — increment attempts, stop flushing (retry later).
        w.attempts += 1;
        w.lastError = netErr instanceof Error ? netErr.message : String(netErr);
        if (w.attempts >= MAX_ATTEMPTS) {
          w.parked = true;
          w.lastError = `Gave up after ${MAX_ATTEMPTS} attempts: ${w.lastError}`;
        }
        await saveQueue(queue);
        await patchMeta({ lastError: w.lastError });
        return;
      }

      // Conflict on a full overwrite: adopt the server copy into the cache and
      // keep the write around, flagged, so the UI/coach can rebase it.
      if (res.error === 'conflict' && w.op === 'write') {
        if (typeof res.content === 'string' && typeof res.modifiedTime === 'string') {
          await writeCacheEntry({
            name: w.file,
            content: res.content,
            modifiedTime: res.modifiedTime,
            fetchedAt: Date.now(),
          });
        }
        w.conflicted = true;
        w.lastError = 'conflict';
        await saveQueue(queue);
        await patchMeta({ lastError: `Conflict on ${w.file}` });
        i += 1; // leave it in place, continue with the rest
        continue;
      }

      // Any other server-side error — record and stop (don't hammer).
      if (res.error) {
        w.attempts += 1;
        w.lastError = res.error;
        if (w.attempts >= MAX_ATTEMPTS) w.parked = true;
        await saveQueue(queue);
        await patchMeta({ lastError: res.error });
        return;
      }

      // Success — update the cache and drop the write from the queue.
      await applySuccessfulWriteToCache(w, res.modifiedTime);
      queue.splice(i, 1); // remove; do NOT advance i (next item shifts down)
      await saveQueue(queue);
      await patchMeta({ lastSyncAt: Date.now(), lastError: null });
    }
  } finally {
    flushing = false;
  }
}

/** Keep the local cache coherent after a successful write/append. */
async function applySuccessfulWriteToCache(
  w: PendingWrite,
  modifiedTime?: string
): Promise<void> {
  const cache = await readCache();
  const existing = cache[w.file];

  let content: string;
  if (w.op === 'append') {
    // Mirror the server's normalization: collapse trailing whitespace to a
    // single blank line, then append.
    const base = existing?.content ?? '';
    content = base.replace(/\s*$/, '\n\n') + w.content;
  } else {
    content = w.content;
  }

  await writeCacheEntry({
    name: w.file,
    content,
    modifiedTime: modifiedTime ?? existing?.modifiedTime ?? new Date().toISOString(),
    fetchedAt: Date.now(),
  });
}

// ─────────────────────────────────────────────────────────────
// Status (for the UI)
// ─────────────────────────────────────────────────────────────

export async function getSyncStatus(): Promise<SyncStatus> {
  const [queue, meta, configured] = await Promise.all([
    readQueue(),
    readMeta(),
    isConfigured(),
  ]);
  return {
    configured,
    queueLength: queue.length,
    lastSyncAt: meta.lastSyncAt ?? null,
    lastError: meta.lastError ?? null,
    conflicts: queue.filter((w) => w.conflicted),
  };
}

/**
 * Drop a queued write by id (e.g. after the coach rebases a conflict). Exposed
 * for the UI / conflict-resolution flows.
 */
export async function removeQueuedWrite(id: string): Promise<void> {
  const queue = await readQueue();
  await saveQueue(queue.filter((w) => w.id !== id));
}
