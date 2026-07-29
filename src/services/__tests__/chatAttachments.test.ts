import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  MAX_CHAT_ATTACHMENTS,
  addChatAttachments,
  attachmentsToBlocks,
  deleteChatAttachments,
  getAttachmentUrl,
  pruneOrphanAttachments,
  rehydrateAttachments,
  revokeAllAttachmentUrls,
} from '../chatAttachments';
import { __setImageOps, type ResizeFn } from '../../utils/imageOps';
import { appendChatMessage, saveInflightSend } from '../storage';
import type { ChatAttachment, ChatMessage } from '../../types';

// ── Mock the IndexedDB blob store with an in-memory Map (as photos.test.ts) ──

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

/** Records how it was called, then echoes the bytes back (no canvas). */
const resizeCalls: Array<{ maxEdge: number; quality: number }> = [];
const echoResize: ResizeFn = async (input, maxEdge, quality) => {
  resizeCalls.push({ maxEdge, quality });
  return new Blob([await input.arrayBuffer()], { type: 'image/jpeg' });
};

function jpegFile(name = 'shot.jpg'): File {
  return new File([new Uint8Array([1, 2, 3, 4, 5])], name, {
    type: 'image/jpeg',
    lastModified: 1_700_000_000_000,
  });
}

function userMessage(attachments: ChatAttachment[]): ChatMessage {
  return {
    id: `u${Math.random().toString(36).slice(2)}`,
    mode: 'coach',
    role: 'user',
    text: 'how do these look',
    timestamp: Date.now(),
    attachments,
  };
}

beforeEach(() => {
  localStorage.clear();
  store.map.clear();
  resizeCalls.length = 0;
  __setImageOps({ resize: echoResize });
  globalThis.URL.createObjectURL = vi.fn(() => 'blob:mock-url');
  globalThis.URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
  __setImageOps({}); // back to the canvas default
  vi.restoreAllMocks();
});

// ── addChatAttachments ────────────────────────────────────────

describe('addChatAttachments', () => {
  it('resizes ONCE to 1024px q0.85 and stores the blob under chat/<id>', async () => {
    const [a] = await addChatAttachments([jpegFile()]);

    // One encode per image, at attach time — a retry re-sends this same blob.
    expect(resizeCalls).toEqual([{ maxEdge: 1024, quality: 0.85 }]);

    expect(a.blobKey).toBe(`chat/${a.id}`);
    expect(a.mediaType).toBe('image/jpeg');
    expect(store.map.has(`chat/${a.id}`)).toBe(true);
    expect(store.map.size).toBe(1);
  });

  it('keeps the picked order and gives each image its own key', async () => {
    const added = await addChatAttachments([jpegFile('a.jpg'), jpegFile('b.jpg')]);

    expect(added).toHaveLength(2);
    expect(new Set(added.map((a) => a.blobKey)).size).toBe(2);
    expect(store.map.size).toBe(2);
  });

  it('refuses more than the 4-image cap and stores nothing', async () => {
    const files = Array.from({ length: MAX_CHAT_ATTACHMENTS + 1 }, (_, i) =>
      jpegFile(`p${i}.jpg`)
    );

    await expect(addChatAttachments(files)).rejects.toThrow(/at most 4 photos/i);
    expect(store.map.size).toBe(0);
  });

  it('is a no-op for an empty pick', async () => {
    expect(await addChatAttachments([])).toEqual([]);
    expect(resizeCalls).toHaveLength(0);
  });
});

// ── attachmentsToBlocks ───────────────────────────────────────

describe('attachmentsToBlocks', () => {
  it('emits one base64 image block per attachment, in order', async () => {
    const added = await addChatAttachments([jpegFile('a.jpg'), jpegFile('b.jpg')]);

    const blocks = await attachmentsToBlocks(added);

    expect(blocks).toHaveLength(2);
    expect(blocks[0].type).toBe('image');
    expect(blocks[0].source?.type).toBe('base64');
    expect(blocks[0].source?.media_type).toBe('image/jpeg');
    expect(blocks[0].source?.data).toBe(btoa('\x01\x02\x03\x04\x05'));
  });

  it('skips an attachment whose blob has gone missing', async () => {
    const added = await addChatAttachments([jpegFile()]);
    store.map.clear();

    expect(await attachmentsToBlocks(added)).toEqual([]);
  });
});

// ── delete / rehydrate / URLs ─────────────────────────────────

describe('deleteChatAttachments + rehydrateAttachments', () => {
  it('deletes by id and rebuilds metadata from the surviving blobs', async () => {
    const [a, b] = await addChatAttachments([jpegFile('a.jpg'), jpegFile('b.jpg')]);

    await deleteChatAttachments([a.id]);

    expect(store.map.has(a.blobKey)).toBe(false);
    expect(store.map.has(b.blobKey)).toBe(true);

    // A retry rehydrates from the blobs — the dead id is simply dropped.
    const rehydrated = await rehydrateAttachments([a.id, b.id]);
    expect(rehydrated.map((x) => x.id)).toEqual([b.id]);
    expect(rehydrated[0].blobKey).toBe(`chat/${b.id}`);
  });

  it('caches one object URL per attachment and revokes them all on unmount', async () => {
    const [a] = await addChatAttachments([jpegFile()]);

    expect(await getAttachmentUrl(a)).toBe('blob:mock-url');
    expect(await getAttachmentUrl(a)).toBe('blob:mock-url');
    expect(globalThis.URL.createObjectURL).toHaveBeenCalledTimes(1);

    revokeAllAttachmentUrls();
    expect(globalThis.URL.revokeObjectURL).toHaveBeenCalledTimes(1);
  });

  it('returns null when the blob is gone', async () => {
    const [a] = await addChatAttachments([jpegFile()]);
    store.map.clear();
    expect(await getAttachmentUrl(a)).toBeNull();
  });
});

// ── pruneOrphanAttachments ────────────────────────────────────

describe('pruneOrphanAttachments', () => {
  it('deletes blobs no message references and KEEPS the referenced ones', async () => {
    const kept = await addChatAttachments([jpegFile('kept.jpg')]);
    const orphaned = await addChatAttachments([jpegFile('gone.jpg')]);
    // Only the first message survives in the thread — the second is what the
    // 200-message cap silently evicts.
    await appendChatMessage(userMessage(kept));

    const deleted = await pruneOrphanAttachments();

    expect(deleted).toBe(1);
    expect(store.map.has(kept[0].blobKey)).toBe(true);
    expect(store.map.has(orphaned[0].blobKey)).toBe(false);
  });

  it('never touches non-chat blobs', async () => {
    store.map.set('photo/123', new Blob(['x']));
    store.map.set('thumb/123', new Blob(['x']));
    await addChatAttachments([jpegFile()]);

    expect(await pruneOrphanAttachments()).toBe(1);
    expect(store.map.has('photo/123')).toBe(true);
    expect(store.map.has('thumb/123')).toBe(true);
  });

  it('keeps blobs held only by an in-flight send (the retry still needs them)', async () => {
    // What an interrupted photo send leaves behind: the orphan user turn has
    // been stripped from the thread, so the record is the only reference.
    const added = await addChatAttachments([jpegFile()]);
    await saveInflightSend({
      mode: 'coach',
      text: '',
      startedAt: Date.now(),
      attempts: 1,
      messageId: 'u1',
      attachmentIds: added.map((a) => a.id),
    });

    expect(await pruneOrphanAttachments()).toBe(0);
    expect(store.map.has(added[0].blobKey)).toBe(true);
  });

  it('counts attachments in the nutrition thread as referenced too', async () => {
    const added = await addChatAttachments([jpegFile()]);
    await appendChatMessage({ ...userMessage(added), mode: 'nutrition' });

    expect(await pruneOrphanAttachments()).toBe(0);
  });

  it('is a cheap no-op when there is nothing stored', async () => {
    expect(await pruneOrphanAttachments()).toBe(0);
  });
});
