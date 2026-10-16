/* db.js — stockage local (IndexedDB) : archers, séances, réglages. Tout reste sur l'appareil. */
const DB = (() => {
  'use strict';
  const NAME = 'archerie', VERSION = 2;
  let dbp = null;

  function open() {
    if (dbp) return dbp;
    dbp = new Promise((res, rej) => {
      const r = indexedDB.open(NAME, VERSION);
      r.onupgradeneeded = () => {
        const db = r.result;
        if (!db.objectStoreNames.contains('archers')) db.createObjectStore('archers', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('sessions')) db.createObjectStore('sessions', { keyPath: 'id' }).createIndex('archerId', 'archerId');
        if (!db.objectStoreNames.contains('settings')) db.createObjectStore('settings');
        // v2 : photos des volées (restent sur l'appareil, ne sont pas synchronisées)
        if (!db.objectStoreNames.contains('photos')) db.createObjectStore('photos', { keyPath: 'id' }).createIndex('sessionId', 'sessionId');
      };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    return dbp;
  }
  const req = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  async function store(name, mode = 'readonly') { return (await open()).transaction(name, mode).objectStore(name); }

  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));

  async function all(name, includeDeleted = false) {
    const rows = await req((await store(name)).getAll());
    return includeDeleted ? rows : rows.filter((r) => !r.deleted);
  }
  async function get(name, id) { return req((await store(name)).get(id)); }
  async function put(name, obj, { keepStamp = false } = {}) {
    if (!obj.id) obj.id = uid();
    if (!keepStamp) obj.updatedAt = Date.now();
    await req((await store(name, 'readwrite')).put(obj));
    return obj;
  }
  // suppression « douce » : l'enregistrement reste pour que la synchronisation propage l'effacement
  async function remove(name, id) {
    const o = await get(name, id);
    if (o) { o.deleted = true; await put(name, o); }
  }
  async function getSetting(key, def) { const v = await req((await store('settings')).get(key)); return v === undefined ? def : v; }
  async function setSetting(key, val) { return req((await store('settings', 'readwrite')).put(val, key)); }

  // fusion d'enregistrements venant d'ailleurs (import, Google Sheets) : le plus récent gagne
  async function mergeRecords(name, rows) {
    let n = 0;
    for (const r of rows) {
      if (!r || !r.id) continue;
      const cur = await get(name, r.id);
      if (!cur || (r.updatedAt || 0) > (cur.updatedAt || 0)) { await put(name, r, { keepStamp: true }); n++; }
    }
    return n;
  }

  // ---- photos : { id, sessionId, key ('03', '03b'…), side ('G'|'D'), name, blob, createdAt }
  // Elles sont indépendantes des volées : supprimer une volée ne supprime pas ses photos.
  async function photosOfSession(sessionId) {
    const rows = await req((await store('photos')).index('sessionId').getAll(sessionId));
    return rows.sort((a, b) => a.key.localeCompare(b.key) || a.side.localeCompare(b.side));
  }
  async function putPhoto(p) { await req((await store('photos', 'readwrite')).put(p)); return p; }
  async function deletePhoto(id) { return req((await store('photos', 'readwrite')).delete(id)); }
  async function allPhotosMeta() { // sans charger les images en mémoire inutilement : on ne garde que les tailles
    const rows = await req((await store('photos')).getAll());
    return rows.map((p) => ({ id: p.id, sessionId: p.sessionId, size: p.blob?.size || 0 }));
  }

  return { all, get, put, remove, getSetting, setSetting, mergeRecords, uid, photosOfSession, putPhoto, deletePhoto, allPhotosMeta };
})();
