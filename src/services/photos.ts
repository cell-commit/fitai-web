// Progress photos service (design doc §5D; web pivot uses IndexedDB, not
// expo-media-library/file-system).
//
// Full-size and thumbnail image blobs live in IndexedDB (blobStore) under the
// keys `photo/<id>` and `thumb/<id>`. Only lightweight metadata (ProgressPhoto)
// goes to localStorage via storage.ts, with fileUri holding the full blob key
// (existing convention). Vision "ask coach" resizes each selected photo down to
// 1024px, base64-encodes it, and sends a MODELS.coach vision call whose exchange
// is persisted into the Coach chat thread so it shows in the Coach pane.
//
// The only canvas-dependent step (downscaling) is isolated behind an injectable
// `resize` function (see __setImageOps, now in src/utils/imageOps.ts and
// re-exported here) so unit tests can run without a real canvas. Everything
// else — blob storage, base64, metadata, object-URL caching, export — is plain
// DOM/JS and testable directly.

import type { ProgressPhoto } from '../types';
import {
  MODELS,
  callClaude,
  guardStopReason,
  firstText,
  type ClaudeMessage,
  type ClaudeContentBlock,
  type SystemBlock,
} from './claude';
import * as blobStore from './blobStore';
import {
  getPhotos,
  savePhoto,
  deletePhoto as deletePhotoMeta,
  appendChatMessage,
} from './storage';
// Canvas-dependent resize + base64 now live in utils/imageOps so coach-chat
// attachments share the exact same swappable seam. The hook and its type are
// re-exported below so existing importers (and photos.test.ts) are unaffected.
import { resize, blobToBase64, __setImageOps } from '../utils/imageOps';

export { __setImageOps };
export type { ResizeFn } from '../utils/imageOps';

// ─────────────────────────────────────────────────────────────
// Tuning
// ─────────────────────────────────────────────────────────────

const FULL_MAX_EDGE = 1600; // stored full-size long edge (px)
const THUMB_MAX_EDGE = 300; // grid thumbnail long edge (px)
const VISION_MAX_EDGE = 1024; // long edge sent to the vision model (token control)
const JPEG_QUALITY = 0.85;
const MAX_ASK_PHOTOS = 4;

// ─────────────────────────────────────────────────────────────
// Blob keys
// ─────────────────────────────────────────────────────────────

function photoKey(id: string): string {
  return `photo/${id}`;
}
function thumbKey(id: string): string {
  return `thumb/${id}`;
}

function makeId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

// ─────────────────────────────────────────────────────────────
// Object-URL cache (create once per blob key, revoke on delete)
// ─────────────────────────────────────────────────────────────

const urlCache = new Map<string, string>();

async function objectUrlFor(key: string): Promise<string | null> {
  const cached = urlCache.get(key);
  if (cached) return cached;
  const blob = await blobStore.get(key);
  if (!blob) return null;
  const url = URL.createObjectURL(blob);
  urlCache.set(key, url);
  return url;
}

function revokeKey(key: string): void {
  const url = urlCache.get(key);
  if (url) {
    URL.revokeObjectURL(url);
    urlCache.delete(key);
  }
}

/** Object URL for a photo's full-size blob (cached), or null if missing. */
export function getPhotoUrl(id: string): Promise<string | null> {
  return objectUrlFor(photoKey(id));
}

/** Object URL for a photo's thumbnail blob (cached), or null if missing. */
export function getThumbUrl(id: string): Promise<string | null> {
  return objectUrlFor(thumbKey(id));
}

/** Revoke every cached object URL (call on pane unmount to free memory). */
export function revokeAllUrls(): void {
  for (const url of urlCache.values()) URL.revokeObjectURL(url);
  urlCache.clear();
}

// ─────────────────────────────────────────────────────────────
// Add / delete
// ─────────────────────────────────────────────────────────────

/**
 * Downscale + store a captured/picked photo. Writes the full blob (≤1600px,
 * JPEG q≈0.85) to `photo/<id>`, a ~300px thumbnail to `thumb/<id>`, and saves
 * ProgressPhoto metadata (fileUri = the full blob key). Returns the metadata.
 */
export async function addPhoto(file: File, note?: string): Promise<ProgressPhoto> {
  const id = makeId();
  const [full, thumb] = await Promise.all([
    resize(file, FULL_MAX_EDGE, JPEG_QUALITY),
    resize(file, THUMB_MAX_EDGE, JPEG_QUALITY),
  ]);

  await Promise.all([
    blobStore.put(photoKey(id), full),
    blobStore.put(thumbKey(id), thumb),
  ]);

  const trimmed = note?.trim();
  const photo: ProgressPhoto = {
    id,
    takenAt: file.lastModified || Date.now(),
    fileUri: photoKey(id),
    ...(trimmed ? { note: trimmed } : {}),
  };
  await savePhoto(photo);
  return photo;
}

/** Remove a photo's full + thumbnail blobs, revoke cached URLs, drop metadata. */
export async function deletePhoto(id: string): Promise<void> {
  revokeKey(photoKey(id));
  revokeKey(thumbKey(id));
  await Promise.all([
    blobStore.del(photoKey(id)),
    blobStore.del(thumbKey(id)),
  ]);
  await deletePhotoMeta(id);
}

// ─────────────────────────────────────────────────────────────
// Export (download the full-size blob out of the app)
// ─────────────────────────────────────────────────────────────

/** Trigger a browser download of a photo's full-size blob. */
export async function exportPhoto(id: string): Promise<void> {
  const blob = await blobStore.get(photoKey(id));
  if (!blob) throw new Error('That photo is no longer available to export.');

  // A dedicated, immediately-revoked URL — never the cached display URL.
  const url = URL.createObjectURL(blob);
  const photos = await getPhotos();
  const meta = photos.find((p) => p.id === id);
  const stamp = meta ? isoDate(meta.takenAt) : isoDate(Date.now());

  const a = document.createElement('a');
  a.href = url;
  a.download = `fitai-progress-${stamp}.jpg`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// ─────────────────────────────────────────────────────────────
// Vision — ask the coach about photos
// ─────────────────────────────────────────────────────────────

const PHOTO_COACH_SYSTEM = `You are Jason's personal strength & conditioning coach, reviewing his progress photos inside his training app. Be constructive, specific, and honest — encouraging where earned, direct where useful. Comment ONLY on what is actually visible in the photos (posture, apparent muscularity/definition, body composition, symmetry, changes across the set when several are shown). Never invent measurements, weights, or trends you cannot see. Keep it conversational and concise, like a coach talking to his athlete. This is not medical advice.`;

function isoDate(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => (n < 10 ? `0${n}` : String(n));
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function longDate(ts: number): string {
  return new Date(ts).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

/**
 * Send 1–4 progress photos to the coach vision model and persist the exchange
 * into the Coach chat thread (so it appears in the Coach pane). Returns the
 * coach's reply text. Photos are downscaled to ≤1024px before upload.
 */
export async function askCoachAboutPhotos(
  photoIds: string[],
  question?: string
): Promise<string> {
  if (photoIds.length === 0) {
    throw new Error('Select at least one photo to ask the coach about.');
  }
  if (photoIds.length > MAX_ASK_PHOTOS) {
    throw new Error(`You can ask about at most ${MAX_ASK_PHOTOS} photos at once.`);
  }

  const allMeta = await getPhotos();
  const byId = new Map(allMeta.map((p) => [p.id, p]));
  // Preserve caller order, drop any ids that no longer have metadata.
  const selected = photoIds
    .map((id) => byId.get(id))
    .filter((p): p is ProgressPhoto => p !== undefined);
  if (selected.length === 0) {
    throw new Error('None of the selected photos are available any more.');
  }

  const content: ClaudeContentBlock[] = [];
  const dateLines: string[] = [];
  for (const photo of selected) {
    const blob = await blobStore.get(photoKey(photo.id));
    if (!blob) continue;
    const resized = await resize(blob, VISION_MAX_EDGE, JPEG_QUALITY);
    const data = await blobToBase64(resized);
    content.push({
      type: 'image',
      source: { type: 'base64', media_type: 'image/jpeg', data },
    });
    const noteBit = photo.note?.trim() ? ` — note: ${photo.note.trim()}` : '';
    dateLines.push(`Photo ${dateLines.length + 1}: ${longDate(photo.takenAt)}${noteBit}`);
  }

  if (content.length === 0) {
    throw new Error('The selected photos could not be loaded for review.');
  }

  const q = question?.trim();
  const intro =
    content.length === 1
      ? 'Here is a progress photo.'
      : `Here are ${content.length} progress photos, in order.`;
  const askLine = q
    ? `My question: ${q}`
    : 'Give me honest, constructive feedback on what you see and any changes across the photos.';
  content.push({
    type: 'text',
    text: `${intro}\n\n${dateLines.join('\n')}\n\n${askLine}`,
  });

  const system: SystemBlock[] = [
    { type: 'text', text: PHOTO_COACH_SYSTEM, cache_control: { type: 'ephemeral' } },
  ];
  const messages: ClaudeMessage[] = [{ role: 'user', content }];

  const response = await callClaude({
    model: MODELS.coach,
    system,
    messages,
    thinking: { type: 'adaptive' },
    maxTokens: 2048,
  });
  guardStopReason(response);
  const reply = firstText(response);

  // Persist the exchange into the Coach thread so it shows in the Coach pane.
  const now = Date.now();
  const userText =
    `📷 Asked for feedback on ${selected.length} ` +
    `${selected.length === 1 ? 'photo' : 'photos'}` +
    (q ? `\n\n${q}` : '');
  await appendChatMessage({
    id: `${now}-photoq`,
    mode: 'coach',
    role: 'user',
    text: userText,
    timestamp: now,
  });
  await appendChatMessage({
    id: `${now + 1}-photoa`,
    mode: 'coach',
    role: 'assistant',
    text: reply,
    timestamp: now + 1,
  });

  return reply;
}
