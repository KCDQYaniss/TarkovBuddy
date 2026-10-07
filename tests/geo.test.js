// Vérifie que notre calibration pure == le CRS Leaflet construit comme tarkov.dev.
const { JSDOM } = require("jsdom");
const dom = new JSDOM("<div id=m style='width:800px;height:600px'></div>", { pretendToBeVisual: true });
global.window = dom.window; global.document = dom.window.document; global.navigator = dom.window.navigator;
const L = require("../ui/vendor/leaflet.js");
const Geo = require("../ui/geo.js");
const maps = require("../ui/maps.json");
let bad = 0, n = 0;
for (const m of maps) {
  const cal = Geo.makeCalibration(m);
  const crs = L.extend({}, L.CRS.Simple, {
    transformation: new L.Transformation(cal.scaleX, cal.marginX, cal.scaleY, cal.marginY),
    projection: L.extend({}, L.Projection.LonLat, {
      project: (ll) => { const r = Geo.rotate(ll.lng, ll.lat, cal.rotation); return L.point(r.lng, r.lat); },
      unproject: (p) => { const r = Geo.rotate(p.x, p.y, -cal.rotation); return L.latLng(r.lat, r.lng); },
    }),
  });
  for (const [x, z] of [[0, 0], [100, -50], [-300, 200], [m.bounds[0][0], m.bounds[0][1]]]) {
    const a = crs.latLngToPoint(L.latLng(z, x), 0);
    const b = cal.gamePixel(x, z);
    n++;
    if (Math.abs(a.x - b.x) > 1e-6 || Math.abs(a.y - b.y) > 1e-6) { bad++; console.log("ÉCART", m.slug, x, z, a, b); }
    // aller-retour
    const back = cal.fromPixel(b.x, b.y);
    if (Math.abs(back.lat - z) > 1e-6 || Math.abs(back.lng - x) > 1e-6) { bad++; console.log("ALLER-RETOUR", m.slug); }
  }
}
console.log(`${n} points comparés, ${bad} écarts`);
// Cap : avancer de +X jeu puis +Z jeu doit donner des caps cohérents (écart de 90°).
const c = Geo.makeCalibration(maps.find(m => m.slug === "customs"));
const hx = c.headingDeg(0,0, 1,0), hz = c.headingDeg(0,0, 0,1);
console.log("customs: cap vers +X =", hx.toFixed(1), "| vers +Z =", hz.toFixed(1));
process.exit(bad ? 1 : 0);
