/*
 * calage.js — Convertit longitude/latitude en coordonnées du fond de carte.
 * Version JavaScript de calage.py.
 *
 *   lon/lat  ->  Lambert-93 (mètres)  ->  pixels du viewBox
 *
 * Il y a DEUX systèmes de fond, avec chacun leur cadrage (viewBox) et donc
 * leur propre calage, mesuré sur les 4 points de repère (résidus < 0,03 px) :
 *   - "350" : viewBox 350 x 481.13     (format colonne mobile)
 *   - "700" : viewBox 589.06 x 550     (format large desktop)
 */
window.CALAGE = (function () {

  const SYSTEMES = {
    "350": { W: 350,    H: 481.13,
             A: 0.0002917616524690125,  B: -19.598324194775188,
             C: -0.00029175176582378647, D: 2192.9448852709143 },
    "700": { W: 589.06, H: 550,
             A: 0.00048873752567448,    B: -27.29312976721053,
             C: -0.000488730771990162,  D: 3503.914426084331 },
  };

  // Projection Lambert-93 (EPSG:2154), Lambert Conforme Conique 2SP, ellipsoïde GRS80.
  function lonlatToL93(lon, lat) {
    const a = 6378137.0, f = 1 / 298.257222101;
    const e = Math.sqrt(2 * f - f * f);
    const lat0 = rad(46.5), lat1 = rad(44.0), lat2 = rad(49.0);
    const lon0 = rad(3.0), x0 = 700000.0, y0 = 6600000.0;
    const m = p => Math.cos(p) / Math.sqrt(1 - e * e * Math.sin(p) ** 2);
    const t = p => Math.tan(Math.PI / 4 - p / 2) /
      Math.pow((1 - e * Math.sin(p)) / (1 + e * Math.sin(p)), e / 2);
    const n = (Math.log(m(lat1)) - Math.log(m(lat2))) / (Math.log(t(lat1)) - Math.log(t(lat2)));
    const F = m(lat1) / (n * Math.pow(t(lat1), n));
    const rho0 = a * F * Math.pow(t(lat0), n);
    const la = rad(lat), lo = rad(lon);
    const rho = a * F * Math.pow(t(la), n);
    const th = n * (lo - lon0);
    return [x0 + rho * Math.sin(th), y0 + rho0 - rho * Math.cos(th)];
  }
  function rad(d) { return d * Math.PI / 180; }

  // lon/lat -> [x, y] dans le repère du fond (système "350" par défaut)
  function lonlatToSvg(lon, lat, systeme) {
    const s = SYSTEMES[systeme || "350"];
    const [X, Y] = lonlatToL93(lon, lat);
    return [s.A * X + s.B, s.C * Y + s.D];
  }

  return { SYSTEMES, lonlatToSvg, lonlatToL93 };
})();
