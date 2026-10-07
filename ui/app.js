"use strict";
// Assemblage : navigation, réglages, évènements envoyés par le backend Rust.
(function () {
  const TT = (window.TT = window.TT || {});
  const T = window.__TAURI__;
  const DEMO = !T;
  const $ = (id) => document.getElementById(id);
  const invoke = T ? T.core.invoke : async () => { throw new Error("hors Tauri"); };
  const listen = T ? T.event.listen : async () => () => {};
  let state = null;
  let lastMapEvent = "";
  const shown = new Set();

  /** Message bref (vert = information, orange = attention) qui disparaît tout seul. */
  TT.notify = function (text, kind) {
    const li = document.createElement("li");
    li.className = kind === "warn" ? "" : "ok";
    li.textContent = text;
    $("warnings").appendChild(li);
    while ($("warnings").children.length > 5) $("warnings").firstChild.remove();
    setTimeout(() => li.remove(), kind === "warn" ? 12000 : 7000);
  };

  TT.warn = function (text) {
    if (!text || shown.has(text)) return;
    shown.add(text);
    const li = document.createElement("li");
    li.textContent = text;
    const x = document.createElement("button");
    x.type = "button"; x.className = "x"; x.setAttribute("aria-label", "Fermer"); x.textContent = "×";
    x.addEventListener("click", () => { li.remove(); shown.delete(text); });
    li.append(x);
    $("warnings").appendChild(li);
  };

  /* ---------- Navigation ---------- */
  const VIEWS = ["map", "quests", "items"];
  TT.nav = {
    show(view) {
      if (!VIEWS.includes(view)) view = "map";
      for (const v of VIEWS) {
        $("view-" + v).hidden = v !== view;
        const tab = document.querySelector(`[data-view="${v}"]`);
        tab.setAttribute("aria-selected", String(v === view));
      }
      localStorage.setItem("view", view);
      if (view === "map") TT.mapview.onShow();
      if (view === "items") TT.items.onShow();
    },
  };

  document.addEventListener("keydown", (e) => {
    const t = e.target, typing = t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName);
    if (typing || e.ctrlKey || e.altKey || e.metaKey || $("settings").open) return;
    if (e.key === "1" || e.key === "2" || e.key === "3") TT.nav.show(VIEWS[+e.key - 1]);
    else if (e.key === "f" || e.key === "F") { if (!$("view-map").hidden) TT.mapview.setFollow(!TT.mapview.isFollowing()); }
    else if (e.key === "/") {
      const box = !$("view-quests").hidden ? $("q-search") : !$("view-items").hidden ? $("i-search") : null;
      if (box) { e.preventDefault(); box.focus(); box.select(); }
    }
  });

  /* ---------- État des données ---------- */
  function renderBadges() {
    const st = TT.store;
    if (!st.S.idx) { $("badge-q").hidden = true; $("badge-i").hidden = true; return; }
    const q = st.startedTasks().length, i = st.neededItems().size;
    $("badge-q").hidden = !q; $("badge-q").textContent = q ? `> ${q}` : "";
    $("badge-i").hidden = !i; $("badge-i").textContent = i || "";
    $("badge-q").title = `${q} quête(s) en cours`; $("badge-i").title = `${i} objet(s) à trouver pour tes quêtes en cours`;
  }
  function renderSyncNote() {
    const sy = TT.store.S.sync, el = $("sync-note");
    el.textContent = sy.busy ? "Synchro des quêtes…" : sy.lastAt ? `Quêtes · ${TT.store.agoMs(sy.lastAt)}` : "";
    el.title = sy.lastAt ? "Dernière synchronisation des quêtes avec tes logs" : "";
  }
  function renderStatus() {
    const S = TT.store.S;
    const el = $("data-status");
    if (S.busy) el.textContent = S.busy;
    else if (S.error && S.retryAt) el.textContent = `Serveur de données indisponible · nouvel essai ${new Date(S.retryAt).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}`;
    else if (S.data) el.textContent = `Données · ${TT.store.ago(S.data.fetchedAt)}`;
    else el.textContent = "Aucune donnée";
    $("refresh-btn").disabled = !!S.busy;
    if (S.error) TT.warn(S.error);
  }

  /* ---------- Réglages ---------- */
  const fmtBytes = (n) => (n > 1048576 ? (n / 1048576).toFixed(1) + " Mo" : Math.max(1, Math.round(n / 1024)) + " Ko");
  function fmtDiag(d) {
    const L = [];
    L.push(`Dossier des logs : ${d.logs_dir || "introuvable"} (${d.logs_dir_source})`);
    L.push(`Sessions de logs : ${d.sessions}${d.latest_session ? " · dernière : " + d.latest_session : ""}`);
    if (d.files.length) {
      L.push("Fichiers de la dernière session :");
      d.files.forEach((f) => L.push(`  ${f.name} · ${fmtBytes(f.bytes)} · modifié ${f.modified_secs_ago == null ? "?" : "il y a " + f.modified_secs_ago + " s"}`));
    }
    L.push(`Dernière map trouvée dans les logs : ${d.last_map_raw ? d.last_map_raw + " → " + (d.last_map_slug || "non reconnue") : "aucune"}`);
    L.push(`Lignes « Location: » : ${d.location_lines}`);
    L.push(`Évènements de quête (dernière session) : ${d.task_events_latest_session}`);
    const dq = TT.store.S.data && TT.store.S.data.quality;
    L.push(dq
      ? `Données (json.tarkov.dev) : ${dq.tasks} quêtes dont ${dq.tasks_with_trader} avec marchand ; ${dq.objectives_with_zone}/${dq.objectives} objectifs placés sur une carte ; ${dq.items} objets (${dq.items_with_category} avec catégorie, ${dq.items_with_price} avec prix) ; ${dq.maps} cartes, ${dq.extracts} extractions, ${dq.containers} conteneurs (${dq.containers_named} nommés), ${dq.loose_points} emplacements de loot au sol`
      : "Données : pas encore téléchargées (ou ancien format)");
    L.push(`Dernier évènement de map reçu par l'app : ${lastMapEvent || "aucun depuis le lancement"}`);
    L.push(`Captures : ${d.screenshots_dir} (${d.screenshots_dir_exists ? "existe" : "absent"})${d.newest_screenshot ? " · la plus récente : " + d.newest_screenshot : ""}`);
    L.push("", "Conclusion :");
    d.hints.forEach((h) => L.push("  - " + h));
    if (d.recent_lines.length) { L.push("", "Dernières lignes du log (identifiants masqués) :"); d.recent_lines.forEach((l) => L.push("  " + l)); }
    if (d.tried.length) { L.push("", "Emplacements vérifiés automatiquement :"); d.tried.slice(0, 12).forEach((t) => L.push("  " + t)); }
    return L.join("\n");
  }
  async function runDiag() {
    const out = $("diag-out");
    if (DEMO) { out.textContent = "Le diagnostic n'est disponible que dans l'application."; return; }
    out.textContent = "Analyse en cours…";
    try { out.textContent = fmtDiag(await invoke("diagnose")); }
    catch (e) { out.textContent = "Échec du diagnostic : " + e; }
  }
  async function copyDiag() {
    const text = $("diag-out").textContent;
    try { await navigator.clipboard.writeText(text); TT.warn("Diagnostic copié dans le presse-papiers."); }
    catch (_) { const r = document.createRange(); r.selectNodeContents($("diag-out")); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r); TT.warn("Sélectionné : fais Ctrl+C pour copier."); }
  }

  function openSettings(withDiag) {
    $("s-shots").value = (state && state.screenshots_dir) || "";
    $("s-logs").value = (state && state.logs_dir) || "";
    $("s-delete").checked = !!(state && state.delete_screenshots);
    $("s-lang").value = TT.store.S.lang;
    $("settings").showModal();
    if (withDiag === true) { $("diag").open = true; runDiag(); }
  }
  TT.openSettings = openSettings;
  async function saveSettings() {
    const settings = {
      screenshots_dir: $("s-shots").value.trim() || null,
      logs_dir: $("s-logs").value.trim() || null,
      delete_screenshots: $("s-delete").checked,
    };
    try {
      shown.clear(); $("warnings").textContent = "";
      state = await invoke("apply_settings", { settings });
      state.warnings.forEach(TT.warn);
      TT.logsOk = !!state.logs_dir; TT.mapview.updateChip(); TT.quests.render();
      if (TT.logsOk) TT.store.rescan(true);
    } catch (e) { TT.warn(`Enregistrement impossible : ${e}`); }
    const lang = $("s-lang").value;
    if (lang !== TT.store.S.lang) TT.store.setLang(lang);
  }

  /* ---------- Démarrage ---------- */
  async function main() {
    TT.mapDefs = await (await fetch("maps.json")).json();
    TT.mapview.init(TT.mapDefs);
    TT.quests.init();
    TT.items.init();

    document.querySelectorAll("[data-view]").forEach((b) => b.addEventListener("click", () => TT.nav.show(b.dataset.view)));
    $("refresh-btn").addEventListener("click", () => TT.store.refresh());
    $("settings-btn").addEventListener("click", () => openSettings());
    $("diag-run").addEventListener("click", runDiag);
    $("diag-copy").addEventListener("click", copyDiag);
    $("settings-form").addEventListener("submit", (e) => { if (e.submitter && e.submitter.value === "save") saveSettings(); });
    TT.store.on((k) => {
      if (k === "status" || k === "data") renderStatus();
      if (k === "progress" || k === "data") renderBadges();
      if (k === "sync" || k === "progress") renderSyncNote();
    });

    // Les évènements de quêtes ne doivent être appliqués qu'une fois la progression sauvegardée relue.
    const ready = TT.store.load();
    await listen("position", (e) => TT.mapview.onPosition(e.payload));
    await listen("map", (e) => {
      lastMapEvent = `${e.payload.raw} → ${e.payload.slug || "non reconnue"}${e.payload.from_scene ? " (via la scène chargée)" : ""} à ${new Date().toLocaleTimeString("fr-FR")}`;
      TT.mapview.onMap(e.payload);
    });
    await listen("warning", (e) => TT.warn(e.payload));
    await listen("task", (e) => ready.then(() => TT.store.applyTaskEvent(e.payload)));
    if (!DEMO) {
      state = await invoke("get_state");
      state.warnings.forEach(TT.warn);
      TT.logsOk = !!state.logs_dir; TT.mapview.updateChip(); TT.quests.render();
      if (state.map) TT.mapview.onMap(state.map);
      if (state.position) TT.mapview.onPosition(state.position);
    } else {
      TT.warn("Mode démo : ouvert hors de l'application, données fictives.");
      TT.mapview.showSlug(TT.mapview.resolveSlug() || "customs");
      const def = TT.mapDefs.find((m) => m.slug === TT.mapview.current().slug);
      const b = def.bounds;
      setTimeout(() => TT.mapview.onPosition({ x: (b[0][0] + b[1][0]) / 2, y: 3.2, z: (b[0][1] + b[1][1]) / 2, fx: 0.7, fz: 0.7, yaw_deg: 45, file: "demo" }), 400);
    }
    await ready;
    renderStatus(); renderBadges();
    // Resynchronisation complète au démarrage : rattrape tout ce qui s'est passé pendant que l'app était fermée.
    if (!DEMO && TT.logsOk) TT.store.rescan(true).then((r) => {
      if (r && (r.changed || r.inferred)) TT.notify(`Quêtes resynchronisées avec tes logs : ${r.changed} mise(s) à jour${r.inferred ? `, ${r.inferred} prérequis déduit(s)` : ""}.`, "ok");
    });
    TT.nav.show(localStorage.getItem("view") || "map");
  }

  main().catch((e) => TT.warn(`Erreur au démarrage : ${e.message || e}`));
})();
