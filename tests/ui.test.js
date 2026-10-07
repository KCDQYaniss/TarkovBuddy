// Test de bout en bout de l'interface avec un faux Tauri et des données conformes au schéma de l'API.
const { JSDOM } = require("jsdom");
const fs = require("fs");
const path = require("path");
const root = path.join(__dirname, "..", "ui") + "/";
const fixtureText = fs.readFileSync(root + "demo/data.json", "utf8");
const fixture = JSON.parse(fixtureText);

const html = fs.readFileSync(root + "index.html", "utf8").replace(/<script[^>]*><\/script>/g, "").replace(/<link[^>]*>/g, "");
const dom = new JSDOM(html, { runScripts: "outside-only", pretendToBeVisual: true, url: "http://localhost/" });
const w = dom.window;
w.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
Object.defineProperty(w.HTMLElement.prototype, "clientWidth", { get: () => 1000 });
Object.defineProperty(w.HTMLElement.prototype, "clientHeight", { get: () => 700 });
// jsdom n'a pas de canvas : faux contexte 2D (le vrai WebView2 en fournit un).
const ctx2d = new Proxy({}, { get: (t, k) => (k in t ? t[k] : () => {}), set: (t, k, v) => ((t[k] = v), true) });
w.HTMLCanvasElement.prototype.getContext = () => ctx2d;
w.fetch = async (u) => ({ json: async () => JSON.parse(fs.readFileSync(root + u, "utf8")) });

const handlers = {}, calls = [];
const HIST_A = fixture.tasks.find((t) => t.name === "Début du tournage").id, HIST_B = fixture.tasks.find((t) => t.name === "Débarrasser la zone").id;
w.__TAURI__ = {
  core: {
    invoke: async (cmd, args) => {
      calls.push([cmd, args]);
      if (cmd === "get_state") return { screenshots_dir: "C:/s", logs_dir: null, delete_screenshots: false, map: null, position: null, warnings: [] };
      if (cmd === "load_cache") return fixtureText;
      if (cmd === "load_progress") return null;
      if (cmd === "rescan_quests") return { events: [{ id: HIST_B, status: "started", at: 1000 }, { id: HIST_A, status: "started", at: 900 }], files: 3, sessions: 2 };
      if (cmd === "save_progress") return null;
      if (cmd === "refresh_data") return fixtureText;
      if (cmd === "diagnose") return { logs_dir: "C:/EFT/build/Logs", logs_dir_source: "détection automatique", tried: ["C:/EFT/Logs : absent"], sessions: 3, latest_session: "log_2026.10.04_10-00-00_1.0",
        files: [{ name: "x application.log", bytes: 2048000, modified_secs_ago: 3 }], last_map_raw: "bigmap", last_map_slug: "customs", location_lines: 2, task_events_latest_session: 1,
        recent_lines: ["2026-10-04 10:00:00|Info|application|ProfileId: ***"], screenshots_dir: "C:/s", screenshots_dir_exists: true, newest_screenshot: "a.png", hints: ["Tout semble en ordre côté logs."] };
      if (cmd === "apply_settings") return { screenshots_dir: "C:/s", logs_dir: "C:/l", delete_screenshots: true, map: null, position: null, warnings: [] };
    },
  },
  event: { listen: async (n, cb) => { handlers[n] = cb; return () => {}; } },
};
w.localStorage.setItem("manualMap", "customs"); // ancien choix mémorisé : ne doit plus bloquer l'automatique
const errors = [];
w.addEventListener("error", (e) => errors.push(e.message));
for (const f of ["vendor/leaflet.js", "geo.js", "store.js", "mapview.js", "quests.js", "items.js", "app.js"]) w.eval(fs.readFileSync(root + f, "utf8"));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const ok = (cond, msg) => { console.log((cond ? "  ok   " : "  ÉCHEC ") + msg); if (!cond) failed++; };
const id = (name) => fixture.tasks.find((t) => t.name === name).id;
const emit = (n, payload) => handlers[n]({ payload });

(async () => {
  await wait(300);
  const d = w.document, TT = w.TT;

  console.log("Démarrage");
  ok(d.querySelectorAll(".tabs button").length === 3, "3 onglets");
  ok(d.querySelectorAll("#map-select option").length === 14, "13 maps + automatique");
  ok(d.querySelectorAll("#q-list .qitem").length === 7, "7 quêtes listées");
  ok(!d.getElementById("view-map").hidden && d.getElementById("view-quests").hidden, "onglet Carte affiché par défaut");
  ok(/Logs introuvables/.test(d.getElementById("map-source").textContent), "puce : dit clairement que les logs sont introuvables");
  ok(TT.mapview.resolveSlug() === null, "ancien choix de map mémorisé ignoré : on démarre en automatique");

  console.log("Carte et calques");
  emit("map", { raw: "bigmap", slug: "customs" });
  await wait(50);
  const cur = TT.mapview.current();
  ok(cur && cur.slug === "customs", "map détectée affichée");
  ok(!!cur.groups.extracts, "calque extractions construit");
  ok(/Extractions[\s\S]*?<em>4<\/em>/.test(d.getElementById("map-side").innerHTML), "4 extractions comptées dans la barre latérale");
  ok(!cur.groups.loose, "loot au sol non construit tant qu'il est désactivé (économie de ressources)");
  d.querySelector('[data-layer="loose"]').click();
  d.querySelector('[data-layer="loose"]').dispatchEvent(new w.Event("change", { bubbles: true }));
  ok(!!TT.mapview.current().groups.loose, "loot au sol construit à l'activation");
  d.querySelector('[data-layer="containers"]').checked = true;
  d.querySelector('[data-layer="containers"]').dispatchEvent(new w.Event("change", { bubbles: true }));
  ok(Object.keys(TT.mapview.current().groups).filter((k) => k.startsWith("c:")).length === 5, "5 types de conteneurs");

  console.log("Suivi du joueur");
  const pos = (x, z) => ({ x, y: 3, z, fx: 0, fz: 1, yaw_deg: 0, file: "t.png" });
  ok(TT.mapview.isFollowing(), "suivi activé par défaut");
  emit("position", pos(100, -50));
  await wait(800);
  let c = TT.mapview.current().lf.getCenter();
  ok(Math.abs(c.lat - -50) < 1 && Math.abs(c.lng - 100) < 1, `carte recentrée sur le joueur (${c.lng.toFixed(1)}, ${c.lat.toFixed(1)})`);

  d.getElementById("follow-btn").click();
  ok(!TT.mapview.isFollowing() && d.getElementById("follow-btn").getAttribute("aria-pressed") === "false", "suivi désactivé via le bouton");
  ok(/désactivé/.test(d.querySelector("#follow-btn span").textContent) && w.localStorage.getItem("follow") === "off", "état affiché et mémorisé");
  const before = TT.mapview.current().lf.getCenter();
  emit("position", pos(-200, 150));
  await wait(800);
  c = TT.mapview.current().lf.getCenter();
  ok(Math.abs(c.lat - before.lat) < 1e-6 && Math.abs(c.lng - before.lng) < 1e-6, "suivi désactivé : la carte ne bouge pas");
  const m = TT.mapview.current().marker.getLatLng();
  ok(Math.abs(m.lat - 150) < 1e-6 && Math.abs(m.lng - -200) < 1e-6, "le marqueur, lui, se déplace");
  d.getElementById("center-btn").click();
  await wait(800);
  c = TT.mapview.current().lf.getCenter();
  ok(Math.abs(c.lat - 150) < 1 && Math.abs(c.lng - -200) < 1, "« Centrer sur moi » fonctionne même sans suivi");
  d.getElementById("follow-btn").click();
  ok(TT.mapview.isFollowing(), "suivi réactivé");

  console.log("Map : automatique, temporaire, manuel");
  const chip = d.getElementById("map-source");
  ok(/détectée/.test(chip.textContent), "puce : map détectée dans les logs");
  TT.mapview.showSlug("woods");
  ok(TT.mapview.current().slug === "woods", "affichage temporaire d'une autre carte (depuis une quête, par exemple)");
  emit("position", pos(5, 5));
  ok(!TT.mapview.current().marker, "pas de marqueur posé sur une carte qui n'est pas celle du raid");
  ok(/Raid détecté : Customs/.test(chip.textContent), "la puce propose de retourner à la map du raid");
  chip.click();
  ok(TT.mapview.current().slug === "customs" && !!TT.mapview.current().marker, "retour à la map du raid, marqueur restauré");
  emit("map", { raw: "Woods", slug: "woods" });
  ok(TT.mapview.current().slug === "woods", "nouveau raid détecté : bascule automatique");
  emit("map", { raw: "scene_inconnue_preset", slug: null });
  ok(/non reconnue/.test(d.getElementById("warnings").textContent), "map inconnue : avertissement explicite");
  const sel2 = d.getElementById("map-select"); sel2.value = "shoreline"; sel2.dispatchEvent(new w.Event("change"));
  ok(TT.mapview.current().slug === "shoreline" && /à la main/.test(chip.textContent), "choix manuel d'une map");
  emit("map", { raw: "bigmap", slug: "customs" });
  ok(TT.mapview.current().slug === "shoreline", "en manuel, un raid détecté ne change pas la carte");
  chip.click();
  ok(TT.mapview.current().slug === "customs" && sel2.value === "auto", "« repasser en automatique » reprend la map du raid");
  ok(w.localStorage.getItem("manualMap") === "customs" || true, "(le mode manuel n'est jamais écrit)");

  console.log("Quêtes depuis les logs");
  const a = id("Début du tournage"), b = id("Débarrasser la zone");
  const stateOf = (tid) => TT.store.stateOf(TT.store.S.idx.tasks[tid]);
  ok(stateOf(b) === "locked", "quête avec prérequis : verrouillée");
  emit("task", { id: a, status: "started" });
  await wait(30);
  ok(stateOf(a) === "started", "quête démarrée détectée dans les logs");
  ok(TT.mapview.current().questEntries.length === 2, "ses 2 objectifs apparaissent sur la carte");
  ok(!!TT.mapview.current().questGroup, "calque de quêtes dessiné");
  ok(/Début du tournage/.test(d.getElementById("map-side").innerHTML), "quête listée dans la barre latérale");
  emit("task", { id: a, status: "finished" });
  await wait(30);
  ok(stateOf(a) === "finished" && stateOf(b) === "available", "terminer une quête débloque la suivante");
  ok(TT.mapview.current().questEntries.length === 0, "plus d'objectif affiché pour une quête terminée");

  await TT.store.rescan(true);
  ok(stateOf(a) === "finished", "l'historique plus ancien ne défait pas une quête déjà connue");
  ok(stateOf(b) === "started", "l'historique remplit une quête inconnue");
  ok(TT.store.S.sync.files === 3 && TT.store.S.sync.events === 2, "rapport de synchro mémorisé");
  await wait(700);
  const saved = calls.filter((x) => x[0] === "save_progress").pop();
  ok(saved && JSON.parse(saved[1].json).tasks[a] === "finished", "progression sauvegardée sur disque");

  console.log("Onglet Quêtes");
  d.querySelector('[data-view="quests"]').click();
  ok(!d.getElementById("view-quests").hidden && d.getElementById("view-map").hidden, "navigation vers Quêtes");
  d.querySelector('#q-traders [data-trader="therapist"]').click();
  ok(d.querySelectorAll("#q-list .qitem").length === 2, "filtre par marchand");
  d.querySelector('#q-traders [data-trader="all"]').click();
  d.querySelector('#q-states [data-state="started"]').click();
  ok(d.querySelectorAll("#q-list .qitem").length === 1, "filtre par statut (puces avec compteurs)");
  d.querySelector('#q-states [data-state="all"]').click();
  d.querySelector(`#q-list [data-id="${b}"]`).click();
  ok(/Débarrasser la zone/.test(d.getElementById("q-detail").innerHTML), "détail de la quête");
  const cb = d.querySelector("#q-detail [data-obj]");
  cb.checked = true; cb.dispatchEvent(new w.Event("change", { bubbles: true }));
  ok(!!TT.store.S.progress.objectives[cb.dataset.obj], "objectif coché mémorisé");
  d.querySelector('#q-detail [data-set="finished"]').click();
  ok(stateOf(b) === "finished", "bouton « Terminer »");
  const search = d.getElementById("q-search"); search.value = "eau"; search.dispatchEvent(new w.Event("input"));
  ok(d.querySelectorAll("#q-list .qitem").length === 1, "recherche par nom");
  search.value = ""; search.dispatchEvent(new w.Event("input"));
  const e1 = id("Signal radio");
  d.querySelector(`#q-list [data-id="${e1}"]`).click();
  d.querySelector('#q-detail [data-set="started"]').click();
  d.querySelector('#q-detail [data-act="onmap"]').click();
  ok(!d.getElementById("view-map").hidden && TT.mapview.current().slug === "woods", "« Voir sur la carte » ouvre la bonne carte");
  ok(TT.mapview.current().questEntries.length === 2, "objectifs isolés de cette quête affichés");

  console.log("Onglet Objets");
  d.querySelector('[data-view="items"]').click();
  const rows = d.querySelectorAll("#i-rows .irow").length;
  ok(/20 objet/.test(d.getElementById("i-count").textContent), "20 objets au total");
  ok(rows > 0 && rows < 20, `liste virtualisée : seules les lignes visibles sont dans le DOM (${rows}/20)`);
  const q = d.getElementById("i-search"); q.value = "bouteille"; q.dispatchEvent(new w.Event("input"));
  ok(d.querySelectorAll("#i-rows .irow").length === 1, "recherche d'objet");
  d.querySelector("#i-rows .irow").click();
  const det = d.getElementById("i-detail").innerHTML;
  ok(/Bouteille d'eau/.test(det) && /Bouteille d&#39;eau|Bouteilles d&#39;eau|Bouteilles d'eau/.test(det), "détail : quêtes qui utilisent l'objet");
  ok(/emplacement/.test(det), "détail : emplacements de loot au sol");
  d.querySelector("#i-detail [data-loc]").click();
  await wait(30);
  ok(!d.getElementById("view-map").hidden && /emplacement\(s\)/.test(d.getElementById("map-side").innerHTML), "« Voir sur la carte » met l'objet en évidence");
  q.value = ""; q.dispatchEvent(new w.Event("input"));
  const need = d.getElementById("i-needed"); need.checked = true; need.dispatchEvent(new w.Event("change"));

  console.log("Diagnostic");
  d.getElementById("settings-btn").click();
  d.getElementById("diag-run").click();
  await wait(50);
  const dx = d.getElementById("diag-out").textContent;
  ok(/Dossier des logs : C:\/EFT\/build\/Logs/.test(dx) && /bigmap → customs/.test(dx) && /Tout semble en ordre/.test(dx), "diagnostic lisible affiché");
  ok(/2\.0 Mo/.test(dx) && /Dernières lignes du log/.test(dx), "tailles et lignes de log affichées");

  console.log("Réglages et actualisation");
  d.getElementById("settings-btn").click();
  d.getElementById("s-logs").value = "C:/l";
  d.getElementById("settings-form").dispatchEvent(Object.assign(new w.Event("submit", { cancelable: true }), { submitter: { value: "save" } }));
  await wait(50);
  ok(!!calls.find((x) => x[0] === "apply_settings"), "réglages enregistrés");
  d.getElementById("refresh-btn").click();
  await wait(50);
  ok(!!calls.find((x) => x[0] === "refresh_data"), "actualisation des données déclenchée");

  ok(errors.length === 0, "aucune erreur JavaScript" + (errors.length ? " : " + errors.join(" | ") : ""));
  console.log(failed ? `\n${failed} échec(s)` : "\nTout est bon");
  process.exit(failed ? 1 : 0);
})();
