import { describe, it, expect, beforeEach, vi, afterEach, type Mock } from 'vitest';
import {
  addPhoto,
  deletePhoto,
  exportPhoto,
  askCoachAboutPhotos,
  __setImageOps,
  type ResizeFn,
} from '../photos';
import { getPhotos, getChatMessages, saveSettings } from '../storage';
import type { ClaudeResponse } from '../claude';

// ── Mock the IndexedDB blob store with an in-memory Map ───────

const store = vi.hoisted(() => ({ map: new Map<string, Blob>() }));

vi.mock('../blobStore', () => ({
  put: vi.fn(async (key: string, blob: Blob) => {
    store.map.set(key, blob);
  }),
  get: vi.fn(async (key: string) => store.map.get(key) ?? null),
  del: vi.fn(async (key: string) => {
    store.map.delete(key);
  }),
  list: vi.fn(async () => Array.from(store.map.keys())),
}));

// ── Helpers ───────────────────────────────────────────────────

/** A resize stub that echoes bytes back (no canvas). */
const echoResize: ResizeFn = async (input) =>
  new Blob([await input.arrayBuffer()], { type: 'image/jpeg' });

function jpegFile(name = 'shot.jpg'): File {
  // A few bytes are enough — the resize step is stubbed.
  return new File([new Uint8Array([1, 2, 3, 4, 5])], name, {
    type: 'image/jpeg',
    lastModified: 1_700_000_000_000,
  });
}

function textResponse(text: string): ClaudeResponse {
  return {
    id: 'msg',
    model: 'claude-opus-4-8',
    content: [{ type: 'text', text }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 1, output_tokens: 1 },
  };
}

function fetchReturning(obj: ClaudeResponse) {
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
  store.map.clear();
  __setImageOps({ resize: echoResize });

  // Object-URL APIs are not implemented in jsdom — stub them.
  globalThis.URL.createObjectURL = vi.fn(() => 'blob:mock-url');
  globalThis.URL.revokeObjectURL = vi.fn();

  mockFetch = vi.fn();
  globalThis.fetch = mockFetch as unknown as typeof fetch;
});

afterEach(() => {
  __setImageOps({}); // reset to the canvas default
  vi.restoreAllMocks();
});

// ── addPhoto ──────────────────────────────────────────────────

describe('addPhoto', () => {
  it('stores a full blob, a thumbnail blob, and metadata', async () => {
    const photo = await addPhoto(jpegFile(), '  chest day  ');

    // Metadata: fileUri points at the full blob key; note is trimmed.
    expect(photo.fileUri).toBe(`photo/${photo.id}`);
    expect(photo.note).toBe('chest day');
    expect(photo.takenAt).toBe(1_700_000_000_000); // from file.lastModified

    // Both blobs landed in the store under the id-derived keys.
    expect(store.map.has(`photo/${photo.id}`)).toBe(true);
    expect(store.map.has(`thumb/${photo.id}`)).toBe(true);

    // Metadata persisted to storage.
    const all = await getPhotos();
    expect(all).toHaveLength(1);
    expect(all[0].id).toBe(photo.id);
  });

  it('omits the note when blank', async () => {
    const photo = await addPhoto(jpegFile(), '   ');
    expect(photo.note).toBeUndefined();
  });
});

// ── deletePhoto ───────────────────────────────────────────────

describe('deletePhoto', () => {
  it('removes the full blob, thumbnail blob, and metadata', async () => {
    const photo = await addPhoto(jpegFile());
    expect(store.map.size).toBe(2);

    await deletePhoto(photo.id);

    expect(store.map.has(`photo/${photo.id}`)).toBe(false);
    expect(store.map.has(`thumb/${photo.id}`)).toBe(false);
    expect(await getPhotos()).toHaveLength(0);
  });
});

// ── askCoachAboutPhotos ───────────────────────────────────────

describe('askCoachAboutPhotos', () => {
  beforeEach(async () => {
    await saveSettings({
      calorieTarget: 2000,
      proteinTarget: 150,
      name: 'Jason',
      anthropicApiKey: 'test-key',
    });
  });

  it('builds a vision message with one image block per photo and persists to the coach thread', async () => {
    const p1 = await addPhoto(jpegFile('a.jpg'));
    const p2 = await addPhoto(jpegFile('b.jpg'));

    mockFetch.mockResolvedValueOnce(
      fetchReturning(textResponse('Solid shoulder development since last month.'))
    );

    const reply = await askCoachAboutPhotos([p1.id, p2.id], 'shoulders?');
    expect(reply).toMatch(/shoulder development/i);

    // One API call with two image blocks + a trailing text block.
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.model).toBe('claude-opus-4-8');
    const content = body.messages[0].content;
    const images = content.filter((b: { type: string }) => b.type === 'image');
    const texts = content.filter((b: { type: string }) => b.type === 'text');
    expect(images).toHaveLength(2);
    expect(images[0].source.type).toBe('base64');
    expect(images[0].source.media_type).toBe('image/jpeg');
    expect(texts[texts.length - 1].text).toContain('shoulders?');
    // Vision system prompt present.
    expect(body.system[0].text).toMatch(/progress photos/i);

    // The exchange was persisted into the coach thread (visible in Coach pane).
    const thread = await getChatMessages('coach');
    expect(thread).toHaveLength(2);
    expect(thread[0].role).toBe('user');
    expect(thread[0].text).toContain('Asked for feedback on 2 photos');
    expect(thread[0].text).toContain('shoulders?');
    expect(thread[1].role).toBe('assistant');
    expect(thread[1].text).toBe('Solid shoulder development since last month.');
  });

  it('rejects an empty selection and an over-cap selection', async () => {
    await expect(askCoachAboutPhotos([])).rejects.toThrow(/at least one/i);
    await expect(
      askCoachAboutPhotos(['a', 'b', 'c', 'd', 'e'])
    ).rejects.toThrow(/at most 4/i);
  });
});

// ── exportPhoto ───────────────────────────────────────────────

describe('exportPhoto', () => {
  it('creates an object URL for the full blob and triggers a download', async () => {
    const photo = await addPhoto(jpegFile());

    await exportPhoto(photo.id);

    expect(globalThis.URL.createObjectURL).toHaveBeenCalledTimes(1);
    expect(globalThis.URL.revokeObjectURL).toHaveBeenCalledTimes(1);
  });

  it('throws when the blob is missing', async () => {
    await expect(exportPhoto('nope')).rejects.toThrow(/no longer available/i);
  });
});
