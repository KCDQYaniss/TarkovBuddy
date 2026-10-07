// Panne du serveur tarkov.dev : l'app doit l'expliquer clairement, réessayer, et se rétablir.
const { JSDOM } = require("jsdom");
const fs = require("fs");
const path = require("path");
const root = path.join(__dirname, "..", "ui") + "/";
const fixtureText = fs.readFileSync(root + "demo/data.json", "utf8");
const html = fs.readFileSync(root + "index.html", "utf8").replace(/<script[^>]*><\/script>/g, "").replace(/<link[^>]*>/g, "");
const w = new JSDOM(html, { runScripts: "outside-only", pretendToBeVisual: true, url: "http://localhost/" }).window;
w.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
Object.defineProperty(w.HTMLElement.prototype, "clientWidth", { get: () => 1000 });
Object.defineProperty(w.HTMLElement.prototype, "clientHeight", { get: () => 700 });
const ctx2d = new Proxy({}, { get: (t, k) => (k in t ? t[k] : () => {}), set: (t, k, v) => ((t[k] = v), true) });
w.HTMLCanvasElement.prototype.getContext = () => ctx2d;
w.fetch = async (u) => ({ json: async () => JSON.parse(fs.readFileSync(root + u, "utf8")) });

const OUTAGE = "Le serveur de données de tarkov.dev est indisponible : c'est une panne de leur côté, pas un problème de ton installation.\n(Réponse du serveur : HTTP 422 : GraphQL server unavailable. Try again later.)";
let serverUp = false, refreshCalls = 0;
w.__TAURI__ = {
  core: { invoke: async (cmd) => {
    if (cmd === "get_state") return { screenshots_dir: "C:/s", logs_dir: "C:/L", delete_screenshots: false, map: null, position: null, warnings: [] };
    if (cmd === "load_cache") return null;
    if (cmd === "refresh_data") { refreshCalls++; if (!serverUp) throw OUTAGE; return fixtureText; }
    return null;
  } },
  event: { listen: async () => () => {} },
};
const errors = [];
w.addEventListener("error", (e) => errors.push(e.message));
for (const f of ["vendor/leaflet.js", "geo.js", "store.js", "mapview.js", "quests.js", "items.js", "app.js"]) w.eval(fs.readFileSync(root + f, "utf8"));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const ok = (c, m) => { console.log((c ? "  ok   " : "  ÉCHEC ") + m); if (!c) failed++; };

(async () => {
  await wait(400);
  const d = w.document, S = w.TT.store.S;
  console.log("Serveur en panne, aucune donnée en cache");
  ok(refreshCalls === 1, "une seule tentative au démarrage (on ne martèle pas)");
  ok(/indisponible/.test(d.getElementById("q-list").textContent), "onglet Quêtes : explication à la place de la liste");
  ok(/pas un problème de ton installation/.test(d.getElementById("q-list").textContent), "…qui précise que ce n'est pas la faute de l'installation");
  ok(/Nouvelle tentative automatique vers \d\d:\d\d/.test(d.getElementById("q-list").textContent), "…et annonce le prochain essai");
  ok(/Serveur de données indisponible/.test(d.getElementById("data-status").textContent), "barre du bas : état clair");
  ok(/indisponible/.test(d.getElementById("warnings").textContent), "notification affichée");
  ok(S.retryAt > Date.now() + 4 * 60 * 1000, "nouvel essai programmé dans ~5 minutes");
  ok(!d.getElementById("refresh-btn").disabled, "le bouton Actualiser reste utilisable");

  console.log("Le serveur revient");
  serverUp = true;
  d.getElementById("refresh-btn").click();
  await wait(200);
  ok(d.querySelectorAll("#q-list .qitem").length === 7, "les quêtes apparaissent");
  ok(S.error === "" && S.retryAt === 0, "erreur effacée, plus de nouvel essai programmé");
  ok(/Données ·/.test(d.getElementById("data-status").textContent), "barre du bas : données à jour");
  ok(errors.length === 0, "aucune erreur JavaScript" + (errors.length ? " : " + errors.join(" | ") : ""));
  console.log(failed ? `\n${failed} échec(s)` : "\nTout est bon");
  process.exit(failed ? 1 : 0);
})();
