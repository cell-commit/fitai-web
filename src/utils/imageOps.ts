// Shared image primitives — downscaling and base64 encoding.
//
// Extracted from src/services/photos.ts so both progress photos and coach-chat
// attachments resize through ONE swappable seam. There is a single module-level
// `resize` binding here and exactly one `__setImageOps`; every consumer must
// call `resize()` from this module (photos.ts re-exports the hook rather than
// keeping a second copy) or a test swap would only affect one of them.

/** Downscale an image blob to a max long-edge, re-encoded as JPEG. */
export type ResizeFn = (
  input: Blob,
  maxEdge: number,
  quality: number
) => Promise<Blob>;

/**
 * Default canvas-based resize. Preserves aspect ratio; never upscales (scale is
 * capped at 1). Uses createImageBitmap (Safari 14.1+) + a 2D canvas → JPEG.
 */
export const canvasResize: ResizeFn = async (input, maxEdge, quality) => {
  const bitmap = await createImageBitmap(input);
  const srcW = bitmap.width;
  const srcH = bitmap.height;
  const scale = Math.min(1, maxEdge / Math.max(srcW, srcH));
  const w = Math.max(1, Math.round(srcW * scale));
  const h = Math.max(1, Math.round(srcH * scale));

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not get a 2D canvas context to resize the image.');
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close?.();

  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('Image resize failed.'))),
      'image/jpeg',
      quality
    );
  });
};

let current: ResizeFn = canvasResize;

/**
 * The active resize implementation. Callers must go through this wrapper (not a
 * captured reference to `current`) so __setImageOps swaps take effect.
 */
export const resize: ResizeFn = (input, maxEdge, quality) =>
  current(input, maxEdge, quality);

/** Test hook: override the canvas-dependent resize step. Pass {} to reset. */
export function __setImageOps(ops: { resize?: ResizeFn }): void {
  current = ops.resize ?? canvasResize;
}

/** Base64-encode a blob's bytes (no data: prefix). Canvas-free, jsdom-safe. */
export async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}
