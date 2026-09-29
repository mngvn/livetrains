/**
 * The smallest useful wrapper around IndexedDB.
 *
 * Two stores: `observations`, the reliability history, which can grow to
 * thousands of rows and wants an index; and `kv`, a handful of larger blobs
 * (the last-known vehicle positions, for offline). Both are best-effort. A
 * browser that refuses storage — some private modes do — gets `null` from
 * `openDb` and every caller carries on without history rather than failing.
 */

const DB_NAME = 'livetrains';
const DB_VERSION = 1;

export const OBSERVATIONS = 'observations';
export const KV = 'kv';

let opening: Promise<IDBDatabase | null> | null = null;

export function openDb(): Promise<IDBDatabase | null> {
  if (opening) return opening;
  opening = new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') {
      resolve(null);
      return;
    }
    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      resolve(null);
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(OBSERVATIONS)) {
        const store = db.createObjectStore(OBSERVATIONS, { keyPath: 'id' });
        store.createIndex('key', 'key');
        store.createIndex('at', 'at');
      }
      if (!db.objectStoreNames.contains(KV)) db.createObjectStore(KV);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });
  return opening;
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

function result<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** Writes rows, replacing any with the same key. */
export async function putAll<T>(storeName: string, rows: T[]): Promise<void> {
  if (rows.length === 0) return;
  const db = await openDb();
  if (!db) return;
  const tx = db.transaction(storeName, 'readwrite');
  const store = tx.objectStore(storeName);
  for (const row of rows) store.put(row);
  await done(tx);
}

/** Every row whose index matches one of the given values. */
export async function getByIndex<T>(storeName: string, index: string, values: string[]): Promise<T[]> {
  const db = await openDb();
  if (!db || values.length === 0) return [];
  const tx = db.transaction(storeName, 'readonly');
  const source = tx.objectStore(storeName).index(index);
  const batches = await Promise.all(values.map((value) => result(source.getAll(value) as IDBRequest<T[]>)));
  return batches.flat();
}

/** Deletes rows whose index value is below a bound (e.g. older than a date). */
export async function deleteBelow(storeName: string, index: string, bound: number): Promise<void> {
  const db = await openDb();
  if (!db) return;
  const tx = db.transaction(storeName, 'readwrite');
  const request = tx.objectStore(storeName).index(index).openCursor(IDBKeyRange.upperBound(bound, true));
  request.onsuccess = () => {
    const cursor = request.result;
    if (!cursor) return;
    cursor.delete();
    cursor.continue();
  };
  await done(tx);
}

export async function kvGet<T>(key: string): Promise<T | undefined> {
  const db = await openDb();
  if (!db) return undefined;
  const tx = db.transaction(KV, 'readonly');
  return (await result(tx.objectStore(KV).get(key))) as T | undefined;
}

export async function kvSet(key: string, value: unknown): Promise<void> {
  const db = await openDb();
  if (!db) return;
  const tx = db.transaction(KV, 'readwrite');
  tx.objectStore(KV).put(value, key);
  await done(tx);
}
