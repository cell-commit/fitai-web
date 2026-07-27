import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { acquireWakeLock, isWakeLockSupported } from '../wakeLock';

interface FakeSentinel {
  release: ReturnType<typeof vi.fn>;
  addEventListener: (type: 'release', cb: () => void) => void;
  fireRelease: () => void;
}

function fakeSentinel(): FakeSentinel {
  const listeners: Array<() => void> = [];
  return {
    release: vi.fn(async () => {}),
    addEventListener: (_type, cb) => listeners.push(cb),
    fireRelease: () => listeners.forEach((cb) => cb()),
  };
}

/** Install a fake navigator.wakeLock; returns the request spy. */
function installWakeLock(
  impl: () => Promise<FakeSentinel>
): ReturnType<typeof vi.fn> {
  const request = vi.fn(impl);
  Object.defineProperty(navigator, 'wakeLock', {
    value: { request },
    configurable: true,
    writable: true,
  });
  return request;
}

function removeWakeLock() {
  Reflect.deleteProperty(navigator as unknown as Record<string, unknown>, 'wakeLock');
}

function goVisible() {
  document.dispatchEvent(new Event('visibilitychange'));
}

beforeEach(removeWakeLock);
afterEach(() => {
  removeWakeLock();
  vi.restoreAllMocks();
});

describe('wakeLock — unsupported browsers', () => {
  it('reports unsupported and no-ops silently', async () => {
    expect(isWakeLockSupported()).toBe(false);

    const lock = await acquireWakeLock();
    expect(lock.supported).toBe(false);
    expect(lock.granted).toBe(false);
    expect(lock.active).toBe(false);
    // Must not throw.
    await expect(lock.release()).resolves.toBeUndefined();
  });

  it('adds no visibilitychange listener when unsupported', async () => {
    const addSpy = vi.spyOn(document, 'addEventListener');
    await acquireWakeLock();
    expect(
      addSpy.mock.calls.filter(([type]) => type === 'visibilitychange')
    ).toHaveLength(0);
  });
});

describe('wakeLock — acquire / release', () => {
  it('requests a screen lock and releases the sentinel', async () => {
    const sentinel = fakeSentinel();
    const request = installWakeLock(async () => sentinel);

    expect(isWakeLockSupported()).toBe(true);

    const lock = await acquireWakeLock();
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith('screen');
    expect(lock.supported).toBe(true);
    expect(lock.granted).toBe(true);
    expect(lock.active).toBe(true);

    await lock.release();
    expect(sentinel.release).toHaveBeenCalledTimes(1);
    expect(lock.active).toBe(false);
  });

  it('survives a denied request without throwing', async () => {
    const request = installWakeLock(async () => {
      throw new Error('NotAllowedError');
    });

    const lock = await acquireWakeLock();
    expect(request).toHaveBeenCalledTimes(1);
    expect(lock.supported).toBe(true);
    // granted:false is what drives the "keeping the screen on helps" hint.
    expect(lock.granted).toBe(false);
    expect(lock.active).toBe(false);
    await expect(lock.release()).resolves.toBeUndefined();
  });

  it('release is idempotent', async () => {
    const sentinel = fakeSentinel();
    installWakeLock(async () => sentinel);
    const lock = await acquireWakeLock();
    await lock.release();
    await lock.release();
    expect(sentinel.release).toHaveBeenCalledTimes(1);
  });
});

describe('wakeLock — re-acquire on visibilitychange', () => {
  it('re-requests when the page becomes visible after the platform auto-released', async () => {
    const first = fakeSentinel();
    const second = fakeSentinel();
    const sentinels = [first, second];
    const request = installWakeLock(async () => sentinels.shift()!);

    const lock = await acquireWakeLock();
    expect(request).toHaveBeenCalledTimes(1);

    // iOS auto-releases the lock when the document hides.
    first.fireRelease();
    expect(lock.active).toBe(false);

    goVisible();
    await Promise.resolve();
    await Promise.resolve();

    expect(request).toHaveBeenCalledTimes(2);
    expect(lock.active).toBe(true);

    await lock.release();
    expect(second.release).toHaveBeenCalledTimes(1);
  });

  it('does not re-request while a sentinel is still held', async () => {
    const request = installWakeLock(async () => fakeSentinel());
    await acquireWakeLock();

    goVisible();
    await Promise.resolve();

    expect(request).toHaveBeenCalledTimes(1);
  });

  it('stops re-requesting after release', async () => {
    const sentinel = fakeSentinel();
    const request = installWakeLock(async () => sentinel);
    const lock = await acquireWakeLock();
    await lock.release();

    goVisible();
    await Promise.resolve();
    await Promise.resolve();

    expect(request).toHaveBeenCalledTimes(1);
    expect(lock.active).toBe(false);
  });

  it('does not re-request when the page becomes hidden', async () => {
    const sentinel = fakeSentinel();
    const request = installWakeLock(async () => sentinel);
    const lock = await acquireWakeLock();
    sentinel.fireRelease();

    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    goVisible();
    await Promise.resolve();

    expect(request).toHaveBeenCalledTimes(1);
    expect(lock.active).toBe(false);
  });
});
