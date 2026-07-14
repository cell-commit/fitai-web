// IndexedDB blob store (design: web pivot §Storage).
//
// Small JSON app state lives in localStorage (see storage.ts). Binary blobs —
// progress photos and imported health files — are far too large for
// localStorage's ~5MB string quota, so they live here in IndexedDB via `idb`.
// Used by later WPs (progress photos in W5, health import in W6); the store is
// scaffolded now so those WPs can build on a stable interface.

import { openDB, type IDBPDatabase } from 'idb';

const DB_NAME = 'fitai-blobs';
const DB_VERSION = 1;
const STORE = 'blobs';

let dbPromise: Promise<IDBPDatabase> | null = null;

function getDb(): Promise<IDBPDatabase> {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE);
        }
      },
    });
  }
  return dbPromise;
}

/** Store a blob under `key`, overwriting any existing entry. */
export async function put(key: string, blob: Blob): Promise<void> {
  const db = await getDb();
  await db.put(STORE, blob, key);
}

/** Retrieve a blob by key, or null if absent. */
export async function get(key: string): Promise<Blob | null> {
  const db = await getDb();
  const value = (await db.get(STORE, key)) as Blob | undefined;
  return value ?? null;
}

/** Delete a blob by key (no-op if absent). */
export async function del(key: string): Promise<void> {
  const db = await getDb();
  await db.delete(STORE, key);
}

/** List all stored blob keys. */
export async function list(): Promise<string[]> {
  const db = await getDb();
  const keys = await db.getAllKeys(STORE);
  return keys.map((k) => String(k));
}
