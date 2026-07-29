import { describe, it, expect, afterEach } from 'vitest';
import {
  blobToBase64,
  resize,
  canvasResize,
  __setImageOps,
  type ResizeFn,
} from '../imageOps';
import { __setImageOps as photosSetImageOps } from '../../services/photos';

afterEach(() => {
  __setImageOps({}); // back to the canvas default
});

// ── blobToBase64 ──────────────────────────────────────────────

describe('blobToBase64', () => {
  it('encodes bytes without a data: prefix', async () => {
    const blob = new Blob([new Uint8Array([104, 105])], { type: 'image/jpeg' });
    expect(await blobToBase64(blob)).toBe(btoa('hi'));
  });

  it('returns an empty string for an empty blob', async () => {
    expect(await blobToBase64(new Blob([]))).toBe('');
  });

  it('encodes a payload larger than the 0x8000 chunk size correctly', async () => {
    // Two-and-a-bit chunks: proves the loop concatenates rather than truncating,
    // and that String.fromCharCode is never handed an over-long argument list.
    const len = 0x8000 * 2 + 123;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) bytes[i] = i % 256;

    const encoded = await blobToBase64(new Blob([bytes]));

    const decoded = atob(encoded);
    expect(decoded).toHaveLength(len);
    expect(decoded.charCodeAt(0)).toBe(0);
    expect(decoded.charCodeAt(0x8000)).toBe(0x8000 % 256);
    expect(decoded.charCodeAt(len - 1)).toBe((len - 1) % 256);
  });
});

// ── the swappable resize seam ─────────────────────────────────

describe('resize seam', () => {
  it('delegates to the injected implementation and resets to canvasResize', async () => {
    const calls: Array<[number, number]> = [];
    const stub: ResizeFn = async (input, maxEdge, quality) => {
      calls.push([maxEdge, quality]);
      return new Blob([await input.arrayBuffer()], { type: 'image/jpeg' });
    };

    __setImageOps({ resize: stub });
    const out = await resize(new Blob([new Uint8Array([1, 2, 3])]), 1024, 0.85);
    expect(calls).toEqual([[1024, 0.85]]);
    expect(await out.text()).toHaveLength(3);

    // Reset puts the canvas implementation back. jsdom has no createImageBitmap,
    // so calling it now fails rather than silently using the stub.
    __setImageOps({});
    expect(resize).not.toBe(canvasResize); // resize is the stable wrapper
    await expect(resize(new Blob([]), 100, 0.8)).rejects.toThrow();
  });

  it('is a SINGLE seam shared with services/photos.ts', async () => {
    // photos.ts re-exports this module's hook. If it ever grew its own `resize`
    // binding, swapping here would stop affecting photo resizing — which is
    // exactly what photos.test.ts relies on.
    expect(photosSetImageOps).toBe(__setImageOps);

    let used = false;
    photosSetImageOps({
      resize: async (input) => {
        used = true;
        return input;
      },
    });
    await resize(new Blob([new Uint8Array([9])]), 300, 0.85);
    expect(used).toBe(true);
  });
});
