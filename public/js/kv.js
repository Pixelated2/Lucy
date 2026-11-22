// Tiny key/value store on IndexedDB, falling back to memory when unavailable.
const DB_NAME = 'lucy-locates';
const STORE = 'kv';
let dbp = null;
const memory = new Map();

function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch { resolve(null); }
  });
  return dbp;
}

export async function get(key) {
  const db = await open();
  if (!db) return memory.get(key);
  return new Promise((resolve) => {
    try {
      const req = db.transaction(STORE).objectStore(STORE).get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(memory.get(key));
    } catch { resolve(memory.get(key)); }
  });
}

export async function set(key, value) {
  memory.set(key, value);
  const db = await open();
  if (!db) return;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    } catch { resolve(); }
  });
}
