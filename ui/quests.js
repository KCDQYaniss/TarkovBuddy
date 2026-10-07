"use strict";
// Onglet Quêtes : bandeau de synchro, onglets marchands, puces de statut, liste à gauche, détail ou tableau de bord à droite.
(function () {
  const TT = (window.TT = window.TT || {});
  const { esc, slugOf } = TT.store;
  const $ = (id) => document.getElementById(id);

  const STATE_LABEL = { finished: "Terminée", started: "En cours", failed: "Échouée", available: "Disponible", locked: "Verrouillée" };
  const ACT_LABEL = { started: "démarrée", finished: "terminée", failed: "échouée" };
  const CHIPS = [["all", "Toutes"], ["started", "En cours"], ["available", "Disponibles"], ["locked", "Verrouillées"], ["finished", "Terminées"], ["failed", "Échouées"]];
  const TYPE_LABEL = {
    visit: "Visiter", mark: "Marquer", giveItem: "Remettre", findItem: "Trouver", shoot: "Éliminer", extract: "Extraire",
    plantItem: "Placer", plantQuestItem: "Placer", findQuestItem: "Trouver", giveQuestItem: "Remettre", taskStatus: "Quête",
    playerLevel: "Niveau", skill: "Compétence", buildWeapon: "Arme", useItem: "Utiliser", traderLevel: "Marchand",
    experience: "Santé", traderStanding: "Réputation",
  };
  const ORDER = { started: 0, available: 1, locked: 2, failed: 3, finished: 4 };
  const mapName = (slug) => { const d = (TT.mapDefs || []).find((m) => m.slug === slugOf(slug)); return d ? d.name : String(slug).replace(/-/g, " "); };

  // « auto » = « En cours » s'il y a des quêtes en cours, sinon « Toutes » (jusqu'à ce que tu choisisses).
  const F = { trader: "all", state: "auto", map: "all", q: "", kappa: false };
  let selected = null;
  const tasks = () => { const i = TT.store.S.idx; return i ? Object.values(i.tasks) : []; };
  const when = (ms) => {
    const d = new Date(ms), now = new Date();
    return d.toDateString() === now.toDateString()
      ? d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })
      : d.toLocaleString("fr-FR", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  };

  /** Quêtes qui passent tous les filtres sauf le statut. */
  function pool() {
    const q = F.q.trim().toLowerCase();
    return tasks().filter((t) => {
      if (F.trader !== "all" && (!t.trader || t.trader.normalizedName !== F.trader)) return false;
      if (F.kappa && !t.kappaRequired) return false;
      if (F.map !== "all") {
        const m = (t.map && slugOf(t.map.normalizedName)) === F.map || (t.objectives || []).some((o) => (o.maps || []).some((x) => slugOf(x.normalizedName) === F.map));
        if (!m) return false;
      }
      return !q || t.name.toLowerCase().includes(q);
    });
  }

  /* ---------- Bandeau de synchro ---------- */
  function renderSync() {
    const S = TT.store.S, sy = S.sync, box = $("q-sync");
    const btn = (act, label) => `<button class="btn sm" data-act="${act}" type="button">${label}</button>`;
    let cls = "syncbar", html;
    if (!window.__TAURI__) html = `<span>Mode démo : la synchro avec les logs n'est disponible que dans l'application.</span>`;
    else if (TT.logsOk === false) { cls += " warn"; html = `<span>Dossier des logs introuvable : la synchro des quêtes est désactivée.</span>${btn("settings", "Configurer")}`; }
    else if (sy.busy) html = `<span>Synchronisation avec tes logs…</span>`;
    else if (sy.error) { cls += " warn"; html = `<span>${esc(sy.error)}</span>${btn("rescan", "Réessayer")}`; }
    else if (sy.lastAt && sy.events === 0) {
      cls += " warn";
      html = `<span>Aucun évènement de quête dans tes logs${sy.files != null ? ` (${sy.files} fichier(s) lus)` : ""}. Tes quêtes se suivront en direct dès que tu en démarres ou en termines une, et tu peux les régler à la main : « Terminée » déduit aussi les prérequis.</span>${btn("rescan", "Resynchroniser")}${btn("settings", "Diagnostic")}`;
    } else if (sy.lastAt) {
      html = `<span class="okdot"></span><span>Synchronisé avec tes logs · ${TT.store.agoMs(sy.lastAt)} · ${sy.events} évènement(s)${sy.files != null ? ` dans ${sy.files} fichier(s)` : ""}${sy.changed ? ` · ${sy.changed} quête(s) mise(s) à jour` : ""}${sy.inferred ? ` · ${sy.inferred} prérequis déduit(s)` : ""}</span>${btn("rescan", "Resynchroniser")}`;
    } else html = `<span>En attente de la première synchro avec tes logs…</span>`;
    box.className = cls; box.innerHTML = html;
  }

  /* ---------- Marchands, puces ---------- */
  function renderTraders() {
    const idx = TT.store.S.idx, st = TT.store;
    const count = (list) => `${list.filter((t) => st.stateOf(t) === "finished").length}/${list.length}`;
    let h = `<button class="subtab${F.trader === "all" ? " on" : ""}" data-trader="all" type="button" role="tab">Tous <em>${count(tasks())}</em></button>`;
    for (const tr of idx.traders) {
      const list = tasks().filter((t) => t.trader && t.trader.normalizedName === tr.normalizedName);
      h += `<button class="subtab${F.trader === tr.normalizedName ? " on" : ""}" data-trader="${esc(tr.normalizedName)}" type="button" role="tab">${esc(tr.name)} <em>${count(list)}</em></button>`;
    }
    $("q-traders").innerHTML = h;
  }
  function renderStates(counts, active) {
    $("q-states").innerHTML = CHIPS.map(([k, l]) => `<button class="chip-tab${k === active ? " on" : ""}" data-state="${k}" type="button">${l} <em>${counts[k]}</em></button>`).join("");
  }

  /* ---------- Liste ---------- */
  function renderList(list, active) {
    const st = TT.store;
    $("q-count").textContent = `${list.length} quête(s)`;
    const empty = {
      started: "Aucune quête en cours. Démarre-en une dans le jeu (elle apparaîtra ici toute seule), ou choisis « Disponibles ».",
      available: "Aucune quête disponible avec ces filtres.", finished: "Aucune quête terminée avec ces filtres.",
    }[active] || "Aucune quête ne correspond aux filtres.";
    $("q-list").innerHTML = list.map((t) => {
      const s = st.stateOf(t), mn = t.map ? mapName(t.map.normalizedName) : "";
      return `<button class="qitem st-${s}${t.id === selected ? " sel" : ""}" data-id="${esc(t.id)}" type="button">` +
        `<i class="dot"></i><span class="qn">${esc(t.name)}</span><span class="qm">${esc(mn)}</span><em>niv. ${t.minPlayerLevel || 1}</em></button>`;
    }).join("") || `<p class="dim pad">${empty}</p>`;
  }

  /* ---------- Détail d'une quête ---------- */
  function objectiveHtml(o) {
    const st = TT.store, idx = st.S.idx, done = !!st.S.progress.objectives[o.id];
    let extra = "";
    const ids = [...(o.items || []), ...(o.useAny || [])];
    if (ids.length) {
      extra = '<div class="oitems">' + ids.slice(0, 6).map((i) => {
        const it = idx.items[i.id];
        return it ? `<button class="chip-item" data-item="${esc(it.id)}" type="button">${it.iconLink ? `<img src="${esc(it.iconLink)}" alt="" loading="lazy" onerror="this.remove()">` : ""}${esc(it.shortName || it.name)}</button>` : "";
      }).join("") + (ids.length > 6 ? `<span class="dim">+${ids.length - 6}</span>` : "") +
        (o.count > 1 ? `<span class="dim">× ${o.count}</span>` : "") + (o.foundInRaid ? '<span class="tag">Trouvé en raid</span>' : "") + "</div>";
    }
    return `<li class="obj${done ? " done" : ""}"><label class="chk"><input type="checkbox" data-obj="${esc(o.id)}"${done ? " checked" : ""}>` +
      `<span><span class="tag">${esc(TYPE_LABEL[o.type] || o.type)}</span> ${esc(o.description)}${o.optional ? ' <span class="tag opt">Facultatif</span>' : ""}</span></label>${extra}</li>`;
  }

  function renderDetail() {
    const st = TT.store, idx = st.S.idx, t = selected && idx.tasks[selected];
    const box = $("q-detail");
    if (!t) { box.innerHTML = summaryHtml(); return; }
    const s = st.stateOf(t), reason = st.lockReason(t), inferred = !!st.S.progress.inferred[t.id];
    const reqs = (t.taskRequirements || []).map((r) => ({ t: idx.tasks[r.task && r.task.id], r })).filter((x) => x.t);
    const unlocks = tasks().filter((x) => (x.taskRequirements || []).some((r) => r.task && r.task.id === t.id));
    const btns = [];
    if (s === "available" || s === "locked") btns.push(["started", "Démarrer", "primary"], ["finished", "Marquer terminée", ""]);
    if (s === "started") btns.push(["finished", "Terminer", "primary"], ["failed", "Échouée", ""]);
    if (s !== "available" && s !== "locked") btns.push(["reset", "Réinitialiser", ""]);
    box.innerHTML =
      `<header class="qhead"><h2>${esc(t.name)}</h2><span class="state st-${s}">${STATE_LABEL[s]}</span>${inferred ? '<span class="tag" title="Déduite : une quête suivante est démarrée ou terminée">déduite</span>' : ""}</header>` +
      `<div class="meta"><span>${esc(t.trader ? t.trader.name : "")}</span><span>Niveau ${t.minPlayerLevel || 1}</span>` +
      (t.map ? `<span>${esc(mapName(t.map.normalizedName))}</span>` : "") +
      (t.kappaRequired ? '<span class="tag">Kappa</span>' : "") + (t.lightkeeperRequired ? '<span class="tag">Gardien</span>' : "") + "</div>" +
      (reason ? `<p class="lock">${esc(reason)}</p>` : "") +
      '<div class="actions">' + btns.map(([v, l, c]) => `<button class="btn ${c}" data-set="${v}" type="button">${l}</button>`).join("") +
      '<button class="btn" data-act="onmap" type="button">Voir sur la carte</button><button class="btn ghost" data-act="back" type="button">Tableau de bord</button></div>' +
      '<h3>Objectifs</h3><ul class="objs">' + (t.objectives || []).map(objectiveHtml).join("") + "</ul>" +
      (reqs.length ? '<h3>Prérequis</h3><div class="links">' + reqs.map((x) => `<button class="link st-${st.stateOf(x.t)}" data-id="${esc(x.t.id)}" type="button"><i class="dot"></i>${esc(x.t.name)}</button>`).join("") + "</div>" : "") +
      (unlocks.length ? '<h3>Débloque</h3><div class="links">' + unlocks.map((x) => `<button class="link st-${st.stateOf(x)}" data-id="${esc(x.id)}" type="button"><i class="dot"></i>${esc(x.name)}</button>`).join("") + "</div>" : "");
  }

  /* ---------- Tableau de bord (aucune quête sélectionnée) ---------- */
  function summaryHtml() {
    const st = TT.store, s = st.stats(), idx = st.S.idx;
    const pct = (a, b) => (b ? Math.round((100 * a) / b) : 0);
    const link = (t, extra) => `<button class="link st-${st.stateOf(t)}" data-id="${esc(t.id)}" type="button"><i class="dot"></i>${esc(t.name)}${extra || ""}</button>`;
    let h = '<h2 class="sumtitle">Ta progression</h2><div class="bars">' +
      `<div class="bar"><span>Quêtes terminées</span><b>${s.finished} / ${s.total}</b><i style="--p:${pct(s.finished, s.total)}%"></i></div>` +
      `<div class="bar"><span>Quêtes Kappa</span><b>${s.kappaDone} / ${s.kappaTotal}</b><i style="--p:${pct(s.kappaDone, s.kappaTotal)}%"></i></div></div>` +
      `<div class="kv"><span>En cours</span><b>${s.started}</b><span>Disponibles</span><b>${s.available}</b><span>Verrouillées</span><b>${s.locked}</b><span>Échouées</span><b>${s.failed}</b></div>`;
    const started = st.startedTasks();
    h += "<h3>À faire maintenant</h3>";
    h += started.length ? '<div class="links">' + started.map((t) => {
      const o = (t.objectives || []).find((x) => !st.S.progress.objectives[x.id] && !x.optional);
      return link(t, o ? ` <em>${esc(o.description).slice(0, 60)}</em>` : "");
    }).join("") + "</div>" : '<p class="dim">Aucune quête en cours. Démarre-en une dans le jeu : elle apparaîtra ici toute seule.</p>';
    const avail = tasks().filter((t) => st.stateOf(t) === "available").sort((a, b) => (a.minPlayerLevel || 0) - (b.minPlayerLevel || 0)).slice(0, 8);
    if (avail.length) h += "<h3>Prochaines quêtes disponibles</h3>" + '<div class="links">' + avail.map((t) => link(t, ` <em>niv. ${t.minPlayerLevel || 1}</em>`)).join("") + "</div>";
    const act = st.S.progress.activity.filter((a) => idx.tasks[a.id]).slice(0, 10);
    h += "<h3>Activité récente</h3>";
    h += act.length ? '<div class="feed">' + act.map((a) => `<button class="feeditem st-${a.status}" data-id="${esc(a.id)}" type="button"><i class="dot"></i><span>Quête ${ACT_LABEL[a.status]}</span><b>${esc(idx.tasks[a.id].name)}</b><em>${when(a.at)} · ${a.src === "logs" ? "logs du jeu" : "à la main"}</em></button>`).join("") + "</div>" : '<p class="dim">Rien pour le moment.</p>';
    return h;
  }

  /* ---------- Rendu global ---------- */
  function render() {
    renderSync();
    const idx = TT.store.S.idx;
    if (!idx) {
      $("q-detail").innerHTML = ""; $("q-list").innerHTML = `<p class="dim pad">${esc(TT.store.emptyMessage())}</p>`;
      $("q-traders").innerHTML = ""; $("q-states").innerHTML = ""; $("q-count").textContent = ""; return;
    }
    const st = TT.store, base = pool();
    const counts = { all: base.length, started: 0, available: 0, locked: 0, finished: 0, failed: 0 };
    for (const t of base) counts[st.stateOf(t)]++;
    const active = F.state === "auto" ? (counts.started > 0 ? "started" : "all") : F.state;
    const list = (active === "all" ? base : base.filter((t) => st.stateOf(t) === active))
      .sort((a, b) => ORDER[st.stateOf(a)] - ORDER[st.stateOf(b)] || (a.minPlayerLevel || 0) - (b.minPlayerLevel || 0) || a.name.localeCompare(b.name));
    renderTraders(); renderStates(counts, active); renderList(list, active); renderDetail();
    const lv = $("q-level");
    if (document.activeElement !== lv) lv.value = st.S.progress.level || "";
  }
  const relist = () => render();

  function init() {
    const sel = $("q-map");
    sel.append(new Option("Toutes les maps", "all"));
    (TT.mapDefs || []).forEach((m) => sel.append(new Option(m.name, m.slug)));
    $("q-traders").addEventListener("click", (e) => { const b = e.target.closest("[data-trader]"); if (b) { F.trader = b.dataset.trader; relist(); } });
    $("q-states").addEventListener("click", (e) => { const b = e.target.closest("[data-state]"); if (b) { F.state = b.dataset.state; relist(); } });
    $("q-list").addEventListener("click", (e) => { const b = e.target.closest("[data-id]"); if (b) { selected = b.dataset.id; render(); } });
    $("q-search").addEventListener("input", (e) => { F.q = e.target.value; relist(); });
    sel.addEventListener("change", (e) => { F.map = e.target.value; relist(); });
    $("q-kappa").addEventListener("change", (e) => { F.kappa = e.target.checked; relist(); });
    $("q-level").addEventListener("change", (e) => TT.store.setLevel(e.target.value));
    $("q-sync").addEventListener("click", (e) => {
      const b = e.target.closest("[data-act]");
      if (!b) return;
      if (b.dataset.act === "rescan") TT.store.rescan(); else if (b.dataset.act === "settings") TT.openSettings && TT.openSettings(true);
    });
    $("q-detail").addEventListener("click", (e) => {
      const b = e.target.closest("[data-set],[data-id],[data-item],[data-act]");
      if (!b) return;
      if (b.dataset.set) TT.store.setTaskStatus(selected, b.dataset.set === "reset" ? null : b.dataset.set);
      else if (b.dataset.id) { selected = b.dataset.id; render(); }
      else if (b.dataset.item) { TT.nav.show("items"); TT.items.select(b.dataset.item); }
      else if (b.dataset.act === "back") { selected = null; render(); }
      else if (b.dataset.act === "onmap") { if (TT.mapview.focusTaskOnMap(selected)) TT.nav.show("map"); else TT.notify("Cette quête n'a pas de position sur une carte connue.", "warn"); }
    });
    $("q-detail").addEventListener("change", (e) => { if (e.target.dataset.obj) TT.store.toggleObjective(e.target.dataset.obj); });
    TT.store.on((k) => { if (["data", "progress", "status", "sync"].includes(k)) render(); });
    render();
  }

  TT.quests = { init, render, select: (id) => { selected = id; render(); }, filters: F };
})();
