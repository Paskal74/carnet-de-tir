/* app.js — interface : archers, séances, volées (photos + validation), statistiques, export, synchronisation. */
(() => {
  'use strict';
  const { esc, r1 } = Stats;
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const view = $('#view');
  const fmtDate = (d) => (d ? new Date(d + 'T12:00').toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }) : '');
  const shortDate = (d) => (d ? new Date(d + 'T12:00').toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' }) : '');
  const today = () => new Date().toISOString().slice(0, 10);

  const state = { archerId: null, archers: [], settings: { arrowDiam: 8, sheetsUrl: '' } };

  function toast(msg, ms = 2600) {
    const t = $('#toast');
    t.textContent = msg; t.hidden = false;
    clearTimeout(toast._t); toast._t = setTimeout(() => { t.hidden = true; }, ms);
  }
  const archer = () => state.archers.find((a) => a.id === state.archerId);

  async function loadState() {
    state.archers = (await DB.all('archers')).sort((a, b) => a.name.localeCompare(b.name));
    state.archerId = await DB.getSetting('archerId', null);
    if (!archer()) state.archerId = state.archers[0]?.id || null;
    state.settings.arrowDiam = await DB.getSetting('arrowDiam', 8);
    state.settings.sheetsUrl = await DB.getSetting('sheetsUrl', '');
    state.settings.photoCopy = await DB.getSetting('photoCopy', true);
    renderArcherSelect();
  }
  function renderArcherSelect() {
    const sel = $('#archer-select');
    sel.innerHTML = state.archers.map((a) => `<option value="${a.id}" ${a.id === state.archerId ? 'selected' : ''}>${esc(a.name)}</option>`).join('')
      + '<option value="__new">+ Nouvel archer…</option>';
    sel.hidden = !state.archers.length;
  }
  $('#archer-select').addEventListener('change', async (e) => {
    if (e.target.value === '__new') { location.hash = '#/archers'; renderArcherSelect(); return; }
    state.archerId = e.target.value;
    await DB.setSetting('archerId', state.archerId);
    route();
  });

  async function sessionsOfArcher() {
    return (await DB.all('sessions')).filter((s) => s.archerId === state.archerId)
      .sort((a, b) => (b.date || '').localeCompare(a.date || '') || (b.createdAt || 0) - (a.createdAt || 0));
  }

  // ======================================================================= routes
  const routes = [
    [/^#?\/?$/, home],
    [/^#\/nouvelle$/, () => sessionForm(null)],
    [/^#\/s\/([^/]+)$/, (id) => sessionView(id)],
    [/^#\/s\/([^/]+)\/infos$/, (id) => sessionForm(id)],
    [/^#\/s\/([^/]+)\/v\/([^/]+)$/, (id, n) => endView(id, n)],
    [/^#\/s\/([^/]+)\/feuille$/, (id) => scoreSheet(id)],
    [/^#\/stats$/, statsView],
    [/^#\/archers$/, archersView],
    [/^#\/reglages$/, settingsView],
  ];
  async function route() {
    const h = location.hash || '#/';
    $$('.tabbar a').forEach((a) => a.classList.toggle('active', h === a.getAttribute('href') || (a.getAttribute('href') === '#/' && h.startsWith('#/s'))));
    document.body.classList.toggle('print-mode', /\/feuille$/.test(h));
    if (!state.archers.length && !/^#\/(archers|reglages)$/.test(h)) return welcome();
    for (const [re, fn] of routes) {
      const m = h.match(re);
      if (m) { try { await fn(...m.slice(1)); } catch (e) { console.error(e); view.innerHTML = `<div class="card error">Erreur : ${esc(e.message)}</div>`; } window.scrollTo(0, 0); return; }
    }
    location.hash = '#/';
  }
  window.addEventListener('hashchange', route);

  // ======================================================================= accueil
  function welcome() {
    view.innerHTML = `
      <section class="card hero">
        <h1>Bienvenue 🎯</h1>
        <p>Comptez vos points à partir de deux photos de la cible, volée après volée, et suivez votre progression.</p>
        <form id="f-first" class="stack">
          <label>Votre nom d'archer<input name="name" required autocomplete="name" placeholder="ex. Pascal"></label>
          <label>Arc<input name="bow" placeholder="ex. Barebow bois monobloc"></label>
          <button class="btn primary">Commencer</button>
        </form>
      </section>`;
    $('#f-first').onsubmit = async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const a = await DB.put('archers', { name: fd.get('name').trim(), bow: fd.get('bow').trim() });
      await DB.setSetting('archerId', a.id);
      await loadState();
      location.hash = '#/';
      route();
    };
  }

  async function home() {
    const list = await sessionsOfArcher();
    view.innerHTML = `
      <div class="row between"><h1>Séances</h1><a class="btn primary" href="#/nouvelle">+ Nouvelle séance</a></div>
      ${list.length ? '' : '<div class="card muted">Aucune séance pour l\'instant. Créez-en une, puis ajoutez vos volées en photographiant la cible.</div>'}
      <div class="list">${list.map((s) => {
        const sm = Stats.summary(s), f = Faces.get(s.faceId);
        return `<a class="card session-item" href="#/s/${s.id}">
          <div><div class="title">${esc(fmtDate(s.date))}</div>
          <div class="muted">${esc(s.distance)} m · ${esc(f.label)}${s.place ? ' · ' + esc(s.place) : ''}</div>
          <div class="muted small">${sm.ends}/${s.endsPlanned || '?'} volées${s.feeling?.rating ? ' · ' + '★'.repeat(s.feeling.rating) : ''}</div></div>
          <div class="score-big">${sm.total}<span>/${sm.max}</span><div class="small muted">${r1(sm.avgArrow, 2)} / flèche</div></div>
        </a>`;
      }).join('')}</div>`;
  }

  // ======================================================================= séance : infos
  async function sessionForm(id) {
    const s = id ? await DB.get('sessions', id) : null;
    const last = (await sessionsOfArcher())[0];
    const v = s || { date: today(), distance: last?.distance || 18, faceId: last?.faceId || '40', place: last?.place || '', equipment: last?.equipment || archer()?.bow || '', arrowsPerEnd: 6, endsPlanned: 10 };
    view.innerHTML = `
      <h1>${s ? 'Modifier la séance' : 'Nouvelle séance'}</h1>
      <form id="f-sess" class="card stack">
        <div class="grid2">
          <label>Date<input type="date" name="date" value="${esc(v.date)}" required></label>
          <label>Distance (m)<input type="number" name="distance" min="1" max="100" step="1" value="${esc(v.distance)}" required></label>
          <label>Blason<select name="faceId">${Faces.LIST.map((f) => `<option value="${f.id}" ${f.id === v.faceId ? 'selected' : ''}>${f.label}</option>`).join('')}</select></label>
          <label>Lieu<input name="place" value="${esc(v.place)}" placeholder="ex. Gymnase, terrain du club…"></label>
          <label>Flèches par volée<input type="number" name="arrowsPerEnd" min="1" max="12" value="${esc(v.arrowsPerEnd)}"></label>
          <label>Volées prévues<input type="number" name="endsPlanned" min="1" max="60" value="${esc(v.endsPlanned)}"></label>
        </div>
        <label>Matériel utilisé<input name="equipment" value="${esc(v.equipment)}" placeholder="arc, puissance, flèches, pointes…"></label>
        <label>Notes<textarea name="notes" rows="2" placeholder="météo, objectif de la séance…">${esc(v.notes || '')}</textarea></label>
        <div class="row"><button class="btn primary">${s ? 'Enregistrer' : 'Créer la séance'}</button><a class="btn" href="${s ? '#/s/' + s.id : '#/'}">Annuler</a></div>
      </form>`;
    $('#f-sess').onsubmit = async (e) => {
      e.preventDefault();
      const fd = Object.fromEntries(new FormData(e.target));
      const o = s || { archerId: state.archerId, ends: [], createdAt: Date.now() };
      Object.assign(o, { date: fd.date, distance: +fd.distance, faceId: fd.faceId, place: fd.place.trim(), equipment: fd.equipment.trim(), notes: fd.notes.trim(), arrowsPerEnd: +fd.arrowsPerEnd || 6, endsPlanned: +fd.endsPlanned || 10 });
      await DB.put('sessions', o);
      location.hash = '#/s/' + o.id;
    };
  }

  // ======================================================================= séance : feuille
  function endRow(e, i, cum, apE) {
    const sorted = [...e.arrows].sort((a, b) => b.s - a.s);
    const cells = [];
    for (let k = 0; k < Math.max(apE, sorted.length); k++) {
      const a = sorted[k];
      cells.push(a ? `<td class="sc ${Faces.scoreClass(a.s)}">${Faces.fmt(a.s)}</td>` : '<td></td>');
    }
    return `<tr data-end="${i}"><th>${i + 1}</th>${cells.join('')}<td class="tot">${Stats.endTotal(e)}</td><td class="cum">${cum}</td></tr>`;
  }
  function sheetTable(s) {
    const apE = s.arrowsPerEnd || 6;
    let cum = 0;
    const rows = (s.ends || []).map((e, i) => { cum += Stats.endTotal(e); return endRow(e, i, cum, apE); }).join('');
    const head = Array.from({ length: apE }, (_, k) => `<th>${k + 1}</th>`).join('');
    return `<table class="sheet"><thead><tr><th>Volée</th>${head}<th>Total</th><th>Cumul</th></tr></thead><tbody>${rows || `<tr><td colspan="${apE + 3}" class="muted">Aucune volée</td></tr>`}</tbody></table>`;
  }
  function tiles(sm) {
    return `<div class="tiles">
      <div class="tile"><div class="k">Total</div><div class="v">${sm.total}<small>/${sm.max}</small></div></div>
      <div class="tile"><div class="k">Moyenne / flèche</div><div class="v">${r1(sm.avgArrow, 2)}</div></div>
      <div class="tile"><div class="k">Moyenne / volée</div><div class="v">${r1(sm.avgEnd, 1)}</div></div>
      <div class="tile"><div class="k">10 · 9 · M</div><div class="v">${sm.tens} · ${sm.nines} · ${sm.misses}</div></div>
    </div>`;
  }

  async function sessionView(id) {
    const s = await DB.get('sessions', id);
    if (!s || s.deleted) { location.hash = '#/'; return; }
    const f = Faces.get(s.faceId), sm = Stats.summary(s);
    const all = (s.ends || []).flatMap((e) => e.arrows);
    const g = Stats.grouping(all);
    const done = sm.ends >= (s.endsPlanned || 0);
    view.innerHTML = `
      <div class="row between wrap"><div><h1>${esc(fmtDate(s.date))}</h1>
        <div class="muted">${esc(s.distance)} m · ${esc(f.label)}${s.place ? ' · ' + esc(s.place) : ''}${s.equipment ? ' · ' + esc(s.equipment) : ''}</div></div>
        <a class="btn small" href="#/s/${s.id}/infos">Modifier</a></div>
      <div class="row wrap actions">
        <a class="btn primary big" href="#/s/${s.id}/v/new">📷 ${sm.ends ? 'Volée suivante' : 'Première volée'} (${sm.ends + 1}${s.endsPlanned ? '/' + s.endsPlanned : ''})</a>
      </div>
      ${done ? '<div class="card ok">Toutes les volées prévues sont saisies. Pensez à noter votre ressenti en bas de page.</div>' : ''}
      ${tiles(sm)}
      <section class="card"><h2>Feuille de marque</h2><div class="scroll-x">${sheetTable(s)}</div>
        <p class="muted small">Touchez une volée pour la corriger.</p></section>
      ${all.some((a) => Number.isFinite(a.x)) ? `<section class="card"><h2>Impacts et groupement</h2>
        <div class="map-wrap">${Stats.impactMap(f, all)}</div>
        ${g ? `<p class="center">Groupement : <b>${r1(g.rms * Faces.ringWidthCm(f))} cm</b> d'écart moyen · centre du groupe : <b>${Stats.direction(g)}</b></p>` : ''}</section>` : ''}
      ${sm.ends > 1 ? `<section class="card"><h2>Total par volée</h2>${Stats.barChart(s.ends.map((e, i) => ({ label: String(i + 1), value: Stats.endTotal(e), tip: `Volée ${i + 1} : ${Stats.endTotal(e)} pts` })), { valueFmt: (v) => String(v), yMax: (s.arrowsPerEnd || 6) * 10 })}</section>` : ''}
      <section class="card"><h2>Ressenti</h2>
        <div class="stars" role="radiogroup" aria-label="Note de la séance">${[1, 2, 3, 4, 5].map((n) => `<button type="button" data-star="${n}" class="${(s.feeling?.rating || 0) >= n ? 'on' : ''}" aria-label="${n} sur 5">★</button>`).join('')}</div>
        <textarea id="feel" rows="3" placeholder="Sensations, points techniques travaillés, fatigue…">${esc(s.feeling?.text || '')}</textarea>
      </section>
      <section class="card" id="ph-sec" hidden></section>
      <div class="row wrap actions">
        <a class="btn" href="#/s/${s.id}/feuille">📄 Feuille de marque (PDF)</a>
        <button class="btn danger" id="del">Supprimer la séance</button>
      </div>`;
    $$('tr[data-end]').forEach((tr) => { tr.onclick = () => { location.hash = `#/s/${s.id}/v/${tr.dataset.end}`; }; });
    $$('[data-star]').forEach((b) => { b.onclick = async () => {
      s.feeling = { ...(s.feeling || {}), rating: +b.dataset.star };
      await DB.put('sessions', s);
      $$('[data-star]').forEach((x) => x.classList.toggle('on', +x.dataset.star <= s.feeling.rating));
    }; });
    $('#feel').onchange = async (e) => { s.feeling = { ...(s.feeling || {}), text: e.target.value }; await DB.put('sessions', s); toast('Ressenti enregistré'); };
    $('#del').onclick = async () => {
      if (!confirm('Supprimer définitivement cette séance et ses photos ?')) return;
      await DB.remove('sessions', s.id);
      await Photos.deleteSession(s.id);
      location.hash = '#/';
    };
    renderSessionPhotos(s);
  }

  // galerie des photos de la séance (rattachées ou non à une volée)
  async function renderSessionPhotos(s) {
    const sec = $('#ph-sec');
    if (!sec) return;
    const pairs = await Photos.pairs(s.id);
    if (!pairs.length) { sec.hidden = true; return; }
    const usedBy = new Map((s.ends || []).map((e, i) => [e.photoKey, i + 1]));
    const all = pairs.flatMap((p) => [p.G, p.D].filter(Boolean));
    const size = all.reduce((t, p) => t + p.blob.size, 0);
    sec.hidden = false;
    sec.innerHTML = `
      <div class="row between wrap"><h2>Photos de la séance</h2>
        <button class="btn small" type="button" id="ph-all">⬇ Tout copier dans le téléphone</button></div>
      <p class="muted small">${all.length} photo(s) · ${Photos.fmtSize(size)} · conservées sur cet appareil, même si une volée est supprimée.</p>
      <div class="pair-gallery">${pairs.map((p) => `
        <div class="pair-card">
          <div class="pair-imgs">${['G', 'D'].map((sd) => (p[sd] ? `<figure><img src="${URL.createObjectURL(p[sd].blob)}" alt="${esc(p[sd].name)}" loading="lazy"><figcaption>${esc(p[sd].name)}</figcaption></figure>` : '<figure class="ph-empty"></figure>')).join('')}</div>
          <div class="row wrap">
            <span class="muted small">${usedBy.has(p.key) ? `Volée ${usedBy.get(p.key)}` : 'Non rattachée à une volée'}</span>
            <button class="btn small" type="button" data-dl="${p.key}">⬇ Copier</button>
            ${Photos.canShare([p.G || p.D]) ? `<button class="btn small" type="button" data-share="${p.key}">↗ Partager</button>` : ''}
            ${usedBy.has(p.key) ? '' : `<button class="btn small danger" type="button" data-rm="${p.key}">Supprimer</button>`}
          </div>
        </div>`).join('')}</div>`;
    const pick = (key) => { const p = pairs.find((x) => x.key === key); return [p.G, p.D].filter(Boolean); };
    $('#ph-all').onclick = () => Photos.downloadAll(all);
    $$('[data-dl]', sec).forEach((b) => { b.onclick = () => Photos.downloadAll(pick(b.dataset.dl)); });
    $$('[data-share]', sec).forEach((b) => { b.onclick = () => Photos.share(pick(b.dataset.share)).catch(() => {}); });
    $$('[data-rm]', sec).forEach((b) => { b.onclick = async () => {
      if (!confirm('Supprimer définitivement ces deux photos de l\'application ?')) return;
      await Photos.deletePair(s.id, b.dataset.rm);
      renderSessionPhotos(s);
    }; });
  }

  // ======================================================================= volée
  async function endView(id, n) {
    const s = await DB.get('sessions', id);
    if (!s) { location.hash = '#/'; return; }
    const f = Faces.get(s.faceId), apE = s.arrowsPerEnd || 6;
    const isNew = n === 'new', idx = isNew ? (s.ends || []).length : +n;
    const end = isNew ? { arrows: [] } : JSON.parse(JSON.stringify(s.ends[idx]));
    const photos = [null, null];
    // photoKey : paire enregistrée actuellement chargée telle quelle (null = nouvelles photos à enregistrer)
    let selected = -1, zoom = false, analysis = null, photoKey = null;
    const savedPairs = await Photos.pairs(s.id);

    view.innerHTML = `
      <div class="row between"><h1>Volée ${idx + 1}</h1><a class="btn small" href="#/s/${s.id}">Retour</a></div>
      <section class="card">
        <h2>1. Photos de la cible</h2>
        <p class="muted small">Photo de <b>gauche</b> puis photo de <b>droite</b>, toute la cible dans le cadre, avant de retirer les flèches.</p>
        <div id="reuse"></div>
        <div class="photos">${['gauche', 'droite'].map((side, i) => `
          <div class="photo-slot" data-i="${i}">
            <div class="thumb" id="thumb${i}"><span>Photo ${side}</span></div>
            <div class="row">
              <label class="btn small">📷 Prendre<input type="file" accept="image/*" capture="environment" data-photo="${i}" hidden></label>
              <label class="btn small">🖼 Galerie<input type="file" accept="image/*" data-photo="${i}" hidden></label>
            </div>
          </div>`).join('')}</div>
        <button class="btn primary" id="analyze" disabled>Analyser les photos</button>
        <div id="an-status" class="muted small"></div>
        <div id="an-views" class="an-views"></div>
      </section>
      <section class="card">
        <h2>2. Vérifier / corriger</h2>
        <p class="muted small">Touchez la cible pour <b>ajouter</b> une flèche, faites <b>glisser</b> un impact pour le déplacer, touchez-le pour le <b>sélectionner</b>. Orange = à vérifier (sur une ligne ou vue sur une seule photo).</p>
        <div class="editor-wrap"><svg id="editor" class="editor"></svg>
          <button class="btn small zoom" id="zoom" type="button">🔍 Loupe</button></div>
        <div id="chips" class="chips"></div>
        <div id="sel-tools" class="row wrap" hidden><span class="muted">Flèche sélectionnée :</span>
          <button class="btn small danger" id="sel-del" type="button">Retirer</button>
          <span class="muted small">ou forcer le score ↓</span></div>
        <div class="keypad">${[10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0].map((v) => `<button type="button" data-key="${v}" class="${Faces.scoreClass(v)}">${Faces.fmt(v)}</button>`).join('')}</div>
        <p class="muted small">Le pavé ajoute un score sans position (saisie manuelle rapide), ou corrige la flèche sélectionnée.</p>
      </section>
      <div class="row wrap actions sticky-actions">
        <button class="btn primary big" id="save">Enregistrer la volée</button>
        ${isNew ? '' : '<button class="btn danger" id="del-end">Supprimer la volée</button>'}
      </div>`;

    // ---- photos
    const showPhoto = (i, blob, label) => {
      photos[i] = blob;
      $('#thumb' + i).innerHTML = blob ? `<img src="${URL.createObjectURL(blob)}" alt="Photo ${i ? 'droite' : 'gauche'}">${label ? `<span class="thumb-name">${esc(label)}</span>` : ''}` : `<span>Photo ${i ? 'droite' : 'gauche'}</span>`;
      $('#analyze').disabled = !photos.some(Boolean);
    };
    const loadPair = (p) => {
      showPhoto(0, p.G?.blob || null, p.G?.name);
      showPhoto(1, p.D?.blob || null, p.D?.name);
      photoKey = p.key;
      renderReuse();
    };
    // clés déjà rattachées à une autre volée de la séance
    const usedKeys = new Set((s.ends || []).filter((_, i) => i !== idx).map((e) => e.photoKey).filter(Boolean));
    function renderReuse() {
      const box = $('#reuse');
      if (!savedPairs.length) { box.innerHTML = ''; return; }
      // suggestion : photos portant le numéro de cette volée et rattachées à aucune autre volée
      const sugg = !photoKey && savedPairs.find((p) => p.num === idx + 1 && !usedKeys.has(p.key));
      box.innerHTML = `
        ${sugg ? `<div class="reuse-hint">📁 Des photos enregistrées existent pour la volée ${idx + 1} (<b>${esc((sugg.G || sugg.D).name.replace(/-[GD]\.jpg$/, ''))}</b>).
          <button type="button" class="btn small primary" data-reuse="${sugg.key}">Réutiliser ces photos</button></div>` : ''}
        <details class="reuse-list"><summary>📂 Photos enregistrées de cette séance (${savedPairs.length})</summary>
          <div class="pair-list">${savedPairs.map((p) => `
            <button type="button" class="pair-pick ${p.key === photoKey ? 'on' : ''}" data-reuse="${p.key}">
              ${['G', 'D'].map((sd) => (p[sd] ? `<img src="${URL.createObjectURL(p[sd].blob)}" alt="">` : '<span class="ph-empty"></span>')).join('')}
              <span>Volée ${p.key}${usedKeys.has(p.key) ? ' · utilisée' : ''}</span></button>`).join('')}</div>
        </details>`;
      $$('[data-reuse]', box).forEach((b) => { b.onclick = () => { loadPair(savedPairs.find((p) => p.key === b.dataset.reuse)); toast('Photos chargées : touchez « Analyser » pour recompter.'); }; });
    }
    $$('input[data-photo]').forEach((inp) => { inp.onchange = () => {
      const file = inp.files[0];
      if (!file) return;
      showPhoto(+inp.dataset.photo, file);
      photoKey = null; // nouvelle photo : la paire sera enregistrée à part
      renderReuse();
      inp.value = '';
    }; });
    // volée existante : on recharge ses photos pour pouvoir les revoir ou relancer l'analyse
    if (!isNew && end.photoKey) { const p = savedPairs.find((x) => x.key === end.photoKey); if (p) loadPair(p); }
    renderReuse();
    $('#analyze').onclick = async () => {
      const btn = $('#analyze'), st = $('#an-status');
      btn.disabled = true; st.textContent = 'Analyse en cours… (quelques secondes)';
      await new Promise((r) => setTimeout(r, 30));
      try {
        const t0 = performance.now();
        analysis = await Vision.analyze(photos[0], photos[1], f.kind === 'trispot' ? 'trispot' : 'full', apE);
        end.arrows = analysis.arrows.map((a) => {
          const sc = Faces.score(f, Math.hypot(a.x, a.y), state.settings.arrowDiam);
          return { x: +a.x.toFixed(3), y: +a.y.toFixed(3), spot: a.spot, s: sc.s, auto: true, doubt: sc.onLine || !a.both };
        });
        const nv = analysis.views.map((v) => (v ? (v.ok ? `${v.arrows.length} flèche(s)` : v.message) : '—'));
        st.innerHTML = `${end.arrows.length} flèche(s) détectée(s) sur ${apE} attendue(s) · gauche : ${esc(nv[0])} · droite : ${esc(nv[1])} · ${Math.round(performance.now() - t0)} ms`
          + (end.arrows.length < apE ? '<br><b>Il manque des flèches : touchez la cible pour les ajouter.</b>' : '');
        drawAnalysisViews();
        // flèches groupées au centre : loupe automatique pour faciliter la vérification
        zoom = end.arrows.length > 0 && end.arrows.every((a) => Math.hypot(a.x, a.y) < (f.kind === 'trispot' ? 2.5 : 4.5));
        $('#zoom').classList.toggle('on', zoom);
        selected = -1; redraw();
      } catch (e) { console.error(e); st.textContent = 'Échec de l\'analyse : ' + e.message + '. Saisissez la volée manuellement.'; }
      btn.disabled = false;
    };
    function drawAnalysisViews() {
      const box = $('#an-views');
      box.innerHTML = '';
      analysis.views.forEach((v, i) => {
        if (!v || !v.canvas) return;
        const c = document.createElement('canvas');
        c.width = v.W; c.height = v.H;
        const g = c.getContext('2d');
        g.drawImage(v.canvas, 0, 0);
        g.lineWidth = Math.max(2, v.W / 300);
        for (const sp of v.spots) for (const e of sp.ells) {
          g.beginPath();
          for (let k = 0; k <= 72; k++) { const a = (k / 72) * 2 * Math.PI, p = sp.family.toImage(e.r * Math.cos(a), e.r * Math.sin(a)); k ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y); }
          g.strokeStyle = 'rgba(0,255,90,.85)'; g.stroke();
        }
        for (const sh of v.shafts) {
          g.strokeStyle = 'rgba(255,0,200,.9)'; g.beginPath(); g.moveTo(sh.tail.x, sh.tail.y); g.lineTo(sh.tip.x, sh.tip.y); g.stroke();
          g.fillStyle = '#00e5ff'; g.beginPath(); g.arc(sh.tip.x, sh.tip.y, v.W / 90, 0, 7); g.fill();
        }
        const fig = document.createElement('figure');
        fig.append(c);
        fig.insertAdjacentHTML('beforeend', `<figcaption>${i ? 'Droite' : 'Gauche'} : anneaux repérés (vert), tubes (rose), pointes (cyan)</figcaption>`);
        box.append(fig);
      });
    }

    // ---- éditeur de cible
    const svg = $('#editor');
    function setViewBox() {
      const vb = Faces.viewBox(f);
      if (zoom) {
        const c = f.kind === 'trispot' ? { x: 0, y: 0, R: 3.2 } : { x: 0, y: 0, R: 5.2 };
        // trispot : loupe sur le spot où se trouve le plus de flèches
        if (f.kind === 'trispot') {
          const n = [0, 1, 2].map((sp) => end.arrows.filter((a) => (a.spot || 0) === sp).length);
          c.y = Faces.spotCenter(f, n.indexOf(Math.max(...n))).y;
        }
        svg.setAttribute('viewBox', `${c.x - c.R} ${c.y - c.R} ${2 * c.R} ${2 * c.R}`);
      } else svg.setAttribute('viewBox', `${vb.x} ${vb.y} ${vb.w} ${vb.h}`);
    }
    function redraw() {
      setViewBox();
      let h = Faces.targetSVG(f);
      end.arrows.forEach((a, i) => {
        if (!Number.isFinite(a.x)) return;
        const p = Faces.toSVG(f, a);
        h += `<g class="arrow ${a.doubt ? 'doubt' : ''} ${i === selected ? 'sel' : ''}" data-i="${i}" transform="translate(${p.x} ${p.y})">
          <circle r="${zoom ? 0.4 : 0.5}" class="halo"/><circle r="${Math.max(0.1, state.settings.arrowDiam / 20 / Faces.ringWidthCm(f))}" class="pt"/>
          <text y="${zoom ? -0.5 : -0.62}" style="font-size:${zoom ? 0.5 : 0.62}px">${Faces.fmt(a.s)}</text></g>`;
      });
      svg.innerHTML = h;
      const sorted = end.arrows.map((a, i) => ({ a, i })).sort((x, y) => y.a.s - x.a.s);
      $('#chips').innerHTML = sorted.map(({ a, i }) => `<button type="button" class="chip ${Faces.scoreClass(a.s)} ${a.doubt ? 'doubt' : ''} ${i === selected ? 'sel' : ''}" data-chip="${i}">${Faces.fmt(a.s)}${Number.isFinite(a.x) ? '' : '<small>✎</small>'}</button>`).join('')
        + `<span class="chip-total">${end.arrows.length}/${apE} flèches · <b>${Stats.endTotal(end)} pts</b></span>`;
      $('#sel-tools').hidden = selected < 0;
      $$('[data-chip]').forEach((b) => { b.onclick = () => { selected = +b.dataset.chip === selected ? -1 : +b.dataset.chip; redraw(); }; });
    }
    const svgPoint = (ev) => { const pt = svg.createSVGPoint(); pt.x = ev.clientX; pt.y = ev.clientY; return pt.matrixTransform(svg.getScreenCTM().inverse()); };
    let drag = null;
    svg.addEventListener('pointerdown', (ev) => {
      const g = ev.target.closest('.arrow');
      const p = svgPoint(ev);
      if (g) {
        const i = +g.dataset.i, a = end.arrows[i], c = Faces.toSVG(f, a);
        drag = { i, dx: c.x - p.x, dy: c.y - p.y, moved: false, x0: ev.clientX, y0: ev.clientY };
        svg.setPointerCapture(ev.pointerId);
      } else drag = { add: true, x0: ev.clientX, y0: ev.clientY };
      ev.preventDefault();
    });
    svg.addEventListener('pointermove', (ev) => {
      if (!drag || drag.add) return;
      if (!drag.moved && Math.hypot(ev.clientX - drag.x0, ev.clientY - drag.y0) < 6) return;
      drag.moved = true;
      const p = svgPoint(ev), a = end.arrows[drag.i];
      Object.assign(a, Faces.fromSVG(f, p.x + drag.dx, p.y + drag.dy));
      rescore(a); a.doubt = Faces.score(f, Math.hypot(a.x, a.y), state.settings.arrowDiam).onLine;
      const g = svg.querySelector(`.arrow[data-i="${drag.i}"]`), c = Faces.toSVG(f, a);
      g.setAttribute('transform', `translate(${c.x} ${c.y})`);
      g.querySelector('text').textContent = Faces.fmt(a.s);
    });
    svg.addEventListener('pointerup', (ev) => {
      if (!drag) return;
      if (drag.add) {
        if (Math.hypot(ev.clientX - drag.x0, ev.clientY - drag.y0) < 8) {
          const p = svgPoint(ev), a = { ...Faces.fromSVG(f, p.x, p.y), s: 0 };
          rescore(a);
          end.arrows.push(a);
          selected = -1;
        }
      } else if (!drag.moved) selected = selected === drag.i ? -1 : drag.i;
      drag = null;
      redraw();
    });
    function rescore(a) {
      a.x = +a.x.toFixed(3); a.y = +a.y.toFixed(3);
      a.s = Faces.score(f, Math.hypot(a.x, a.y), state.settings.arrowDiam).s;
      delete a.manual;
    }
    $('#zoom').onclick = () => { zoom = !zoom; $('#zoom').classList.toggle('on', zoom); redraw(); };
    $('#sel-del').onclick = () => { if (selected >= 0) { end.arrows.splice(selected, 1); selected = -1; redraw(); } };
    $$('[data-key]').forEach((b) => { b.onclick = () => {
      const v = +b.dataset.key;
      if (selected >= 0) { end.arrows[selected].s = v; end.arrows[selected].manual = true; end.arrows[selected].doubt = false; selected = -1; }
      else end.arrows.push({ s: v, manual: true });
      redraw();
    }; });
    $('#save').onclick = async () => {
      if (!end.arrows.length) { toast('Aucune flèche dans cette volée.'); return; }
      if (end.arrows.length !== apE && !confirm(`Cette volée contient ${end.arrows.length} flèche(s) au lieu de ${apE}. Enregistrer quand même ?`)) return;
      end.arrows.forEach((a) => { delete a.doubt; delete a.auto; });
      end.at = end.at || Date.now();
      // photos : nouvelles → enregistrées et nommées ; réutilisées → simple rattachement
      let copied = 0;
      if (photos.some(Boolean) && !photoKey) {
        const btn = $('#save');
        btn.disabled = true; btn.textContent = 'Enregistrement des photos…';
        try {
          const { key, saved } = await Photos.savePair(s, idx + 1, photos);
          end.photoKey = key;
          Photos.persist();
          if (state.settings.photoCopy) { await Photos.downloadAll(saved); copied = saved.length; }
        } catch (e) { console.error(e); toast('Photos non enregistrées : ' + e.message); }
      } else if (photoKey) end.photoKey = photoKey;
      s.ends = s.ends || [];
      if (isNew) s.ends.push(end); else s.ends[idx] = end;
      await DB.put('sessions', s);
      toast(`Volée ${idx + 1} enregistrée : ${Stats.endTotal(end)} pts${end.photoKey ? ` · photos ${s.date}-${s.distance}m-${end.photoKey}` : ''}${copied ? ' (copiées dans Téléchargements)' : ''}`, 3500);
      location.hash = '#/s/' + s.id;
    };
    if (!isNew) $('#del-end').onclick = async () => {
      if (!confirm('Supprimer cette volée ?' + (end.photoKey ? '\n(Ses photos restent enregistrées : vous pourrez les réutiliser en recréant la volée.)' : ''))) return;
      s.ends.splice(idx, 1);
      await DB.put('sessions', s);
      location.hash = '#/s/' + s.id;
    };
    redraw();
  }

  // ======================================================================= feuille de marque imprimable
  async function scoreSheet(id) {
    const s = await DB.get('sessions', id);
    if (!s) { location.hash = '#/'; return; }
    const f = Faces.get(s.faceId), sm = Stats.summary(s), a = state.archers.find((x) => x.id === s.archerId);
    const all = (s.ends || []).flatMap((e) => e.arrows), g = Stats.grouping(all);
    view.innerHTML = `
      <div class="no-print row wrap actions"><button class="btn primary" id="print">🖨 Imprimer / Enregistrer en PDF</button><a class="btn" href="#/s/${s.id}">Retour</a>
        <span class="muted small">Dans la fenêtre d'impression, choisissez « Enregistrer au format PDF ».</span></div>
      <article class="print-sheet">
        <header><h1>Feuille de marque</h1>
          <dl class="meta"><div><dt>Archer</dt><dd>${esc(a?.name || '')}</dd></div><div><dt>Date</dt><dd>${esc(fmtDate(s.date))}</dd></div>
          <div><dt>Lieu</dt><dd>${esc(s.place || '–')}</dd></div><div><dt>Distance</dt><dd>${esc(s.distance)} m</dd></div>
          <div><dt>Blason</dt><dd>${esc(f.label)}</dd></div><div><dt>Matériel</dt><dd>${esc(s.equipment || a?.bow || '–')}</dd></div></dl></header>
        ${sheetTable(s)}
        <div class="sum-line"><b>Total : ${sm.total} / ${sm.max}</b> · ${sm.arrows} flèches · moyenne ${r1(sm.avgArrow, 2)} / flèche · ${r1(sm.avgEnd, 1)} / volée · 10 : ${sm.tens} · 9 : ${sm.nines} · M : ${sm.misses}</div>
        <div class="print-bottom">
          ${all.some((x) => Number.isFinite(x.x)) ? `<div class="print-map">${Stats.impactMap(f, all)}${g ? `<p>Groupement ${r1(g.rms * Faces.ringWidthCm(f))} cm · ${Stats.direction(g)}</p>` : ''}</div>` : ''}
          <div class="print-notes"><h3>Ressenti ${s.feeling?.rating ? '★'.repeat(s.feeling.rating) + '☆'.repeat(5 - s.feeling.rating) : ''}</h3><p>${esc(s.feeling?.text || '')}</p>
          ${s.notes ? `<h3>Notes</h3><p>${esc(s.notes)}</p>` : ''}
          <div class="sign"><span>Signature archer</span><span>Signature marqueur</span></div></div>
        </div>
      </article>`;
    $('#print').onclick = () => window.print();
  }

  // ======================================================================= statistiques
  async function statsView() {
    const sessions = (await sessionsOfArcher()).filter((s) => (s.ends || []).length);
    const prev = statsView.filters || { dist: '', face: '', period: '0' };
    const dists = [...new Set(sessions.map((s) => s.distance))].sort((a, b) => a - b);
    const faces = [...new Set(sessions.map((s) => s.faceId))];
    view.innerHTML = `
      <h1>Statistiques</h1>
      <div class="filters">
        <label>Distance<select id="fl-dist"><option value="">Toutes</option>${dists.map((d) => `<option value="${d}" ${String(d) === prev.dist ? 'selected' : ''}>${d} m</option>`).join('')}</select></label>
        <label>Blason<select id="fl-face"><option value="">Tous</option>${faces.map((id) => `<option value="${id}" ${id === prev.face ? 'selected' : ''}>${Faces.get(id).label}</option>`).join('')}</select></label>
        <label>Période<select id="fl-period">${[['0', 'Tout'], ['30', '30 jours'], ['90', '3 mois'], ['365', '1 an']].map(([v, l]) => `<option value="${v}" ${v === prev.period ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      </div>
      <div id="st-body"></div>`;
    const draw = () => {
      const fl = statsView.filters = { dist: $('#fl-dist').value, face: $('#fl-face').value, period: $('#fl-period').value };
      const since = +fl.period ? new Date(Date.now() - fl.period * 864e5).toISOString().slice(0, 10) : '';
      const list = sessions.filter((s) => (!fl.dist || String(s.distance) === fl.dist) && (!fl.face || s.faceId === fl.face) && (!since || s.date >= since))
        .sort((a, b) => a.date.localeCompare(b.date));
      const body = $('#st-body');
      if (!list.length) { body.innerHTML = '<div class="card muted">Aucune séance avec des volées pour ces filtres.</div>'; return; }
      const sums = list.map((s) => ({ s, sm: Stats.summary(s) }));
      const arrows = list.flatMap((s) => s.ends.flatMap((e) => e.arrows));
      const total = Stats.sum(arrows.map((a) => a.s)), ends = Stats.sum(sums.map((x) => x.sm.ends));
      const best = sums.reduce((b, x) => (!b || x.sm.avgArrow > b.sm.avgArrow ? x : b), null);
      const byDist = dists.map((d) => {
        const xs = sessions.filter((s) => s.distance === d && (!fl.face || s.faceId === fl.face) && (!since || s.date >= since)).flatMap((s) => s.ends.flatMap((e) => e.arrows));
        return xs.length ? { label: d + ' m', value: Stats.sum(xs.map((a) => a.s)) / xs.length, tip: `${d} m : ${r1(Stats.sum(xs.map((a) => a.s)) / xs.length, 2)} pts/flèche sur ${xs.length} flèches` } : null;
      }).filter(Boolean);
      const distrib = [10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0].map((v) => { const n = arrows.filter((a) => a.s === v).length; return { label: Faces.fmt(v), value: (100 * n) / arrows.length, tip: `${Faces.fmt(v)} : ${n} flèche(s), ${r1((100 * n) / arrows.length)} %` }; })
        .filter((d, i, arr) => d.value > 0 || arr.slice(i).some((x) => x.value > 0));
      const mapFace = Faces.get(fl.face || list[list.length - 1].faceId);
      const g = Stats.grouping(arrows);
      body.innerHTML = `
        <div class="tiles">
          <div class="tile"><div class="k">Séances</div><div class="v">${list.length}</div></div>
          <div class="tile"><div class="k">Flèches</div><div class="v">${arrows.length}</div></div>
          <div class="tile"><div class="k">Moyenne / flèche</div><div class="v">${r1(total / arrows.length, 2)}</div></div>
          <div class="tile"><div class="k">Moyenne / volée</div><div class="v">${r1(total / ends, 1)}</div></div>
          <div class="tile"><div class="k">Meilleure séance</div><div class="v">${r1(best.sm.avgArrow, 2)}<small> /fl.</small></div><div class="small muted">${esc(shortDate(best.s.date))} · ${best.s.distance} m</div></div>
        </div>
        <section class="card"><h2>Progression — moyenne par flèche</h2>
          ${Stats.lineChart(sums.map((x) => ({ label: shortDate(x.s.date), y: x.sm.avgArrow, tip: `${fmtDate(x.s.date)} · ${x.s.distance} m · ${x.sm.total}/${x.sm.max} · ${r1(x.sm.avgArrow, 2)} pts/flèche` })), { yLabel: 'Moyenne par flèche' })}</section>
        ${byDist.length > 1 ? `<section class="card"><h2>Comparaison des distances — moyenne par flèche</h2>${Stats.barChart(byDist, { yMax: 10 })}</section>` : ''}
        <section class="card"><h2>Répartition des points (% des flèches)</h2>${Stats.barChart(distrib, { valueFmt: (v) => r1(v, 0) + ' %' })}</section>
        ${arrows.some((a) => Number.isFinite(a.x)) ? `<section class="card"><h2>Carte des impacts</h2><div class="map-wrap">${Stats.impactMap(mapFace, arrows, { foldTrispot: true })}</div>
          ${g ? `<p class="center">${g.n} impacts positionnés · centre du groupe : <b>${Stats.direction(g)}</b> · écart moyen ${r1(g.rms, 2)} anneau(x)</p>` : ''}</section>` : ''}
        <section class="card"><h2>Détail des séances</h2><div class="scroll-x"><table class="data">
          <thead><tr><th>Date</th><th>Dist.</th><th>Blason</th><th>Volées</th><th>Total</th><th>Moy./flèche</th><th>Groupement</th></tr></thead>
          <tbody>${sums.slice().reverse().map(({ s, sm }) => { const gg = Stats.grouping(s.ends.flatMap((e) => e.arrows)); const ff = Faces.get(s.faceId); return `<tr onclick="location.hash='#/s/${s.id}'"><td>${esc(shortDate(s.date))}</td><td>${s.distance} m</td><td>${esc(ff.label)}</td><td>${sm.ends}</td><td>${sm.total}/${sm.max}</td><td>${r1(sm.avgArrow, 2)}</td><td>${gg ? r1(gg.rms * Faces.ringWidthCm(ff)) + ' cm' : '–'}</td></tr>`; }).join('')}</tbody>
        </table></div></section>`;
    };
    $$('.filters select').forEach((s) => { s.onchange = draw; });
    draw();
  }

  // ======================================================================= archers
  async function archersView() {
    view.innerHTML = `
      <h1>Archers</h1>
      <div class="list">${state.archers.map((a) => `
        <div class="card row between wrap">
          <div><div class="title">${esc(a.name)} ${a.id === state.archerId ? '<span class="badge">actif</span>' : ''}</div><div class="muted small">${esc(a.bow || '')}</div></div>
          <div class="row"><button class="btn small" data-use="${a.id}">Choisir</button><button class="btn small" data-edit="${a.id}">Renommer</button><button class="btn small danger" data-del="${a.id}">Supprimer</button></div>
        </div>`).join('')}</div>
      <form id="f-archer" class="card stack"><h2>Ajouter un archer</h2>
        <div class="grid2"><label>Nom<input name="name" required></label><label>Arc<input name="bow" placeholder="ex. Barebow, classique…"></label></div>
        <button class="btn primary">Ajouter</button></form>`;
    $('#f-archer').onsubmit = async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const a = await DB.put('archers', { name: fd.get('name').trim(), bow: fd.get('bow').trim() });
      if (!state.archerId) { state.archerId = a.id; await DB.setSetting('archerId', a.id); }
      await loadState(); archersView();
    };
    $$('[data-use]').forEach((b) => { b.onclick = async () => { state.archerId = b.dataset.use; await DB.setSetting('archerId', state.archerId); renderArcherSelect(); location.hash = '#/'; }; });
    $$('[data-edit]').forEach((b) => { b.onclick = async () => {
      const a = await DB.get('archers', b.dataset.edit);
      const name = prompt('Nom de l\'archer', a.name); if (!name) return;
      const bow = prompt('Arc', a.bow || '') ?? a.bow;
      Object.assign(a, { name: name.trim(), bow: bow.trim() }); await DB.put('archers', a); await loadState(); archersView();
    }; });
    $$('[data-del]').forEach((b) => { b.onclick = async () => {
      if (!confirm('Supprimer cet archer et toutes ses séances ?')) return;
      for (const s of (await DB.all('sessions')).filter((s) => s.archerId === b.dataset.del)) await DB.remove('sessions', s.id);
      await DB.remove('archers', b.dataset.del);
      await loadState(); archersView();
    }; });
  }

  // ======================================================================= réglages, export, synchro
  async function settingsView() {
    view.innerHTML = `
      <h1>Réglages</h1>
      <section class="card stack"><h2>Flèches</h2>
        <label>Diamètre des tubes (mm)<input type="number" id="diam" min="4" max="12" step="0.1" value="${state.settings.arrowDiam}"></label>
        <p class="muted small">Sert à compter les flèches « sur la ligne » (qui comptent pour la zone supérieure). Bois 5/16″ ≈ 7,9 mm · 11/32″ ≈ 8,7 mm.</p></section>
      <section class="card stack"><h2>Photos des volées</h2>
        <p class="muted small">Les deux photos de chaque volée sont conservées dans l'application, nommées <code>date-distance-volée-G</code> / <code>-D</code>
          (ex. <code>2026-10-15-18m-03-G.jpg</code>). Elles restent disponibles si vous supprimez puis recréez une volée.</p>
        <label class="check"><input type="checkbox" id="ph-copy" ${state.settings.photoCopy ? 'checked' : ''}>
          Copier aussi automatiquement chaque photo dans le téléphone (dossier Téléchargements)</label>
        <p id="ph-usage" class="muted small">Calcul de l'espace utilisé…</p></section>
      <section class="card stack"><h2>Synchronisation Google Sheets</h2>
        <p class="muted small">Permet de retrouver vos séances sur le PC et le smartphone. Installez le script fourni (fichier <code>google-apps-script/Code.gs</code>, voir LISEZMOI) puis collez ici l'URL de l'application Web.</p>
        <label>URL du script<input id="sheets" type="url" placeholder="https://script.google.com/macros/s/…/exec" value="${esc(state.settings.sheetsUrl)}"></label>
        <div class="row wrap"><button class="btn primary" id="sync">🔄 Synchroniser maintenant</button><span id="sync-st" class="muted small"></span></div></section>
      <section class="card stack"><h2>Sauvegarde et export</h2>
        <div class="row wrap"><button class="btn" id="exp-json">💾 Sauvegarde complète (.json)</button>
        <label class="btn">📂 Restaurer une sauvegarde<input type="file" id="imp-json" accept="application/json,.json" hidden></label>
        <button class="btn" id="exp-csv">📊 Export des volées (.csv)</button></div></section>
      <section class="card stack"><h2>Application</h2>
        <p class="muted small">Fonctionne hors ligne une fois installée. Toutes les données restent sur cet appareil (sauf si vous synchronisez avec votre Google Sheets).</p>
        <button class="btn" id="install" hidden>📲 Installer l'application</button></section>`;
    $('#ph-copy').onchange = async (e) => { state.settings.photoCopy = e.target.checked; await DB.setSetting('photoCopy', state.settings.photoCopy); };
    (async () => {
      const meta = await DB.allPhotosMeta(), size = meta.reduce((t, p) => t + p.size, 0);
      let free = '';
      try { const est = await navigator.storage.estimate(); if (est.quota) free = ` · place disponible pour l'application : ${Photos.fmtSize(est.quota - est.usage)}`; } catch { /* non disponible */ }
      const persisted = navigator.storage?.persisted ? await navigator.storage.persisted() : false;
      $('#ph-usage').textContent = `${meta.length} photo(s) enregistrée(s), ${Photos.fmtSize(size)}${free}${persisted ? ' · stockage protégé contre l\'effacement automatique' : ''}.`;
    })();
    $('#diam').onchange = async (e) => { state.settings.arrowDiam = +e.target.value || 8; await DB.setSetting('arrowDiam', state.settings.arrowDiam); toast('Diamètre enregistré'); };
    $('#sheets').onchange = async (e) => { state.settings.sheetsUrl = e.target.value.trim(); await DB.setSetting('sheetsUrl', state.settings.sheetsUrl); };
    $('#sync').onclick = async () => {
      const st = $('#sync-st');
      state.settings.sheetsUrl = $('#sheets').value.trim();
      await DB.setSetting('sheetsUrl', state.settings.sheetsUrl);
      if (!state.settings.sheetsUrl) { st.textContent = 'Indiquez d\'abord l\'URL du script.'; return; }
      st.textContent = 'Synchronisation…';
      try { const r = await sync(state.settings.sheetsUrl); st.textContent = `Terminé : ${r.pulled} élément(s) reçu(s), ${r.pushed} envoyé(s).`; await loadState(); }
      catch (e) { st.textContent = 'Échec : ' + e.message; }
    };
    $('#exp-json').onclick = async () => download(`archerie-sauvegarde-${today()}.json`, JSON.stringify({ app: 'archerie', version: 1, archers: await DB.all('archers', true), sessions: await DB.all('sessions', true) }, null, 1), 'application/json');
    $('#imp-json').onchange = async (e) => {
      try {
        const d = JSON.parse(await e.target.files[0].text());
        const n = (await DB.mergeRecords('archers', d.archers || [])) + (await DB.mergeRecords('sessions', d.sessions || []));
        await loadState(); toast(`${n} élément(s) importé(s)`);
      } catch (err) { toast('Fichier invalide : ' + err.message); }
    };
    $('#exp-csv').onclick = async () => {
      const archers = await DB.all('archers'), rows = [['archer', 'date', 'lieu', 'distance_m', 'blason', 'volee', ...Array.from({ length: 6 }, (_, i) => 'f' + (i + 1)), 'total']];
      for (const s of (await DB.all('sessions')).sort((a, b) => a.date.localeCompare(b.date))) {
        const a = archers.find((x) => x.id === s.archerId);
        (s.ends || []).forEach((e, i) => {
          const sc = e.arrows.map((x) => x.s).sort((p, q) => q - p);
          rows.push([a?.name || '', s.date, s.place || '', s.distance, Faces.get(s.faceId).label, i + 1, ...Array.from({ length: Math.max(6, sc.length) }, (_, k) => (sc[k] ?? '')), Stats.endTotal(e)]);
        });
      }
      download(`archerie-volees-${today()}.csv`, '﻿' + rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(';')).join('\r\n'), 'text/csv');
    };
    if (deferredInstall) { $('#install').hidden = false; $('#install').onclick = () => deferredInstall.prompt(); }
  }
  function download(name, text, type) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type }));
    a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }
  // Synchronisation : on récupère d'abord (le plus récent gagne), puis on envoie tout.
  async function sync(url) {
    const r = await fetch(url + (url.includes('?') ? '&' : '?') + 'action=pull', { redirect: 'follow' });
    if (!r.ok) throw new Error('lecture impossible (HTTP ' + r.status + ')');
    const d = await r.json();
    if (d.error) throw new Error(d.error);
    const pulled = (await DB.mergeRecords('archers', d.archers || [])) + (await DB.mergeRecords('sessions', d.sessions || []));
    const archers = await DB.all('archers', true), sessions = await DB.all('sessions', true);
    const w = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ action: 'push', archers, sessions }) });
    const res = await w.json();
    if (res.error) throw new Error(res.error);
    return { pulled, pushed: archers.length + sessions.length };
  }

  // ======================================================================= info-bulles des graphiques
  const tip = $('#tip');
  const showTip = (el, x, y) => { tip.textContent = el.dataset.tip; tip.hidden = false; tip.style.left = Math.min(x + 12, innerWidth - tip.offsetWidth - 8) + 'px'; tip.style.top = (y - tip.offsetHeight - 12) + 'px'; };
  document.addEventListener('pointerover', (e) => { const el = e.target.closest('[data-tip]'); if (el) showTip(el, e.clientX, e.clientY); });
  document.addEventListener('pointermove', (e) => { const el = e.target.closest('[data-tip]'); if (el) showTip(el, e.clientX, e.clientY); else tip.hidden = true; });
  document.addEventListener('pointerout', (e) => { if (e.target.closest('[data-tip]')) tip.hidden = true; });

  // ======================================================================= installation / hors ligne
  let deferredInstall = null;
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferredInstall = e; });
  if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});

  loadState().then(route);
})();
