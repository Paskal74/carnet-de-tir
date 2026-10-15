/*
 * vision.js — Détection automatique des flèches dans la cible (100 % local, aucune dépendance).
 *
 * Principe :
 *  1. Chaque pixel est classé par couleur (or, rouge, bleu, noir, blanc, bois).
 *  2. Les frontières entre zones de couleur (or/rouge, rouge/bleu, bleu/noir, noir/blanc) sont
 *     ajustées par des ellipses (RANSAC + ajustement direct de Halir-Flusser).
 *  3. Ces ellipses définissent une « famille » continue d'ellipses paramétrée par le rayon en
 *     unités d'anneau : cela corrige la perspective (centres qui se décalent, écrasement latéral).
 *  4. Les tubes en bois sont détectés comme des segments de droite (RANSAC séquentiel) ; la pointe
 *     est l'extrémité du tube opposée au bord de la photo (le tube sort du cadre côté archer).
 *  5. Les pointes des deux photos (gauche / droite) sont ramenées dans un repère « de face »,
 *     puis appariées : une flèche masquée sur une photo est retrouvée sur l'autre.
 *
 * Unité de distance : 1 unité = largeur d'un anneau (6,1 cm sur 122, 4 cm sur 80, 3 cm sur 60, 2 cm sur 40).
 */
const Vision = (() => {
  'use strict';

  const NONE = 0, GOLD = 1, RED = 2, BLUE = 3, BLACK = 4, WHITE = 5, WOOD = 6, WOOD2 = 7;
  const MAX_SIDE = 1000;

  // Frontières de couleur utilisées pour la géométrie : [classe intérieure, classe extérieure, rayon en unités]
  const FACE_GEOMETRY = {
    full: { spots: 1, maxR: 10, minScore: 1, bounds: [[GOLD, RED, 2], [RED, BLUE, 4], [BLUE, BLACK, 6], [BLACK, WHITE, 8]] },
    trispot: { spots: 3, maxR: 5, minScore: 6, bounds: [[GOLD, RED, 2], [RED, BLUE, 4], [BLUE, WHITE, 5]] },
  };

  // ---------------------------------------------------------------- couleurs
  function classify(r, g, b, p) {
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const v = max / 255, d = max - min, s = max ? d / max : 0;
    if (v < p.blackV) return BLACK;
    if (s < 0.2 && v > 0.55) return WHITE;
    if (s < 0.35) return NONE;
    let h;
    if (max === r) h = 60 * (((g - b) / d) % 6);
    else if (max === g) h = 60 * ((b - r) / d + 2);
    else h = 60 * ((r - g) / d + 4);
    if (h < 0) h += 360;
    if (h >= p.goldH && h < 72 && v > 0.5) return s > p.goldS ? GOLD : NONE;
    if (h >= p.woodH0 && h < p.woodH1 && v > 0.22 && v < 0.97 && s > p.woodS) return WOOD;
    // bois foncé et verni : brun-rouge, mais bien plus sombre que le rouge du blason (≈ 5°, très lumineux)
    if (h >= 11 && h < p.woodH0 && v < 0.55 && v > 0.18 && s > p.darkWoodS) return WOOD;
    // bois clair / ocre (et paille) : utilisé seulement sur la surface du blason
    if (h >= p.woodH0 && h < 48 && s > p.wood2S && v > 0.3 && v < 0.97) return WOOD2;
    if (h < p.woodH0 || h >= 330) return v > 0.35 ? RED : NONE;
    if (h >= 175 && h < 235) return BLUE;
    return NONE;
  }

  function loadImage(src) {
    return new Promise((res, rej) => {
      const img = new Image();
      img.onload = () => res(img);
      img.onerror = () => rej(new Error('Image illisible'));
      img.src = typeof src === 'string' ? src : URL.createObjectURL(src);
    });
  }

  function toPixels(img) {
    const sc = Math.min(1, MAX_SIDE / Math.max(img.naturalWidth || img.width, img.naturalHeight || img.height));
    const W = Math.round((img.naturalWidth || img.width) * sc), H = Math.round((img.naturalHeight || img.height) * sc);
    const cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, W, H);
    return { W, H, data: ctx.getImageData(0, 0, W, H).data, canvas: cv };
  }

  function classMap(px, params) {
    const { W, H, data } = px, cls = new Uint8Array(W * H);
    for (let i = 0, j = 0; i < cls.length; i++, j += 4) cls[i] = classify(data[j], data[j + 1], data[j + 2], params);
    return cls;
  }

  // ---------------------------------------------------------------- morphologie
  function erode(mask, W, H, r) {
    const out = new Uint8Array(mask.length), tmp = new Uint8Array(mask.length);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      let ok = 1;
      for (let k = -r; k <= r && ok; k++) { const xx = x + k; if (xx < 0 || xx >= W || !mask[y * W + xx]) ok = 0; }
      tmp[y * W + x] = ok;
    }
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      let ok = 1;
      for (let k = -r; k <= r && ok; k++) { const yy = y + k; if (yy < 0 || yy >= H || !tmp[yy * W + x]) ok = 0; }
      out[y * W + x] = ok;
    }
    return out;
  }
  function dilate(mask, W, H, r) {
    const out = new Uint8Array(mask.length), tmp = new Uint8Array(mask.length);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      let ok = 0;
      for (let k = -r; k <= r && !ok; k++) { const xx = x + k; if (xx >= 0 && xx < W && mask[y * W + xx]) ok = 1; }
      tmp[y * W + x] = ok;
    }
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      let ok = 0;
      for (let k = -r; k <= r && !ok; k++) { const yy = y + k; if (yy >= 0 && yy < H && tmp[yy * W + x]) ok = 1; }
      out[y * W + x] = ok;
    }
    return out;
  }

  function components(mask, W, H, minArea) {
    const lab = new Int32Array(W * H), comps = [];
    const stack = new Int32Array(W * H);
    let n = 0;
    for (let i = 0; i < mask.length; i++) {
      if (!mask[i] || lab[i]) continue;
      n++; let sp = 0; stack[sp++] = i; lab[i] = n;
      const pts = [];
      while (sp) {
        const p = stack[--sp]; pts.push(p);
        const x = p % W, y = (p / W) | 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx, yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
          const q = yy * W + xx;
          if (mask[q] && !lab[q]) { lab[q] = n; stack[sp++] = q; }
        }
      }
      if (pts.length >= minArea) comps.push(pts);
    }
    return comps;
  }

  // ---------------------------------------------------------------- algèbre
  function solve(A, b) { // Gauss avec pivot partiel ; A n×n
    const n = b.length, M = A.map((row, i) => [...row, b[i]]);
    for (let c = 0; c < n; c++) {
      let piv = c;
      for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
      if (Math.abs(M[piv][c]) < 1e-12) return null;
      [M[c], M[piv]] = [M[piv], M[c]];
      for (let r = 0; r < n; r++) if (r !== c) {
        const f = M[r][c] / M[c][c];
        for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
      }
    }
    return M.map((row, i) => row[n] / row[i]);
  }
  function inv3(m) {
    const [a, b, c] = m[0], [d, e, f] = m[1], [g, h, i] = m[2];
    const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
    const det = a * A + b * B + c * C;
    if (Math.abs(det) < 1e-18) return null;
    return [[A / det, -(b * i - c * h) / det, (b * f - c * e) / det],
            [B / det, (a * i - c * g) / det, -(a * f - c * d) / det],
            [C / det, -(a * h - b * g) / det, (a * e - b * d) / det]];
  }
  const mul3 = (A, B) => A.map((r) => [0, 1, 2].map((j) => r[0] * B[0][j] + r[1] * B[1][j] + r[2] * B[2][j]));
  const tr3 = (A) => [0, 1, 2].map((i) => [A[0][i], A[1][i], A[2][i]]);

  function realEigen3(M) { // valeurs propres réelles d'une matrice 3×3 + vecteurs propres
    const a = -(M[0][0] + M[1][1] + M[2][2]);
    const b = M[0][0] * M[1][1] - M[0][1] * M[1][0] + M[0][0] * M[2][2] - M[0][2] * M[2][0] + M[1][1] * M[2][2] - M[1][2] * M[2][1];
    const c = -(M[0][0] * (M[1][1] * M[2][2] - M[1][2] * M[2][1]) - M[0][1] * (M[1][0] * M[2][2] - M[1][2] * M[2][0]) + M[0][2] * (M[1][0] * M[2][1] - M[1][1] * M[2][0]));
    // λ³ + aλ² + bλ + c = 0
    const Q = (a * a - 3 * b) / 9, R = (2 * a * a * a - 9 * a * b + 27 * c) / 54;
    let roots;
    if (R * R < Q * Q * Q) {
      const th = Math.acos(R / Math.sqrt(Q * Q * Q)), sq = -2 * Math.sqrt(Q);
      roots = [sq * Math.cos(th / 3) - a / 3, sq * Math.cos((th + 2 * Math.PI) / 3) - a / 3, sq * Math.cos((th - 2 * Math.PI) / 3) - a / 3];
    } else {
      const A = -Math.sign(R) * Math.cbrt(Math.abs(R) + Math.sqrt(R * R - Q * Q * Q)), B = A ? Q / A : 0;
      roots = [A + B - a / 3];
    }
    return roots.map((l) => {
      const r = [0, 1, 2].map((i) => [0, 1, 2].map((j) => M[i][j] - (i === j ? l : 0)));
      const cr = (u, v) => [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
      const cands = [cr(r[0], r[1]), cr(r[0], r[2]), cr(r[1], r[2])];
      let best = cands[0], bn = 0;
      for (const v of cands) { const n = Math.hypot(...v); if (n > bn) { bn = n; best = v; } }
      return { value: l, vector: bn ? best.map((x) => x / bn) : [0, 0, 0] };
    });
  }

  // ---------------------------------------------------------------- ellipses
  // Conique : A x² + B xy + C y² + D x + E y + F = 0
  function fitEllipseDirect(pts) { // Halir & Flusser (1998), coordonnées normalisées
    const n = pts.length;
    if (n < 6) return null;
    let mx = 0, my = 0;
    for (const p of pts) { mx += p[0]; my += p[1]; }
    mx /= n; my /= n;
    let sc = 0;
    for (const p of pts) sc += Math.hypot(p[0] - mx, p[1] - my);
    sc = sc / n || 1;
    const S1 = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], S2 = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], S3 = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    for (const p of pts) {
      const x = (p[0] - mx) / sc, y = (p[1] - my) / sc;
      const d1 = [x * x, x * y, y * y], d2 = [x, y, 1];
      for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
        S1[i][j] += d1[i] * d1[j]; S2[i][j] += d1[i] * d2[j]; S3[i][j] += d2[i] * d2[j];
      }
    }
    const S3i = inv3(S3);
    if (!S3i) return null;
    const T = mul3(S3i, tr3(S2)).map((r) => r.map((v) => -v));
    const Mr = mul3(S2, T).map((r, i) => r.map((v, j) => v + S1[i][j]));
    const M = [Mr[2].map((v) => v / 2), Mr[1].map((v) => -v), Mr[0].map((v) => v / 2)];
    let a1 = null;
    for (const { vector: v } of realEigen3(M)) if (4 * v[0] * v[2] - v[1] * v[1] > 0) { a1 = v; break; }
    if (!a1) return null;
    const a2 = [0, 1, 2].map((i) => T[i][0] * a1[0] + T[i][1] * a1[1] + T[i][2] * a1[2]);
    return denormConic([...a1, ...a2], mx, my, sc);
  }
  function denormConic(c, mx, my, sc) { // conique exprimée en (x-mx)/sc → coordonnées image
    const [a, b, cc, d, e, f] = c, s2 = sc * sc;
    const A = a / s2, B = b / s2, C = cc / s2, D = d / sc, E = e / sc;
    return [A, B, C,
      D - 2 * A * mx - B * my,
      E - 2 * C * my - B * mx,
      A * mx * mx + B * mx * my + C * my * my - D * mx - E * my + f];
  }
  function conicThrough5(P) {
    const A = P.map(([x, y]) => [x * x, x * y, y * y, x, y]);
    const s = solve(A, [-1, -1, -1, -1, -1]);
    return s ? [...s, 1] : null;
  }
  function sampson(c, x, y) {
    const [A, B, C, D, E, F] = c;
    const v = A * x * x + B * x * y + C * y * y + D * x + E * y + F;
    const gx = 2 * A * x + B * y + D, gy = B * x + 2 * C * y + E;
    return Math.abs(v) / (Math.hypot(gx, gy) || 1e-12);
  }
  function conicToEllipse(c) {
    const [A, B, C, D, E, F] = c, den = B * B - 4 * A * C;
    if (den >= 0) return null;
    const cx = (2 * C * D - B * E) / den, cy = (2 * A * E - B * D) / den;
    // forme quadratique centrée : (p-c)ᵀ Q (p-c) = k
    const k = -(A * cx * cx + B * cx * cy + C * cy * cy + D * cx + E * cy + F);
    if (!(k > 0) && !(k < 0)) return null;
    let q = [A / k, B / 2 / k, C / k];
    if (q[0] < 0) return null;
    const det = q[0] * q[2] - q[1] * q[1];
    if (det <= 0) return null;
    const tr = q[0] + q[2], dl = Math.sqrt(Math.max(0, tr * tr / 4 - det));
    const l1 = tr / 2 - dl, l2 = tr / 2 + dl; // l1 = plus petit → demi-grand axe
    return { cx, cy, q, a: 1 / Math.sqrt(l1), b: 1 / Math.sqrt(l2) };
  }
  // distance normalisée d'un point à l'ellipse (1 = sur l'ellipse)
  const ellRho = (e, x, y) => { const dx = x - e.cx, dy = y - e.cy; return Math.sqrt(e.q[0] * dx * dx + 2 * e.q[1] * dx * dy + e.q[2] * dy * dy); };

  function robustEllipse(pts, tolPx, iters = 500) {
    if (pts.length < 20) return null;
    const sub = pts.length > 2500 ? sample(pts, 2500) : pts;
    let best = null, bestN = 0;
    for (let it = 0; it < iters; it++) {
      const P = sample(sub, 5);
      const c = conicThrough5(P);
      if (!c || c[1] * c[1] - 4 * c[0] * c[2] >= 0) continue;
      let n = 0;
      for (const p of sub) if (sampson(c, p[0], p[1]) < tolPx) n++;
      if (n > bestN) { bestN = n; best = c; }
    }
    if (!best || bestN < 15) return null;
    let conic = best, inl = null;
    for (let k = 0; k < 3; k++) {
      inl = pts.filter((p) => sampson(conic, p[0], p[1]) < tolPx * (k ? 1 : 1.5));
      const c2 = fitEllipseDirect(inl);
      if (!c2) break;
      conic = c2;
    }
    const e = conicToEllipse(conic);
    if (e) { e.support = inl.length; e.total = pts.length; }
    return e;
  }
  function median(xs) { const s = xs.slice().sort((a, b) => a - b); return s[s.length >> 1] || 0; }
  function linFit(xs, ys) {
    const n = xs.length, mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
    let sxy = 0, sxx = 0;
    for (let i = 0; i < n; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; }
    const k = sxx ? sxy / sxx : 0;
    return [my - k * mx, k];
  }
  // générateur pseudo-aléatoire à graine fixe : deux analyses des mêmes photos donnent le même résultat
  let seed = 1;
  const rand = () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  function sample(arr, k) {
    const out = [];
    for (let i = 0; i < k; i++) out.push(arr[(rand() * arr.length) | 0]);
    return out;
  }

  function momentEllipse(pts) { // ellipse « pleine » à partir des moments d'un nuage de pixels
    let mx = 0, my = 0;
    for (const p of pts) { mx += p[0]; my += p[1]; }
    mx /= pts.length; my /= pts.length;
    let sxx = 0, sxy = 0, syy = 0;
    for (const p of pts) { const dx = p[0] - mx, dy = p[1] - my; sxx += dx * dx; sxy += dx * dy; syy += dy * dy; }
    sxx /= pts.length; sxy /= pts.length; syy /= pts.length;
    // ellipse pleine : cov = Σ/4 → Q = (4 cov)⁻¹
    const det = 16 * (sxx * syy - sxy * sxy);
    if (det <= 0) return null;
    return { cx: mx, cy: my, q: [4 * syy / det, -4 * sxy / det, 4 * sxx / det] };
  }

  // ---------------------------------------------------------------- famille d'ellipses (perspective)
  // Pour chaque frontière ajustée on connaît le rayon r (unités). On interpole linéairement en r :
  // centre c(r) et forme normalisée Ŝ(r) = r²·Q(r). Un point P est sur l'ellipse de rayon r si
  // sqrt((P-c(r))ᵀ Ŝ(r) (P-c(r))) = r.
  function buildFamily(ells) {
    const fitLin = (xs, ys) => {
      if (xs.length === 1) return [ys[0], 0];
      const n = xs.length, mx = xs.reduce((a, b) => a + b) / n, my = ys.reduce((a, b) => a + b) / n;
      let sxy = 0, sxx = 0;
      for (let i = 0; i < n; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; }
      const k = sxx ? sxy / sxx : 0;
      return [my - k * mx, k];
    };
    const rs = ells.map((e) => e.r);
    const f = {
      cx: fitLin(rs, ells.map((e) => e.cx)), cy: fitLin(rs, ells.map((e) => e.cy)),
      s0: fitLin(rs, ells.map((e) => e.q[0] * e.r * e.r)),
      s1: fitLin(rs, ells.map((e) => e.q[1] * e.r * e.r)),
      s2: fitLin(rs, ells.map((e) => e.q[2] * e.r * e.r)),
    };
    // l'extrapolation d'une forme n'est sûre que près des rayons mesurés : on borne r
    const rMin = Math.min(...rs), rMax = Math.max(...rs);
    const at = (r) => {
      const rr = Math.min(Math.max(r, rMin * 0.5), rMax * 1.6);
      const ev = (p) => p[0] + p[1] * rr;
      // le centre suit r sans borne inférieure (le centre réel est en r = 0)
      return { cx: f.cx[0] + f.cx[1] * Math.min(r, rMax * 1.6), cy: f.cy[0] + f.cy[1] * Math.min(r, rMax * 1.6), s: [ev(f.s0), ev(f.s1), ev(f.s2)] };
    };
    const rhoAt = (x, y, r) => {
      const e = at(r), dx = x - e.cx, dy = y - e.cy;
      return Math.sqrt(Math.max(0, e.s[0] * dx * dx + 2 * e.s[1] * dx * dy + e.s[2] * dy * dy));
    };
    return {
      ells, at,
      // point image → rayon (unités) et coordonnées « de face » (unités, y vers le haut)
      toTarget(x, y) {
        let lo = 0, hi = 30;
        if (rhoAt(x, y, hi) > hi) return { r: hi, u: 0, v: 0 };
        for (let i = 0; i < 40; i++) { const m = (lo + hi) / 2; if (rhoAt(x, y, m) > m) lo = m; else hi = m; }
        const r = (lo + hi) / 2, e = at(r), dx = x - e.cx, dy = y - e.cy;
        // racine carrée symétrique de Ŝ : conserve l'orientation (le haut de la photo reste en haut)
        const [a, b, c] = e.s, sd = Math.sqrt(Math.max(1e-12, a * c - b * b)), t = Math.sqrt(a + c + 2 * sd);
        const u = ((a + sd) * dx + b * dy) / t, v = (b * dx + (c + sd) * dy) / t;
        return { r, u, v: -v };
      },
      // coordonnées de face → point image (pour l'affichage)
      toImage(u, v) {
        const r = Math.hypot(u, v), e = at(r);
        const [a, b, c] = e.s, sd = Math.sqrt(Math.max(1e-12, a * c - b * b)), t = Math.sqrt(a + c + 2 * sd);
        const m = [(a + sd) / t, b / t, (c + sd) / t], det = m[0] * m[2] - m[1] * m[1];
        const vv = -v;
        return { x: e.cx + (m[2] * u - m[1] * vv) / det, y: e.cy + (-m[1] * u + m[0] * vv) / det };
      },
    };
  }

  // ---------------------------------------------------------------- cible
  // Point de frontière « franche » : côté A plein sur plusieurs pixels, côté B plein aussi.
  // Les trous (petites taches sombres) et les tubes ne produisent donc presque pas de faux points.
  function boundaryPoints(cls, W, H, A, B, depth) {
    const pts = [], D = depth;
    const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]];
    const at = (x, y) => (x < 0 || y < 0 || x >= W || y >= H ? -1 : cls[y * W + x]);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      if (cls[y * W + x] !== A) continue;
      for (const [dx, dy] of dirs) {
        let k = 1;
        while (k <= 3 && at(x + dx * k, y + dy * k) !== B) k++;
        if (k > 3) continue;
        let ok = true;
        for (let j = 1; j <= D && ok; j++) {
          if (at(x - dx * j, y - dy * j) !== A && at(x - dx * j, y - dy * j) !== WOOD) ok = j > D * 0.75 ? ok : false;
          if (at(x + dx * (k + j), y + dy * (k + j)) !== B) ok = j > D * 0.75 ? ok : false;
        }
        if (ok) { pts.push([x + 0.5 + dx * (k - 1) / 2, y + 0.5 + dy * (k - 1) / 2]); break; }
      }
    }
    return pts;
  }

  function kmeans(pts, k, iters = 15) {
    const sorted = [...pts].sort((a, b) => a[1] - b[1]);
    let C = [];
    for (let i = 0; i < k; i++) C.push(sorted[Math.floor(((i + 0.5) / k) * sorted.length)].slice());
    let lab = new Int32Array(pts.length);
    for (let it = 0; it < iters; it++) {
      const acc = C.map(() => [0, 0, 0]);
      pts.forEach((p, i) => {
        let bi = 0, bd = Infinity;
        C.forEach((c, j) => { const d = (p[0] - c[0]) ** 2 + (p[1] - c[1]) ** 2; if (d < bd) { bd = d; bi = j; } });
        lab[i] = bi; acc[bi][0] += p[0]; acc[bi][1] += p[1]; acc[bi][2]++;
      });
      C = acc.map((a, j) => (a[2] ? [a[0] / a[2], a[1] / a[2]] : C[j]));
    }
    return { centers: C, labels: lab };
  }

  function findTarget(cls, W, H, geom) {
    // 1) pixels or, débarrassés du bruit
    let gm = new Uint8Array(W * H);
    for (let i = 0; i < gm.length; i++) gm[i] = cls[i] === GOLD ? 1 : 0;
    gm = dilate(erode(gm, W, H, 2), W, H, 2);
    // La paille de la butte peut ressembler à l'or : le vrai centre est une tache jaune entourée de rouge.
    const rawComps = components(gm, W, H, (W * H) / 4000);
    const goldComps = rawComps.map((c) => {
      const pts = c.map((p) => [p % W, (p / W) | 0]);
      const mom = momentEllipse(pts);
      let red = 0, n = 0;
      if (mom) for (let k = 0; k < 96; k++) {
        const a = (k / 96) * 2 * Math.PI;
        // points sur l'ellipse des moments agrandie de 30 %
        const [q0, q1, q2] = mom.q, det = q0 * q2 - q1 * q1;
        const ux = Math.cos(a), uy = Math.sin(a);
        const rr = 1.3 / Math.sqrt((q0 * ux * ux + 2 * q1 * ux * uy + q2 * uy * uy) || 1e-9);
        const x = Math.round(mom.cx + ux * rr), y = Math.round(mom.cy + uy * rr);
        if (x < 0 || y < 0 || x >= W || y >= H || !(det > 0)) continue;
        n++; if (cls[y * W + x] === RED) red++;
      }
      return { c, pts, mom, redFrac: n ? red / n : 0 };
    }).filter((g) => g.mom && g.redFrac > 0.25);
    if (!goldComps.length) return null;
    goldComps.sort((a, b) => b.redFrac * Math.sqrt(b.c.length) - a.redFrac * Math.sqrt(a.c.length));
    let goldPts = [];
    if (geom.spots === 1) {
      // l'or est souvent coupé en morceaux par les tubes : à partir du morceau choisi, on agrège les
      // morceaux voisins (séparés au plus d'une largeur de tube) ; la paille, elle, est bien plus loin.
      const bbox = (c) => { let x0 = W, y0 = H, x1 = 0, y1 = 0; for (const p of c) { const x = p % W, y = (p / W) | 0; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; } return [x0, y0, x1, y1]; };
      const boxes = rawComps.map(bbox), gapMax = Math.max(W, H) * 0.05;
      const near = (a, b) => Math.max(a[0] - b[2], b[0] - a[2], a[1] - b[3], b[1] - a[3]) <= gapMax;
      const seed0 = rawComps.indexOf(goldComps[0].c), inC = new Set([seed0]);
      let grew = true;
      while (grew) {
        grew = false;
        rawComps.forEach((_, i) => { if (!inC.has(i) && [...inC].some((j) => near(boxes[i], boxes[j]))) { inC.add(i); grew = true; } });
      }
      for (const i of inC) for (const p of rawComps[i]) goldPts.push([p % W, (p / W) | 0]);
    } else for (const g of goldComps) goldPts.push(...g.pts);
    const km = geom.spots === 1 ? { centers: [null], labels: new Int32Array(goldPts.length) } : kmeans(goldPts, geom.spots);
    const spots = [];
    for (let s = 0; s < geom.spots; s++) {
      const mine = goldPts.filter((_, i) => km.labels[i] === s);
      if (mine.length < 30) continue;
      const mom = momentEllipse(mine);
      if (mom) spots.push({ mom });
    }
    if (!spots.length) return null;
    spots.sort((a, b) => a.mom.cy - b.mom.cy);

    const tol = Math.max(1.5, Math.max(W, H) / 500);
    for (const sp of spots) sp.ells = [];
    for (const [A, B, r] of geom.bounds) {
      const pts = boundaryPoints(cls, W, H, A, B, Math.max(4, Math.round(Math.max(W, H) / 120)));
      for (const sp of spots) {
        const ref = sp.ells[0] || { ...sp.mom, r: 2 };
        const expect = r / ref.r;
        const mine = pts.filter((p) => {
          const rho = ellRho(ref, p[0], p[1]);
          if (rho < expect * 0.72 || rho > expect * 1.35) return false;
          if (spots.length > 1) for (const o of spots) if (o !== sp && ellRho(o.ells[0] || o.mom, p[0], p[1]) < rho) return false;
          return true;
        });
        const e = robustEllipse(mine, tol);
        if (!e) continue;
        // contrôle de cohérence : taille attendue par rapport à la référence, couverture suffisante
        const mean = Math.sqrt(e.a * e.b), refMean = 1 / Math.sqrt(Math.sqrt(ref.q[0] * ref.q[2] - ref.q[1] * ref.q[1]));
        const ratio = mean / refMean / expect;
        const perim = 2 * Math.PI * mean;
        if (ratio < 0.8 || ratio > 1.25 || e.support < perim * 0.25) continue;
        e.r = r;
        sp.ells.push(e);
      }
      for (const sp of spots) if (!sp.ells.length) { // l'ellipse or/rouge est indispensable : repli sur les moments
        sp.ells.push({ ...sp.mom, r: 2, fallback: true });
      }
    }
    for (const sp of spots) sp.family = buildFamily(sp.ells);
    return spots;
  }

  // ---------------------------------------------------------------- tubes
  function findShafts(cls, W, H, ctx) {
    const p = ctx.params;
    // On ne cherche les tubes que sur le blason : autour, la paille a la même couleur que le bois clair.
    let wm = new Uint8Array(W * H);
    for (let i = 0; i < wm.length; i++) wm[i] = ctx.inFace[i] && (cls[i] === WOOD || cls[i] === WOOD2) ? 1 : 0;
    // ouverture légère : de loin, un tube près de la cible ne fait que quelques pixels de large
    wm = dilate(erode(wm, W, H, 1), W, H, 1);
    const minArea = (W * H) / 5000, minLen = Math.max(W, H) * 0.035;
    const shafts = [];
    for (const comp of components(wm, W, H, minArea)) {
      let pts = comp.map((p) => [p % W, (p / W) | 0]);
      for (let guard = 0; guard < 8 && pts.length >= minArea * 0.6; guard++) {
        const seg = bestLine(pts, wm, W, H, minLen);
        if (!seg) break;
        shafts.push(seg);
        const rest = [];
        for (const p of pts) {
          const t = (p[0] - seg.x0) * seg.dx + (p[1] - seg.y0) * seg.dy;
          const d = Math.abs((p[0] - seg.x0) * -seg.dy + (p[1] - seg.y0) * seg.dx);
          if (t >= seg.t0 - 3 && t <= seg.t1 + 3 && d <= seg.halfWidthAt(t) * 1.15 + 3) continue;
          rest.push(p);
        }
        if (rest.length === pts.length) break;
        pts = rest;
      }
    }
    mergeCollinear(shafts, Math.max(W, H));
    // Le tube part de la pointe et sort du blason en direction de l'archer : l'extrémité qui touche
    // le bord du blason (ou de la photo) est la queue, l'autre est la pointe.
    const border = (p) => Math.min(p.x, p.y, W - 1 - p.x, H - 1 - p.y);
    const lim = Math.max(W, H) * 0.03;
    const atEdge = (p) => border(p) < lim || ctx.rOf(p.x, p.y) >= ctx.cutR - 0.9;
    const finalize = (s) => {
      const ends = [s.t0, s.t1].map((t) => ({ t, x: s.x0 + s.dx * t, y: s.y0 + s.dy * t }));
      const e0 = atEdge(ends[0]), e1 = atEdge(ends[1]);
      let tip;
      if (e0 !== e1) tip = e0 ? ends[1] : ends[0];
      else tip = ctx.rOf(ends[0].x, ends[0].y) < ctx.rOf(ends[1].x, ends[1].y) ? ends[0] : ends[1];
      s.tip = tip;
      s.tail = tip === ends[0] ? ends[1] : ends[0];
      s.len = s.t1 - s.t0;
      s.hwTip = s.halfWidthAt(tip.t);
      // un vrai tube sort du blason ; il est aussi bien plus long que large (≠ trous alignés)
      s.valid = atEdge(s.tail) && s.len > 4 * (s.width || 2);
      return s;
    };
    shafts.forEach(finalize);
    // tubes collés l'un à l'autre : bande deux fois plus large que les autres → deux lignes parallèles
    let valid = shafts.filter((s) => s.valid);
    for (const s of valid.slice()) {
      const others = valid.filter((o) => o !== s).map((o) => o.width);
      if (others.length < 2 || s.width < median(others) * 1.6) continue;
      const parts = [];
      for (const sg of [-1, 1]) {
        const off = (s.width / 4) * sg;
        const line = { x0: s.x0 - s.dy * off, y0: s.y0 + s.dx * off, dx: s.dx, dy: s.dy };
        const m = measureLine(line, wm, W, H, minLen);
        if (m) parts.push(finalize(m));
      }
      // les deux tubes convergent : la ligne décalée peut sortir de la bande avant le bord de la photo
      if (parts.length === 2 && parts.every((p) => p.valid || p.len > minLen * 2)) {
        parts.forEach((p) => { p.split = s; });
        valid = valid.filter((o) => o !== s).concat(parts);
      }
    }
    valid.forEach((s) => { if (p.tipMode === 'extend') extendTip(s, cls, W, H); else if (p.tipMode === 'trim') trimTip(s, wm, W, H); });
    // doublons : segments quasi parallèles et superposés → on garde le plus long
    const kept = valid.sort((a, b) => b.len - a.len);
    const out = [];
    for (const s of kept) {
      const dup = out.some((o) => {
        if (s.split && s.split === o.split) return false;
        if (Math.abs(s.dx * o.dx + s.dy * o.dy) < Math.cos((5 * Math.PI) / 180)) return false;
        const d = Math.abs((s.tip.x - o.x0) * -o.dy + (s.tip.y - o.y0) * o.dx);
        const t = (s.tip.x - o.x0) * o.dx + (s.tip.y - o.y0) * o.dy;
        return d < o.halfWidthAt(t) * 1.5 + 2 && t > o.t0 - 10 && t < o.t1 + 10;
      });
      if (!dup) out.push(s);
    }
    return out;
  }

  // Les bandes décoratives coupent un tube en plusieurs morceaux alignés : on les recolle.
  function mergeCollinear(shafts, size) {
    const ends = (s) => [{ x: s.x0 + s.dx * s.t0, y: s.y0 + s.dy * s.t0, w: s.halfWidthAt(s.t0) }, { x: s.x0 + s.dx * s.t1, y: s.y0 + s.dy * s.t1, w: s.halfWidthAt(s.t1) }];
    let merged = true;
    while (merged) {
      merged = false;
      for (let i = 0; i < shafts.length && !merged; i++) for (let j = i + 1; j < shafts.length && !merged; j++) {
        const a = shafts[i], b = shafts[j];
        if (Math.abs(a.dx * b.dx + a.dy * b.dy) < Math.cos((3 * Math.PI) / 180)) continue;
        const eb = ends(b), ea = ends(a);
        const tol = Math.max(4, a.halfWidthAt((a.t0 + a.t1) / 2) * 0.8);
        if (eb.some((p) => Math.abs((p.x - a.x0) * -a.dy + (p.y - a.y0) * a.dx) > tol)) continue;
        // écart le long de l'axe entre les deux morceaux
        const tb = eb.map((p) => (p.x - a.x0) * a.dx + (p.y - a.y0) * a.dy).sort((p, q) => p - q);
        const gap = Math.max(tb[0] - a.t1, a.t0 - tb[1]);
        if (gap > size * 0.12) continue;
        // nouveau segment entre les deux extrémités les plus éloignées
        const pts = [...ea, ...eb];
        let P = pts[0], Q = pts[1], best = -1;
        for (const p of pts) for (const q of pts) { const d = Math.hypot(p.x - q.x, p.y - q.y); if (d > best) { best = d; P = p; Q = q; } }
        const L = best, dx = (Q.x - P.x) / L, dy = (Q.y - P.y) / L;
        const wP = P.w, wQ = Q.w;
        const m = { x0: P.x, y0: P.y, dx, dy, t0: 0, t1: L, merged: true };
        m.halfWidthAt = (t) => Math.max(2, wP + ((wQ - wP) * Math.max(0, Math.min(L, t))) / L);
        m.width = Math.round(2 * m.halfWidthAt(L / 2));
        shafts.splice(j, 1); shafts.splice(i, 1, m);
        merged = true;
      }
    }
  }

  // Le suivi du tube tolère des trous (bandes décorées) ; côté pointe, cela peut faire « sauter » la
  // pointe sur un ancien trou brun. On recule la pointe jusqu'au début d'une portion de tube continue.
  function trimTip(s, wm, W, H) {
    const ux = s.tail.x - s.tip.x, uy = s.tail.y - s.tip.y, L = Math.hypot(ux, uy);
    const dx = ux / L, dy = uy / L, need = Math.max(10, Math.round(Math.max(W, H) / 70));
    const on = (k) => [0, -1.5, 1.5].some((o) => {
      const x = Math.round(s.tip.x + dx * k - dy * o), y = Math.round(s.tip.y + dy * k + dx * o);
      return x >= 0 && y >= 0 && x < W && y < H && wm[y * W + x];
    });
    const maxBack = Math.min(L / 2, Math.max(W, H) * 0.06);
    for (let k = 0; k <= maxBack; k++) {
      let run = 0, miss = 0;
      for (let j = k; j < k + need && j <= L; j++) { if (on(j)) run++; else if (++miss > 1) break; }
      if (run >= need - 1) {
        if (k > 0) { s.trimmed = k; s.tip = { t: s.tip.t, x: s.tip.x + dx * k, y: s.tip.y + dy * k }; }
        return;
      }
    }
  }

  // Près de la cible le tube est souvent dans l'ombre ou teinté par le blason : sa couleur n'est
  // plus « bois ». On prolonge la pointe tant qu'on suit une trace qui n'a pas la couleur d'un anneau.
  function extendTip(s, cls, W, H) {
    const ux = s.tip.x - s.tail.x, uy = s.tip.y - s.tail.y, L = Math.hypot(ux, uy);
    const dx = ux / L, dy = uy / L, maxExt = Math.max(W, H) * 0.05;
    const ring = (c) => c === GOLD || c === RED || c === BLUE || c === WHITE;
    const at = (x, y) => { x = Math.round(x); y = Math.round(y); return x < 0 || y < 0 || x >= W || y >= H ? -1 : cls[y * W + x]; };
    // dans le noir, impossible de distinguer le tube du blason : on ne prolonge pas
    const side = Math.max(4, s.hwTip * 2.5);
    if (at(s.tip.x - dy * side, s.tip.y + dx * side) === BLACK && at(s.tip.x + dy * side, s.tip.y - dx * side) === BLACK) return;
    let last = 0, miss = 0;
    for (let k = 1; k <= maxExt; k++) {
      const x = s.tip.x + dx * k, y = s.tip.y + dy * k;
      let shaft = false;
      for (const o of [0, -1, 1]) if (!ring(at(x - dy * o, y + dx * o)) && at(x - dy * o, y + dx * o) !== -1) { shaft = true; break; }
      // on suit une trace fine : au moins un des deux côtés doit être un anneau (pas un autre tube)
      const w = s.hwTip + 4;
      if (shaft && !ring(at(x - dy * w, y + dx * w)) && !ring(at(x + dy * w, y - dx * w))) shaft = false;
      if (shaft) { last = k; miss = 0; } else if (++miss > 2) break;
    }
    s.extended = last;
    s.tip = { t: s.tip.t, x: s.tip.x + dx * last, y: s.tip.y + dy * last };
  }

  function bestLine(pts, wm, W, H, minLen) {
    let best = null, bestN = 0;
    const band = Math.max(2, Math.max(W, H) / 330);
    const sub = pts.length > 3000 ? sample(pts, 3000) : pts;
    for (let it = 0; it < 250; it++) {
      const a = sub[(rand() * sub.length) | 0], b = sub[(rand() * sub.length) | 0];
      const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (L < minLen * 0.3) continue;
      const dx = (b[0] - a[0]) / L, dy = (b[1] - a[1]) / L;
      let n = 0;
      for (const p of sub) if (Math.abs((p[0] - a[0]) * -dy + (p[1] - a[1]) * dx) < band) n++;
      if (n > bestN) { bestN = n; best = { x0: a[0], y0: a[1], dx, dy }; }
    }
    if (!best) return null;
    // affinage : ACP sur les pixels de la bande élargie
    for (let k = 0; k < 2; k++) {
      const inb = pts.filter((p) => Math.abs((p[0] - best.x0) * -best.dy + (p[1] - best.y0) * best.dx) < band * 3);
      if (inb.length < 10) return null;
      let mx = 0, my = 0;
      for (const p of inb) { mx += p[0]; my += p[1]; }
      mx /= inb.length; my /= inb.length;
      let sxx = 0, sxy = 0, syy = 0;
      for (const p of inb) { const u = p[0] - mx, v = p[1] - my; sxx += u * u; sxy += u * v; syy += v * v; }
      const th = 0.5 * Math.atan2(2 * sxy, sxx - syy);
      best = { x0: mx, y0: my, dx: Math.cos(th), dy: Math.sin(th) };
    }
    return measureLine(best, wm, W, H, minLen);
  }

  function measureLine(best, wm, W, H, minLen) {
    // étendue : plus long tronçon continu de pixels du masque le long de l'axe
    const at = (t) => { const x = Math.round(best.x0 + best.dx * t), y = Math.round(best.y0 + best.dy * t); return x >= 0 && y >= 0 && x < W && y < H && wm[y * W + x]; };
    const near = (t) => at(t) || at(t + 0.5) || [-1.5, 1.5].some((o) => { const x = Math.round(best.x0 + best.dx * t - best.dy * o), y = Math.round(best.y0 + best.dy * t + best.dx * o); return x >= 0 && y >= 0 && x < W && y < H && wm[y * W + x]; });
    // tolérance de trou : bandes décoratives sombres, reflets
    const R = Math.hypot(W, H), gapMax = Math.max(6, Math.max(W, H) / 45);
    let runs = [], start = null, gap = 0, last = null;
    for (let t = -R; t <= R; t += 1) {
      if (near(t)) { if (start === null) start = t; last = t; gap = 0; }
      else if (start !== null && ++gap > gapMax) { runs.push([start, last]); start = null; gap = 0; }
    }
    if (start !== null) runs.push([start, last]);
    if (!runs.length) return null;
    runs.sort((a, b) => b[1] - b[0] - (a[1] - a[0]));
    const [t0, t1] = runs[0];
    if (t1 - t0 < minLen) return null;
    // demi-largeur locale (pour retirer le tube du masque et repérer l'extrémité fine)
    const hw = [];
    for (let t = t0; t <= t1; t += 4) {
      const cx = best.x0 + best.dx * t, cy = best.y0 + best.dy * t;
      let w = 0;
      for (const sgn of [-1, 1]) {
        let k = 0, miss = 0;
        for (let o = 1; o < 80; o++) {
          const x = Math.round(cx - best.dy * o * sgn), y = Math.round(cy + best.dx * o * sgn);
          if (x < 0 || y < 0 || x >= W || y >= H || !wm[y * W + x]) { if (++miss > 2) break; } else { k = o; miss = 0; }
        }
        w = Math.max(w, k);
      }
      hw.push(w);
    }
    // la largeur d'un tube varie linéairement (perspective) ; là où deux tubes se touchent, la
    // largeur mesurée explose : on ajuste une droite en écartant ces mesures aberrantes.
    const ts = hw.map((_, i) => t0 + i * 4);
    let fit = [median(hw), 0];
    for (let k = 0; k < 3; k++) {
      const keep = hw.map((w, i) => [ts[i], w]).filter(([t, w]) => w > 0 && w <= (fit[0] + fit[1] * t) * 1.25 + 1);
      if (keep.length < 4) break;
      fit = linFit(keep.map((p) => p[0]), keep.map((p) => p[1]));
    }
    best.t0 = t0; best.t1 = t1;
    best.halfWidthAt = (t) => Math.max(2, fit[0] + fit[1] * Math.max(t0, Math.min(t1, t)));
    best.width = Math.round(2 * best.halfWidthAt((t0 + t1) / 2));
    return best;
  }

  function paperFraction(cls, W, H, cx, cy, R) {
    let n = 0, k = 0;
    for (let i = 0; i < 48; i++) {
      const a = (i / 48) * 2 * Math.PI, x = Math.round(cx + R * Math.cos(a)), y = Math.round(cy + R * Math.sin(a));
      if (x < 0 || y < 0 || x >= W || y >= H) continue;
      n++;
      const c = cls[y * W + x];
      if (c === GOLD || c === RED || c === BLUE || c === BLACK || c === WHITE) k++;
    }
    return n ? k / n : 0;
  }

  // ---------------------------------------------------------------- analyse d'une photo
  const DEFAULT_PARAMS = { blackV: 0.3, goldH: 42, goldS: 0.6, woodH0: 17, woodH1: 38, woodS: 0.45, tipMaxR: 10.3, paperMin: 0.6, tipMode: 'extend', darkWoodS: 0.7, wood2S: 0.38 }; // réglages calibrés sur 10 volées réelles (blason 60 cm)

  async function analyzeView(src, faceKind, params = {}) {
    const p = { ...DEFAULT_PARAMS, ...params };
    seed = 12345;
    const geom = FACE_GEOMETRY[faceKind];
    const img = src instanceof HTMLImageElement ? src : await loadImage(src);
    const px = toPixels(img);
    const cls = classMap(px, p);
    const view = { W: px.W, H: px.H, cls, canvas: px.canvas, ok: false, arrows: [], shafts: [], spots: [] };
    const spots = findTarget(cls, px.W, px.H, geom);
    if (!spots) { view.message = 'Cible non trouvée (zone jaune introuvable).'; return view; }
    view.spots = spots;
    // zone du blason : intérieur de l'ellipse de rayon cutR (un peu au-delà du dernier anneau)
    const cutR = geom.maxR + 0.3, inFace = new Uint8Array(px.W * px.H);
    const cuts = spots.map((sp) => sp.family.at(cutR));
    for (let y = 0; y < px.H; y++) for (let x = 0; x < px.W; x++) {
      for (const e of cuts) {
        const dx = x - e.cx, dy = y - e.cy;
        if (e.s[0] * dx * dx + 2 * e.s[1] * dx * dy + e.s[2] * dy * dy <= cutR * cutR) { inFace[y * px.W + x] = 1; break; }
      }
    }
    view.inFace = inFace;
    const rOf = (x, y) => Math.min(...spots.map((sp) => sp.family.toTarget(x, y).r));
    view.shafts = findShafts(cls, px.W, px.H, { inFace, rOf, cutR, params: p });
    for (const s of view.shafts) {
      // rattachement au spot le plus proche (rayon minimal)
      let best = null;
      spots.forEach((sp, i) => { const t = sp.family.toTarget(s.tip.x, s.tip.y); if (!best || t.r < best.r) best = { ...t, spot: i }; });
      s.target = best;
      // une pointe doit être plantée dans le papier du blason (pas dans la paille autour)
      s.paper = paperFraction(cls, px.W, px.H, s.tip.x, s.tip.y, (s.hwTip || 4) * 3 + 4);
      const rLim = faceKind === 'trispot' ? geom.maxR + 0.4 : p.tipMaxR;
      if (best && best.r <= rLim && s.paper >= p.paperMin) view.arrows.push({ spot: best.spot, u: best.u, v: best.v, r: best.r, img: { x: s.tip.x / px.W, y: s.tip.y / px.H },
        // confiance : pointe bien entourée de papier, tube long
        conf: s.paper * Math.min(1, s.len / (0.12 * Math.max(px.W, px.H))) });
    }
    view.ok = true;
    return view;
  }

  // ---------------------------------------------------------------- fusion des deux photos
  // Les deux repères « de face » peuvent différer d'une petite rotation (appareil penché).
  // On cherche la rotation qui superpose au mieux les pointes de la vue b sur celles de la vue a.
  function alignRotation(a, b) {
    if (a.length < 2 || b.length < 2) return 0;
    let best = 0, bestCost = Infinity;
    for (let deg = -30; deg <= 30; deg += 0.5) {
      const t = (deg * Math.PI) / 180, c = Math.cos(t), s = Math.sin(t);
      let cost = 0;
      for (const p of b) {
        const x = p.u * c - p.v * s, y = p.u * s + p.v * c;
        let d = 1.2;
        for (const q of a) if (q.spot === p.spot) d = Math.min(d, Math.hypot(q.u - x, q.v - y));
        cost += d;
      }
      cost += Math.abs(deg) * 0.002; // à égalité, on préfère ne pas tourner
      if (cost < bestCost) { bestCost = cost; best = t; }
    }
    return best;
  }

  // Fusion : la photo dont le nombre de flèches est le plus proche du nombre attendu sert de
  // référence ; l'autre confirme ses flèches et complète celles qui manquent (les plus fiables d'abord).
  function merge(views, expected) {
    const extra = [];
    // 1) chaque photo est d'abord ramenée au nombre de flèches attendu (on écarte les moins sûres)
    const ok = views.map((v, i) => ({ v, i })).filter((o) => o.v && o.v.ok).map((o) => {
      let arr = o.v.arrows.map((a) => ({ ...a, view: o.i })).sort((p, q) => q.conf - p.conf);
      if (expected && arr.length > expected) { extra.push(...arr.slice(expected)); arr = arr.slice(0, expected); }
      return { ...o, arr, score: arr.reduce((t, a) => t + a.conf, 0) };
    });
    if (!ok.length) return { arrows: [], extra: [] };
    // 2) la photo la plus fiable dans son ensemble sert de référence
    ok.sort((a, b) => b.score - a.score);
    const [ref, oth] = ok;
    const A = ref.arr;
    let B = [];
    if (oth) {
      B = oth.arr;
      const t = alignRotation(A, B), c = Math.cos(t), s = Math.sin(t);
      B.forEach((p) => { const x = p.u * c - p.v * s, y = p.u * s + p.v * c; p.u = x; p.v = y; });
    }
    const groups = A.map((a) => ({ spot: a.spot, members: [a], conf: a.conf }));
    // appariement glouton par distance croissante
    const pairs = [];
    B.forEach((b, bi) => groups.forEach((g, gi) => {
      const a = g.members[0];
      if (a.spot !== b.spot) return;
      const d = Math.hypot(a.u - b.u, a.v - b.v);
      if (d < 1.2) pairs.push([d, bi, gi]);
    }));
    pairs.sort((p, q) => p[0] - q[0]);
    const usedB = new Set(), usedG = new Set();
    for (const [, bi, gi] of pairs) {
      if (usedB.has(bi) || usedG.has(gi)) continue;
      usedB.add(bi); usedG.add(gi);
      groups[gi].members.push(B[bi]); groups[gi].conf += 1;
    }
    if (expected && groups.length < expected) {
      // compléter avec les flèches vues seulement sur l'autre photo : fiables et distinctes d'abord
      const free = B.filter((_, bi) => !usedB.has(bi)).map((b) => {
        const near = Math.min(3, ...groups.filter((g) => g.members[0].spot === b.spot).map((g) => Math.hypot(g.members[0].u - b.u, g.members[0].v - b.v)));
        return { b, key: b.conf + 0.15 * near };
      }).sort((p, q) => q.key - p.key);
      for (const { b } of free) (groups.length < expected ? groups.push({ spot: b.spot, members: [b], conf: b.conf }) : extra.push(b));
    } else if (expected && groups.length > expected) {
      // trop de flèches sur la photo de référence : on écarte les moins sûres, non confirmées
      groups.sort((p, q) => q.conf - p.conf);
      extra.push(...groups.splice(expected).map((g) => g.members[0]));
    }
    const out = groups.map((g) => {
      const r = avg(g.members.map((m) => m.r));
      const u = avg(g.members.map((m) => m.u)), v = avg(g.members.map((m) => m.v)), k = r / (Math.hypot(u, v) || 1);
      return { spot: g.spot, x: u * k, y: v * k, r, both: g.members.length > 1, members: g.members.map((m) => a2m(m, m.view)),
        spread: g.members.length > 1 ? Math.abs(g.members[0].r - g.members[1].r) : null };
    });
    return { arrows: out, extra: extra.map((m) => ({ spot: m.spot, x: m.u, y: m.v, r: m.r })) };
  }
  const a2m = (a, vi) => ({ view: vi, u: a.u, v: a.v, r: a.r, img: a.img });
  const avg = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;

  async function analyze(srcLeft, srcRight, faceKind, expected = 6, params) {
    const views = [];
    for (const s of [srcLeft, srcRight]) views.push(s ? await analyzeView(s, faceKind, params) : null);
    return { views, ...merge(views, expected) };
  }

  return { analyze, analyzeView, merge, FACE_GEOMETRY, CLASSES: { NONE, GOLD, RED, BLUE, BLACK, WHITE, WOOD }, loadImage };
})();
if (typeof window !== 'undefined') window.Vision = Vision;
