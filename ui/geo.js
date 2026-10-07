// Conversion coordonnées jeu -> carte. Logique pure, sans Leaflet ni DOM.
//
// Calibration (transform, rotation, bounds) : the-hideout/tarkov-dev (MIT).
// Convention reprise du site tarkov.dev : un point jeu (x, z) devient
// lat = z, lng = x ; on le tourne de `rotation` degrés, puis on applique
// l'affine [scaleX, marginX, -scaleY, marginY].
(function (root) {
  function rotate(lng, lat, deg) {
    if (!deg) return { lng, lat };
    const a = (deg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
    return { lng: lng * c - lat * s, lat: lng * s + lat * c };
  }

  function makeCalibration(map) {
    const t = map.transform || [1, 0, 1, 0];
    const rot = map.rotation || 0;
    const scaleX = t[0], marginX = t[1], scaleY = -t[2], marginY = t[3];
    return {
      rotation: rot,
      scaleX, marginX, scaleY, marginY,
      // lat/lng "brut" -> point en pixels au zoom 0
      toPixel(lat, lng) {
        const r = rotate(lng, lat, rot);
        return { x: scaleX * r.lng + marginX, y: scaleY * r.lat + marginY };
      },
      // pixel au zoom 0 -> lat/lng "brut"
      fromPixel(px, py) {
        const r = { lng: (px - marginX) / scaleX, lat: (py - marginY) / scaleY };
        return rotate(r.lng, r.lat, -rot);
      },
      // Position jeu (x, z) -> pixel au zoom 0
      gamePixel(x, z) { return this.toPixel(z, x); },
      // Cap du joueur (degrés, 0 = haut de l'écran, sens horaire) à partir
      // du vecteur "avant" jeu (fx, fz).
      headingDeg(x, z, fx, fz) {
        const p = this.gamePixel(x, z);
        const q = this.gamePixel(x + fx * 10, z + fz * 10);
        return (Math.atan2(q.x - p.x, -(q.y - p.y)) * 180) / Math.PI;
      },
    };
  }

  // Emprise de l'image : svgBounds si présent, sinon bounds. Les bornes sont
  // exprimées en [lng, lat] = [x jeu, z jeu].
  function imageBoundsLatLng(map) {
    const b = map.svgBounds || map.bounds;
    return [[b[0][1], b[0][0]], [b[1][1], b[1][0]]];
  }

  const api = { rotate, makeCalibration, imageBoundsLatLng };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.Geo = api;
})(typeof window !== "undefined" ? window : globalThis);
