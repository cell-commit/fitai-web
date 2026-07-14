import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import * as driveSync from '../driveSync';
import { saveSettings } from '../storage';

/** Build a fetch Response-like object wrapping a JSON body. */
function jsonResponse(obj: unknown) {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify(obj),
    json: async () => obj,
  };
}

let mockFetch: Mock;

beforeEach(() => {
  localStorage.clear();
  mockFetch = vi.fn();
  globalThis.fetch = mockFetch as unknown as typeof fetch;
});

async function configure() {
  await saveSettings({
    calorieTarget: 2000,
    proteinTarget: 150,
    name: '',
    appsScriptUrl: 'https://example.com/exec',
    appsScriptToken: 'secret',
  });
}

describe('fetchFile', () => {
  it('parses the GET response and updates the cache', async () => {
    await configure();
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        name: 'CLAUDE.md',
        content: 'hello world',
        modifiedTime: '2026-07-13T10:00:00.000Z',
      })
    );

    const file = await driveSync.fetchFile('CLAUDE.md');
    expect(file.content).toBe('hello world');
    expect(file.modifiedTime).toBe('2026-07-13T10:00:00.000Z');

    const cached = await driveSync.getCached('CLAUDE.md');
    expect(cached?.content).toBe('hello world');

    // GET URL carries the token + file, both URL-encoded.
    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).toContain('token=secret');
    expect(url).toContain('file=CLAUDE.md');

    const status = await driveSync.getSyncStatus();
    expect(status.lastSyncAt).not.toBeNull();
  });
});

describe('queueWrite + flushQueue', () => {
  it('preserves FIFO order across a network failure (second write not sent)', async () => {
    await configure();
    mockFetch.mockRejectedValue(new Error('network down'));

    await driveSync.queueWrite({
      file: 'training-history-log.md',
      op: 'append',
      content: 'A',
    });
    await driveSync.queueWrite({
      file: 'training-history-log.md',
      op: 'append',
      content: 'B',
    });

    // Every POST attempted only the head-of-queue write ("A"); "B" never sent.
    const bodies = mockFetch.mock.calls.map(
      (c) => JSON.parse(c[1].body as string) as { content: string }
    );
    expect(bodies.length).toBeGreaterThan(0);
    expect(bodies.every((b) => b.content === 'A')).toBe(true);

    // Queue still holds both, in order; head has accumulated attempts.
    const raw = JSON.parse(
      localStorage.getItem('@fitai/sync_queue') as string
    ) as driveSync.PendingWrite[];
    expect(raw.map((w) => w.content)).toEqual(['A', 'B']);
    expect(raw[0].attempts).toBeGreaterThanOrEqual(1);

    const status = await driveSync.getSyncStatus();
    expect(status.queueLength).toBe(2);
    expect(status.lastError).toBeTruthy();
  });

  it('on a write conflict, refreshes the cache and retains the write marked conflicted', async () => {
    await configure();
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        error: 'conflict',
        modifiedTime: '2026-07-13T12:00:00.000Z',
        content: 'SERVER VERSION',
      })
    );

    await driveSync.queueWrite({
      file: 'training-status.md',
      op: 'write',
      content: 'MY EDIT',
      baseModifiedTime: '2026-07-13T09:00:00.000Z',
    });

    const cached = await driveSync.getCached('training-status.md');
    expect(cached?.content).toBe('SERVER VERSION');
    expect(cached?.modifiedTime).toBe('2026-07-13T12:00:00.000Z');

    const status = await driveSync.getSyncStatus();
    expect(status.queueLength).toBe(1);
    expect(status.conflicts).toHaveLength(1);
    expect(status.conflicts[0].content).toBe('MY EDIT');
    expect(status.conflicts[0].conflicted).toBe(true);
  });

  it('removes an append from the queue on success and updates the cache', async () => {
    await configure();
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ ok: true, modifiedTime: '2026-07-13T12:00:00.000Z' })
    );

    await driveSync.queueWrite({
      file: 'training-history-log.md',
      op: 'append',
      content: '## New session',
    });

    const status = await driveSync.getSyncStatus();
    expect(status.queueLength).toBe(0);
    expect(status.lastSyncAt).not.toBeNull();
    expect(status.lastError).toBeNull();

    // POST used the text/plain convention and the right body shape.
    const [, opts] = mockFetch.mock.calls[0];
    expect(opts.headers['Content-Type']).toBe('text/plain;charset=utf-8');
    const body = JSON.parse(opts.body as string);
    expect(body.op).toBe('append');
    expect(body.token).toBe('secret');
    expect(body.file).toBe('training-history-log.md');

    const cached = await driveSync.getCached('training-history-log.md');
    expect(cached?.content).toContain('## New session');
  });
});

describe('testConnection', () => {
  it('parses the list response', async () => {
    await configure();
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        files: [
          { name: 'training-status.md', modifiedTime: 'a' },
          { name: 'training-history-log.md', modifiedTime: 'b' },
          { name: 'CLAUDE.md', modifiedTime: 'c' },
        ],
      })
    );

    const files = await driveSync.testConnection();
    expect(files.map((f) => f.name)).toEqual([
      'training-status.md',
      'training-history-log.md',
      'CLAUDE.md',
    ]);

    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).toContain('file=__list__');
  });
});

describe('not configured', () => {
  it('fetchFile and testConnection throw, but queueWrite still queues offline', async () => {
    await expect(driveSync.fetchFile('CLAUDE.md')).rejects.toThrow(
      'Sync not configured'
    );
    await expect(driveSync.testConnection()).rejects.toThrow(
      'Sync not configured'
    );

    // Offline write is still accepted and held in the queue; no network call.
    await driveSync.queueWrite({
      file: 'CLAUDE.md',
      op: 'append',
      content: 'later',
    });
    expect(mockFetch).not.toHaveBeenCalled();

    const status = await driveSync.getSyncStatus();
    expect(status.configured).toBe(false);
    expect(status.queueLength).toBe(1);
  });

  it('refreshAll silently no-ops when not configured', async () => {
    await expect(driveSync.refreshAll()).resolves.toBeUndefined();
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
