/* stats.js — calculs et graphiques SVG (une seule série par graphique, info-bulles via data-tip). */
const Stats = (() => {
  'use strict';
  const sum = (xs) => xs.reduce((a, b) => a + b, 0);
  const r1 = (x, d = 1) => (Number.isFinite(x) ? x.toFixed(d).replace('.', ',') : '–');
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const endTotal = (e) => sum(e.arrows.map((a) => a.s));
  function summary(sess) {
    const ends = sess.ends || [];
    const arrows = ends.flatMap((e) => e.arrows);
    const total = sum(arrows.map((a) => a.s));
    return {
      ends: ends.length, arrows: arrows.length, total, max: arrows.length * 10,
      avgArrow: arrows.length ? total / arrows.length : NaN,
      avgEnd: ends.length ? total / ends.length : NaN,
      tens: arrows.filter((a) => a.s === 10).length, nines: arrows.filter((a) => a.s === 9).length,
      misses: arrows.filter((a) => a.s === 0).length,
      bestEnd: ends.length ? Math.max(...ends.map(endTotal)) : NaN,
    };
  }
  // groupement : centre moyen et dispersion (écart quadratique moyen au centre), en unités d'anneau
  function grouping(arrows) {
    const pts = arrows.filter((a) => Number.isFinite(a.x));
    if (pts.length < 2) return null;
    const mx = sum(pts.map((p) => p.x)) / pts.length, my = sum(pts.map((p) => p.y)) / pts.length;
    const rms = Math.sqrt(sum(pts.map((p) => (p.x - mx) ** 2 + (p.y - my) ** 2)) / pts.length);
    return { mx, my, rms, n: pts.length };
  }
  const direction = (g) => {
    if (!g || Math.hypot(g.mx, g.my) < 0.4) return 'centré';
    const v = g.my > 0.4 ? 'haut' : g.my < -0.4 ? 'bas' : '';
    const h = g.mx > 0.4 ? 'droite' : g.mx < -0.4 ? 'gauche' : '';
    return [v, h].filter(Boolean).join('-');
  };

  // ---------------------------------------------------------------- carte des impacts
  function impactMap(face, arrows, { group = true, numbered = false, foldTrispot = false } = {}) {
    const f = foldTrispot && face.kind === 'trispot' ? { ...face, kind: 'single5' } : face;
    const single5 = f.kind === 'single5';
    const vb = single5 ? { x: -5.6, y: -5.6, w: 11.2, h: 11.2 } : Faces.viewBox(face);
    let s = `<svg class="impact" viewBox="${vb.x} ${vb.y} ${vb.w} ${vb.h}" role="img" aria-label="Carte des impacts">`;
    s += single5 ? singleSpot() : Faces.targetSVG(face);
    const pos = (a) => (single5 ? { x: a.x, y: -a.y } : Faces.toSVG(face, a));
    arrows.forEach((a, i) => {
      if (!Number.isFinite(a.x)) return;
      const p = pos(a);
      s += `<circle class="hit" cx="${p.x}" cy="${p.y}" r="0.32" data-tip="${Faces.fmt(a.s)} pt${a.s > 1 ? 's' : ''}"/>`;
      if (numbered) s += `<text x="${p.x}" y="${p.y + 0.12}" class="hit-n">${i + 1}</text>`;
    });
    if (group) {
      const spotsN = single5 ? 1 : Faces.spots(face);
      for (let sp = 0; sp < spotsN; sp++) {
        const g = grouping(arrows.filter((a) => single5 || (a.spot || 0) === sp));
        if (!g) continue;
        const c = single5 ? { x: g.mx, y: -g.my } : Faces.toSVG(face, { spot: sp, x: g.mx, y: g.my });
        s += `<circle class="grp" cx="${c.x}" cy="${c.y}" r="${Math.max(0.3, g.rms)}" data-tip="Groupement : ${r1(g.rms * Faces.ringWidthCm(face))} cm (écart moyen)"/>`;
        s += `<path class="grp-c" d="M${c.x - 0.45} ${c.y}h0.9M${c.x} ${c.y - 0.45}v0.9"/>`;
      }
    }
    return s + '</svg>';
    function singleSpot() {
      let t = '';
      const Z = [[5, '#33a7e0'], [4, '#ef4b3c'], [3, '#ef4b3c'], [2, '#f7d117'], [1, '#f7d117']];
      for (const [r, c] of Z) t += `<circle r="${r}" fill="${c}" stroke="#1b1b1b" stroke-width="0.04"/>`;
      return t;
    }
  }

  // ---------------------------------------------------------------- graphiques
  // Courbe d'une seule série. points: [{label, y, tip}]
  function lineChart(points, { yLabel = '', yMin, yMax, height = 220 } = {}) {
    if (!points.length) return '<p class="muted">Pas encore de données.</p>';
    const W = 640, H = height, L = 44, R = 14, T = 14, B = 34;
    const ys = points.map((p) => p.y);
    let lo = yMin ?? Math.floor(Math.min(...ys) - 0.5), hi = yMax ?? Math.ceil(Math.max(...ys) + 0.5);
    if (hi - lo < 1) { lo -= 0.5; hi += 0.5; }
    const X = (i) => L + (points.length === 1 ? (W - L - R) / 2 : (i * (W - L - R)) / (points.length - 1));
    const Y = (v) => T + ((hi - v) * (H - T - B)) / (hi - lo);
    let s = `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(yLabel)}">`;
    const ticks = niceTicks(lo, hi, 4);
    for (const t of ticks) s += `<line class="grid" x1="${L}" x2="${W - R}" y1="${Y(t)}" y2="${Y(t)}"/><text class="axis" x="${L - 6}" y="${Y(t) + 4}" text-anchor="end">${r1(t, t % 1 ? 1 : 0)}</text>`;
    s += `<polyline class="line" points="${points.map((p, i) => `${X(i)},${Y(p.y)}`).join(' ')}"/>`;
    const step = Math.max(1, Math.ceil(points.length / 6));
    points.forEach((p, i) => {
      s += `<circle class="dot" cx="${X(i)}" cy="${Y(p.y)}" r="4"/>`;
      s += `<rect class="hitbox" x="${X(i) - 14}" y="${T}" width="28" height="${H - T - B}" data-tip="${esc(p.tip || p.label + ' : ' + r1(p.y, 2))}"/>`;
      if (i % step === 0 || i === points.length - 1) s += `<text class="axis" x="${X(i)}" y="${H - 12}" text-anchor="middle">${esc(p.label)}</text>`;
    });
    // étiquette directe sur la dernière valeur
    const last = points[points.length - 1];
    s += `<text class="val" x="${Math.min(X(points.length - 1), W - R - 4)}" y="${Y(last.y) - 10}" text-anchor="end">${r1(last.y, 2)}</text>`;
    return s + '</svg>';
  }
  // Barres verticales d'une seule série. items: [{label, value, tip}]
  function barChart(items, { height = 200, valueFmt = (v) => r1(v, 2), yMax } = {}) {
    if (!items.length) return '<p class="muted">Pas encore de données.</p>';
    const W = 640, H = height, L = 40, R = 10, T = 22, B = 30;
    const hi = yMax ?? (Math.max(...items.map((i) => i.value)) * 1.1 || 1);
    const bw = Math.min(56, ((W - L - R) / items.length) * 0.6), gap = (W - L - R) / items.length;
    const Y = (v) => T + ((hi - v) * (H - T - B)) / hi;
    let s = `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img">`;
    for (const t of niceTicks(0, hi, 3)) s += `<line class="grid" x1="${L}" x2="${W - R}" y1="${Y(t)}" y2="${Y(t)}"/><text class="axis" x="${L - 6}" y="${Y(t) + 4}" text-anchor="end">${r1(t, t % 1 ? 1 : 0)}</text>`;
    items.forEach((it, i) => {
      const x = L + gap * i + (gap - bw) / 2, y = Y(it.value), h = Math.max(0, H - B - y);
      s += `<path class="bar" d="${roundTop(x, y, bw, h, 4)}"/>`;
      s += `<rect class="hitbox" x="${L + gap * i}" y="${T}" width="${gap}" height="${H - T - B}" data-tip="${esc(it.tip || it.label + ' : ' + valueFmt(it.value))}"/>`;
      s += `<text class="axis" x="${x + bw / 2}" y="${H - 10}" text-anchor="middle">${esc(it.label)}</text>`;
      if (items.length <= 12) s += `<text class="val" x="${x + bw / 2}" y="${y - 6}" text-anchor="middle">${valueFmt(it.value)}</text>`;
    });
    return s + '</svg>';
  }
  function roundTop(x, y, w, h, r) {
    r = Math.min(r, w / 2, h);
    return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
  }
  function niceTicks(lo, hi, n) {
    const span = hi - lo, raw = span / n, mag = 10 ** Math.floor(Math.log10(raw));
    const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => span / s <= n) || mag * 10;
    const out = [];
    for (let t = Math.ceil(lo / step) * step; t <= hi + 1e-9; t += step) out.push(Math.round(t * 1000) / 1000);
    return out;
  }

  return { summary, endTotal, grouping, direction, impactMap, lineChart, barChart, r1, esc, sum };
})();
