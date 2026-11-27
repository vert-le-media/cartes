/*
 * carte.js — Carte interactive des coupes rases 2019-2025 par commune (France métropolitaine).
 * Hexagones de 2 km abandonnés le 2026-11-25 (index.html = version communale) ; leur code reste, inactif sans
 * window.COMMUNES_CARTE.
 * JS natif, sans dépendance. Tout est dessiné en Lambert-93 (mètres) dans un <canvas>.
 *   - deux modes : part de la surface boisée / part du territoire en coupes rases
 *   - survol (souris) ou toucher (mobile) : infobulle de l'hexagone
 *   - recherche de commune : le contour (chargé à la demande, donnees/communes/XX.js) n'apparaît
 *     qu'une fois la commune choisie ; elle est soulignée (contour) et la carte zoome dessus.
 *   - en zoomant (S_POLY), polygones des coupes de Canopée par année, chargés par carreaux de 20 km
 *     (donnees/coupes/i_j.js, index donnees/coupes-index.js, script 12_tuiles_coupes.R)
 * Données : window.HEX, window.CONTOURS, window.ZONES (zones d'erreur, 06_scripts/08_zones_erreur.R), window.COMMUNES (chargé à la demande) (06_scripts/06_donnees_carte_interactive.R).
 */
(function () {
  "use strict";

  // ---------- Réglages ----------
  const BORNES = [0, 2, 4, 10, 15, 30, 50];
  const ETIQ = ["0 à 2 %", "2 à 4 %", "4 à 10 %", "10 à 15 %", "15 à 30 %", "30 à 50 %", "50 % et plus"];
  const PAL = ["#fff0e6", "#fdd0b4", "#fba47f", "#f95a35", "#d33b1c", "#9b2511", "#561106"];
  const GRIS = "#e2e2e2";
  // Zéro à part (2026-11-20) : classe 8 = aucune coupe détectée (forêt présente), distincte de 0-2 % et du
  // « pas de forêt » (classe 7, transparente sur le satellite)
  const ZERO = "#9fb88a", ZERO_ETIQ = "Aucune coupe détectée";
  const couleurClasse = k => k === 8 ? ZERO : k === 7 ? GRIS : PAL[k];
  // aucun seuil de surface boisée (choix de Sébastien, 2026-11-20) : taux calculé dès qu'il y a de la forêt
  // zoom maximal : 0,3 px par mètre (≈ 3 m par pixel, un hexagone ≈ 600 px) ; 0,08 avant les polygones (2026-11-24)
  const S_MAX = 0.3;
  // Fond satellite (2026-11-26) : orthophotos IGN en tuiles toutes prêtes (WMTS de la Géoplateforme, projection
  // Web Mercator « PM », 256 px, niveaux 0 à 19), redressées en Lambert-93 dans le navigateur (voir dessinerSatellite).
  // Avant : WMS calculé à la demande en Lambert-93, 12 à 26 s par image le 2026-11-26 ; WMTS : 0,1 à 1,5 s.
  const WMTS = "https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=ORTHOIMAGERY.ORTHOPHOTOS" +
               "&STYLE=normal&TILEMATRIXSET=PM&FORMAT=image/jpeg";
  const Z_MAX_SAT = 19, MER = "#0a3b59";   // MER : bleu uni de la mer sur ces images (fond pendant le chargement)
  // Opacité des hexagones sur le satellite (2026-11-20 : plus transparent pour laisser voir les photos) :
  // classes claires (aucune coupe, 0-2 %, 2-4 %), qui couvrent l'essentiel du territoire, plus transparentes
  // 2026-11-26 (demande de Sébastien) : « aucune coupe détectée » transparente (retirée de la légende, gardée dans
  // l'infobulle) ; 0-2 % éclaircie (0,45 → 0,3)
  const opacite = k => k === 8 ? 0 : k === 0 ? 0.3 : k === 1 ? 0.45 : 0.62;
  const MODES = {
    foret: { titre: window.COMMUNES_CARTE ? "Taux de coupes rases en % de la forêt, par commune, entre 2018 et 2025"
                                         : "Taux de coupes rases en % de la forêt, par maille de 2 km de diamètre", gris: "Pas de forêt" },
    hex:   { titre: "Taux de coupes rases en % du territoire, par maille de 2 km de diamètre", gris: null },
  };

  // Chronomètre (console, et sous la carte avec ?chrono) : où part le temps à l'ouverture.
  const CHRONO = [];
  function chrono(etape, ms) {
    CHRONO.push(etape + " : " + Math.round(ms) + " ms");
    if (window.console && console.info) console.info("[carte] " + etape + " : " + Math.round(ms) + " ms");
    const el = document.getElementById("chrono");
    if (el) el.textContent = CHRONO.join(" · ");
  }
  if (/[?&]chrono/.test(location.search)) {
    const el = document.createElement("p"); el.id = "chrono"; el.className = "chrono";
    document.querySelector(".habillage").appendChild(el);
  }
  if (window.T_PAGE !== undefined) chrono("page et styles, avant les données (depuis l'ouverture)", window.T_PAGE);
  chrono("données téléchargées et lues (depuis l'ouverture)", performance.now());
  const T_SCRIPT = performance.now();
  const H = window.HEX, G = H.grille, N = H.col.length;
  const $ = id => document.getElementById(id);
  const canvas = $("carte"), ctx = canvas.getContext("2d"), cadre = $("cadre");
  const tt = $("tt"), q = $("q"), res = $("res"), effacer = $("effacer");

  // ---------- Géométrie des hexagones ----------
  const CX = new Float64Array(N), CY = new Float64Array(N), INDEX = new Map();
  for (let i = 0; i < N; i++) {
    CX[i] = G.x0 + H.col[i] * G.dx / 2;
    CY[i] = G.y0 + H.ligne[i] * G.dy;
    INDEX.set(H.ligne[i] * 4096 + H.col[i], i);
  }
  const taux = {
    foret: i => H.boise[i] > 0 ? 100 * H.coupe[i] / H.boise[i] : null,
    hex:   i => H.terre[i] > 0 ? 10 * H.coupe[i] / H.terre[i] : null,
  };
  function classe(t) {
    if (t === null) return 7;
    if (t === 0) return 8;
    let k = 0;
    while (k < BORNES.length - 1 && t >= BORNES[k + 1]) k++;
    return k;
  }
  // Un Path2D par classe et par mode, en coordonnées Lambert-93. Sommets agrandis de 2 % pour que
  // les hexagones voisins se chevauchent légèrement (pas de liseré blanc dû à l'anticrénelage).
  const SOM = G.sommets.map(([x, y]) => [x * 1.02, y * 1.02]);
  function hexagone(p, i) {
    const x = CX[i], y = CY[i];
    p.moveTo(x + SOM[0][0], y + SOM[0][1]);
    for (let k = 1; k < 6; k++) p.lineTo(x + SOM[k][0], y + SOM[k][1]);
    p.closePath();
  }
  const CLASSES = {};
  for (const m of Object.keys(MODES)) {
    const cl = new Uint8Array(N);
    for (let i = 0; i < N; i++) cl[i] = classe(taux[m](i));
    CLASSES[m] = cl;
  }
  // (H.coupe et H.boise en 0,01 ha ; H.terre en 0,1 ha)

  // ---------- Variante communale (communes.html, 2026-11-23) ----------
  // Chargée seulement si la page fournit window.COMMUNES_CARTE (contours, script 11) et window.TAUX_COMMUNES
  // (surfaces coupée / boisée en 0,01 ha + zone d'erreur, script 10). Les communes remplacent alors les hexagones
  // pour le dessin, le survol et l'infobulle ; tout le reste (légende, recherche, satellite, points) est commun.
  const COMMUNAL = !!(window.COMMUNES_CARTE && window.TAUX_COMMUNES);
  const COM = COMMUNAL ? Object.keys(window.COMMUNES_CARTE.geo) : [];
  const NC = COM.length, CL_C = new Uint8Array(NC), ERR_C = new Uint8Array(NC), TX_C = new Float64Array(NC);
  const CHEMIN_C = new Array(NC), BB_C = new Float64Array(NC * 4), CASES_C = new Map(), CASE_C = 10000;
  if (COMMUNAL) {
    for (let i = 0; i < NC; i++) {
      const t = window.TAUX_COMMUNES[COM[i]] || [0, 0, 0];
      TX_C[i] = t[1] > 0 ? 100 * t[0] / t[1] : NaN;
      CL_C[i] = classe(t[1] > 0 ? TX_C[i] : null); ERR_C[i] = t[2] ? 1 : 0;
    }
  }
  const clAt = i => COMMUNAL ? CL_C[i] : CLASSES[mode][i];
  const zoneAt = i => COMMUNAL ? ERR_C[i] : EN_ZONE[i];
  function preparerCommunes() {   // chemins Path2D (Lambert-93) et index spatial des communes, une fois
    if (!COMMUNAL || preparerCommunes.ok) return;
    preparerCommunes.ok = true;
    const t = performance.now();
    for (let i = 0; i < NC; i++) {
      const { p, bb } = cheminCommune(window.COMMUNES_CARTE.geo[COM[i]]);
      CHEMIN_C[i] = p; BB_C.set(bb, 4 * i);
      for (let gx = Math.floor(bb[0] / CASE_C); gx <= Math.floor(bb[2] / CASE_C); gx++)
        for (let gy = Math.floor(bb[1] / CASE_C); gy <= Math.floor(bb[3] / CASE_C); gy++) {
          const key = gx * 1000 + gy; if (!CASES_C.has(key)) CASES_C.set(key, []); CASES_C.get(key).push(i);
        }
    }
    chrono("contours des communes préparés", performance.now() - t);
  }
  // peint les communes dans cv (coin haut gauche X0, Ytop en mètres ; m mètres par pixel), découpé à la France
  function peindreCommunes(cv, X0, Ytop, m, contours) {
    preparerCommunes();
    const c = cv.getContext("2d"), X1 = X0 + cv.width * m, Ybas = Ytop - cv.height * m;
    c.setTransform(1, 0, 0, 1, 0, 0); c.clearRect(0, 0, cv.width, cv.height);
    c.setTransform(1 / m, 0, 0, -1 / m, -X0 / m, Ytop / m);
    const parClasse = new Map(), vis = [];
    for (let i = 0; i < NC; i++) {
      const o = 4 * i;
      if (BB_C[o + 2] < X0 || BB_C[o] > X1 || BB_C[o + 3] < Ybas || BB_C[o + 1] > Ytop) continue;
      vis.push(i);
      const k = zonesVisibles && ERR_C[i] ? 9 : CL_C[i];
      if (k !== 9 && ((satellite && (k === 7 || k === 8)) || masquees.has(k))) continue;
      if (!parClasse.has(k)) parClasse.set(k, new Path2D());
      parClasse.get(k).addPath(CHEMIN_C[i]);
    }
    for (const [k, p] of parClasse) {
      c.globalAlpha = k === 9 ? Z_OPAC : (satellite ? opacite(k) : 1);
      c.fillStyle = k === 9 ? Z_COUL : couleurClasse(k);
      c.fill(p, "evenodd");
    }
    c.globalAlpha = 1;
    if (contours) {   // limites communales en filet blanc, seulement quand on a zoomé
      const p = new Path2D(); for (const i of vis) p.addPath(CHEMIN_C[i]);
      c.strokeStyle = "rgba(255,255,255,0.45)"; c.lineWidth = 0.7 * m; c.stroke(p);
    }
    return c;
  }

  // Index spatial : hexagones triés par ligne puis colonne, avec le début de chaque ligne,
  // pour ne parcourir que les hexagones visibles à l'écran.
  let LMAX = 0;
  for (let i = 0; i < N; i++) if (H.ligne[i] > LMAX) LMAX = H.ligne[i];
  const DEBUT = new Int32Array(LMAX + 2);
  for (let i = 0; i < N; i++) DEBUT[H.ligne[i] + 1]++;
  for (let r = 1; r <= LMAX + 1; r++) DEBUT[r] += DEBUT[r - 1];
  const ORDRE = new Int32Array(N);
  { const pos = DEBUT.slice(); for (let i = 0; i < N; i++) ORDRE[pos[H.ligne[i]]++] = i; }
  for (let r = 0; r <= LMAX; r++) {
    const ligne = Array.from(ORDRE.subarray(DEBUT[r], DEBUT[r + 1])).sort((a, b) => H.col[a] - H.col[b]);
    ORDRE.set(ligne, DEBUT[r]);
  }
  function visibles(x0, y0, x1, y1) {   // indices des hexagones dont le centre est dans l'emprise (+ 1 hexagone)
    const out = [];
    const r0 = Math.max(0, Math.floor((y0 - G.y0) / G.dy) - 1), r1 = Math.min(LMAX, Math.ceil((y1 - G.y0) / G.dy) + 1);
    const c0 = Math.floor((x0 - G.x0) / (G.dx / 2)) - 2, c1 = Math.ceil((x1 - G.x0) / (G.dx / 2)) + 2;
    for (let r = r0; r <= r1; r++) {
      let a = DEBUT[r], b = DEBUT[r + 1];
      while (a < b) { const m = (a + b) >> 1; if (H.col[ORDRE[m]] < c0) a = m + 1; else b = m; }   // 1re colonne ≥ c0
      for (let k = a; k < DEBUT[r + 1] && H.col[ORDRE[k]] <= c1; k++) out.push(ORDRE[k]);
    }
    return out;
  }

  // ---------- Contours ----------
  function anneaux(liste, fermer) {
    const p = new Path2D();
    for (const r of liste) {
      p.moveTo(r[0], r[1]);
      for (let k = 2; k < r.length; k += 2) p.lineTo(r[k], r[k + 1]);
      if (fermer) p.closePath();
    }
    return p;
  }
  const FRANCE = anneaux(window.CONTOURS.france, true);
  const LIMITES = anneaux(window.CONTOURS.limites, false);
  // Zones où la marge d'erreur de la détection Canopée est trop élevée (2026-11-20) : hexagones dont le centre tombe
  // dans un carré count = 2 des fichiers bounds_with_count_2025 (script 08), peints en gris à la place de leur classe
  // (le détourage des groupes a été abandonné : pas assez lisible). Clic sur la légende : afficher leurs vrais taux.
  const ZONES = !!window.ZONES;
  const EN_ZONE = new Uint8Array(N);
  if (ZONES) for (const i of window.ZONES.hex) EN_ZONE[i] = 1;
  const Z_COUL = "#c3c9ca", Z_OPAC = 0.75, Z_ETIQ = "Marge d'erreur élevée";
  let zonesVisibles = true;
  // Mobilisations contre des coupes rases (2026-11-23, texte de Canopée) : un point au centre de la commune
  const MOB = window.MOBILISATIONS || [], MOB_COUL = "#004352", MOB_ETIQ = "Mobilisation contre une coupe rase";
  // 2026-11-26 (demande de Sébastien) : picto « contestation » de la carte des data centers à la place de la pastille,
  // points masqués à l'ouverture (on les affiche depuis la légende)
  let mobVisibles = false, mobSurvole = -1;
  const PICTO_MOB = new Image(); PICTO_MOB.onload = () => rendre(); PICTO_MOB.src = "picto-contestation.svg";
  const PICTO_RATIO = 10.31 / 9.39, PICTO_CY = 0.464;   // hauteur / largeur du picto ; centre du disque (part de la hauteur)
  // Polygones des coupes rases (2026-11-24) : à partir de S_POLY px/m (≈ 40 m par pixel), les carreaux de 20 km qui
  // touchent l'écran sont chargés (script JSONP, marche aussi en local) et peints par année par-dessus les
  // hexagones / communes, alors estompés. Toutes en rouge de la charte (2026-11-25, demande de Sébastien ; avant :
  // couleur par année), l'année et les enjeux (script 13) sont dans l'infobulle. Rouge #ed1c24 choisi par Sébastien
  // le 2026-11-26 (avant : #f74141).
  const CI = window.COUPES_INDEX, POLY = !!CI, S_POLY = 0.025, FONDU_POLY = 0.45;
  const ROUGE = "#ed1c24", ROUGE_ETIQ = "Coupe rase détectée (visible en zoomant)";
  // rouge plein, sans transparence, sur la carte comme dans la légende (2026-11-27 ; avant : opacité 0,85)
  let polyVisibles = true, polySurvole = null;
  const CARREAUX = new Map();   // "i_j" -> { a, s, f, p, noms, z, n, chemins, bb, tous } (null pendant le chargement)
  const polyActif = () => POLY && polyVisibles && vue.s >= S_POLY;
  window.COUPES_TUILE = (cle, d) => {
    const n = d.a.length, chemins = new Array(n), bb = new Float64Array(4 * n);
    const tous = new Path2D();
    for (let i = 0; i < n; i++) {
      const p = new Path2D(); let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const r of d.g[i]) {
        let x = r[0], y = r[1]; p.moveTo(x, y);
        for (let k = 0; k < r.length; k += 2) {
          if (k) { x += r[k]; y += r[k + 1]; p.lineTo(x, y); }
          if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
        }
        p.closePath();
      }
      chemins[i] = p; bb.set([x0, y0, x1, y1], 4 * i); tous.addPath(p);
    }
    CARREAUX.set(cle, { a: d.a, s: d.s, f: d.f || [], p: d.p || [], noms: d.n || [], z: d.z || [], n, chemins, bb, tous });
    if (CARREAUX.size > 80) for (const k of CARREAUX.keys()) { if (CARREAUX.size <= 60) break; if (CARREAUX.get(k)) CARREAUX.delete(k); }   // 120 / 100 avant le 2026-11-27
    if (couche) couche.perime = true;
    rendre();
  };
  function chargerCarreau(k) {
    if (CARREAUX.has(k)) return;
    CARREAUX.set(k, null);
    const sc = document.createElement("script");
    sc.src = `donnees/coupes/${k}.js`; sc.onerror = () => CARREAUX.delete(k); sc.onload = () => sc.remove();
    document.head.appendChild(sc);
  }
  function carreauxDans(x0, y0, x1, y1) {   // carreaux dont l'emprise réelle (coupes entières) touche le rectangle
    const out = [];
    for (const k in CI.t) { const b = CI.t[k]; if (b[2] >= x0 && b[0] <= x1 && b[3] >= y0 && b[1] <= y1) out.push(k); }
    return out;
  }
  function peindrePolys(c, X0, Ytop, Wc, Hc, s) {
    c.save(); c.setTransform(1, 0, 0, 1, 0, 0);   // hexagones / communes estompés dessous
    c.globalCompositeOperation = "destination-in"; c.fillStyle = `rgba(0,0,0,${FONDU_POLY})`;
    c.fillRect(0, 0, c.canvas.width, c.canvas.height); c.restore();
    const prets = [];
    for (const k of carreauxDans(X0, Ytop - Hc / s, X0 + Wc / s, Ytop)) {
      const t = CARREAUX.get(k); if (t) prets.push(t); else chargerCarreau(k);
    }
    c.save();
    c.setTransform(DPR * s, 0, 0, -DPR * s, -X0 * s * DPR, Ytop * s * DPR);
    c.globalAlpha = 1; c.fillStyle = ROUGE;
    for (const t of prets) c.fill(t.tous, "nonzero");
    c.globalAlpha = 1; c.lineJoin = "round";
    c.strokeStyle = "rgba(255,255,255,0.8)"; c.lineWidth = (s > 0.1 ? 1 : 0.6) / s;
    for (const t of prets) c.stroke(t.tous);
    c.restore();
  }
  function trouverPoly(u, v) {   // coupe sous le pointeur (la plus récente si plusieurs se superposent)
    if (!polyActif()) return null;
    const [X, Y] = versMonde(u, v), tol = 3 / vue.s;   // 3 px de tolérance pour les toutes petites coupes
    const ctx2 = trouver.ctx || (trouver.ctx = document.createElement("canvas").getContext("2d"));
    let best = null;
    for (const [k, t] of CARREAUX) {
      if (!t) continue;
      const b = CI.t[k]; if (X < b[0] - tol || X > b[2] + tol || Y < b[1] - tol || Y > b[3] + tol) continue;
      for (let i = 0; i < t.n; i++) {
        const o = 4 * i;
        if (X < t.bb[o] - tol || X > t.bb[o + 2] + tol || Y < t.bb[o + 1] - tol || Y > t.bb[o + 3] + tol) continue;
        if (best && t.a[i] <= best.t.a[best.i]) continue;
        ctx2.lineWidth = 2 * tol;
        if (ctx2.isPointInPath(t.chemins[i], X, Y, "evenodd") || ctx2.isPointInStroke(t.chemins[i], X, Y)) best = { t, i };
      }
    }
    return best;
  }
  let BB = [Infinity, Infinity, -Infinity, -Infinity];
  for (const r of window.CONTOURS.france) for (let k = 0; k < r.length; k += 2) {
    BB = [Math.min(BB[0], r[k]), Math.min(BB[1], r[k + 1]), Math.max(BB[2], r[k]), Math.max(BB[3], r[k + 1])];
  }
  // Point d'étiquette de chaque département : l'hexagone du département le plus proche de son barycentre
  const ETIQ_DEP = (() => {
    const acc = {};
    for (let i = 0; i < N; i++) {
      const a = acc[H.dep[i]] || (acc[H.dep[i]] = { x: 0, y: 0, w: 0, best: -1, d: Infinity });
      a.x += CX[i] * H.terre[i]; a.y += CY[i] * H.terre[i]; a.w += H.terre[i];
    }
    for (const a of Object.values(acc)) { a.x /= a.w; a.y /= a.w; }
    for (let i = 0; i < N; i++) {
      const a = acc[H.dep[i]], d = (CX[i] - a.x) ** 2 + (CY[i] - a.y) ** 2;
      if (d < a.d && H.terre[i] > 3000) { a.d = d; a.best = i; }
    }
    return Object.entries(acc).filter(([, a]) => a.best >= 0)
      .map(([code, a]) => ({ nom: H.deps[code] || code, x: CX[a.best], y: CY[a.best] }));
  })();

  // ---------- Vue ----------
  let W = 0, Hh = 0, DPR = 1, vue = { cx: 0, cy: 0, s: 1 }, sMin = 0.0001, mode = "foret";
  let survole = -1, epingle = false, selection = null, vol = null, prevu = false;
  const satellite = true;   // fond satellite toujours affiché (vue plan supprimée le 2026-11-19)

  // Cadre « à la BRGM » : la hauteur du cadre suit les proportions de la France (Corse comprise) pour
  // la largeur disponible (légende au-dessus, hors de la carte) ; plafonnée à 85 % de la fenêtre.
  // marge autour de la France ; la légende est hors de la carte
  // marges autour de la France, en px : côtés et haut ; en bas, 8 px seulement pour ne jamais passer sous la limite
  // sud de la mosaïque satellite IGN (Y ≈ 6 004 000, 42 km sous la pointe de la Corse) — la légende est hors carte
  // gauche : en plein écran sur grand écran, la France se cale à droite du panneau flottant (titre, légende, recherche)
  const marges = () => {
    const m = W < 520 ? 14 : 20; let gauche = m;
    if (W > 900 && estPlein()) {
      const p = document.querySelector(".panneau"), rp = p && p.getBoundingClientRect && p.getBoundingClientRect(), rc = cadre.getBoundingClientRect();
      if (rp && rp.right > 0 && rc && rc.left !== undefined) gauche = Math.max(m, rp.right - rc.left + 16);
    }
    return { m, gauche, haut: m, bas: 8 };
  };
  function estPlein() {
    const h = document.querySelector(".habillage");
    return !!(document.fullscreenElement || document.webkitFullscreenElement) || !!(h && h.classList && h.classList.contains("plein"));
  }
  function ajusterTaille() {
    const hab = document.querySelector(".habillage");
    // largeur disponible pour la carte (contenu de l'habillage), indépendante de la largeur actuelle du cadre
    let dispoW = cadre.getBoundingClientRect().width;
    if (hab && window.getComputedStyle && hab.clientWidth) {
      const cs = getComputedStyle(hab);
      dispoW = hab.clientWidth - parseFloat(cs.paddingLeft || 0) - parseFloat(cs.paddingRight || 0);
    }
    W = dispoW;
    const { m, haut, bas } = marges(), ratio = (BB[3] - BB[1]) / (BB[2] - BB[0]);
    // Dans l'iframe de l'article, innerHeight = hauteur de l'iframe, qui suit elle-même la hauteur de la carte
    // (message vert-carte-hauteur) : s'y caler ferait rapetisser la carte à chaque aller-retour. On se cale alors sur
    // l'écran (hauteur utile moins ~110 px de barres du navigateur), valeur fixe : pas de boucle.
    const dansIframe = window.parent !== window;
    const ih = dansIframe ? Math.max(500, ((window.screen && screen.availHeight) || 900) - 110) : (window.innerHeight || 900), prop = (dispoW - 2 * m) * ratio + haut + bas;
    let h = prop, larg = null;
    if ((window.innerWidth || 1000) > 760) {
      // ordinateur : tout l'habillage (titre, légende, recherche, carte, sources) tient dans
      // la fenêtre / l'iframe. Si la place manque en hauteur, la carte rapetisse dans les DEUX sens (proportions de
      // la France, centrée) : sinon elle montrerait l'Italie et la mer hors de la mosaïque satellite (bande unie).
      const autres = hab ? hab.getBoundingClientRect().height - cadre.getBoundingClientRect().height : 0;
      const dispoH = ih - autres - 2 * 8 - 4;   // 8 : marge du body ; 4 : sécurité
      // 2026-11-26 (demande de Sébastien) : la carte garde toute la largeur sous la recherche (avant : rétrécie et
      // centrée) ; le fond WMTS couvre aussi l'étranger et la mer, plus de bande unie sur les côtés
      if (dispoH < prop) h = Math.max(300, dispoH);
    } else h = Math.min(prop, ih * 0.85);   // mobile : la page peut défiler
    h = Math.round(h);
    // recalcul seulement si la largeur disponible (≥ 20 px) ou la hauteur de fenêtre (≥ 10 px) a vraiment changé,
    // ou si on le force (police chargée) : pas d'oscillation
    const a = ajusterTaille;
    if (estPlein()) {   // plein écran : la carte prend toute la place restante (CSS, flex), quelle que soit la forme
      cadre.style.height = cadre.style.width = cadre.style.alignSelf = ""; a.w = 0;
    } else if (a.force || !a.w || Math.abs(dispoW - a.w) >= 20 || Math.abs(ih - a.ih) >= 10) {
      cadre.style.height = h + "px";
      cadre.style.width = larg ? Math.round(larg) + "px" : "";
      cadre.style.alignSelf = larg ? "center" : "";
      a.w = dispoW; a.ih = ih; a.force = false;
    }
    const r = cadre.getBoundingClientRect();
    // Mémoire (2026-11-27 : Safari fermait l'onglet sur un iPhone X, 3 Go) : densité plafonnée à 2 pixels réels par
    // point (les écrans à 3 triplaient les images calculées ; rendu toujours net) ; image de la France plus légère sur
    // téléphone (elle n'y est jamais affichée à plus de ~0,0006 px/m)
    W = r.width; Hh = r.height; DPR = Math.min(2, window.devicePixelRatio || 1);
    { const sn = W < 760 ? 0.0013 : 0.002; if (sn !== S_NAT) { S_NAT = sn; nationale = null; } }
    canvas.width = Math.round(W * DPR); canvas.height = Math.round(Hh * DPR);
    { const { m, gauche, haut, bas } = marges();   // (marges recalculées avec la largeur réelle du cadre)
      sMin = Math.min((W - gauche - m) / (BB[2] - BB[0]), (Hh - haut - bas) / (BB[3] - BB[1])); }
  }
  const vueFrance = () => contraindre({ cx: (BB[0] + BB[2]) / 2, cy: (BB[1] + BB[3]) / 2, s: sMin });
  // Vue bloquée dans le cadre : pas de dézoom au-delà de la France entière, et la fenêtre ne sort jamais
  // de l'emprise de la France (+ marge). Si la France est plus petite que
  // la fenêtre dans un sens, elle reste centrée dans ce sens.
  function contraindre(v) {
    v.s = Math.max(sMin, Math.min(S_MAX, v.s));
    const { m, gauche, haut, bas } = marges(), mm = m / v.s;
    const borne = (lo, hi, demi, x) => {
      const a = lo + demi, b = hi - demi;
      return a <= b ? Math.max(a, Math.min(b, x)) : (a + b) / 2;
    };
    v.cx = borne(BB[0] - gauche / v.s, BB[2] + mm, W / 2 / v.s, v.cx);
    v.cy = borne(BB[1] - bas / v.s, BB[3] + haut / v.s, Hh / 2 / v.s, v.cy);
    return v;
  }
  const versMonde = (u, v) => [vue.cx + (u - W / 2) / vue.s, vue.cy - (v - Hh / 2) / vue.s];
  const versEcran = (X, Y) => [W / 2 + (X - vue.cx) * vue.s, Hh / 2 - (Y - vue.cy) * vue.s];

  // ---------- Dessin ----------
  // ---------- Fond satellite (tuiles WMTS Web Mercator redressées en Lambert-93) ----------
  // Lambert-93 (RGF93, ellipsoïde GRS80) <-> longitude / latitude en degrés (formules IGN, NTG 71)
  const L93 = (() => {
    const e = 0.0818191910428158, n = 0.725607765053267, C = 11754255.426096, XS = 700000, YS = 12655612.049876;
    const L0 = 3 * Math.PI / 180, RAD = Math.PI / 180;
    function directe(lon, lat) {
      const s = Math.sin(lat * RAD), L = 0.5 * Math.log((1 + s) / (1 - s)) - e / 2 * Math.log((1 + e * s) / (1 - e * s));
      const R = C * Math.exp(-n * L), g = n * (lon * RAD - L0);
      return [XS + R * Math.sin(g), YS - R * Math.cos(g)];
    }
    function inverse(X, Y) {
      const dx = X - XS, dy = YS - Y, R = Math.hypot(dx, dy), g = Math.atan2(dx, dy), L = -Math.log(R / C) / n;
      let p = 2 * Math.atan(Math.exp(L)) - Math.PI / 2;
      for (let k = 0; k < 6; k++) { const s = e * Math.sin(p); p = 2 * Math.atan(Math.pow((1 + s) / (1 - s), e / 2) * Math.exp(L)) - Math.PI / 2; }
      return [(L0 + g / n) / RAD, p / RAD];
    }
    return { directe, inverse };
  })();
  const latTuile = t => Math.atan(Math.sinh(Math.PI * (1 - 2 * t))) * 180 / Math.PI;   // t : ordonnée de tuile / 2^z
  const yTuile = lat => (1 - Math.asinh(Math.tan(lat * Math.PI / 180)) / Math.PI) / 2;
  const TUILES = new Map();   // "z/x/y" -> { img, ok }
  function tuile(z, x, y, demander) {
    const cle = z + "/" + x + "/" + y;
    let t = TUILES.get(cle);
    // tuile en échec (erreur ou refus passager du serveur IGN) : redemandée après 1, 2, 4… s, 5 fois au plus
    if (t && t.echec && demander && t.essais < 5 && performance.now() - t.echec > 1000 * 2 ** (t.essais - 1)) t = null;
    if (!t && demander) {
      const img = new Image(), avant = TUILES.get(cle);
      t = { img, ok: false, essais: avant ? avant.essais : 0 };
      img.crossOrigin = "anonymous";
      img.onload = () => { t.ok = true; rendre(); };
      img.onerror = () => { t.echec = performance.now(); t.essais++; setTimeout(rendre, 1000 * 2 ** (t.essais - 1) + 50); };
      img.src = WMTS + "&TILEMATRIX=" + z + "&TILEROW=" + y + "&TILECOL=" + x;
      TUILES.set(cle, t);
      if (TUILES.size > 250) TUILES.delete(TUILES.keys().next().value);   // cache borné (600 avant le 2026-11-27 : ~150 Mo d'images décodées)
    }
    return t && t.ok ? t : null;
  }
  // Une tuile Web Mercator est découpée en n × n carrés ; chaque carré est posé avec la transformation affine qui
  // relie ses 4 coins (projetés en Lambert-93 puis à l'écran). Plus la tuile couvre de terrain, plus on la découpe
  // (rotation des méridiens et variation d'échelle de Mercator) : écart à la vraie projection < 0,5 px.
  // Chaque carré est agrandi d'un pixel pour ne pas laisser de joints.
  function peindreTuile(img, z, x, y, n) {
    const N = 2 ** z, pas = 256 / n, m = n + 1, P = new Float64Array(2 * m * m), Wp = W * DPR, Hp = Hh * DPR;
    for (let j = 0; j <= n; j++) {
      const lat = latTuile((y + j / n) / N);
      for (let i = 0; i <= n; i++) {
        const [X, Y] = L93.directe((x + i / n) / N * 360 - 180, lat), k = 2 * (j * m + i);
        P[k] = (W / 2 + (X - vue.cx) * vue.s) * DPR; P[k + 1] = (Hh / 2 - (Y - vue.cy) * vue.s) * DPR;
      }
    }
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      const a = 2 * (j * m + i), b = a + 2, c = a + 2 * m, d = c + 2;
      const xmin = Math.min(P[a], P[b], P[c], P[d]), xmax = Math.max(P[a], P[b], P[c], P[d]);
      const ymin = Math.min(P[a + 1], P[b + 1], P[c + 1], P[d + 1]), ymax = Math.max(P[a + 1], P[b + 1], P[c + 1], P[d + 1]);
      if (xmax < 0 || ymax < 0 || xmin > Wp || ymin > Hp) continue;
      let ux = (P[b] - P[a] + P[d] - P[c]) / 2 / pas, uy = (P[b + 1] - P[a + 1] + P[d + 1] - P[c + 1]) / 2 / pas;
      let vx = (P[c] - P[a] + P[d] - P[b]) / 2 / pas, vy = (P[c + 1] - P[a + 1] + P[d + 1] - P[b + 1]) / 2 / pas;
      const fu = 1 + 1 / Math.max(1, Math.hypot(ux, uy) * pas), fv = 1 + 1 / Math.max(1, Math.hypot(vx, vy) * pas);
      ux *= fu; uy *= fu; vx *= fv; vy *= fv;
      const cx = (P[a] + P[b] + P[c] + P[d]) / 4, cy = (P[a + 1] + P[b + 1] + P[c + 1] + P[d + 1]) / 4;
      ctx.setTransform(ux, uy, vx, vy, cx - (ux + vx) * pas / 2, cy - (uy + vy) * pas / 2);
      ctx.drawImage(img, i * pas, j * pas, pas, pas, 0, 0, pas, pas);
    }
  }
  function dessinerSatellite() {
    // niveau dont la résolution est la plus proche de celle de l'écran (pixels physiques), au centre de la vue
    const lat0 = L93.inverse(vue.cx, vue.cy)[1];
    const zv = Math.max(0, Math.min(Z_MAX_SAT, Math.round(Math.log2(156543.034 * Math.cos(lat0 * Math.PI / 180) * vue.s * DPR))));
    // emprise de l'écran en longitude / latitude (bords échantillonnés : les méridiens ne sont pas verticaux)
    let lo0 = Infinity, lo1 = -Infinity, la0 = Infinity, la1 = -Infinity;
    for (let a = 0; a <= 4; a++) for (const [u, v] of [[a * W / 4, 0], [a * W / 4, Hh], [0, a * Hh / 4], [W, a * Hh / 4]]) {
      const [X, Y] = versMonde(u, v), [lo, la] = L93.inverse(X, Y);
      if (lo < lo0) lo0 = lo; if (lo > lo1) lo1 = lo; if (la < la0) la0 = la; if (la > la1) la1 = la;
    }
    ctx.save(); ctx.imageSmoothingEnabled = true;
    // niveaux plus grossiers déjà chargés d'abord (évite les trous pendant le chargement), puis le niveau visé
    for (let z = Math.max(0, zv - 4); z <= zv; z++) {
      // découpage : selon le niveau, et plus fin pour les tuiles plus grossières, agrandies à l'écran
      const N = 2 ** z, n = Math.min(16, (z <= 5 ? 8 : z <= 7 ? 4 : z <= 9 ? 2 : 1) * 2 ** (zv - z));
      const x0 = Math.max(0, Math.floor((lo0 + 180) / 360 * N)), x1 = Math.min(N - 1, Math.floor((lo1 + 180) / 360 * N));
      const y0 = Math.max(0, Math.floor(yTuile(la1) * N)), y1 = Math.min(N - 1, Math.floor(yTuile(la0) * N));
      if ((x1 - x0 + 1) * (y1 - y0 + 1) > 300) continue;   // sécurité
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
        const t = tuile(z, x, y, !vol && z === zv);
        if (t) peindreTuile(t.img, z, x, y, n);
      }
    }
    ctx.restore(); ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  // ---------- Couche des hexagones (optimisée pour les téléphones modestes) ----------
  // 1. Vue d'ensemble : une image de toute la France (4 pixels par hexagone), peinte une seule fois par
  //    mode / fond, puis simplement réduite à l'écran (en vue nationale un hexagone fait ~1 pixel).
  // 2. Vue zoomée, au repos : on ne peint que les hexagones visibles (+ 20 % de marge) dans une image
  //    hors écran, réutilisée tant que la vue ne change pas (survol, infobulle : rien à repeindre).
  // 3. Pendant un geste (glisser, pincer, molette, vol animé) : on ne repeint rien, on déplace et on
  //    agrandit les images déjà prêtes ; la vue nette est repeinte quand le geste se termine.
  let S_NAT = 0.002;   // pixels physiques par mètre de l'image nationale (0,0013 sur téléphone, voir ajusterTaille)
  const MARGE_COUCHE = 0.2;
  let nationale = null, couche = null, finMolette = 0;
  const masquees = new Set();   // classes masquées en cliquant sur la légende
  const cleFond = () => mode + "|" + satellite + "|" + [...masquees].sort().join(",") + "|" + zonesVisibles;
  const cleCouche = () => cleFond() + "|" + W + "|" + Hh + "|" + DPR + "|" + polyVisibles;
  const enMouvement = () => !!vol || !!(geste && geste.bouge) || performance.now() - finMolette < 200;

  // Les hexagones sont peints pixel par pixel (et non comme des milliers de tracés vectoriels, que les
  // navigateurs remplissent très lentement) : chaque pixel prend la couleur de l'hexagone dont le centre
  // est le plus proche (= l'hexagone qui le contient). Grille dense pour retrouver un hexagone sans Map.
  let CMAX = 0;
  for (let i = 0; i < N; i++) if (H.col[i] > CMAX) CMAX = H.col[i];
  const NCOL = CMAX + 1, GRILLE = new Int32Array((LMAX + 1) * NCOL);
  for (let i = 0; i < N; i++) GRILLE[H.ligne[i] * NCOL + H.col[i]] = i + 1;
  const P0 = (H.col[0] - H.ligne[0]) & 1;   // parité des colonnes : (col - ligne) est de parité constante
  const rgba = (h, a) => ((Math.round(255 * a) << 24) | (parseInt(h.slice(5, 7), 16) << 16) | (parseInt(h.slice(3, 5), 16) << 8) | parseInt(h.slice(1, 3), 16)) >>> 0;
  function couleurs() {   // couleur de chaque classe en entier RGBA (ordre mémoire petit-boutiste) ; 9 = zone d'erreur
    return Uint32Array.from({ length: 10 }, (_, k) => {
      if (k === 9) return rgba(Z_COUL, satellite ? Z_OPAC : 1);
      if (satellite && k === 7) return 0;   // « pas de forêt » : transparent sur le satellite
      if (masquees.has(k)) return 0;         // classe masquée depuis la légende
      const h = couleurClasse(k);
      return rgba(h, satellite ? opacite(k) : 1);
    });
  }
  function rasteriser(c, wpx, hpx, X0, Ytop, m) {   // X0, Ytop : coin haut gauche (m) ; m : mètres par pixel
    const img = c.createImageData(wpx, hpx), pix = new Uint32Array(img.data.buffer);
    const cl = CLASSES[mode], COUL = couleurs(), demi = G.dx / 2, gris = ZONES && zonesVisibles;
    for (let py = 0; py < hpx; py++) {
      const rf = (Ytop - (py + 0.5) * m - G.y0) / G.dy, ra = Math.floor(rf), rb = ra + 1;
      const okA = ra >= 0 && ra <= LMAX, okB = rb >= 0 && rb <= LMAX;
      if (!okA && !okB) continue;
      const da2 = ((rf - ra) * G.dy) ** 2, db2 = ((rb - rf) * G.dy) ** 2;
      const pa = (P0 + ra) & 1, pb = (P0 + rb) & 1, la = ra * NCOL, lb = rb * NCOL;
      let o = py * wpx;
      for (let px = 0; px < wpx; px++, o++) {
        const cf = (X0 + (px + 0.5) * m - G.x0) / demi;
        const ca = 2 * Math.round((cf - pa) / 2) + pa, cb = 2 * Math.round((cf - pb) / 2) + pb;
        const ea = (cf - ca) * demi, eb = (cf - cb) * demi;
        let g;
        if (ea * ea + da2 <= eb * eb + db2) g = okA && ca >= 0 && ca < NCOL ? GRILLE[la + ca] : 0;
        else g = okB && cb >= 0 && cb < NCOL ? GRILLE[lb + cb] : 0;
        if (g) pix[o] = COUL[gris && EN_ZONE[g - 1] ? 9 : cl[g - 1]];
      }
    }
    return img;
  }
  let brouillon = null;   // canvas intermédiaire (putImageData ignore la découpe au contour de la France)
  function peindreRaster(cv, X0, Ytop, m) {   // peint cv (déjà dimensionné), découpé au contour de la France
    brouillon = brouillon || document.createElement("canvas");
    brouillon.width = cv.width; brouillon.height = cv.height;
    const b = brouillon.getContext("2d");
    b.putImageData(rasteriser(b, cv.width, cv.height, X0, Ytop, m), 0, 0);
    const c = cv.getContext("2d");
    c.setTransform(1, 0, 0, 1, 0, 0); c.clearRect(0, 0, cv.width, cv.height);
    c.save();
    c.setTransform(1 / m, 0, 0, -1 / m, -X0 / m, Ytop / m);
    c.clip(FRANCE, "evenodd");
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.drawImage(brouillon, 0, 0);
    c.restore();
    return c;
  }
  function imageNationale() {
    if (nationale && nationale.cle === cleFond()) return nationale;
    const t = performance.now();
    const cv = nationale && nationale.cv || document.createElement("canvas");
    cv.width = Math.ceil((BB[2] - BB[0]) * S_NAT); cv.height = Math.ceil((BB[3] - BB[1]) * S_NAT);
    if (COMMUNAL) peindreCommunes(cv, BB[0], BB[3], 1 / S_NAT, false); else peindreRaster(cv, BB[0], BB[3], 1 / S_NAT);
    chrono("image nationale", performance.now() - t);
    return (nationale = { cv, cle: cleFond() });
  }
  function peindreCouche() {
    const t = performance.now();
    const Wc = W * (1 + 2 * MARGE_COUCHE), Hc = Hh * (1 + 2 * MARGE_COUCHE), s = vue.s;
    const cv = couche && couche.cv || document.createElement("canvas");
    cv.width = Math.round(Wc * DPR); cv.height = Math.round(Hc * DPR);
    const X0 = vue.cx - Wc / 2 / s, Ytop = vue.cy + Hc / 2 / s;
    const c = COMMUNAL ? peindreCommunes(cv, X0, Ytop, 1 / (s * DPR), s > sMin * 2.5) : peindreRaster(cv, X0, Ytop, 1 / (s * DPR));
    if (!COMMUNAL && s * 2000 > 28) {   // contour blanc des hexagones, seulement quand ils sont grands (peu nombreux)
      c.save();
      c.setTransform(DPR * s, 0, 0, -DPR * s, -X0 * s * DPR, Ytop * s * DPR);
      c.clip(FRANCE, "evenodd");
      c.beginPath();
      for (const i of visibles(X0, Ytop - Hc / s, X0 + Wc / s, Ytop)) {
        if (!(ZONES && zonesVisibles && EN_ZONE[i]) && ((satellite && CLASSES[mode][i] === 7) || masquees.has(CLASSES[mode][i]))) continue;   // (hexagones seulement)
        hexagone(c, i);
      }
      c.strokeStyle = satellite ? "rgba(255,255,255,0.4)" : "rgba(255,255,255,0.55)"; c.lineWidth = 0.6 / s;
      c.stroke();
      c.restore();
    }
    if (polyActif()) peindrePolys(c, X0, Ytop, Wc, Hc, s);
    couche = { cv, cx: vue.cx, cy: vue.cy, s, Wc, Hc, cle: cleCouche() };
    chrono("vue zoomée", performance.now() - t);
  }
  function collerNationale() {
    const n = imageNationale(), [u, v] = versEcran(BB[0], BB[3]), k = vue.s * DPR / S_NAT;
    ctx.drawImage(n.cv, u * DPR, v * DPR, n.cv.width * k, n.cv.height * k);
  }
  function rectCouche() {   // position de la couche à l'écran, en pixels physiques
    const [u, v] = versEcran(couche.cx - couche.Wc / 2 / couche.s, couche.cy + couche.Hc / 2 / couche.s);
    const k = vue.s / couche.s;
    return [u * DPR, v * DPR, couche.Wc * k * DPR, couche.Hc * k * DPR];
  }
  function dessinerHexagones() {
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = "high";
    const cle = cleCouche();
    if (vue.s * DPR <= S_NAT) collerNationale();                    // vue d'ensemble
    else if (enMouvement()) {
      // geste en cours : couche déjà peinte si elle est utilisable, image nationale autour
      if (couche && couche.cle === cle && couche.s * DPR > S_NAT && vue.s / couche.s < 6) {
        const r = rectCouche();
        ctx.save();
        ctx.beginPath(); ctx.rect(0, 0, canvas.width, canvas.height); ctx.rect(r[0], r[1], r[2], r[3]);
        ctx.clip("evenodd"); collerNationale(); ctx.restore();
        ctx.drawImage(couche.cv, r[0], r[1], r[2], r[3]);
      } else collerNationale();
    } else {
      if (!couche || couche.perime || couche.cle !== cle || couche.s !== vue.s || couche.cx !== vue.cx || couche.cy !== vue.cy) peindreCouche();
      const r = rectCouche(); ctx.drawImage(couche.cv, r[0], r[1], r[2], r[3]);
    }
    ctx.restore();
  }

  function rendre() { if (!prevu) { prevu = true; requestAnimationFrame(dessiner); } }
  function dessiner() {
    prevu = false;
    const s = vue.s, px = 1 / s;   // 1 pixel en mètres
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    // fond couleur mer sous le satellite : la mosaïque IGN s'arrête (blanc pur, rendu transparent) au sud vers
    // Y = 6 004 000 (sous la Corse), au nord vers 7 240 000, à l'ouest vers X = -905 000, à l'est vers 1 327 000 ;
    // sans ce fond, un trait blanc apparaissait au bord de la carte en vue d'ensemble (2026-11-20)
    if (satellite) { ctx.fillStyle = MER; ctx.fillRect(0, 0, canvas.width, canvas.height); dessinerSatellite(); }
    dessinerHexagones();
    ctx.setTransform(DPR * s, 0, 0, -DPR * s, DPR * (W / 2 - vue.cx * s), DPR * (Hh / 2 + vue.cy * s));

    // limites des départements : trait sombre sur halo clair (plan) ou blanc sur halo sombre (satellite).
    // Atténuées le 2026-11-23 (demande de Sébastien) : trait blanc à 70 %, plus fin, halo plus léger et plus étroit
    // (avant : blanc plein 1,1 / 1,6 px, halo noir 55 % sur +2,2 px ; contour de la France blanc plein 1,4 px, halo 55 %)
    ctx.lineJoin = "round"; ctx.lineCap = "round";
    const proche = s > sMin * 3, ep = proche ? 1.3 : 0.9;
    ctx.strokeStyle = satellite ? "rgba(0,0,0,0.25)" : "rgba(255,255,255,0.85)";
    ctx.lineWidth = (ep + 1.6) * px; ctx.stroke(LIMITES);
    ctx.strokeStyle = satellite ? "rgba(255,255,255,0.7)" : "rgba(28,36,38,0.75)";
    ctx.lineWidth = ep * px; ctx.stroke(LIMITES);
    if (satellite) { ctx.strokeStyle = "rgba(0,0,0,0.35)"; ctx.lineWidth = 2.8 * px; ctx.stroke(FRANCE); }
    ctx.strokeStyle = satellite ? "rgba(255,255,255,0.85)" : "#1c2426"; ctx.lineWidth = (satellite ? 1.2 : 1) * px;
    ctx.stroke(FRANCE);

    if (selection && selection.chemin) {
      // contour de la commune avec un halo blanc ; pas de voile : les couleurs des hexagones restent intactes
      ctx.strokeStyle = "#ffffff"; ctx.lineWidth = 6 * px; ctx.stroke(selection.chemin);
      ctx.strokeStyle = "#1c2426"; ctx.lineWidth = 2.4 * px; ctx.stroke(selection.chemin);
    }
    if (survole >= 0) {
      const p = COMMUNAL ? CHEMIN_C[survole] : new Path2D(); if (!COMMUNAL) hexagone(p, survole);
      ctx.strokeStyle = "#ffffff"; ctx.lineWidth = 3.5 * px; ctx.stroke(p);
      ctx.strokeStyle = "#1c2426"; ctx.lineWidth = 1.6 * px; ctx.stroke(p);
    }

    if (polySurvole && polyActif()) {
      const p = polySurvole.t.chemins[polySurvole.i];
      ctx.strokeStyle = "#ffffff"; ctx.lineWidth = 4 * px; ctx.stroke(p);
      ctx.strokeStyle = "#1c2426"; ctx.lineWidth = 1.8 * px; ctx.stroke(p);
    }
    // noms des départements dès qu'on a un peu zoomé (en pixels)
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    if (s > sMin * 2.2) {
      ctx.font = "600 11px 'Vend Sans', Helvetica Neue, Arial, sans-serif";
      ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.lineJoin = "round"; ctx.lineWidth = 3.5;
      for (const d of ETIQ_DEP) {
        const [u, v] = versEcran(d.x, d.y);
        if (u < -60 || u > W + 60 || v < -10 || v > Hh + 10) continue;
        const t = d.nom.toUpperCase();
        ctx.strokeStyle = satellite ? "rgba(0,0,0,0.7)" : "rgba(255,255,255,0.9)"; ctx.strokeText(t, u, v);
        ctx.fillStyle = satellite ? "#ffffff" : "#1c2426"; ctx.fillText(t, u, v);
      }
    }
    // points des mobilisations : picto « contestation » centré sur la commune (plus gros au survol)
    if (mobVisibles && PICTO_MOB.complete && PICTO_MOB.naturalWidth) MOB.forEach((m, k) => {
      const [u, v] = versEcran(m.x, m.y);
      if (u < -20 || u > W + 20 || v < -20 || v > Hh + 20) return;
      const l = k === mobSurvole ? 30 : 24, h = l * PICTO_RATIO;
      ctx.drawImage(PICTO_MOB, u - l / 2, v - h * PICTO_CY, l, h);
    });
    // étiquette de la commune sélectionnée
    if (selection && selection.bb) {
      const [u, v] = versEcran((selection.bb[0] + selection.bb[2]) / 2, selection.bb[3]);
      ctx.font = "600 15px 'Vend Sans', Helvetica Neue, Arial, sans-serif";
      ctx.textAlign = "center"; ctx.textBaseline = "bottom";
      ctx.lineWidth = 4; ctx.strokeStyle = "#ffffff"; ctx.lineJoin = "round";
      const y = Math.max(22, v - 8);
      ctx.strokeText(selection.c.n, u, y); ctx.fillStyle = "#1c2426"; ctx.fillText(selection.c.n, u, y);
    }
  }

  // ---------- Hexagone sous le pointeur ----------
  function trouver(u, v) {
    const [X, Y] = versMonde(u, v);
    if (COMMUNAL) {   // commune qui contient le point (boîtes englobantes puis test exact)
      preparerCommunes();
      const ctx2 = trouver.ctx || (trouver.ctx = document.createElement("canvas").getContext("2d"));
      for (const i of CASES_C.get(Math.floor(X / CASE_C) * 1000 + Math.floor(Y / CASE_C)) || []) {
        const o = 4 * i;
        if (X < BB_C[o] || X > BB_C[o + 2] || Y < BB_C[o + 1] || Y > BB_C[o + 3]) continue;
        if (ctx2.isPointInPath(CHEMIN_C[i], X, Y, "evenodd")) return i;
      }
      return -1;
    }
    const r = Math.round((Y - G.y0) / G.dy), c = Math.round((X - G.x0) / (G.dx / 2));
    let best = -1, dmin = Infinity;
    for (let rr = r - 1; rr <= r + 1; rr++) for (let cc = c - 2; cc <= c + 2; cc++) {
      const i = INDEX.get(rr * 4096 + cc);
      if (i === undefined) continue;
      const d = (CX[i] - X) ** 2 + (CY[i] - Y) ** 2;
      if (d < dmin) { dmin = d; best = i; }
    }
    if (best < 0 || dmin > (G.dx * 0.6) ** 2) return -1;
    const ctx2 = trouver.ctx || (trouver.ctx = document.createElement("canvas").getContext("2d"));
    return ctx2.isPointInPath(FRANCE, X, Y, "evenodd") ? best : -1;
  }

  // Commune la plus proche du centre d'un hexagone (pour situer l'infobulle)
  // L'index des communes (3 Mo, 0,8 Mo compressé) n'est chargé qu'au premier besoin : clic dans la recherche,
  // premier survol / toucher de la carte, ou lien direct ?commune=.
  let promesseCommunes = null;
  const CASE = 10000, CASES = new Map();
  function chargerCommunes() {
    if (!promesseCommunes) promesseCommunes = new Promise((ok, ko) => {
      const s = document.createElement("script");
      s.src = "donnees/communes.js";
      s.onload = () => {
        window.COMMUNES.forEach((c, k) => {
          const key = Math.floor(c.x / CASE) * 1000 + Math.floor(c.y / CASE);
          if (!CASES.has(key)) CASES.set(key, []);
          CASES.get(key).push(k);
        });
        NOMS = window.COMMUNES.map(c => norm(c.n));
        if (!tt.hidden && survole >= 0) tt.innerHTML = contenuBulle(survole);   // compléter l'infobulle
        ok();
      };
      s.onerror = () => { promesseCommunes = null; ko(new Error("index des communes")); };
      document.head.appendChild(s);
    });
    return promesseCommunes;
  }
  function communeProche(X, Y) {
    if (!window.COMMUNES) { chargerCommunes().catch(e => console.warn(e)); return null; }
    const gx = Math.floor(X / CASE), gy = Math.floor(Y / CASE);
    let best = null, dmin = Infinity;
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) {
      for (const k of CASES.get((gx + a) * 1000 + gy + b) || []) {
        const c = window.COMMUNES[k];
        if (/Arrondissement/.test(c.n)) continue;
        const d = (c.x - X) ** 2 + (c.y - Y) ** 2;
        if (d < dmin) { dmin = d; best = c; }
      }
    }
    return best;
  }

  const fmt = (x, d = 0) => x.toLocaleString("fr-FR", { minimumFractionDigits: d, maximumFractionDigits: d });
  const ha = x => x < 10 ? fmt(x, 1) : fmt(x);   // x en hectares
  function pourcent(t) { return t < 1 ? fmt(t, 1) : fmt(Math.round(t)); }

  // zone grisée : pas de chiffre, seulement l'avertissement
  const CORPS_ZONE = `<div class="tt-classe"><i style="background:${Z_COUL}"></i><b>Marge d'erreur trop élevée</b></div>
           <small>Dans cette zone, la marge d'erreur de la détection des coupes rases est trop grande pour publier un chiffre fiable.</small>`;
  function contenuBulle(i) {
    if (COMMUNAL) {
      const t = window.TAUX_COMMUNES[COM[i]] || [0, 0, 0], coupe = t[0] / 100, boise = t[1] / 100, k = CL_C[i];
      const lieu = `<b>${window.COMMUNES_CARTE.noms[COM[i]]}</b> · ${H.deps[COM[i].slice(0, 2)] || ""}`;
      let corps;
      if (!(boise > 0)) corps = `<div class="tt-classe"><i style="background:${GRIS}"></i><b>Pas de forêt</b></div>
           <small>Aucune surface boisée dans cette commune : taux non calculé.</small>`;
      else if (coupe === 0) corps = `<div class="tt-classe"><i style="background:transparent;box-shadow:inset 0 0 0 1px #888"></i><b>${ZERO_ETIQ}</b></div>
           <div>entre 2019 et 2025</div><small>${ha(boise)} ha de forêt</small>`;
      else corps = `<div class="tt-classe"><i style="background:${couleurClasse(k)}"></i><span class="tt-chiffre">${pourcent(TX_C[i])} %</span></div>
           <div>de la forêt en coupes rases entre 2019 et 2025</div>
           <small>${ha(coupe)} ha coupés sur ${ha(boise)} ha de forêt</small>`;
      if (ERR_C[i] && zonesVisibles) corps = CORPS_ZONE;
      return `<div class="lieu">${lieu}</div>${corps}`;
    }
    const coupe = H.coupe[i] / 100, boise = H.boise[i] / 100, terre = H.terre[i] / 10;
    const c = communeProche(CX[i], CY[i]);
    const lieu = (c ? "Près de " + c.n + " · " : "") + (H.deps[H.dep[i]] || "");
    const t = taux[mode](i), k = CLASSES[mode][i];
    let corps;
    if (t === 0) {   // classe à part : aucune coupe détectée
      corps = `<div class="tt-classe"><i style="background:transparent;box-shadow:inset 0 0 0 1px #888"></i><b>${ZERO_ETIQ}</b></div>
           <div>entre 2019 et 2025</div>
           <small>${mode === "foret" ? ha(boise) + " ha de forêt" : ha(terre) + " ha (hexagone de 2 km)"}</small>`;
    } else if (mode === "foret") {
      corps = t === null
        ? `<div class="tt-classe"><i style="background:${GRIS}"></i><b>Pas de forêt</b></div>
           <small>Aucune surface boisée dans cet hexagone : taux non calculé.</small>`
        : `<div class="tt-classe"><i style="background:${couleurClasse(k)}"></i><span class="tt-chiffre">${pourcent(t)} %</span></div>
           <div>de la forêt en coupes rases entre 2019 et 2025</div>
           <small>${ha(coupe)} ha coupés sur ${ha(boise)} ha de forêt</small>`;
    } else {
      corps = `<div class="tt-classe"><i style="background:${couleurClasse(k)}"></i><span class="tt-chiffre">${pourcent(t)} %</span></div>
           <div>du territoire en coupes rases entre 2019 et 2025</div>
           <small>${ha(coupe)} ha coupés sur ${ha(terre)} ha (hexagone de 2 km)</small>`;
    }
    if (EN_ZONE[i] && zonesVisibles) corps = CORPS_ZONE;
    return `<div class="lieu">${lieu}</div>${corps}`;
  }
  function placerBulle(u, v) {
    tt.hidden = false;
    const w = tt.offsetWidth, h = tt.offsetHeight;
    let x = u + 14, y = v + 14;
    if (x + w > W - 8) x = u - w - 14;
    if (x < 8) x = Math.max(8, Math.min(W - w - 8, u - w / 2));
    if (y + h > Hh - 8) y = v - h - 14;
    if (y < 8) y = 8;
    tt.style.left = x + "px"; tt.style.top = y + "px";
  }
  function mobProche(u, v) {   // point de mobilisation à moins de 12 px du pointeur (le plus proche)
    if (!mobVisibles) return -1;
    let best = -1, d = 144;
    MOB.forEach((m, k) => { const [a, b] = versEcran(m.x, m.y), dd = (a - u) ** 2 + (b - v) ** 2; if (dd < d) { d = dd; best = k; } });
    return best;
  }
  const echap = t => String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;");
  function contenuMob(k) {
    const m = MOB[k];
    return `<div class="tt-mob"><div class="lieu">${echap(m.commune)} (${echap(m.dep)}) · ${echap(m.date)}</div>` +
      `<b>${echap(m.titre)}</b><p>${echap(m.texte)}</p>` +
      `<small>${m.source ? "Source : " + echap(m.source) + " ; Canopée" : "Source : Canopée"}</small></div>`;
  }
  function contenuPoly(p, u, v) {
    const t = p.t, i = p.i, o = 4 * i, a = t.a[i];
    const c = communeProche((t.bb[o] + t.bb[o + 2]) / 2, (t.bb[o + 1] + t.bb[o + 3]) / 2);
    const lieu = c ? "Près de " + c.n + " · " + (H.deps[c.c.slice(0, 2)] || "") : "";
    const z = trouver(u, v), enZone = z >= 0 && zonesVisibles && zoneAt(z);
    // enjeux : forêt ancienne et pente (part de la coupe, couches Canopée), espaces protégés touchés (INPN)
    const enj = [], pc = x => x >= 95 ? "" : ` (${x} % de la coupe)`;
    if (t.f[i]) enj.push("En forêt ancienne" + pc(t.f[i]));
    if (t.p[i]) enj.push("Sur une pente de plus de 30 %" + pc(t.p[i]));
    for (const k of t.z[i] || []) { const [ty, nom] = t.noms[k].split("|"); enj.push(`${echap(ty)} : ${echap(nom)}`); }
    return `<div class="lieu">${lieu}</div>` +
      `<div class="tt-classe"><i style="background:${ROUGE}"></i><b>Coupe rase détectée en ${2019 + a}</b></div>` +
      `<small>${ha(t.s[i] / 100)} ha</small>` +
      (enj.length ? `<ul class="tt-enjeux">${enj.map(e => `<li>${e}</li>`).join("")}</ul>` : "") +
      (enZone ? `<div class="tt-zone">Zone où la marge d'erreur de la détection est trop élevée : cette coupe est à prendre avec précaution.</div>` : "");
  }
  function survol(u, v, epingler) {
    const k = mobProche(u, v);
    if (k >= 0) {   // un point de mobilisation l'emporte sur l'hexagone dessous
      if (survole >= 0) survole = -1;
      if (k !== mobSurvole) mobSurvole = k;
      rendre();
      tt.innerHTML = contenuMob(k); placerBulle(u, v); epingle = !!epingler;
      canvas.style.cursor = "pointer";
      return;
    }
    if (mobSurvole >= 0) { mobSurvole = -1; rendre(); }
    canvas.style.cursor = "";
    const pc = trouverPoly(u, v);
    if (pc) {   // une coupe l'emporte sur l'hexagone / la commune dessous
      if (survole >= 0) { survole = -1; rendre(); }
      if (!polySurvole || polySurvole.t !== pc.t || polySurvole.i !== pc.i) { polySurvole = pc; rendre(); }
      tt.innerHTML = contenuPoly(pc, u, v); placerBulle(u, v); epingle = !!epingler;
      return;
    }
    if (polySurvole) { polySurvole = null; rendre(); }
    let i = trouver(u, v);
    if (i >= 0 && masquees.has(clAt(i)) && !(zonesVisibles && zoneAt(i))) i = -1;   // hexagone masqué depuis la légende : pas d'infobulle
    if (i !== survole) { survole = i; rendre(); }
    if (i < 0) { fermerBulle(); return; }
    tt.innerHTML = contenuBulle(i);
    placerBulle(u, v);
    epingle = !!epingler;
  }
  function fermerBulle() {
    tt.hidden = true; epingle = false;
    if (survole >= 0 || mobSurvole >= 0 || polySurvole) { survole = -1; mobSurvole = -1; polySurvole = null; rendre(); }
  }

  // ---------- Zoom et déplacement ----------
  function zoomEn(f, u, v) {
    arreterVol();
    const [X, Y] = versMonde(u, v);
    const s = Math.max(sMin, Math.min(S_MAX, vue.s * f));
    vue = contraindre({ s, cx: X - (u - W / 2) / s, cy: Y + (v - Hh / 2) / s });
    rendre();
  }
  function voler(cible, duree = 750) {
    arreterVol();
    const a = { ...vue }, b = contraindre({ ...cible }), t0 = performance.now();
    const la = Math.log(a.s), lb = Math.log(b.s);
    const ease = t => t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    vol = requestAnimationFrame(function pas(now) {
      const t = Math.min(1, (now - t0) / duree), e = ease(t);
      vue = { s: Math.exp(la + (lb - la) * e), cx: a.cx + (b.cx - a.cx) * e, cy: a.cy + (b.cy - a.cy) * e };
      dessiner();
      vol = t < 1 ? requestAnimationFrame(pas) : null;
      if (!vol) rendre();   // fin du vol : vue nette (hexagones repeints, tuiles du niveau final)
    });
  }
  function arreterVol() { if (vol) { cancelAnimationFrame(vol); vol = null; } }

  const pointeurs = new Map();
  let geste = null;
  canvas.addEventListener("pointerdown", e => {
    canvas.setPointerCapture(e.pointerId);
    pointeurs.set(e.pointerId, { x: e.offsetX, y: e.offsetY });
    arreterVol();
    if (pointeurs.size === 1) geste = { type: "glisser", x: e.offsetX, y: e.offsetY, t: performance.now(), bouge: false, vue: { ...vue } };
    else if (pointeurs.size === 2) {
      const [p1, p2] = [...pointeurs.values()];
      geste = { type: "pincer", d: Math.hypot(p1.x - p2.x, p1.y - p2.y), vue: { ...vue },
                m: versMonde((p1.x + p2.x) / 2, (p1.y + p2.y) / 2), bouge: true };
      fermerBulle();
    }
  });
  canvas.addEventListener("pointermove", e => {
    if (!pointeurs.has(e.pointerId)) {
      if (e.pointerType === "mouse" && !epingle) survol(e.offsetX, e.offsetY);
      return;
    }
    pointeurs.set(e.pointerId, { x: e.offsetX, y: e.offsetY });
    if (!geste) return;
    if (geste.type === "glisser") {
      const dx = e.offsetX - geste.x, dy = e.offsetY - geste.y;
      if (!geste.bouge && Math.hypot(dx, dy) < 5) return;
      if (!geste.bouge) { geste.bouge = true; canvas.classList.add("drag"); fermerBulle(); }
      vue = contraindre({ s: geste.vue.s, cx: geste.vue.cx - dx / geste.vue.s, cy: geste.vue.cy + dy / geste.vue.s });
      rendre();
    } else if (geste.type === "pincer" && pointeurs.size === 2) {
      const [p1, p2] = [...pointeurs.values()];
      const d = Math.hypot(p1.x - p2.x, p1.y - p2.y), mu = (p1.x + p2.x) / 2, mv = (p1.y + p2.y) / 2;
      const s = Math.max(sMin, Math.min(S_MAX, geste.vue.s * d / geste.d));
      vue = contraindre({ s, cx: geste.m[0] - (mu - W / 2) / s, cy: geste.m[1] + (mv - Hh / 2) / s });
      rendre();
    }
  });
  function memeCible(u, v) {   // toucher sur l'élément dont l'infobulle est déjà ouverte : on la ferme
    if (mobSurvole >= 0) return mobProche(u, v) === mobSurvole;
    if (mobProche(u, v) >= 0) return false;
    const p = trouverPoly(u, v);
    if (polySurvole) return !!p && p.t === polySurvole.t && p.i === polySurvole.i;
    return !p && trouver(u, v) === survole;
  }
  function finPointeur(e) {
    if (!pointeurs.has(e.pointerId)) return;
    pointeurs.delete(e.pointerId);
    canvas.classList.remove("drag");
    if (geste && geste.type === "glisser" && !geste.bouge && performance.now() - geste.t < 500) {
      // simple toucher / clic : infobulle épinglée (mobile) ou bascule (souris)
      if (e.pointerType === "mouse") survol(e.offsetX, e.offsetY, false);
      else if (epingle && memeCible(e.offsetX, e.offsetY)) fermerBulle();
      else survol(e.offsetX, e.offsetY, true);
    }
    if (pointeurs.size === 1 && geste && geste.type === "pincer") {
      const [p] = [...pointeurs.values()];
      geste = { type: "glisser", x: p.x, y: p.y, t: 0, bouge: true, vue: { ...vue } };
    } else if (pointeurs.size === 0) { geste = null; rendre(); }   // fin du geste : vue nette
  }
  canvas.addEventListener("pointerup", finPointeur);
  canvas.addEventListener("pointercancel", finPointeur);
  canvas.addEventListener("pointerleave", e => { if (e.pointerType === "mouse" && !epingle) fermerBulle(); });
  canvas.addEventListener("wheel", e => {
    e.preventDefault();
    fermerBulle();
    finMolette = performance.now();   // molette = geste continu : vue nette 200 ms après le dernier cran
    clearTimeout(zoomEn.t); zoomEn.t = setTimeout(rendre, 220);
    zoomEn(Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0018)), e.offsetX, e.offsetY);
  }, { passive: false });
  canvas.addEventListener("dblclick", e => zoomEn(2, e.offsetX, e.offsetY));
  $("z-plus").onclick = () => zoomEn(1.8, W / 2, Hh / 2);
  $("z-moins").onclick = () => zoomEn(1 / 1.8, W / 2, Hh / 2);
  $("z-reset").onclick = () => { fermerBulle(); voler(vueFrance()); };

  // ---------- Modes et légende ----------
  // Légende « personnalisée » (modèle fourni par Sébastien le 2026-11-20, couleurs de la carte) : barre à bord noir,
  // extrémités en pointe, ombre grise décalée vers le bas ; carré « aucune coupe » et coins en équerre « peu de forêt ».
  // Chaque segment (SVG) et le carré « aucune coupe » sont cliquables : masquer / réafficher la classe.
  const NS_SVG = "http://www.w3.org/2000/svg", OMBRE = "#e3e3e3";
  // Géométrie commune barre / carrés, en vrais pixels (pas de mise à l'échelle) : même épaisseur de trait,
  // même hauteur et même ligne médiane pour la barre, les carrés et leur texte.
  const LG = { h: 14, y: 3, ombre: 3, trait: 1.2, sep: 1, pointe: 7 };   // hauteur, haut, décalage de l'ombre, traits
  const HAUT_SVG = LG.y + LG.h + LG.ombre + 1;                             // 21 px : centre de la barre à 10 px
  // barre des taux un peu plus foncée que la carte (2026-11-23, demande de Sébastien) : opacité de la carte + 0,15
  // (0,45 → 0,60 pour les classes claires, 0,62 → 0,77 pour les autres) ; carrés et carte inchangés
  const LEG_FONCE = 0.15;
  function barreSVG(largeur) {
    const L = Math.max(200, Math.round(largeur || 300)), x0 = 1, x1 = L - 1, pointe = LG.pointe;
    const yh = LG.y, yb = LG.y + LG.h, ym = (yh + yb) / 2, seg = (x1 - x0 - 2 * pointe) / 7;
    const contour = (dy = 0) => `M${x0},${ym + dy} L${x0 + pointe},${yh + dy} L${x1 - pointe},${yh + dy} L${x1},${ym + dy} L${x1 - pointe},${yb + dy} L${x0 + pointe},${yb + dy} Z`;
    let s = `<svg class="barre" width="${L}" height="${HAUT_SVG}" viewBox="0 0 ${L} ${HAUT_SVG}" xmlns="${NS_SVG}" role="group" aria-label="Classes de taux, cliquer pour masquer ou afficher">`;
    s += `<path d="${contour(LG.ombre)}" fill="${OMBRE}"/>`;
    s += `<path d="${contour()}" fill="#fff"/>`;   // fond blanc : une case masquée (pâle) ne laisse pas voir l'ombre
    for (let k = 0; k < 7; k++) {
      const g = x0 + pointe + k * seg, d = g + seg;
      const forme = k === 0 ? `M${x0},${ym} L${x0 + pointe},${yh} L${d},${yh} L${d},${yb} L${x0 + pointe},${yb} Z`
        : k === 6 ? `M${g},${yh} L${x1 - pointe},${yh} L${x1},${ym} L${x1 - pointe},${yb} L${g},${yb} Z`
        : `M${g},${yh} L${d},${yh} L${d},${yb} L${g},${yb} Z`;
      const m = masquees.has(k);
      s += `<g class="seg${m ? " masquee" : ""}" data-k="${k}" role="button" tabindex="0" aria-pressed="${!m}" aria-label="${ETIQ[k]}">` +
        `<title>${ETIQ[k]} : cliquer pour ${m ? "afficher" : "masquer"}</title>` +
        `<path d="${forme}" fill="${PAL[k]}" fill-opacity="${m ? 0.12 : opacite(k) + LEG_FONCE}"/>` +
        (m ? `<line x1="${g + 4}" y1="${yb - 2}" x2="${d - 4}" y2="${yh + 2}" stroke="#000" stroke-width="${LG.sep}"/>` : "") + "</g>";
    }
    for (let k = 1; k < 7; k++) { const x = x0 + pointe + k * seg; s += `<line x1="${x}" y1="${yh}" x2="${x}" y2="${yb}" stroke="#000" stroke-width="${LG.sep}"/>`; }
    s += `<path d="${contour()}" fill="none" stroke="#000" stroke-width="${LG.trait}" stroke-linejoin="miter" pointer-events="none"/></svg>`;
    // graduations en HTML : le seuil bas de chaque case, sous son bord gauche
    s += '<div class="grad">' + BORNES.map((b, k) =>
      `<span style="left:${(x0 + pointe + k * seg).toFixed(1)}px">${b}${k === BORNES.length - 1 ? " et +" : ""}</span>`).join("") + "</div>";
    return s;
  }
  // carrés : même hauteur (14 px), même trait (1,2 px), même ombre et même ligne médiane que la barre
  const carre = (fond, opac) => { const c = LG.h, y = LG.y, x = 1;
    return `<svg width="${c + 2}" height="${HAUT_SVG}" viewBox="0 0 ${c + 2} ${HAUT_SVG}" aria-hidden="true">` +
      `<rect x="${x}" y="${y + LG.ombre}" width="${c}" height="${c}" fill="${OMBRE}"/><rect x="${x}" y="${y}" width="${c}" height="${c}" fill="#fff"/>` +
      (fond ? `<rect x="${x}" y="${y}" width="${c}" height="${c}" fill="${fond}" fill-opacity="${opac}"/>` : "") +
      `<rect x="${x}" y="${y}" width="${c}" height="${c}" fill="none" stroke="#000" stroke-width="${LG.trait}"/></svg>`; };
  // carré « zone d'erreur » : gris de la carte, même dessin que les autres carrés
  const carreZone = () => carre(Z_COUL, zonesVisibles ? Z_OPAC : 0.12);
  function legende() {
    const M = MODES[mode];
    // astérisque renvoyant à la note sur les Outre-mer, sous la carte (2026-11-27 ; masqués en plein écran)
    $("leg-titre").innerHTML = echap(M.titre) + (COMMUNAL ? '<span class="asterisque">*</span>' : "");
    // « Aucune coupe détectée » retirée de la légende (2026-11-26) : transparente sur la carte, reste dans l'infobulle
    // « Pas de forêt » retiré de la légende (2026-11-20) : ces hexagones restent transparents (on voit le satellite)
    // 2026-11-27 (demande de Sébastien) : « Marge d'erreur élevée » sur la ligne des coupes rases, juste avant
    // (avant : à droite de la barre des taux)
    let h = '<div class="leg-barre" id="leg-barre"></div>';
    const zb = ZONES ? `<button type="button" class="leg-item" data-k="z" aria-pressed="${zonesVisibles}"${zonesVisibles ? "" : " data-masquee"} title="Cliquer pour afficher / regriser les taux de ces ${COMMUNAL ? "communes" : "hexagones"}">` +
      carreZone() + `<span>${Z_ETIQ}</span></button>` : "";
    const pb = POLY ? `<button type="button" class="leg-item" data-k="p" aria-pressed="${polyVisibles}"${polyVisibles ? "" : " data-masquee"} title="Cliquer pour masquer / afficher">` +
      carre(ROUGE, polyVisibles ? 1 : 0.12) + `<span>${ROUGE_ETIQ}</span></button>` : "";
    if (zb || pb) h += `<div class="leg-poly">${zb}${pb}</div>`;
    if (MOB.length) h += `<div class="leg-mob"><button type="button" class="leg-item" data-k="m" aria-pressed="${mobVisibles}"${mobVisibles ? "" : " data-masquee"} title="Cliquer pour afficher / masquer">` +
      `<img src="picto-contestation.svg" width="17" height="${Math.round(17 * PICTO_RATIO)}" alt=""${mobVisibles ? "" : ' style="opacity:.45"'}><span>${mobVisibles ? MOB_ETIQ : "Cliquez pour afficher les mobilisations contre les coupes rases"}</span></button></div>`;
    h += `<div class="leg-astuce">Cliquez sur une couleur pour masquer ou afficher ces ${COMMUNAL ? "communes" : "hexagones"}.</div>`;
    $("leg-cases").innerHTML = h;
    // barre dessinée à la largeur réelle de son emplacement (traits nets, mêmes épaisseurs que les carrés)
    const b = $("leg-barre"); b.innerHTML = barreSVG(b.clientWidth);
  }
  function basculerClasse(e) {
    const b = e.target.closest && e.target.closest("[data-k]");
    if (!b) return;
    if (b.dataset.k === "m") {   // points des mobilisations
      mobVisibles = !mobVisibles; if (!mobVisibles && mobSurvole >= 0) fermerBulle();
      legende(); rendre();
      const f = $("leg-cases").querySelector && $("leg-cases").querySelector('[data-k="m"]');
      if (f && e.type === "keydown" && f.focus) f.focus();
      return;
    }
    if (b.dataset.k === "p") {   // polygones des coupes
      polyVisibles = !polyVisibles; if (!polyVisibles && polySurvole) fermerBulle();
      legende(); rendre();
      const f = $("leg-cases").querySelector && $("leg-cases").querySelector('[data-k="p"]');
      if (f && e.type === "keydown" && f.focus) f.focus();
      return;
    }
    if (b.dataset.k === "z") {   // zones d'erreur : gris ↔ vraies couleurs
      zonesVisibles = !zonesVisibles; legende(); rendre();
      if (!tt.hidden && survole >= 0) tt.innerHTML = contenuBulle(survole);
      const f = $("leg-cases").querySelector && $("leg-cases").querySelector('[data-k="z"]');
      if (f && e.type === "keydown" && f.focus) f.focus();
      return;
    }
    const k = +b.dataset.k;
    if (masquees.has(k)) masquees.delete(k); else masquees.add(k);
    legende(); rendre();
    const f = $("leg-cases").querySelector && $("leg-cases").querySelector(`[data-k="${k}"]`);   // garder le focus clavier
    if (f && e.type === "keydown" && f.focus) f.focus();
  }
  $("leg-cases").addEventListener("click", basculerClasse);
  $("leg-cases").addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); basculerClasse(e); } });

  // bascule forêt / territoire retirée de la page le 2026-11-23 (part de la forêt seulement) : code du mode « hex »
  // gardé, inactif (aucun bouton .bascule dans index.html)
  document.querySelectorAll(".bascule button").forEach(b => b.addEventListener("click", () => {
    mode = b.dataset.mode;
    document.querySelectorAll(".bascule button").forEach(x => x.setAttribute("aria-checked", x === b));
    legende();
    if (!tt.hidden && survole >= 0) tt.innerHTML = contenuBulle(survole);
    rendre();
  }));

  // ---------- Recherche de commune ----------
  const norm = s => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/[-'’]/g, " ").replace(/\bst\b/g, "saint").replace(/\bste\b/g, "sainte").replace(/\s+/g, " ").trim();
  let NOMS = [];
  const cps = c => [].concat(c.cp || []);   // un seul code postal est stocké comme une chaîne
  let resultats = [], actif = -1;

  function chercher(texte) {
    const t = norm(texte);
    if (t.length < 2 || !window.COMMUNES) return [];
    const sc = [];
    if (/^\d[\dab]{1,4}$/i.test(texte.trim())) {
      const code = texte.trim().toUpperCase();
      window.COMMUNES.forEach((c, k) => {
        if (c.c.startsWith(code) || cps(c).some(p => p.startsWith(code))) sc.push([k, cps(c).includes(code) ? 0 : 1]);
      });
    } else {
      NOMS.forEach((n, k) => {
        let s = -1;
        if (n === t) s = 0;
        else if (n.startsWith(t)) s = 1;
        else if ((" " + n).includes(" " + t)) s = 2;
        else if (t.length >= 3 && n.includes(t)) s = 3;
        if (s >= 0) sc.push([k, s]);
      });
    }
    sc.sort((a, b) => a[1] - b[1] || (window.COMMUNES[b[0]].p || 0) - (window.COMMUNES[a[0]].p || 0));
    return sc.slice(0, 12).map(x => window.COMMUNES[x[0]]);
  }
  function afficherResultats() {
    if (!resultats.length) {
      res.innerHTML = q.value.trim().length >= 2 ? `<div aria-disabled="true"><small>Aucune commune trouvée</small></div>` : "";
    } else {
      res.innerHTML = resultats.map((c, k) =>
        `<div role="option" data-k="${k}" class="${k === actif ? "actif" : ""}" aria-selected="${k === actif}">
           ${c.n} <small>${cps(c)[0] || ""} · ${H.deps[c.d] || c.d}</small></div>`).join("");
    }
    res.hidden = !res.innerHTML;
    q.setAttribute("aria-expanded", !res.hidden);
  }
  q.addEventListener("input", () => {
    effacer.hidden = !q.value; actif = -1;
    chargerCommunes().then(() => { resultats = chercher(q.value); afficherResultats(); }, e => console.warn(e));
  });
  q.addEventListener("focus", () => chargerCommunes().catch(e => console.warn(e)));
  q.addEventListener("keydown", e => {
    if (res.hidden) return;
    if (e.key === "ArrowDown") { actif = Math.min(resultats.length - 1, actif + 1); afficherResultats(); e.preventDefault(); }
    else if (e.key === "ArrowUp") { actif = Math.max(0, actif - 1); afficherResultats(); e.preventDefault(); }
    else if (e.key === "Enter") { const c = resultats[Math.max(0, actif)]; if (c) choisir(c); e.preventDefault(); }
    else if (e.key === "Escape") { res.hidden = true; }
  });
  // Souris : choix dès l'appui (le champ garde le focus). Toucher : choix au « clic » qui suit un tap sans glissement,
  // pour pouvoir faire défiler la liste du doigt (avant le 2026-11-27, le simple appui choisissait la commune).
  res.addEventListener("pointerdown", e => {
    if (e.pointerType !== "mouse") return;
    const d = e.target.closest("[data-k]");
    if (d) { e.preventDefault(); res.choixSouris = performance.now(); choisir(resultats[+d.dataset.k]); }
  });
  res.addEventListener("click", e => {
    if (performance.now() - (res.choixSouris || 0) < 600) return;   // déjà choisi à l'appui de la souris
    const d = e.target.closest && e.target.closest("[data-k]");
    if (d && resultats[+d.dataset.k]) choisir(resultats[+d.dataset.k]);
  });
  q.addEventListener("blur", () => setTimeout(() => { res.hidden = true; q.setAttribute("aria-expanded", "false"); }, 150));
  effacer.addEventListener("click", () => {
    q.value = ""; effacer.hidden = true; res.hidden = true; selection = null;
    fermerBulle(); voler(vueFrance()); q.focus();
  });

  const chargements = {};
  function chargerDepartement(d) {
    if (!chargements[d]) chargements[d] = new Promise((ok, ko) => {
      const s = document.createElement("script");
      s.src = `donnees/communes/${d}.js`; s.onload = ok; s.onerror = () => ko(new Error("contours " + d));
      document.head.appendChild(s);
    });
    return chargements[d];
  }
  function cheminCommune(anneauxDelta) {   // format du projet modèle : pas de 10 m, deltas
    const p = new Path2D(), bb = [Infinity, Infinity, -Infinity, -Infinity];
    for (const r of anneauxDelta) {
      let x = r[0], y = r[1];
      for (let k = 0; k < r.length; k += 2) {
        if (k) { x += r[k]; y += r[k + 1]; }
        const X = x * 10, Y = y * 10;
        if (k) p.lineTo(X, Y); else p.moveTo(X, Y);
        if (X < bb[0]) bb[0] = X; if (Y < bb[1]) bb[1] = Y; if (X > bb[2]) bb[2] = X; if (Y > bb[3]) bb[3] = Y;
      }
      p.closePath();
    }
    return { p, bb };
  }
  async function choisir(c) {
    q.value = c.n; effacer.hidden = false; res.hidden = true; q.blur(); fermerBulle();
    selection = { c, chemin: null, bb: null };
    try {
      const g = COMMUNAL && window.COMMUNES_CARTE.geo[c.c] ? window.COMMUNES_CARTE.geo[c.c]
        : (await chargerDepartement(c.c.slice(0, 2)), (window.GEO_COMMUNES || {})[c.c]);
      if (g) { const { p, bb } = cheminCommune(g); selection.chemin = p; selection.bb = bb; }
    } catch (err) { console.warn(err); }
    // cadrage : la commune occupe environ la moitié de la carte (au moins 12 km de large)
    const bb = selection.bb || [c.x - 3000, c.y - 3000, c.x + 3000, c.y + 3000];
    const larg = Math.max(bb[2] - bb[0], 12000), haut = Math.max(bb[3] - bb[1], 12000);
    // … mais toujours assez près pour voir les coupes précises (2026-11-27, demande de Sébastien) : au moins 15 % au-delà
    // du seuil d'affichage des polygones (S_POLY), quitte à ne pas montrer toute une grande commune (téléphone surtout)
    const s = Math.min(S_MAX, Math.max(POLY ? S_POLY * 1.15 : 0, Math.min(W / (larg * 2), Hh / (haut * 2))));
    voler({ cx: (bb[0] + bb[2]) / 2, cy: (bb[1] + bb[3]) / 2, s }, 900);
  }

  // ---------- Démarrage ----------
  function demarrer() {
    const t = performance.now();
    legende(); ajusterTaille(); vue = vueFrance(); dessiner();
    $("chg").hidden = true;
    chrono("préparation de la carte", t - T_SCRIPT);
    chrono("premier dessin", performance.now() - t);
    chrono("TOTAL jusqu'à la carte affichée (depuis l'ouverture)", performance.now());
    // la police Vend Sans arrive après le premier dessin : on redessine les noms une fois chargée
    // police chargée : noms redessinés, et hauteur de carte recalculée (le titre peut changer de hauteur)
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { recadrer(true); rendre(); });
    // lien direct : index.html?commune=33529 (code INSEE)
    const P = new URLSearchParams(location.search);
    if (P.get("commune")) chargerCommunes().then(() => {
      const c = window.COMMUNES.find(x => x.c === P.get("commune"));
      if (c) choisir(c);
    }, e => console.warn(e));
  }
  window.CARTE = { aller: v => { vue = contraindre(v); rendre(); }, L93, peindreTuile, dessinerSatellite, TUILES, POLY, CARREAUX, trouverPoly, contenuPoly, polyActif, carreauxDans, chargerCarreau, COMMUNAL, COM, CL_C, peindreCommunes, MOB, mobProche, contenuMob, survol, masquees, EN_ZONE, zones: () => zonesVisibles, legende, rasteriser, CLASSES, chargerCommunes, contraindre, vueFrance, chercher, choisir, trouver, contenuBulle, vue: () => vue, selection: () => selection };  // pour les tests
  // Redimensionnement : on ne réagit qu'à un vrai changement de taille, et une seule fois par image
  // (sinon boucle possible : hauteur du cadre -> barre de défilement -> largeur -> hauteur…).
  let tailleVue = "", redim = 0;
  function recadrer(forcer) {
    cancelAnimationFrame(redim);
    redim = requestAnimationFrame(() => {
      if (forcer) { ajusterTaille.force = true; tailleVue = ""; }
      const r = cadre.getBoundingClientRect(), t = Math.round(r.width) + "x" + Math.round(r.height) + "x" + (window.innerHeight || 0);
      if (t === tailleVue) return;
      const ancien = sMin; ajusterTaille();
      tailleVue = Math.round(W) + "x" + Math.round(Hh) + "x" + (window.innerHeight || 0);
      if (Math.abs(vue.s - ancien) < 1e-9 && !selection) vue = vueFrance(); else vue = contraindre(vue);
      legende();   // la barre de la légende suit la largeur disponible
      dessiner();
    });
  }
  new ResizeObserver(() => recadrer(false)).observe(cadre);

  // ---------- Plein écran (2026-11-26, demande de Sébastien) ----------
  // Bouton sous le zoom. API Fullscreen sur tout l'habillage (titre, légende, recherche, carte) ; si elle manque
  // (iPhone) ou si l'iframe de l'article ne l'autorise pas (attribut allow="fullscreen" absent) : dans l'iframe, la
  // carte s'ouvre dans un nouvel onglet en mode plein (?plein) ; hors iframe, l'habillage est fixé sur la fenêtre (CSS).
  const HAB = document.querySelector(".habillage"), B_PLEIN = $("plein");
  const ICONE_PLEIN = '<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M1.5 5.5v-4h4M10.5 1.5h4v4M14.5 10.5v4h-4M5.5 14.5h-4v-4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const ICONE_SORTIR = '<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M5.5 1.5v4h-4M14.5 5.5h-4v-4M10.5 14.5v-4h4M1.5 10.5h4v4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  function majPlein() {
    const p = estPlein();
    // sources : en plein écran, dans le panneau juste au-dessus de la recherche ; sinon sous la carte (2026-11-27)
    const pied = document.querySelector(".hab-pied"), rech = document.querySelector(".recherche");
    if (pied && rech && rech.parentNode && pied.parentNode) {
      if (p && pied.nextElementSibling !== rech) rech.parentNode.insertBefore(pied, rech);
      else if (!p && pied.parentNode === rech.parentNode && cadre.parentNode) {
        const apres = document.querySelector(".hab-note") || cadre;   // sous la note des Outre-mer
        apres.parentNode.insertBefore(pied, apres.nextSibling);
      }
    }
    if (B_PLEIN) { B_PLEIN.innerHTML = p ? ICONE_SORTIR : ICONE_PLEIN; B_PLEIN.title = p ? "Quitter le plein écran" : "Plein écran";
                   B_PLEIN.setAttribute("aria-label", B_PLEIN.title); B_PLEIN.setAttribute("aria-pressed", String(p)); }
    recadrer(true);
  }
  function pleinCSS(oui) {
    if (!HAB || !HAB.classList) return;
    HAB.classList.toggle("plein", oui); document.body.style.overflow = oui ? "hidden" : ""; majPlein();
  }
  function repliPlein() {
    if (window.parent !== window) window.open(location.href.replace(/[?#].*$/, "") + "?plein", "_blank");
    else pleinCSS(true);
  }
  if (B_PLEIN) B_PLEIN.onclick = () => {
    if (estPlein()) {
      if (document.fullscreenElement) document.exitFullscreen();
      else if (document.webkitFullscreenElement) document.webkitExitFullscreen();
      else pleinCSS(false);
      return;
    }
    const req = HAB && (HAB.requestFullscreen || HAB.webkitRequestFullscreen);
    if (req && (document.fullscreenEnabled || document.webkitFullscreenEnabled)) {
      try { const pr = req.call(HAB); if (pr && pr.catch) pr.catch(repliPlein); } catch (e) { repliPlein(); }
    } else repliPlein();
  };
  // plein écran sur téléphone : légende repliée par défaut, dépliée par le bouton (2026-11-27)
  const B_LEG = $("bouton-legende"), PANNEAU = document.querySelector(".panneau");
  if (B_LEG && PANNEAU && PANNEAU.classList) B_LEG.onclick = () => {
    const o = !PANNEAU.classList.contains("ouvert");
    PANNEAU.classList.toggle("ouvert", o);
    B_LEG.textContent = o ? "Masquer la légende" : "Afficher la légende"; B_LEG.setAttribute("aria-expanded", String(o));
    if (o) legende();   // barre des taux redessinée à la largeur du panneau
  };
  document.addEventListener("fullscreenchange", majPlein);
  document.addEventListener("webkitfullscreenchange", majPlein);
  document.addEventListener("keydown", e => { if (e.key === "Escape" && HAB && HAB.classList && HAB.classList.contains("plein")) pleinCSS(false); });
  if (/[?&]plein\b/.test(location.search) && window.parent === window) pleinCSS(true); else majPlein();

  // ---------- Hauteur automatique de l'iframe (comme les autres cartes du dépôt vert-le-media/cartes) ----------
  // La page envoie sa hauteur à l'article ({ type: "vert-carte-hauteur", h }) ; le script commun du README du dépôt
  // (bloc HTML WordPress) ajuste la hauteur de l'iframe.
  if (window.parent !== window) {
    const hab = document.querySelector(".habillage");
    let hEnvoyee = 0;
    const envoyerHauteur = () => {
      const h = Math.ceil(hab.getBoundingClientRect().bottom + window.scrollY) + 10;   // 8 px de marge du body + 2
      if (h && h !== hEnvoyee) { hEnvoyee = h; window.parent.postMessage({ type: "vert-carte-hauteur", h }, "*"); }
    };
    new ResizeObserver(envoyerHauteur).observe(hab);
    window.addEventListener("load", envoyerHauteur);
    envoyerHauteur();
  }
  window.addEventListener("resize", () => recadrer(false));   // hauteur de fenêtre (le cadre ne bouge pas forcément)
  demarrer();
})();
