'use strict';
// IndexedDB の薄いラッパー。データは端末内（ブラウザ内）にだけ保存される。
// v1: recipes / v2: shopping を追加（既存の recipes はそのまま残る）
const DB = (() => {
  const NAME = 'recipe-book';
  const VERSION = 2;
  const STORES = ['recipes', 'shopping'];
  let dbPromise;

  function open() {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(NAME, VERSION);
        req.onupgradeneeded = () => {
          const db = req.result;
          for (const s of STORES) {
            if (!db.objectStoreNames.contains(s)) db.createObjectStore(s, { keyPath: 'id' });
          }
        };
        req.onsuccess = () => {
          const db = req.result;
          // 新しいバージョンが別タブで開かれたら接続を閉じて更新を妨げない
          db.onversionchange = () => { db.close(); dbPromise = null; };
          resolve(db);
        };
        req.onerror = () => { dbPromise = null; reject(req.error); };
      });
    }
    return dbPromise;
  }

  const wrap = req => new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

  async function store(name, mode) {
    const db = await open();
    return db.transaction(name, mode).objectStore(name);
  }

  const make = name => ({
    all: async () => wrap((await store(name, 'readonly')).getAll()),
    get: async id => wrap((await store(name, 'readonly')).get(id)),
    put: async rec => wrap((await store(name, 'readwrite')).put(rec)),
    del: async id => wrap((await store(name, 'readwrite')).delete(id)),
  });

  return { ...make('recipes'), shopping: make('shopping') };
})();
