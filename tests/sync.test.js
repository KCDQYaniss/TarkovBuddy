// Synchronisation des quêtes avec les logs : suivi en direct, resynchronisation, déduction, protection des choix manuels.
const { JSDOM } = require("jsdom");
const fs = require("fs");
const path = require("path");
const root = path.join(__dirname, "..", "ui") + "/";
const fixtureText = fs.readFileSync(root + "demo/data.json", "utf8");
const fixture = JSON.parse(fixtureText);
const ID = (n) => fixture.tasks.find((t) => t.name === n).id;
const A = ID("Début du tournage"), B = ID("Débarrasser la zone"), C = ID("Bouteilles d'eau"), E = ID("Signal radio"), F = ID("Les clés du dortoir");
const WATER = fixture.items.find((i) => i.name === "Bouteille d'eau").id;

let failed = 0;
const ok = (c, m) => { console.log((c ? "  ok   " : "  ÉCHEC ") + m); if (!c) failed++; };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function boot({ logsDir = "C:/L", report = { events: [], files: 2, sessions: 3 }, progress = null } = {}) {
  const html = fs.readFileSync(root + "index.html", "utf8").replace(/<script[^>]*><\/script>/g, "").replace(/<link[^>]*>/g, "");
  const w = new JSDOM(html, { runScripts: "outside-only", pretendToBeVisual: true, url: "http://localhost/" }).window;
  w.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  Object.defineProperty(w.HTMLElement.prototype, "clientWidth", { get: () => 1000 });
  Object.defineProperty(w.HTMLElement.prototype, "clientHeight", { get: () => 700 });
  const ctx2d = new Proxy({}, { get: (t, k) => (k in t ? t[k] : () => {}), set: (t, k, v) => ((t[k] = v), true) });
  w.HTMLCanvasElement.prototype.getContext = () => ctx2d;
  w.fetch = async (u) => ({ json: async () => JSON.parse(fs.readFileSync(root + u, "utf8")) });
  const handlers = {}, calls = [], env = { report };
  w.__TAURI__ = {
    core: { invoke: async (cmd, args) => {
      calls.push([cmd, args]);
      if (cmd === "get_state") return { screenshots_dir: "C:/s", logs_dir: logsDir, delete_screenshots: false, map: null, position: null, warnings: [] };
      if (cmd === "load_cache") return fixtureText;
      if (cmd === "load_progress") return progress ? JSON.stringify(progress) : null;
      if (cmd === "rescan_quests") { if (env.fail) throw env.fail; return env.report; }
      return null;
    } },
    event: { listen: async (n, cb) => { handlers[n] = cb; return () => {}; } },
  };
  const errors = [];
  w.addEventListener("error", (e) => errors.push(e.message));
  for (const f of ["vendor/leaflet.js", "geo.js", "store.js", "mapview.js", "quests.js", "items.js", "app.js"]) w.eval(fs.readFileSync(root + f, "utf8"));
  await wait(350);
  const st = w.TT.store;
  return { w, d: w.document, TT: w.TT, st, handlers, calls, env, errors, state: (id) => st.stateOf(st.S.idx.tasks[id]) };
}

(async () => {
  const now = Date.now();
  console.log("Démarrage : resynchronisation complète depuis les logs");
  let h = await boot({ report: { events: [
    { id: B, status: "started", at: now - 5000 }, { id: A, status: "finished", at: now - 10000 }, { id: C, status: "finished", at: now - 8000 },
  ], files: 2, sessions: 3 } });
  ok(h.calls.some((c) => c[0] === "rescan_quests"), "l'app relit les logs au démarrage");
  ok(h.state(A) === "finished" && h.state(B) === "started" && h.state(C) === "finished", "états reconstitués, quel que soit l'ordre des évènements dans le rapport");
  ok(h.st.S.sync.events === 3 && h.st.S.sync.files === 2 && h.st.S.sync.sessions === 3, "rapport de synchro conservé (3 évènements, 2 fichiers, 3 sessions)");
  ok(/Synchronisé avec tes logs/.test(h.d.getElementById("q-sync").textContent) && /3 évènement/.test(h.d.getElementById("q-sync").textContent), "bandeau de synchro affiché dans l'onglet Quêtes");
  ok(h.d.getElementById("badge-q").textContent === "> 1" && !h.d.getElementById("badge-q").hidden, "badge vert : 1 quête en cours");
  ok(/Quêtes · /.test(h.d.getElementById("sync-note").textContent), "barre du bas : dernière synchro");
  h.d.querySelector('[data-view="quests"]').click();
  ok(h.d.querySelectorAll("#q-list .qitem").length === 1 && /Débarrasser/.test(h.d.getElementById("q-list").textContent), "la liste s'ouvre directement sur les quêtes en cours");
  ok(/Ta progression/.test(h.d.getElementById("q-detail").textContent) && /2 \/ 7/.test(h.d.getElementById("q-detail").textContent), "tableau de bord : 2 quêtes terminées sur 7");
  ok(/Activité récente/.test(h.d.getElementById("q-detail").textContent) && /Quête terminée/.test(h.d.getElementById("q-detail").textContent), "fil d'activité récente");

  console.log("Évènements en direct");
  h.handlers.task({ payload: { id: F, status: "started", at: 0 } });
  await wait(20);
  ok(h.state(F) === "started", "quête démarrée en jeu → suivie aussitôt");
  const toast = [...h.d.querySelectorAll("#warnings li.ok")].find((li) => /Quête démarrée/.test(li.textContent));
  ok(toast && /Quête démarrée : Les clés du dortoir/.test(toast.textContent), "notification verte « Quête démarrée : … »");
  h.handlers.task({ payload: { id: F, status: "finished", at: 0 } });
  await wait(20);
  ok(h.state(F) === "finished" && h.st.S.progress.objectives[fixture.tasks.find((t) => t.id === F).objectives[0].id], "terminée → ses objectifs sont cochés (plus rien sur la carte)");
  h.handlers.task({ payload: { id: E, status: "failed", at: 0 } });
  await wait(20);
  ok(/Quête échouée/.test([...h.d.querySelectorAll("#warnings li")].pop().textContent), "échec signalé");

  console.log("Un choix manuel récent n'est jamais défait par un vieil évènement");
  h.st.setTaskStatus(A, "failed");
  h.env.report = { events: [{ id: A, status: "finished", at: now - 10000 }], files: 2, sessions: 3 };
  await h.st.rescan(true);
  ok(h.state(A) === "failed", "relire les logs ne touche pas à ce que tu as réglé depuis");
  h.env.report = { events: [{ id: A, status: "finished", at: Date.now() + 60000 }], files: 2, sessions: 3 };
  await h.st.rescan(true);
  ok(h.state(A) === "finished", "mais un évènement plus récent que ton réglage l'emporte");

  console.log("Déduction des prérequis");
  h = await boot({ report: { events: [{ id: E, status: "started", at: now - 1000 }], files: 1, sessions: 1 } });
  ok(h.state(E) === "started" && h.state(B) === "finished" && h.state(A) === "finished", "« Signal radio » démarrée ⇒ « Débarrasser la zone » et « Début du tournage » terminées");
  ok(h.st.S.progress.inferred[A] && h.st.S.progress.inferred[B] && !h.st.S.progress.inferred[E], "les quêtes déduites sont marquées comme telles");
  ok(h.st.S.sync.inferred === 2, "synchro : 2 prérequis déduits");
  h.d.querySelector('[data-view="quests"]').click();
  h.d.querySelector('#q-states [data-state="all"]').click();
  h.d.querySelector(`#q-list [data-id="${A}"]`).click();
  ok(/déduite/.test(h.d.getElementById("q-detail").textContent), "le détail indique qu'une quête est déduite");
  h.handlers.task({ payload: { id: A, status: "finished", at: Date.now() + 5 } });
  await wait(20);
  ok(!h.st.S.progress.inferred[A], "un vrai évènement remplace la déduction");
  h.st.setTaskStatus(F, "finished");
  ok(h.state(F) === "finished" && h.state(A) === "finished", "« Marquer terminée » à la main déduit aussi les prérequis");

  console.log("Niveau du joueur");
  h = await boot();
  ok(h.state(C) === "available", "quête de niveau 2 sans prérequis : disponible");
  h.st.setLevel(1);
  ok(h.state(C) === "locked" && /Niveau 2 requis/.test(h.st.lockReason(h.st.S.idx.tasks[C])), "niveau 1 : verrouillée, avec la raison");
  h.d.querySelector('[data-view="quests"]').click();
  const lv = h.d.getElementById("q-level"); lv.value = "5"; lv.dispatchEvent(new h.w.Event("change"));
  ok(h.st.S.progress.level === 5 && h.state(C) === "available", "champ « Niveau » de la barre de filtres");
  h.d.querySelector('#q-states [data-state="all"]').click();
  h.d.querySelector(`#q-list [data-id="${E}"]`).click();
  ok(/Prérequis : Débarrasser la zone/.test(h.d.getElementById("q-detail").textContent), "quête verrouillée : prérequis manquants listés");

  console.log("Liste de courses des quêtes en cours");
  h.st.setTaskStatus(C, "started");
  const need = h.st.neededItems().get(WATER);
  ok(need && need.count === 3 && need.fir, "« trouver 3 » puis « remettre 3 » = 3 bouteilles à trouver (pas 6), en raid");
  ok(h.d.getElementById("badge-i").textContent === "1", "badge gris : 1 objet à trouver");
  h.d.querySelector('[data-view="items"]').click();
  const q = h.d.getElementById("i-search"); q.value = "bouteille"; q.dispatchEvent(new h.w.Event("input"));
  ok(/× 3 FIR/.test(h.d.getElementById("i-rows").textContent), "le nombre à trouver apparaît sur la ligne de l'objet");
  h.d.querySelector("#i-rows .irow").click();
  ok(/À trouver pour tes quêtes en cours/.test(h.d.getElementById("i-detail").textContent), "le détail liste les quêtes concernées");

  console.log("Cas particuliers");
  h = await boot({ logsDir: null });
  ok(!h.calls.some((c) => c[0] === "rescan_quests"), "logs introuvables : pas de tentative de lecture");
  h.d.querySelector('[data-view="quests"]').click();
  ok(/introuvable/.test(h.d.getElementById("q-sync").textContent) && h.d.getElementById("q-sync").classList.contains("warn"), "bandeau orange « dossier des logs introuvable »");
  h = await boot({ report: { events: [], files: 4, sessions: 2 } });
  h.d.querySelector('[data-view="quests"]').click();
  ok(h.d.getElementById("q-sync").classList.contains("warn") && /Aucun évènement de quête dans tes logs \(4 fichier/.test(h.d.getElementById("q-sync").textContent), "aucun évènement : explication claire, pas une page vide");
  h.env.report = { events: [{ id: C, status: "started", at: Date.now() }], files: 5, sessions: 2 };
  h.d.querySelector('#q-sync [data-act="rescan"]').click();
  await wait(60);
  ok(h.state(C) === "started" && /5 fichier/.test(h.d.getElementById("q-sync").textContent), "bouton « Resynchroniser »");
  ok(/Synchro terminée/.test(h.d.getElementById("warnings").textContent), "résumé de la synchro affiché");
  h.env.fail = "Dossier des logs introuvable : renseigne-le dans Réglages.";
  await h.st.rescan(true);
  ok(h.d.getElementById("q-sync").classList.contains("warn") && /introuvable/.test(h.d.getElementById("q-sync").textContent), "erreur de lecture : affichée dans le bandeau");

  console.log("Raccourcis clavier");
  h = await boot();
  const key = (k) => h.d.dispatchEvent(new h.w.KeyboardEvent("keydown", { key: k, bubbles: true }));
  key("2"); ok(!h.d.getElementById("view-quests").hidden, "touche 2 : Quêtes");
  key("3"); ok(!h.d.getElementById("view-items").hidden, "touche 3 : Objets");
  key("1"); ok(!h.d.getElementById("view-map").hidden, "touche 1 : Carte");
  const was = h.TT.mapview.isFollowing(); key("f");
  ok(h.TT.mapview.isFollowing() === !was, "touche F : suivi du joueur");
  key("2"); key("/");
  ok(h.d.activeElement === h.d.getElementById("q-search"), "touche / : met le focus sur la recherche");

  ok(h.errors.length === 0, "aucune erreur JavaScript" + (h.errors.length ? " : " + h.errors.join(" | ") : ""));
  console.log(failed ? `\n${failed} échec(s)` : "\nTout est bon");
  process.exit(failed ? 1 : 0);
})();
