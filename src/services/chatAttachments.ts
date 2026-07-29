// Coach-chat photo attachments (WP-2).
//
// Mirrors src/services/photos.ts, with three deliberate differences:
//
//  1. ONE resize, at attach time. Progress photos keep a 1600px original and
//     re-encode to 1024px per vision call; a chat attachment is resized to
//     1024px the moment it is picked and THAT blob is what gets sent. A retry
//     after an interrupted send therefore costs no second encode, and the blob
//     the user saw as a thumbnail is byte-identical to the one Claude saw.
//  2. The thread holds references only (ChatAttachment.blobKey → `chat/<id>`);
//     image bytes never touch localStorage.
//  3. Orphan pruning exists here and not in photos.ts, because chat threads are
//     CAPPED at 200 messages and appendChatMessage silently drops the oldest.
//     Every evicted message with attachments would otherwise leak its IndexedDB
//     blobs forever, with no UI that could ever reach them again.
//
// The canvas-dependent step goes through the shared `imageOps` seam (WP-0), so
// unit tests swap one implementation for both photos and chat attachments.

import type { ChatAttachment, ChatMode } from '../types';
import type { ClaudeContentBlock } from './claude';
import * as blobStore from './blobStore';
import { getChatMessages, getInflightSend } from './storage';
import { resize, blobToBase64 } from '../utils/imageOps';

// ─────────────────────────────────────────────────────────────
// Tuning
// ─────────────────────────────────────────────────────────────

/** Long edge sent to the vision model — same budget as progress photos. */
export const CHAT_MAX_EDGE = 1024;
const JPEG_QUALITY = 0.85;

/** Hard cap on images per chat message (token cost + phone upload time). */
export const MAX_CHAT_ATTACHMENTS = 4;

/** Every chat attachment blob key starts with this; prune scans by prefix. */
export const CHAT_BLOB_PREFIX = 'chat/';

const DEFAULT_MEDIA_TYPE = 'image/jpeg';

// ─────────────────────────────────────────────────────────────
// Keys / ids
// ─────────────────────────────────────────────────────────────

/** blobStore key for a chat attachment id. */
export function chatBlobKey(id: string): string {
  return `${CHAT_BLOB_PREFIX}${id}`;
}

function makeId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

// ─────────────────────────────────────────────────────────────
// Object-URL cache (create once per blob key, revoke on delete/unmount)
// ─────────────────────────────────────────────────────────────

const urlCache = new Map<string, string>();

function revokeKey(key: string): void {
  const url = urlCache.get(key);
  if (url) {
    URL.revokeObjectURL(url);
    urlCache.delete(key);
  }
}

/** Cached object URL for an attachment's blob, or null when it is gone. */
export async function getAttachmentUrl(
  attachment: ChatAttachment
): Promise<string | null> {
  const key = attachment.blobKey || chatBlobKey(attachment.id);
  const cached = urlCache.get(key);
  if (cached) return cached;
  const blob = await blobStore.get(key);
  if (!blob) return null;
  const url = URL.createObjectURL(blob);
  urlCache.set(key, url);
  return url;
}

/** Revoke every cached attachment URL (call on CoachPane unmount). */
export function revokeAllAttachmentUrls(): void {
  for (const url of urlCache.values()) URL.revokeObjectURL(url);
  urlCache.clear();
}

// ─────────────────────────────────────────────────────────────
// Add / delete
// ─────────────────────────────────────────────────────────────

/**
 * Downscale each picked image to ≤1024px (JPEG q0.85) and store it under
 * `chat/<id>`. Returns the metadata to hang on the outgoing ChatMessage.
 * Throws above the 4-image cap rather than silently dropping images.
 */
export async function addChatAttachments(
  files: File[]
): Promise<ChatAttachment[]> {
  if (files.length === 0) return [];
  if (files.length > MAX_CHAT_ATTACHMENTS) {
    throw new Error(
      `You can attach at most ${MAX_CHAT_ATTACHMENTS} photos to a message.`
    );
  }

  const out: ChatAttachment[] = [];
  for (const file of files) {
    const id = makeId();
    const blob = await resize(file, CHAT_MAX_EDGE, JPEG_QUALITY);
    const key = chatBlobKey(id);
    await blobStore.put(key, blob);
    out.push({
      id,
      blobKey: key,
      mediaType: blob.type || DEFAULT_MEDIA_TYPE,
    });
  }
  return out;
}

/** Delete attachment blobs by id and drop their cached object URLs. */
export async function deleteChatAttachments(ids: string[]): Promise<void> {
  for (const id of ids) {
    const key = chatBlobKey(id);
    revokeKey(key);
    await blobStore.del(key);
  }
}

/**
 * Rebuild ChatAttachment metadata from the stored blobs. Used by the retry path:
 * the in-flight record persists ids only, and the blobs are deliberately kept
 * when an orphaned user turn is stripped, so a retry re-attaches the exact same
 * images without re-encoding. Ids whose blob is gone are dropped.
 */
export async function rehydrateAttachments(
  ids: string[]
): Promise<ChatAttachment[]> {
  const out: ChatAttachment[] = [];
  for (const id of ids) {
    const key = chatBlobKey(id);
    const blob = await blobStore.get(key);
    if (!blob) continue;
    out.push({ id, blobKey: key, mediaType: blob.type || DEFAULT_MEDIA_TYPE });
  }
  return out;
}

// ─────────────────────────────────────────────────────────────
// Wire format
// ─────────────────────────────────────────────────────────────

/** Base64 image content blocks, in order. Missing blobs are skipped. */
export async function attachmentsToBlocks(
  attachments: ChatAttachment[]
): Promise<ClaudeContentBlock[]> {
  const blocks: ClaudeContentBlock[] = [];
  for (const a of attachments) {
    const blob = await blobStore.get(a.blobKey || chatBlobKey(a.id));
    if (!blob) continue;
    blocks.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: a.mediaType || DEFAULT_MEDIA_TYPE,
        data: await blobToBase64(blob),
      },
    });
  }
  return blocks;
}

// ─────────────────────────────────────────────────────────────
// Orphan pruning
// ─────────────────────────────────────────────────────────────

const MODES: ChatMode[] = ['coach', 'nutrition'];

/**
 * Delete `chat/*` blobs that no chat message references any more, and return how
 * many were removed.
 *
 * Why this has to exist: the coach and nutrition threads are capped at 200
 * messages each and appendChatMessage drops the oldest without telling anyone.
 * Once a message with attachments falls off the end, nothing in the app can ever
 * reach its blobs again — they would sit in IndexedDB forever, growing by ~150KB
 * per photo. Run it fire-and-forget on CoachPane mount.
 *
 * The in-flight send record counts as a reference: retryCoachSend rehydrates its
 * attachmentIds from these blobs, and stripOrphanUserTurn deliberately removes
 * the message while keeping the images, so for that window the record is the
 * ONLY thing pointing at them.
 */
export async function pruneOrphanAttachments(): Promise<number> {
  const keys = await blobStore.list();
  const chatKeys = keys.filter((k) => k.startsWith(CHAT_BLOB_PREFIX));
  if (chatKeys.length === 0) return 0;

  const referenced = new Set<string>();
  for (const mode of MODES) {
    const thread = await getChatMessages(mode);
    for (const m of thread) {
      for (const a of m.attachments ?? []) {
        referenced.add(a.blobKey || chatBlobKey(a.id));
      }
    }
  }
  const inflight = await getInflightSend();
  for (const id of inflight?.attachmentIds ?? []) {
    referenced.add(chatBlobKey(id));
  }

  let deleted = 0;
  for (const key of chatKeys) {
    if (referenced.has(key)) continue;
    revokeKey(key);
    await blobStore.del(key);
    deleted++;
  }
  return deleted;
}
