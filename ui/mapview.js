"use strict";
// Vue carte : position joueur, suivi, calques de données, quêtes actives, recherche d'objets.
(function () {
  const TT = (window.TT = window.TT || {});
  const { esc, slugOf } = TT.store;
  const $ = (id) => document.getElementById(id);

  const COL = {
    pmc: "#8fbf5a", scav: "#e0a23a", shared: "#d8d4c0", transit: "#6fb7c9",
    spawnPmc: "#5b9bd5", spawnScav: "#cc7a4a", container: "#c7b07a", loose: "#4fb0b8",
    quest: "#f2b13a", hl: "#ff5a3c", stationary: "#a98fd0",
  };
  const LAYERS = [
    { key: "extracts", label: "Extractions", color: COL.pmc },
    { key: "transits", label: "Transits", color: COL.transit },
    { key: "spawns", label: "Apparitions", color: COL.spawnPmc },
    { key: "containers", label: "Conteneurs", color: COL.container },
    { key: "loose", label: "Loot au sol", color: COL.loose },
    { key: "stationary", label: "Armes fixes", color: COL.stationary },
    { key: "quests", label: "Objectifs de quêtes", color: COL.quest },
  ];
  const store = (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (_) { return d; } };
  const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (_) {} };

  let calibs = [], bySlug = {};
  let cur = null;                  // carte affichée
  let lastPos = null;
  let detectedSlug = null;
  let manualSlug = "auto";                 // « auto » = on suit la map détectée dans les logs (jamais mémorisé entre deux lancements)
  let follow = localStorage.getItem("follow") !== "off";          // suivi du joueur : activé par défaut
  const layerOn = Object.assign({ extracts: true, transits: true, quests: true, questsAvail: false }, store("layers", {}));
  const offTypes = new Set(store("offTypes", []));
  let hl = null;                   // objet mis en évidence { id, name, count }
  let focusTask = null;            // quête dont on isole les objectifs

  /* ---------- Carte Leaflet ---------- */
  function buildCrs(cal) {
    return L.extend({}, L.CRS.Simple, {
      transformation: new L.Transformation(cal.scaleX, cal.marginX, cal.scaleY, cal.marginY),
      projection: L.extend({}, L.Projection.LonLat, {
        project: (ll) => { const r = Geo.rotate(ll.lng, ll.lat, cal.rotation); return L.point(r.lng, r.lat); },
        unproject: (p) => { const r = Geo.rotate(p.x, p.y, -cal.rotation); return L.latLng(r.lat, r.lng); },
      }),
    });
  }
  const ll = (p) => L.latLng(p.z, p.x); // convention tarkov.dev : [z, x]

  function showMap(slug) {
    const def = bySlug[slug];
    if (!def) return;
    if (cur && cur.slug === slug) return;
    if (cur) cur.lf.remove();

    const cal = Geo.makeCalibration(def);
    const imageBounds = L.latLngBounds(...Geo.imageBoundsLatLng(def));
    const lf = L.map("map", {
      crs: buildCrs(cal), minZoom: def.minZoom, maxZoom: def.maxZoom + 1, zoomSnap: 0.25,
      attributionControl: false, zoomControl: false, maxBounds: imageBounds.pad(0.6), maxBoundsViscosity: 0.6, preferCanvas: true,
    });
    L.control.zoom({ position: "bottomright", zoomInTitle: "Zoom +", zoomOutTitle: "Zoom −" }).addTo(lf);
    if (def.image) L.imageOverlay(def.image, imageBounds).addTo(lf);
    else if (def.tiles) L.tileLayer(def.tiles, { tileSize: def.tileSize || 256, bounds: imageBounds, noWrap: true, minZoom: def.minZoom, maxZoom: def.maxZoom }).addTo(lf);
    cur = {
      slug, def, cal, lf, imageBounds, groups: {}, marker: null, questGroup: null, hlGroup: null, questEntries: [],
      tip: L.tooltip({ direction: "top", offset: [0, -4], className: "tt-tip" }), needsFit: false,
    };
    if ($("map").clientWidth > 0) lf.fitBounds(imageBounds); else cur.needsFit = true;
    $("map-select").value = manualSlug;
    hl = null; focusTask = null;
    if (lastPos && slug === resolveSlug()) placeMarker(lastPos, false);
    syncLayers(); renderSidebar(); refreshEmpty();
  }

  function markerIcon() {
    return L.divIcon({
      className: "", iconSize: [44, 44], iconAnchor: [22, 22],
      html: '<div class="player"><span class="pulse"></span><svg viewBox="0 0 44 44" aria-hidden="true"><g class="arrow">' +
        '<path d="M22 5 L33 36 L22 29 L11 36 Z" fill="#f2b13a" stroke="#1a1405" stroke-width="2.5" stroke-linejoin="round"/></g></svg></div>',
    });
  }

  function placeMarker(p, announce) {
    if (!cur) return;
    const pt = ll(p);
    const heading = cur.cal.headingDeg(p.x, p.z, p.fx, p.fz);
    if (!cur.marker) cur.marker = L.marker(pt, { icon: markerIcon(), interactive: false, keyboard: false, zIndexOffset: 1000 }).addTo(cur.lf);
    else cur.marker.setLatLng(pt);
    const el = cur.marker.getElement();
    el.querySelector(".arrow").setAttribute("transform", `rotate(${heading.toFixed(1)} 22 22)`);
    if (announce) {
      const box = el.querySelector(".player");
      box.classList.remove("fresh"); void box.offsetWidth; box.classList.add("fresh");
    }
    // Suivi : on recentre à chaque nouvelle position. Désactivé = la carte ne bouge jamais toute seule.
    if (follow) cur.lf.panTo(pt, { animate: announce, duration: 0.45 });
  }

  function centerOnPlayer() {
    if (cur && cur.marker) cur.lf.panTo(cur.marker.getLatLng(), { animate: true });
  }

  /* ---------- Calques ---------- */
  const dot = (pt, color, r, extra) => L.circleMarker(pt, Object.assign({ radius: r, color: "#0c0d0e", weight: 1, fillColor: color, fillOpacity: 0.95 }, extra || {}));
  function tip(layer, html) {
    layer.on("mouseover", (e) => { cur.tip.setLatLng(e.latlng).setContent(html); cur.lf.openTooltip(cur.tip); });
    layer.on("mouseout", () => cur && cur.lf.closeTooltip(cur.tip));
  }
  const mapData = () => { const i = TT.store.S.idx; return i && i.maps[cur.slug]; };
  const itemName = (id) => { const it = TT.store.S.idx.items[id]; return it ? it.name : "Objet inconnu"; };
  const itemList = (items) => {
    const names = (items || []).map((i) => esc(itemName(i.id)));
    return names.slice(0, 6).join("<br>") + (names.length > 6 ? `<br>+${names.length - 6} autres` : "");
  };

  const builders = {
    extracts(md) {
      const g = L.layerGroup();
      for (const e of md.extracts) {
        const c = COL[e.faction] || COL.shared;
        if (e.outline && e.outline.length > 2) L.polygon(e.outline.map(ll), { color: c, weight: 1, fillOpacity: 0.12, interactive: false }).addTo(g);
        const d = dot(ll(e.position), c, 6, { weight: 2 }).addTo(g);
        d.bindTooltip(esc(e.name || "Extraction"), { permanent: true, direction: "right", offset: [8, 0], className: "tt-label" });
      }
      return g;
    },
    transits(md) {
      const g = L.layerGroup();
      for (const t of md.transits) {
        const d = dot(ll(t.position), COL.transit, 6, { weight: 2, dashArray: "2 2" }).addTo(g);
        tip(d, `<b>Transit</b><br>${esc(t.description || "")}`);
      }
      return g;
    },
    spawns(md) {
      const g = L.layerGroup();
      for (const s of md.spawns) {
        const sc = (s.sides || []).includes("scav") && !(s.sides || []).includes("pmc") && !(s.sides || []).includes("all");
        const d = dot(ll(s.position), sc ? COL.spawnScav : COL.spawnPmc, 4).addTo(g);
        tip(d, `<b>Apparition ${sc ? "Scav" : "PMC"}</b><br>${esc((s.categories || []).join(", "))}`);
      }
      return g;
    },
    loose(md) {
      const g = L.layerGroup();
      for (const l of md.loose) tip(dot(ll(l.position), COL.loose, 2.5, { weight: 0.5 }).addTo(g), itemList(l.items) || "Loot au sol");
      return g;
    },
    stationary(md) {
      const g = L.layerGroup();
      for (const w of md.stationary) tip(dot(ll(w.position), COL.stationary, 5).addTo(g), esc((w.stationaryWeapon && w.stationaryWeapon.name) || "Arme fixe"));
      return g;
    },
  };
  function containerTypes(md) {
    const t = {};
    for (const c of md.containers) { const n = c.lootContainer.name; (t[n] = t[n] || []).push(c); }
    return t;
  }

  function setGroup(key, on, build) {
    const have = cur.groups[key];
    if (on) { const g = have || (cur.groups[key] = build()); if (!cur.lf.hasLayer(g)) g.addTo(cur.lf); }
    else if (have && cur.lf.hasLayer(have)) cur.lf.removeLayer(have);
  }

  function syncLayers() {
    if (!cur) return;
    const md = mapData();
    if (md) {
      for (const k of ["extracts", "transits", "spawns", "loose", "stationary"]) setGroup(k, !!layerOn[k], () => builders[k](md));
      const types = containerTypes(md);
      for (const [name, list] of Object.entries(types)) {
        setGroup("c:" + name, !!layerOn.containers && !offTypes.has(name), () => {
          const g = L.layerGroup();
          for (const c of list) tip(dot(ll(c.position), COL.container, 3.5).addTo(g), esc(name));
          return g;
        });
      }
    }
    drawQuests();
    drawHighlight();
    // Les points de surbrillance et de quêtes passent au-dessus.
    [cur.hlGroup, cur.questGroup].forEach((g) => g && g.eachLayer && g.eachLayer((l) => l.bringToFront && l.bringToFront()));
  }

  /* ---------- Objectifs de quêtes ---------- */
  function questEntries() {
    const st = TT.store, idx = st.S.idx;
    if (!idx) return [];
    let tasks = focusTask ? [idx.tasks[focusTask]].filter(Boolean) : st.startedTasks();
    if (!focusTask && layerOn.questsAvail) tasks = tasks.concat(Object.values(idx.tasks).filter((t) => st.stateOf(t) === "available"));
    const out = [];
    for (const t of tasks) for (const o of t.objectives || []) {
      if (st.S.progress.objectives[o.id]) continue;
      const maps = (o.maps || []).map((m) => slugOf(m.normalizedName));
      const zonesHere = (o.zones || []).filter((z) => z.map && slugOf(z.map.normalizedName) === cur.slug);
      const locsHere = (o.possibleLocations || []).filter((l) => l.map && slugOf(l.map.normalizedName) === cur.slug);
      const itemIds = [...(o.items || []), ...(o.useAny || [])].map((i) => i.id);
      const looseHere = itemIds.length && (!maps.length || maps.includes(cur.slug)) ? itemIds : [];
      const extractHere = o.type === "extract" && o.exitName && maps.includes(cur.slug);
      if (!(zonesHere.length || locsHere.length || looseHere.length || extractHere || maps.includes(cur.slug))) continue;
      out.push({ task: t, obj: o, zonesHere, locsHere, looseIds: looseHere });
    }
    return out;
  }

  function drawQuests() {
    if (cur.questGroup) { cur.lf.removeLayer(cur.questGroup); cur.questGroup = null; }
    cur.questEntries = layerOn.quests || focusTask ? questEntries() : [];
    if (!cur.questEntries.length) return;
    const md = mapData();
    const g = (cur.questGroup = L.layerGroup().addTo(cur.lf));
    for (const e of cur.questEntries) {
      const pts = [];
      const html = `<b>${esc(e.task.name)}</b><br>${esc(e.obj.description)}`;
      for (const z of e.zonesHere) {
        if (z.outline && z.outline.length > 2) {
          const poly = L.polygon(z.outline.map(ll), { color: COL.quest, weight: 2, fillOpacity: 0.18 }).addTo(g);
          tip(poly, html); pts.push(...z.outline.map(ll));
        } else if (z.position) {
          tip(dot(ll(z.position), COL.quest, 8, { weight: 2, fillOpacity: 0.35 }).addTo(g), html); pts.push(ll(z.position));
        }
      }
      for (const l of e.locsHere) for (const p of l.positions || []) {
        tip(dot(ll(p), COL.quest, 6, { weight: 2 }).addTo(g), html); pts.push(ll(p));
      }
      if (md && e.looseIds.length) {
        const ids = new Set(e.looseIds);
        for (const l of md.loose) if ((l.items || []).some((i) => ids.has(i.id))) {
          tip(dot(ll(l.position), COL.quest, 4, { weight: 1 }).addTo(g), html + "<br>" + itemList(l.items)); pts.push(ll(l.position));
        }
      }
      if (md && e.obj.type === "extract" && e.obj.exitName) {
        const x = md.extracts.find((m) => (m.name || "").toLowerCase() === e.obj.exitName.toLowerCase());
        if (x) { tip(dot(ll(x.position), COL.quest, 10, { weight: 2, fillOpacity: 0.2 }).addTo(g), html); pts.push(ll(x.position)); }
      }
      e.bounds = pts.length ? L.latLngBounds(pts) : null;
    }
  }

  function drawHighlight() {
    if (cur.hlGroup) { cur.lf.removeLayer(cur.hlGroup); cur.hlGroup = null; }
    const md = mapData();
    if (!hl || !md) return;
    const g = (cur.hlGroup = L.layerGroup().addTo(cur.lf));
    const pts = [];
    for (const l of md.loose) if ((l.items || []).some((i) => i.id === hl.id)) {
      const p = ll(l.position); pts.push(p);
      tip(dot(p, COL.hl, 7, { weight: 2, fillOpacity: 0.3, color: COL.hl }).addTo(g), `<b>${esc(hl.name)}</b><br>${itemList(l.items)}`);
    }
    hl.count = pts.length;
    hl.bounds = pts.length ? L.latLngBounds(pts) : null;
  }

  /* ---------- Barre latérale ---------- */
  function renderSidebar() {
    const el = $("map-side");
    const S = TT.store.S;
    if (!cur) { el.innerHTML = ""; return; }
    if (!S.idx || !mapData()) {
      el.innerHTML = `<section class="sec"><h3>Données</h3><p class="dim">${S.idx ? "Aucune donnée pour cette carte." : esc(TT.store.emptyMessage())}</p>` +
        `<button class="btn" data-act="refresh" type="button">Télécharger les données</button></section>`;
      return;
    }
    const md = mapData();
    const types = containerTypes(md);
    const counts = { extracts: md.extracts.length, transits: md.transits.length, spawns: md.spawns.length, containers: md.containers.length, loose: md.loose.length, stationary: md.stationary.length, quests: cur.questEntries.length };
    let h = '<section class="sec"><h3>Calques</h3>';
    for (const L_ of LAYERS) {
      h += `<label class="chk"><input type="checkbox" data-layer="${L_.key}"${layerOn[L_.key] ? " checked" : ""}><i class="sw" style="--c:${L_.color}"></i><span>${L_.label}</span><em>${counts[L_.key]}</em></label>`;
      if (L_.key === "containers" && layerOn.containers && Object.keys(types).length) {
        h += '<div class="sub">';
        for (const [name, list] of Object.entries(types).sort((a, b) => a[0].localeCompare(b[0]))) {
          h += `<label class="chk small"><input type="checkbox" data-ctype="${esc(name)}"${offTypes.has(name) ? "" : " checked"}><span>${esc(name)}</span><em>${list.length}</em></label>`;
        }
        h += "</div>";
      }
    }
    h += `<label class="chk small"><input type="checkbox" data-layer="questsAvail"${layerOn.questsAvail ? " checked" : ""}><span>Inclure les quêtes disponibles</span></label></section>`;

    h += '<section class="sec"><h3>Chercher un objet</h3><input id="hl-input" class="txt" type="text" autocomplete="off" spellcheck="false" placeholder="Nom de l\'objet…"><ul id="hl-sugg" class="sugg" hidden></ul>';
    h += hl ? `<div class="pill">${esc(hl.name)} · ${hl.count || 0} emplacement(s) <button class="x" data-act="clear-hl" type="button" aria-label="Effacer">×</button></div>` : "";
    h += "</section>";

    h += '<section class="sec"><h3>Quêtes sur cette carte</h3>';
    if (focusTask) h += `<div class="pill">Quête isolée <button class="x" data-act="clear-focus" type="button" aria-label="Afficher toutes les quêtes">×</button></div>`;
    if (!cur.questEntries.length) h += '<p class="dim">Aucun objectif actif ici. Démarre une quête dans l\'onglet Quêtes, ou elle sera détectée dans tes logs.</p>';
    cur.questEntries.forEach((e, i) => { h += `<button class="qrow" data-qe="${i}" type="button"><b>${esc(e.task.name)}</b><span>${esc(e.obj.description)}</span></button>`; });
    h += "</section>";

    if (md.bosses && md.bosses.length) {
      h += '<section class="sec"><h3>Boss</h3>';
      for (const b of md.bosses) h += `<div class="boss"><span>${esc(b.boss.name)}</span><em>${Math.round((b.spawnChance || 0) * 100)} %</em></div>`;
      h += "</section>";
    }
    h += `<section class="sec info"><span>${md.players ? esc(md.players) + " joueurs" : ""}</span><span>${md.raidDuration ? md.raidDuration + " min de raid" : ""}</span></section>`;
    el.innerHTML = h;
  }

  function onSideEvent(e) {
    const t = e.target;
    if (t.dataset && t.dataset.layer) { layerOn[t.dataset.layer] = t.checked; save("layers", layerOn); syncLayers(); renderSidebar(); }
    else if (t.dataset && t.dataset.ctype) { t.checked ? offTypes.delete(t.dataset.ctype) : offTypes.add(t.dataset.ctype); save("offTypes", [...offTypes]); syncLayers(); }
  }
  function onSideClick(e) {
    const b = e.target.closest("[data-act],[data-qe],[data-sugg]");
    if (!b) return;
    if (b.dataset.act === "refresh") TT.store.refresh();
    else if (b.dataset.act === "clear-hl") { hl = null; syncLayers(); renderSidebar(); }
    else if (b.dataset.act === "clear-focus") { focusTask = null; syncLayers(); renderSidebar(); }
    else if (b.dataset.qe != null) {
      const en = cur.questEntries[+b.dataset.qe];
      if (en && en.bounds) cur.lf.fitBounds(en.bounds.pad(0.6), { maxZoom: cur.def.maxZoom - 1 });
    } else if (b.dataset.sugg) highlightItem(b.dataset.sugg);
  }
  function onSideInput(e) {
    if (e.target.id !== "hl-input") return;
    const box = $("hl-sugg"), q = e.target.value.trim().toLowerCase();
    const idx = TT.store.S.idx;
    if (q.length < 2) { box.hidden = true; return; }
    const here = Object.keys(idx.lootByItem).filter((id) => idx.lootByItem[id][cur.slug] && idx.items[id]);
    const res = here.map((id) => idx.items[id]).filter((it) => (it.name || "").toLowerCase().includes(q) || (it.shortName || "").toLowerCase().includes(q)).slice(0, 8);
    box.innerHTML = res.length ? res.map((it) => `<li><button type="button" data-sugg="${esc(it.id)}">${esc(it.name)} <em>${idx.lootByItem[it.id][cur.slug]}</em></button></li>`).join("") : '<li class="dim">Aucun résultat sur cette carte</li>';
    box.hidden = false;
  }

  /* ---------- Actions publiques ---------- */
  function highlightItem(id) {
    const it = TT.store.S.idx && TT.store.S.idx.items[id];
    if (!it || !cur) return;
    hl = { id, name: it.name };
    drawHighlight(); renderSidebar();
    if (hl.bounds) cur.lf.fitBounds(hl.bounds.pad(0.4), { maxZoom: cur.def.maxZoom - 1 });
  }
  /** Affiche la carte qui contient le plus d'emplacements de l'objet, avec surbrillance. */
  function locateItem(id, wanted) {
    const idx = TT.store.S.idx; if (!idx) return false;
    const where = idx.lootByItem[id] || {};
    const slug = wanted || (where[cur && cur.slug] ? cur.slug : Object.keys(where).sort((a, b) => where[b] - where[a])[0]);
    if (!slug || !bySlug[slug]) return false;
    showSlug(slug);
    highlightItem(id);
    return true;
  }
  function focusTaskOnMap(id) {
    const st = TT.store, t = st.S.idx && st.S.idx.tasks[id];
    if (!t) return false;
    const slugs = new Set();
    if (t.map) slugs.add(slugOf(t.map.normalizedName));
    for (const o of t.objectives || []) {
      (o.maps || []).forEach((m) => slugs.add(slugOf(m.normalizedName)));
      (o.zones || []).forEach((z) => z.map && slugs.add(slugOf(z.map.normalizedName)));
    }
    const slug = [...slugs].find((s) => bySlug[s]);
    if (!slug) return false;
    showSlug(slug);
    focusTask = id;
    syncLayers(); renderSidebar();
    const b = cur.questEntries.map((e) => e.bounds).filter(Boolean);
    if (b.length) cur.lf.fitBounds(b.reduce((a, c) => a.extend(c), L.latLngBounds(b[0].getSouthWest(), b[0].getNorthEast())).pad(0.5), { maxZoom: cur.def.maxZoom - 1 });
    return true;
  }
  /** Affiche une carte sans changer de mode : si on est en automatique, le prochain raid reprend la main. */
  function showSlug(slug) {
    showMap(slug); updateChip(); refreshEmpty();
  }
  function setFollow(on) {
    follow = on; localStorage.setItem("follow", on ? "on" : "off");
    const b = $("follow-btn");
    b.setAttribute("aria-pressed", String(on));
    b.querySelector("span").textContent = on ? "Suivi : activé" : "Suivi : désactivé";
    if (on) centerOnPlayer();
  }
  function onShow() {
    if (!cur) return;
    cur.lf.invalidateSize();
    if (cur.needsFit) { cur.lf.fitBounds(cur.imageBounds); cur.needsFit = false; }
  }

  /* ---------- Évènements du jeu ---------- */
  function resolveSlug() { return manualSlug !== "auto" ? manualSlug : detectedSlug; }
  function onPosition(p) {
    lastPos = p;
    const time = new Date().toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    $("r-time").textContent = `Capture de ${time}`;
    $("r-xyz").textContent = `x ${p.x.toFixed(1)}  ·  hauteur ${p.y.toFixed(1)}  ·  z ${p.z.toFixed(1)}`;
    $("readout").hidden = false;
    if (!cur) { const s = resolveSlug(); if (s) showMap(s); }
    // Si on regarde une autre carte que celle du raid (ex. depuis une quête), on n'y pose pas le marqueur.
    if (cur && cur.slug === resolveSlug()) placeMarker(p, true);
    updateChip(); refreshEmpty();
  }
  function onMap(m) {
    detectedSlug = m.slug && bySlug[m.slug] ? m.slug : null;
    if (!detectedSlug) TT.warn(`Map « ${m.raw} » non reconnue : choisis-la dans la liste.`);
    if (manualSlug === "auto" && detectedSlug) {
      lastPos = null; $("readout").hidden = true;      // nouvelle map = nouveau raid
      if (cur && cur.marker) { cur.marker.remove(); cur.marker = null; }
      showMap(detectedSlug);
    }
    updateChip(); refreshEmpty();
  }
  function updateChip() {
    const chip = $("map-source");
    const name = (sl) => (bySlug[sl] ? bySlug[sl].name : sl);
    let text, act = "", warn = false;
    if (manualSlug !== "auto") { text = "Map choisie à la main · repasser en automatique"; act = "auto"; }
    else if (detectedSlug && cur && cur.slug !== detectedSlug) { text = `Raid détecté : ${name(detectedSlug)} · y retourner`; act = "raid"; }
    else if (detectedSlug) text = "Map détectée dans les logs";
    else if (TT.logsOk === false) { text = "Logs introuvables · ouvrir le diagnostic"; act = "settings"; warn = true; }
    else text = "En attente d'un raid (ou choisis la map dans la liste)";
    chip.hidden = false; chip.textContent = text; chip.dataset.act = act;
    chip.className = "chip" + (warn ? " warn" : "");
    chip.disabled = !act;
  }
  function onChip() {
    const act = $("map-source").dataset.act;
    if (act === "auto") { setAuto(); }
    else if (act === "raid") { showMap(detectedSlug); updateChip(); refreshEmpty(); }
    else if (act === "settings") TT.openSettings && TT.openSettings(true);
  }
  function setAuto() {
    manualSlug = "auto"; $("map-select").value = "auto";
    const slug = resolveSlug();
    if (slug) showMap(slug);
    updateChip(); refreshEmpty();
  }

  function refreshEmpty() {
    const empty = $("empty"), slug = resolveSlug();
    if (!cur && !slug) { $("empty-text").textContent = "Choisis une map dans la liste, ou lance un raid : elle sera détectée dans les logs."; empty.hidden = false; }
    else if (!lastPos) { $("empty-text").textContent = "En raid, prends une capture d'écran avec la touche du jeu. Ta position apparaît ici."; empty.hidden = false; }
    else empty.hidden = true;
  }

  function init(calibrations) {
    calibs = calibrations; bySlug = Object.fromEntries(calibs.map((m) => [m.slug, m]));
    const sel = $("map-select");
    sel.append(new Option("Automatique (logs)", "auto"));
    calibs.forEach((m) => sel.append(new Option(m.name, m.slug)));
    sel.value = manualSlug;
    sel.addEventListener("change", () => {
      manualSlug = sel.value;
      const slug = resolveSlug();
      if (slug) {
        lastPos = null; $("readout").hidden = true;
        if (cur && cur.marker) { cur.marker.remove(); cur.marker = null; }
        showMap(slug);
      }
      updateChip(); refreshEmpty();
    });
    $("follow-btn").addEventListener("click", () => setFollow(!follow));
    $("center-btn").addEventListener("click", centerOnPlayer);
    $("map-source").addEventListener("click", onChip);
    const side = $("map-side");
    side.addEventListener("change", onSideEvent);
    side.addEventListener("click", onSideClick);
    side.addEventListener("input", onSideInput);
    setFollow(follow);
    const s = resolveSlug(); if (s) showMap(s);
    updateChip(); refreshEmpty();
    TT.store.on((k) => { if (!cur) return; if (k === "data" || k === "progress") { syncLayers(); renderSidebar(); } else if (k === "status" && !TT.store.S.idx) renderSidebar(); });
  }

  TT.mapview = { init, updateChip, setAuto, onPosition, onMap, showSlug, highlightItem, locateItem, focusTaskOnMap, setFollow, onShow, resolveSlug, isFollowing: () => follow, current: () => cur };
})();
