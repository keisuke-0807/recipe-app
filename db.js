'use strict';
// IndexedDB の薄いラッパー。レシピは端末内（ブラウザ内）にだけ保存される。
const DB = (() => {
  const NAME = 'recipe-book';
  const VERSION = 1;
  const STORE = 'recipes';
  let dbPromise;

  function open() {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(NAME, VERSION);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }
    return dbPromise;
  }

  const wrap = req => new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

  async function store(mode) {
    const db = await open();
    return db.transaction(STORE, mode).objectStore(STORE);
  }

  return {
    all: async () => wrap((await store('readonly')).getAll()),
    get: async id => wrap((await store('readonly')).get(id)),
    put: async rec => wrap((await store('readwrite')).put(rec)),
    del: async id => wrap((await store('readwrite')).delete(id)),
  };
})();
