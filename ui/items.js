"use strict";
// Onglet Objets : liste virtualisée (milliers de lignes, seules les lignes visibles existent dans le DOM).
(function () {
  const TT = (window.TT = window.TT || {});
  const { esc, fmtPrice } = TT.store;
  const $ = (id) => document.getElementById(id);
  const ROW = 54;

  const F = { q: "", cat: "all", sort: "name", needed: false };
  let list = [], selected = null, raf = 0;

  const needed = () => TT.store.neededItems();

  function compute() {
    const idx = TT.store.S.idx;
    if (!idx) { list = []; return; }
    const q = F.q.trim().toLowerCase(), need = F.needed ? needed() : null;
    list = Object.values(idx.items).filter((it) => {
      if (F.cat !== "all" && !(it.category && it.category.name === F.cat)) return false;
      if (need && !need.has(it.id)) return false;
      return !q || (it.name || "").toLowerCase().includes(q) || (it.shortName || "").toLowerCase().includes(q);
    });
    const price = (it) => it.avg24hPrice || it.basePrice || 0;
    list.sort(F.sort === "price" ? (a, b) => price(b) - price(a) : (a, b) => (a.name || "").localeCompare(b.name || ""));
    $("i-count").textContent = `${list.length} objet(s)`;
    $("i-spacer").style.height = list.length * ROW + "px";
    $("i-scroll").scrollTop = 0;
  }

  function paint() {
    raf = 0;
    const sc = $("i-scroll"), idx = TT.store.S.idx;
    if (!idx) return;
    const h = sc.clientHeight || 600;
    const first = Math.max(0, Math.floor(sc.scrollTop / ROW) - 4);
    const last = Math.min(list.length, Math.ceil((sc.scrollTop + h) / ROW) + 4);
    const need = needed();
    let html = "";
    for (let i = first; i < last; i++) {
      const it = list[i];
      html += `<button class="irow${it.id === selected ? " sel" : ""}${need.has(it.id) ? " need" : ""}" style="top:${i * ROW}px" data-id="${esc(it.id)}" type="button">` +
        `<span class="ico">${it.iconLink ? `<img src="${esc(it.iconLink)}" alt="" loading="lazy" onerror="this.remove()">` : ""}</span>` +
        `<span class="in"><b>${esc(it.name)}${need.has(it.id) ? `<i class="need-tag">× ${need.get(it.id).count}${need.get(it.id).fir ? " FIR" : ""}</i>` : ""}</b><small>${esc(it.category ? it.category.name : "")}</small></span>` +
        `<span class="ip">${fmtPrice(it.avg24hPrice || it.basePrice)}</span></button>`;
    }
    $("i-rows").innerHTML = html;
  }
  const schedule = () => { if (!raf) raf = requestAnimationFrame(paint); };

  function detail() {
    const st = TT.store, idx = st.S.idx, it = selected && idx && idx.items[selected];
    const box = $("i-detail");
    if (!it) { box.innerHTML = '<p class="dim pad">Sélectionne un objet dans la liste.</p>'; return; }
    const uses = idx.usage[it.id] || [];
    const where = idx.lootByItem[it.id] || {};
    let h = `<header class="qhead"><h2>${esc(it.name)}</h2></header>` +
      `<div class="meta"><span>${esc(it.category ? it.category.name : "")}</span><span>${it.width}×${it.height}</span></div>` +
      `<div class="kv"><span>Prix de base</span><b>${fmtPrice(it.basePrice)}</b><span>Moyenne 24 h (marché)</span><b>${fmtPrice(it.avg24hPrice)}</b></div>`;
    const nd = needed().get(it.id);
    if (nd) {
      h += `<h3>À trouver pour tes quêtes en cours</h3><p class="needline"><b>× ${nd.count}</b>${nd.fir ? " <span class=\"tag\">Trouvé en raid</span>" : ""}</p><div class="links">` +
        nd.quests.map((q) => `<button class="link st-started" data-task="${esc(q.task.id)}" type="button"><i class="dot"></i>${esc(q.task.name)} <em>× ${q.count}</em></button>`).join("") + "</div>";
    }
    h += '<h3>Toutes les quêtes concernées</h3>';
    // Une quête qui demande de trouver puis de remettre le même objet ne doit apparaître qu'une fois.
    const byTask = new Map();
    for (const u of uses) {
      const e = byTask.get(u.taskId) || { count: 0, fir: false };
      e.count = Math.max(e.count, u.obj.count || 1); e.fir = e.fir || !!u.obj.foundInRaid;
      byTask.set(u.taskId, e);
    }
    h += byTask.size ? '<div class="links">' + [...byTask].map(([tid, u]) => {
      const t = idx.tasks[tid], s = st.stateOf(t);
      return `<button class="link st-${s}" data-task="${esc(t.id)}" type="button"><i class="dot"></i>${esc(t.name)}${u.count > 1 ? " × " + u.count : ""}${u.fir ? " (FIR)" : ""}</button>`;
    }).join("") + "</div>" : '<p class="dim">Cet objet n\'apparaît dans aucun objectif de quête.</p>';
    h += "<h3>Loot au sol</h3>";
    const maps = Object.entries(where).sort((a, b) => b[1] - a[1]);
    h += maps.length ? '<div class="links">' + maps.map(([slug, n]) => {
      const def = (TT.mapDefs || []).find((m) => m.slug === slug);
      return `<button class="link" data-loc="${esc(slug)}" type="button">${esc(def ? def.name : slug)} <em>${n} emplacement(s)</em></button>`;
    }).join("") + "</div>" : '<p class="dim">Aucun emplacement connu de loot au sol (il peut se trouver dans des conteneurs).</p>';
    box.innerHTML = h;
  }

  function select(id) {
    selected = id;
    // On fait défiler jusqu'à l'objet si on le trouve dans la liste actuelle.
    let i = list.findIndex((x) => x.id === id);
    if (i < 0 && TT.store.S.idx) { F.q = ""; F.cat = "all"; F.needed = false; $("i-search").value = ""; $("i-cat").value = "all"; $("i-needed").checked = false; compute(); i = list.findIndex((x) => x.id === id); }
    if (i >= 0) $("i-scroll").scrollTop = Math.max(0, i * ROW - 80);
    paint(); detail();
  }

  function render() {
    const idx = TT.store.S.idx, cat = $("i-cat");
    if (idx && cat.options.length <= 1) idx.categories.forEach(([n, c]) => cat.append(new Option(`${n} (${c})`, n)));
    if (!idx) { $("i-count").textContent = ""; $("i-rows").innerHTML = ""; $("i-spacer").style.height = "0"; $("i-detail").innerHTML = `<p class="dim pad">${esc(TT.store.emptyMessage())}</p>`; return; }
    compute(); paint(); detail();
  }

  function init() {
    $("i-cat").append(new Option("Toutes les catégories", "all"));
    $("i-search").addEventListener("input", (e) => { F.q = e.target.value; compute(); paint(); });
    $("i-cat").addEventListener("change", (e) => { F.cat = e.target.value; compute(); paint(); });
    $("i-sort").addEventListener("change", (e) => { F.sort = e.target.value; compute(); paint(); });
    $("i-needed").addEventListener("change", (e) => { F.needed = e.target.checked; compute(); paint(); });
    $("i-scroll").addEventListener("scroll", schedule, { passive: true });
    $("i-rows").addEventListener("click", (e) => { const b = e.target.closest("[data-id]"); if (b) { selected = b.dataset.id; paint(); detail(); } });
    $("i-detail").addEventListener("click", (e) => {
      const b = e.target.closest("[data-task],[data-loc]");
      if (!b) return;
      if (b.dataset.task) { TT.nav.show("quests"); TT.quests.select(b.dataset.task); }
      else if (TT.mapview.locateItem(selected, b.dataset.loc)) TT.nav.show("map");
    });
    TT.store.on((k) => { if (k === "data") { $("i-cat").length = 1; render(); } else if (k === "progress") { paint(); detail(); } else if (k === "status" && !TT.store.S.idx) render(); });
    render();
  }

  TT.items = { init, render, select, onShow: schedule };
})();
