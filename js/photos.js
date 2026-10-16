/* photos.js — photos des volées conservées sur l'appareil.
 * Nom : date-distance-numéro de volée-G|D, par ex. 2026-10-15-18m-03-G.jpg
 * Une paire (G + D) est identifiée dans la séance par sa clé : le numéro de volée sur 2 chiffres,
 * suivi d'une lettre si ce numéro a déjà des photos (03b, 03c…), pour ne jamais écraser une photo.
 */
const Photos = (() => {
  'use strict';
  const MAX_SIDE = 2400, QUALITY = 0.88; // ≈ 0,5 à 1 Mo par photo, largement assez pour l'analyse (1000 px)

  const pad = (n) => String(n).padStart(2, '0');
  const fileName = (s, key, side) => `${s.date}-${s.distance}m-${key}-${side}.jpg`;

  // réduit la photo (le téléphone produit 5 à 6 Mo par photo) en conservant l'orientation
  async function compress(file) {
    const img = await Vision.loadImage(file);
    const w = img.naturalWidth, h = img.naturalHeight, k = Math.min(1, MAX_SIDE / Math.max(w, h));
    if (k === 1 && file.type === 'image/jpeg' && file.size < 1.5e6) return file;
    const c = document.createElement('canvas');
    c.width = Math.round(w * k); c.height = Math.round(h * k);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return new Promise((res) => c.toBlob((b) => res(b || file), 'image/jpeg', QUALITY));
  }

  // paires de la séance : [{ key, num, G, D }]
  async function pairs(sessionId) {
    const map = new Map();
    for (const p of await DB.photosOfSession(sessionId)) {
      if (!map.has(p.key)) map.set(p.key, { key: p.key, num: parseInt(p.key, 10), createdAt: p.createdAt });
      map.get(p.key)[p.side] = p;
    }
    return [...map.values()].sort((a, b) => a.key.localeCompare(b.key));
  }

  // enregistre la paire de la volée n° num ; blobs = [gauche, droite] (l'une peut manquer)
  async function savePair(session, num, blobs) {
    const existing = new Set((await pairs(session.id)).map((p) => p.key));
    let key = pad(num), i = 0;
    while (existing.has(key)) key = pad(num) + 'bcdefghijklmnopqrstuvwxyz'[i++];
    const saved = [];
    for (const [i2, side] of [[0, 'G'], [1, 'D']]) {
      if (!blobs[i2]) continue;
      const blob = await compress(blobs[i2]);
      saved.push(await DB.putPhoto({ id: `${session.id}:${key}:${side}`, sessionId: session.id, key, side, name: fileName(session, key, side), blob, createdAt: Date.now() }));
    }
    return { key, saved };
  }

  async function deletePair(sessionId, key) {
    for (const side of ['G', 'D']) await DB.deletePhoto(`${sessionId}:${key}:${side}`);
  }
  async function deleteSession(sessionId) {
    for (const p of await DB.photosOfSession(sessionId)) await DB.deletePhoto(p.id);
  }

  // copie dans le téléphone (dossier Téléchargements) sous le nom de la photo
  function download(photo) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(photo.blob);
    a.download = photo.name;
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  }
  async function downloadAll(list) {
    for (const p of list) { download(p); await new Promise((r) => setTimeout(r, 400)); }
  }
  // partage (iPhone : « Enregistrer l'image » les met dans Photos)
  const canShare = (list) => {
    try { return !!(navigator.canShare && navigator.canShare({ files: list.map((p) => new File([p.blob], p.name, { type: 'image/jpeg' })) })); } catch { return false; }
  };
  async function share(list) {
    const files = list.map((p) => new File([p.blob], p.name, { type: 'image/jpeg' }));
    await navigator.share({ files, title: list.map((p) => p.name).join(', ') });
  }

  // demande au navigateur de ne pas effacer les données de l'application en cas de manque de place
  async function persist() {
    try { return navigator.storage && navigator.storage.persist ? await navigator.storage.persist() : false; } catch { return false; }
  }
  const fmtSize = (b) => (b > 1e9 ? (b / 1e9).toFixed(1) + ' Go' : b > 1e6 ? Math.round(b / 1e6) + ' Mo' : Math.round(b / 1e3) + ' Ko');

  return { pairs, savePair, deletePair, deleteSession, download, downloadAll, canShare, share, persist, fileName, fmtSize, pad };
})();
