"use strict";
// Données du jeu (cache disque via Tauri), progression des quêtes, synchronisation avec les logs, index de recherche.
(function () {
  const T = window.__TAURI__;
  const invoke = T ? T.core.invoke : null;
  const TT = (window.TT = window.TT || {});

  // L'API sépare parfois des variantes d'une même carte : on les fusionne sur la carte de base.
  const ALIAS = { "ground-zero-21": "ground-zero", "night-factory": "factory" };
  const slugOf = (s) => ALIAS[s] || s;
  const TRADER_ORDER = ["prapor", "therapist", "skier", "peacekeeper", "mechanic", "ragman", "jaeger", "ref", "lightkeeper"];
  const STATUSES = new Set(["started", "finished", "failed"]);
  const ITEM_TYPES = new Set(["findItem", "giveItem", "plantItem", "useItem", "mark", "buildWeapon"]);

  const freshProgress = () => ({ v: 2, tasks: {}, at: {}, inferred: {}, objectives: {}, level: null, activity: [] });
  const S = {
    lang: localStorage.getItem("lang") || "fr",
    data: null, idx: null,
    progress: freshProgress(),
    sync: { lastAt: 0, events: 0, files: null, sessions: null, changed: 0, inferred: 0, error: "", busy: false },
    busy: "", error: "", retryAt: 0,
  };
  const listeners = new Set();
  const emit = (kind) => listeners.forEach((f) => { try { f(kind); } catch (e) { console.error(e); } });
  const notify = (text, kind) => TT.notify && TT.notify(text, kind);

  /* ---------- Utilitaires ---------- */
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fmtPrice = (n) => (n == null ? "—" : n.toLocaleString("fr-FR") + " ₽");
  function ago(ts) {
    if (!ts) return "jamais";
    const m = Math.max(0, Math.round((Date.now() / 1000 - ts) / 60));
    if (m < 2) return "à l'instant";
    if (m < 90) return `il y a ${m} min`;
    const h = Math.round(m / 60);
    if (h < 48) return `il y a ${h} h`;
    return `il y a ${Math.round(h / 24)} j`;
  }
  const agoMs = (ms) => (ms ? ago(ms / 1000) : "jamais");
  const hhmm = (ms) => new Date(ms).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });

  /* ---------- Index ---------- */
  function buildIndex(data) {
    const idx = { items: {}, tasks: {}, traders: [], maps: {}, lootByItem: {}, usage: {}, categories: [] };
    for (const it of data.items || []) idx.items[it.id] = it;

    const traders = {};
    for (const t of data.tasks || []) {
      idx.tasks[t.id] = t;
      if (t.trader) traders[t.trader.normalizedName] = t.trader;
      for (const o of t.objectives || []) {
        const ids = [];
        (o.items || []).forEach((i) => ids.push(i.id));
        (o.useAny || []).forEach((i) => ids.push(i.id));
        if (o.markerItem) ids.push(o.markerItem.id);
        for (const id of ids) (idx.usage[id] = idx.usage[id] || []).push({ taskId: t.id, obj: o });
      }
    }
    idx.traders = Object.values(traders).sort((a, b) => {
      const ia = TRADER_ORDER.indexOf(a.normalizedName), ib = TRADER_ORDER.indexOf(b.normalizedName);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.name.localeCompare(b.name);
    });

    for (const m of data.maps || []) {
      const slug = slugOf(m.normalizedName);
      const e = (idx.maps[slug] = idx.maps[slug] || {
        slug, name: m.name, nameId: m.nameId, raidDuration: m.raidDuration, players: m.players,
        extracts: [], transits: [], spawns: [], containers: [], loose: [], stationary: [], bosses: [],
      });
      if (m.normalizedName === slug) { e.name = m.name; e.raidDuration = m.raidDuration; e.players = m.players; }
      e.extracts.push(...(m.extracts || []).filter((x) => x.position));
      e.transits.push(...(m.transits || []).filter((x) => x.position));
      e.spawns.push(...(m.spawns || []).filter((x) => x.position));
      e.containers.push(...(m.lootContainers || []).filter((x) => x.position && x.lootContainer));
      e.loose.push(...(m.lootLoose || []).filter((x) => x.position));
      e.stationary.push(...(m.stationaryWeapons || []).filter((x) => x.position));
      if (m.normalizedName === slug || !e.bosses.length) e.bosses = m.bosses || e.bosses;
    }
    for (const [slug, m] of Object.entries(idx.maps)) {
      for (const l of m.loose) for (const it of l.items || []) {
        const o = (idx.lootByItem[it.id] = idx.lootByItem[it.id] || {});
        o[slug] = (o[slug] || 0) + 1;
      }
    }
    const cats = {};
    for (const it of data.items || []) { const c = it.category && it.category.name; if (c) cats[c] = (cats[c] || 0) + 1; }
    idx.categories = Object.entries(cats).sort((a, b) => a[0].localeCompare(b[0]));
    return idx;
  }

  function setData(data) {
    S.data = data;
    S.idx = buildIndex(data);
    if (inferPrereqs()) scheduleSave();
    emit("data");
  }

  /* ---------- Progression : persistance ---------- */
  let saveTimer = null;
  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      const json = JSON.stringify(S.progress);
      try {
        if (invoke) await invoke("save_progress", { json });
        else localStorage.setItem("progress", json);
      } catch (e) { console.error("sauvegarde progression", e); }
    }, 500);
  }
  async function loadProgress() {
    try {
      const txt = invoke ? await invoke("load_progress") : localStorage.getItem("progress");
      if (txt) { S.progress = Object.assign(freshProgress(), JSON.parse(txt)); S.progress.v = 2; }
    } catch (e) { console.error("lecture progression", e); }
  }

  /* ---------- Progression : états des quêtes ---------- */
  const STATUS_TO_REQ = { finished: "complete", started: "active", failed: "failed" };
  const reqMet = (req) => {
    const st = S.progress.tasks[req.task && req.task.id];
    return !!st && (req.status || []).includes(STATUS_TO_REQ[st]);
  };
  const unmetReqs = (task) => (task.taskRequirements || []).filter((r) => !reqMet(r));
  const levelOk = (task) => !S.progress.level || !task.minPlayerLevel || S.progress.level >= task.minPlayerLevel;

  /** 'finished' | 'started' | 'failed' | 'available' | 'locked' */
  function stateOf(task) {
    const st = S.progress.tasks[task.id];
    if (st) return st;
    return !unmetReqs(task).length && levelOk(task) ? "available" : "locked";
  }
  /** Pourquoi une quête est verrouillée (texte), ou "" si elle ne l'est pas. */
  function lockReason(task) {
    if (S.progress.tasks[task.id]) return "";
    const un = unmetReqs(task).map((r) => (S.idx && S.idx.tasks[r.task && r.task.id] || {}).name).filter(Boolean);
    if (un.length) return "Prérequis : " + un.slice(0, 3).join(", ") + (un.length > 3 ? ` (+${un.length - 3})` : "");
    if (!levelOk(task)) return `Niveau ${task.minPlayerLevel} requis`;
    return "";
  }
  const startedTasks = () => Object.values(S.idx ? S.idx.tasks : {}).filter((t) => S.progress.tasks[t.id] === "started");

  function completeObjectives(taskId) {
    const t = S.idx && S.idx.tasks[taskId];
    if (t) for (const o of t.objectives || []) S.progress.objectives[o.id] = true;
  }
  function clearObjectives(taskId) {
    const t = S.idx && S.idx.tasks[taskId];
    if (t) for (const o of t.objectives || []) delete S.progress.objectives[o.id];
  }
  function recordActivity(id, status, at, src) {
    const a = S.progress.activity;
    if (a.some((x) => x.id === id && x.status === status && x.at === at)) return;
    a.unshift({ id, status, at, src });
    a.sort((x, y) => y.at - x.at);
    if (a.length > 60) a.length = 60;
  }

  /**
   * Applique un évènement venant des logs. Un évènement plus ancien que l'état déjà connu (par exemple un choix
   * manuel fait depuis) est ignoré : rejouer l'historique ne défait donc jamais tes réglages récents.
   */
  function applyOne(ev, src) {
    const { id, status } = ev || {};
    if (!id || !STATUSES.has(status)) return false;
    const at = ev.at || Date.now();
    const known = S.progress.tasks[id];
    const prev = S.progress.at[id] || 0;
    const inferred = !!S.progress.inferred[id];
    if (known && !inferred && ev.at && ev.at < prev) return false;       // plus ancien que ce qu'on sait
    if (known === status && !inferred) { S.progress.at[id] = Math.max(prev, at); return false; }
    S.progress.tasks[id] = status;
    S.progress.at[id] = at;
    delete S.progress.inferred[id];
    if (status === "finished") completeObjectives(id);
    recordActivity(id, status, at, src);
    return true;
  }

  /** Une quête commencée ou terminée implique que ses prérequis « terminés » le sont aussi. */
  function inferPrereqs() {
    if (!S.idx) return 0;
    const stack = Object.values(S.idx.tasks).filter((t) => ["started", "finished"].includes(S.progress.tasks[t.id]));
    let n = 0;
    while (stack.length) {
      const t = stack.pop();
      for (const r of t.taskRequirements || []) {
        const rid = r.task && r.task.id;
        if (!rid || S.progress.tasks[rid] || !(r.status || []).includes("complete")) continue;
        S.progress.tasks[rid] = "finished"; S.progress.at[rid] = 1; S.progress.inferred[rid] = true;
        completeObjectives(rid); n++;
        if (S.idx.tasks[rid]) stack.push(S.idx.tasks[rid]);
      }
    }
    return n;
  }

  function setTaskStatus(id, status) {
    if (status) {
      S.progress.tasks[id] = status; S.progress.at[id] = Date.now(); delete S.progress.inferred[id];
      if (status === "finished") completeObjectives(id);
      recordActivity(id, status, S.progress.at[id], "manuel");
      inferPrereqs();
    } else {
      delete S.progress.tasks[id]; delete S.progress.at[id]; delete S.progress.inferred[id];
      clearObjectives(id);
    }
    scheduleSave(); emit("progress");
  }
  function toggleObjective(id) {
    if (S.progress.objectives[id]) delete S.progress.objectives[id]; else S.progress.objectives[id] = true;
    scheduleSave(); emit("progress");
  }
  function setLevel(n) {
    const v = Math.round(Number(n));
    S.progress.level = v >= 1 && v <= 79 ? v : null;
    scheduleSave(); emit("progress");
  }

  const STATUS_LABEL = { started: "démarrée", finished: "terminée", failed: "échouée" };
  /** Évènement en direct : on prévient l'utilisateur, c'est le « suivi dynamique ». */
  function applyTaskEvent(ev) {
    const changed = applyOne(ev, "logs");
    if (!changed) return false;
    const inferred = inferPrereqs();
    S.sync.lastAt = Date.now();
    scheduleSave(); emit("progress");
    const t = S.idx && S.idx.tasks[ev.id];
    notify(`Quête ${STATUS_LABEL[ev.status]} : ${t ? t.name : ev.id}${inferred ? ` (+${inferred} prérequis déduit${inferred > 1 ? "s" : ""})` : ""}`, ev.status === "failed" ? "warn" : "ok");
    return true;
  }
  /** Historique (relecture des logs) : appliqué dans l'ordre chronologique. */
  function applyHistory(events, meta) {
    const before = Object.assign({}, S.progress.tasks);
    for (const ev of [...(events || [])].sort((a, b) => (a.at || 0) - (b.at || 0))) applyOne(ev, "logs");
    const inferred = inferPrereqs();
    const changed = Object.keys(S.progress.tasks).filter((id) => S.progress.tasks[id] !== before[id]).length;
    S.sync = Object.assign({}, S.sync, meta || {}, { lastAt: Date.now(), events: (events || []).length, changed, inferred, error: "", busy: false });
    if (changed) scheduleSave();
    emit("progress"); emit("sync");
    return { changed, inferred };
  }
  async function rescan(quiet) {
    if (!invoke) { notify("La resynchronisation n'est disponible que dans l'application.", "warn"); return null; }
    if (S.sync.busy) return null;
    S.sync.busy = true; emit("sync");
    try {
      const rep = await invoke("rescan_quests");
      const r = applyHistory(rep.events, { files: rep.files, sessions: rep.sessions });
      if (!quiet) {
        notify(rep.events.length
          ? `Synchro terminée : ${rep.events.length} évènement(s) lus dans ${rep.files} fichier(s), ${r.changed} quête(s) mise(s) à jour${r.inferred ? `, ${r.inferred} prérequis déduit(s)` : ""}.`
          : `Aucun évènement de quête trouvé dans ${rep.files} fichier(s) de ${rep.sessions} session(s). Lance le diagnostic dans Réglages.`, rep.events.length ? "ok" : "warn");
      }
      return r;
    } catch (e) {
      S.sync = Object.assign({}, S.sync, { error: String(e), busy: false });
      emit("sync");
      if (!quiet) notify(String(e), "warn");
      return null;
    }
  }

  /* ---------- Statistiques et besoins ---------- */
  function stats() {
    if (!S.idx) return null;
    const out = { total: 0, finished: 0, started: 0, failed: 0, available: 0, locked: 0, kappaTotal: 0, kappaDone: 0 };
    for (const t of Object.values(S.idx.tasks)) {
      const st = stateOf(t);
      out.total++; out[st]++;
      if (t.kappaRequired) { out.kappaTotal++; if (st === "finished") out.kappaDone++; }
    }
    return out;
  }
  /** Objets à trouver pour les quêtes en cours : id -> { count, fir, quests: [{ task, count }] }. */
  function neededItems() {
    const out = new Map();
    for (const t of startedTasks()) {
      const per = new Map();
      for (const o of t.objectives || []) {
        if (S.progress.objectives[o.id] || o.optional || !ITEM_TYPES.has(o.type)) continue;
        for (const i of o.items || []) {
          const e = per.get(i.id) || { count: 0, fir: false };
          e.count = Math.max(e.count, o.count || 1); e.fir = e.fir || !!o.foundInRaid;   // « trouver » puis « remettre » = un seul lot
          per.set(i.id, e);
        }
      }
      for (const [id, e] of per) {
        const g = out.get(id) || { count: 0, fir: false, quests: [] };
        g.count += e.count; g.fir = g.fir || e.fir; g.quests.push({ task: t, count: e.count });
        out.set(id, g);
      }
    }
    return out;
  }

  /* ---------- Chargement / actualisation ---------- */
  async function demoData() {
    try { return await (await fetch("demo/data.json")).json(); } catch (_) { return null; }
  }
  async function load() {
    await loadProgress();
    let text = null;
    try { text = invoke ? await invoke("load_cache", { lang: S.lang }) : null; } catch (e) { S.error = String(e); }
    if (text) { setData(JSON.parse(text)); }
    else if (!invoke) { const d = await demoData(); if (d) setData(d); }
    emit("status");
    const stale = !S.data || Date.now() / 1000 - (S.data.fetchedAt || 0) > 24 * 3600;
    if (invoke && stale) refresh(true);
  }

  // Réessai automatique quand le téléchargement échoue : 5 min, puis 10, 20, 30 max.
  let retryTimer = null, retryDelay = 5 * 60 * 1000;
  function scheduleRetry() {
    clearTimeout(retryTimer);
    S.retryAt = Date.now() + retryDelay;
    retryTimer = setTimeout(() => refresh(true), retryDelay);
    retryDelay = Math.min(retryDelay * 2, 30 * 60 * 1000);
  }
  /** Texte à afficher à la place d'une liste vide quand on n'a pas de données. */
  function emptyMessage() {
    if (S.busy) return S.busy;
    if (S.error) {
      const t = S.retryAt ? hhmm(S.retryAt) : "";
      return S.error.split("\n")[0] + (t ? ` Nouvelle tentative automatique vers ${t}, ou clique sur « Actualiser ».` : "");
    }
    return "Les données ne sont pas encore téléchargées. Clique sur « Actualiser ».";
  }
  async function refresh(silent) {
    if (!invoke) { S.error = "Mode démo : pas de téléchargement."; emit("status"); return; }
    if (S.busy) return;
    S.busy = "Téléchargement…"; S.error = ""; emit("status");
    try {
      const text = await invoke("refresh_data", { lang: S.lang });
      const d = JSON.parse(text);
      setData(d);
      (d.warnings || []).forEach((w) => TT.warn && TT.warn(w));
      clearTimeout(retryTimer); S.retryAt = 0; retryDelay = 5 * 60 * 1000;
      if (!silent) notify("Données à jour.", "ok");
    } catch (e) {
      // Un échec silencieux au démarrage ne doit pas gêner : les données en cache restent utilisables.
      S.error = String(e);
      scheduleRetry();
    } finally { S.busy = ""; emit("status"); }
  }
  if (T) T.event.listen("data-progress", (e) => { S.busy = e.payload; emit("status"); });
  async function setLang(lang) {
    S.lang = lang; localStorage.setItem("lang", lang); S.data = null; S.idx = null;
    emit("data"); await load();
  }

  TT.store = {
    S, setLang, emptyMessage, esc, fmtPrice, ago, agoMs, hhmm, slugOf, load, refresh, setData,
    stateOf, lockReason, setTaskStatus, toggleObjective, setLevel, applyTaskEvent, applyHistory, rescan, inferPrereqs,
    startedTasks, stats, neededItems,
    on: (f) => (listeners.add(f), () => listeners.delete(f)),
  };
})();
