// Tiny async key/value adapter over localStorage.
//
// Web port shim: the React Native code used AsyncStorage (a Promise-based API).
// Mirroring that surface here lets storage.ts and driveSync.ts port over
// near-verbatim while keeping their async signatures. Small JSON state only —
// binary blobs go to IndexedDB (see blobStore.ts).

export const kv = {
  async getItem(key: string): Promise<string | null> {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  async setItem(key: string, value: string): Promise<void> {
    localStorage.setItem(key, value);
  },
  async removeItem(key: string): Promise<void> {
    localStorage.removeItem(key);
  },
  async clear(): Promise<void> {
    localStorage.clear();
  },
};
