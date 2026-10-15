/* faces.js — blasons, calcul des points, dessin SVG de la cible.
 * Coordonnées d'une flèche : x, y en « unités d'anneau » depuis le centre du spot, y vers le haut.
 */
const Faces = (() => {
  'use strict';
  const LIST = [
    { id: '122', label: '122 cm', kind: 'full', diam: 122 },
    { id: '80', label: '80 cm', kind: 'full', diam: 80 },
    { id: '60', label: '60 cm', kind: 'full', diam: 60 },
    { id: '40', label: '40 cm', kind: 'full', diam: 40 },
    { id: 'tri40', label: 'Trispot 40 cm', kind: 'trispot', diam: 40 },
  ];
  const get = (id) => LIST.find((f) => f.id === id) || LIST[1];
  const ringWidthCm = (f) => f.diam / 20;
  const maxR = (f) => (f.kind === 'trispot' ? 5 : 10);
  const spots = (f) => (f.kind === 'trispot' ? 3 : 1);
  const SPOT_GAP = 11.5; // distance entre centres de spots (unités) pour l'affichage du trispot

  // Une flèche qui touche une ligne compte pour la zone supérieure : on retire le rayon du tube.
  function score(face, r, arrowDiamMm = 8) {
    const f = typeof face === 'string' ? get(face) : face;
    const rho = arrowDiamMm / 20 / ringWidthCm(f); // rayon du tube en unités
    const eff = r - rho;
    let s = eff <= 0 ? 10 : 11 - Math.ceil(eff);
    if (eff > maxR(f) || s < (f.kind === 'trispot' ? 6 : 1)) s = 0;
    s = Math.max(0, Math.min(10, s));
    // près d'une ligne (± 0,15 unité) : on signale le doute pour vérification
    const frac = eff - Math.floor(eff);
    const onLine = eff > 0 && (frac < 0.15 || frac > 0.85);
    return { s, onLine };
  }

  const ZONES = [ // [rayon extérieur, couleur, couleur des lignes]
    [10, '#f4f4f0', '#333'], [9, '#f4f4f0', '#333'], [8, '#2b2b2b', '#e8e8e8'], [7, '#2b2b2b', '#e8e8e8'],
    [6, '#33a7e0', '#1b1b1b'], [5, '#33a7e0', '#1b1b1b'], [4, '#ef4b3c', '#1b1b1b'], [3, '#ef4b3c', '#1b1b1b'],
    [2, '#f7d117', '#1b1b1b'], [1, '#f7d117', '#1b1b1b'],
  ];
  function spotSVG(face, cx, cy) {
    const zones = face.kind === 'trispot' ? ZONES.slice(5) : ZONES;
    let s = '';
    for (const [r, fill, line] of zones) s += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${fill}" stroke="${line}" stroke-width="0.04"/>`;
    s += `<circle cx="${cx}" cy="${cy}" r="0.5" fill="none" stroke="#1b1b1b" stroke-width="0.03"/>`;
    s += `<path d="M${cx - 0.15} ${cy}h0.3M${cx} ${cy - 0.15}v0.3" stroke="#1b1b1b" stroke-width="0.03"/>`;
    return s;
  }
  // centre d'affichage d'un spot (repère SVG : y vers le bas)
  function spotCenter(face, spot = 0) {
    if (face.kind !== 'trispot') return { x: 0, y: 0 };
    return { x: 0, y: (spot - 1) * SPOT_GAP };
  }
  function viewBox(face, pad = 0.6) {
    if (face.kind !== 'trispot') { const R = 10 + pad; return { x: -R, y: -R, w: 2 * R, h: 2 * R }; }
    const R = 5 + pad;
    return { x: -R, y: -SPOT_GAP - R, w: 2 * R, h: 2 * SPOT_GAP + 2 * R };
  }
  function targetSVG(face) {
    let s = '';
    for (let i = 0; i < spots(face); i++) { const c = spotCenter(face, i); s += spotSVG(face, c.x, c.y); }
    return s;
  }
  // coordonnées flèche ↔ SVG
  const toSVG = (face, a) => { const c = spotCenter(face, a.spot || 0); return { x: c.x + a.x, y: c.y - a.y }; };
  function fromSVG(face, X, Y) {
    let best = 0, bd = Infinity;
    for (let i = 0; i < spots(face); i++) { const c = spotCenter(face, i), d = Math.hypot(X - c.x, Y - c.y); if (d < bd) { bd = d; best = i; } }
    const c = spotCenter(face, best);
    return { spot: best, x: X - c.x, y: -(Y - c.y) };
  }
  const fmt = (s) => (s === 0 ? 'M' : String(s));
  const scoreClass = (s) => (s >= 9 ? 'z-gold' : s >= 7 ? 'z-red' : s >= 5 ? 'z-blue' : s >= 3 ? 'z-black' : s >= 1 ? 'z-white' : 'z-miss');

  return { LIST, get, ringWidthCm, maxR, spots, score, targetSVG, viewBox, toSVG, fromSVG, spotCenter, fmt, scoreClass };
})();
