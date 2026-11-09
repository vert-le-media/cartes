/*
 * visionneuse.js — Visionneuse de TRAVAIL : côte du fond × communes.
 * Partagée par index.html (local, double-clic) et artifact.html (version publiée).
 * Données : donnees-*.js, générées par 06_scripts/05_preparer_visionneuse.py.
 *
 * - Deux fonds, comme la carte BRGM : « 350 » (écran étroit < 500 px) et « 700 ».
 * - Généralisation selon l'échelle : on affiche le niveau le plus grossier dont la tolérance
 *   reste sous ~1,2 pixel écran (g4000, g1500, g500, 100m), chargé à la demande.
 * - Pendant un geste, on peut déplacer une image en cache au lieu de tout redessiner.
 *
 * Deux types de données thématiques (window.VIS_DATA) :
 *  - aplats (défaut) : {classes: [{cle, libelle, couleur…}], communes: {code: [classe, …]}} (ex. pesticides) ;
 *  - points (type: "points") : option taille_legende (diamètre des pictos de légende, px, 14 par défaut) ;
 *    {categories: [{cle, libelle, court, couleur, forme, rayon, nb}],
 *      points: [[catégorie, territoire, x, y, code INSEE, nom, opérateur, statut, texte, [urls], [drapeaux]]]}
 *    x, y en mètres dans la projection du territoire (Lambert-93 en métropole). Ex. data centers.
 *    Légende cliquable (filtre), infobulle par site (clic = épinglée, liens cliquables), recherche des sites.
 *  - option (les deux types) contour: {q, france, hors} : contour de France imposé (ex. Natural Earth 1:50 m)
 *    à la place de la côte tirée des communes ; « hors » = terre du fond à masquer ; limites coupées au contour.
 */
(function () {
  "use strict";
  const FOND = window.VIS_FOND_DIR || "";
  // Données thématiques (donnees-pesticides.js, script 09) : une classe par commune ; sinon couleurs au hasard
  const DATA = window.VIS_DATA || null;
  const POINTS = !!(DATA && DATA.type === "points");
  const TERRE = "#ebe6da"; // communes des encarts outre-mer en mode points
  const PALETTE = POINTS ? [TERRE] : DATA ? DATA.classes.map(k => k.couleur) : ["#FBE3CF", "#F6C9A8", "#EE9A6A", "#E2683C", "#B9461F"];
  const SANS_DONNEES = DATA && !POINTS ? DATA.classes.findIndex(k => k.cle === "pas_de_donnees") : -1;
  const ALERTE = DATA && !POINTS ? DATA.classes.findIndex(k => k.cle === "sup_valeur_sanitaire") : -1;
  const ALERTES_VISIBLES = 150; // m/pixel : au-delà, les communes en alerte sanitaire sont aussi marquées d'un point
  const SEUIL_MOBILE = 500;   // largeur (px) sous laquelle on passe au fond 350
  const MARGE_TOL = 1.2;      // tolérance acceptée, en pixels écran
  const LIMITES_COMMUNES = [1500, 600]; // m/pixel : limites communales invisibles au-delà, pleines en deçà
  const ZMAX = 40;
  const ATTENTE_RENDU = 140;  // ms sans geste avant le rendu complet

  const D = window.VIS_BASE;
  // Option VIS_DATA.cadrage_mobile = {x: [x0, x1], encarts: {code: [x, y, l, h]}} : sur mobile (fond 350), la vue
  // d'ensemble ne montre que la bande x0–x1 du fond (plus zoomée, ex. sans la Corse) ; les encarts d'outre-mer
  // y sont replacés pour rester entiers. La carte s'allonge d'autant ; on peut toujours se déplacer jusqu'aux bords.
  const CADRAGE_M = (DATA && DATA.cadrage_mobile) || null;
  if (CADRAGE_M && CADRAGE_M.encarts) Object.assign(D.systemes["350"].encarts, CADRAGE_M.encarts);
  // Option VIS_DATA.encarts_ordinateur = {code: [x, y, l, h]} : encarts du fond ordinateur (700) replacés
  if (DATA && DATA.encarts_ordinateur) Object.assign(D.systemes["700"].encarts, DATA.encarts_ordinateur);
  const NIVEAUX = D.niveaux_def; // [[nom, tolérance m], …] du plus grossier au plus fin
  const $ = id => document.getElementById(id);
  const cv = $("carte");
  const ctx = cv.getContext("2d");
  const cache = document.createElement("canvas");
  const cctx = cache.getContext("2d");
  const tt = $("tt");

  // ---------- Géométrie ----------
  const projMetro = S => (X, Y) => [S.A * X + S.B, S.C * Y + S.D];
  function projEncart(S, t) {
    const [bx, by, bw, bh] = S.encarts[t], [x0, y0, x1, y1] = D.territoires[t].bbox, m = D.marge_encart;
    const s = Math.min((bw - 2 * m) / (x1 - x0), (bh - 2 * m) / (y1 - y0));
    const ox = bx + (bw - (x1 - x0) * s) / 2, oy = by + (bh - (y1 - y0) * s) / 2;
    return (X, Y) => [ox + (X - x0) * s, oy + (y1 - Y) * s];
  }
  function chemin(anneaux, q, proj, bb, ouvert) {
    const p = new Path2D();
    for (const r of anneaux) {
      let x = r[0], y = r[1];
      for (let i = 0; i < r.length; i += 2) {
        if (i) { x += r[i]; y += r[i + 1]; }
        const [u, v] = proj(x * q, y * q);
        if (i) p.lineTo(u, v); else p.moveTo(u, v);
        if (bb) { if (u < bb[0]) bb[0] = u; if (v < bb[1]) bb[1] = v; if (u > bb[2]) bb[2] = u; if (v > bb[3]) bb[3] = v; }
      }
      if (!ouvert) p.closePath();
    }
    return p;
  }
  function couleur(code) {
    if (POINTS) return 0;
    if (DATA) { const d = DATA.communes[code]; return d ? d[0] : SANS_DONNEES; }
    let h = 0;
    for (const ch of code) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return h % PALETTE.length;
  }
  // Un « jeu » de communes : chemins individuels (survol), fusionnés par couleur (dessin rapide)
  const GRILLE = 4; // cellule de l'index spatial (unités viewBox)
  function jeu(communes, q, proj) {
    const items = [], parCouleur = PALETTE.map(() => new Path2D()), tout = new Path2D(), grille = new Map();
    for (const code in communes) {
      const bb = [Infinity, Infinity, -Infinity, -Infinity];
      const p = chemin(communes[code], q, proj, bb);
      const it = { code, p, bb };
      items.push(it);
      parCouleur[couleur(code)].addPath(p);
      tout.addPath(p);
      for (let gx = Math.floor(bb[0] / GRILLE); gx <= Math.floor(bb[2] / GRILLE); gx++)
        for (let gy = Math.floor(bb[1] / GRILLE); gy <= Math.floor(bb[3] / GRILLE); gy++) {
          const k = gx + "," + gy;
          if (!grille.has(k)) grille.set(k, []);
          grille.get(k).push(it);
        }
    }
    return { items, parCouleur, tout, grille, parCode: Object.fromEntries(items.map(i => [i.code, i])) };
  }

  // ---------- Index de recherche ----------
  const norm = s => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[-'’]/g, " ").trim();
  const INDEX = D.index.map(([c, n, d, t, p, x, y, cp]) => ({ c, n, d, t, p, x, y, cp, cle: norm(n) }));
  const PARCODE = Object.fromEntries(INDEX.map(i => [i.c, i]));

  // ---------- Couches par système (350 / 700), construites à la première utilisation ----------
  const SYS = {};
  function systeme(nom) {
    if (SYS[nom]) return SYS[nom];
    const S = D.systemes[nom], metro = projMetro(S);
    const enc = {}, om = {};
    for (const t in S.encarts) {
      enc[t] = projEncart(S, t);
      om[t] = jeu(D.outremer[t].communes, D.outremer[t].q, enc[t]);
    }
    const imgs = {};
    for (const th in S.fonds) {
      imgs[th] = new Image();
      imgs[th].onload = () => rendreBientot();
      imgs[th].src = FOND + S.fonds[th];
    }
    SYS[nom] = {
      nom, S, metro, enc, om, imgs, niveaux: {},
      // communes trop petites pour être vues en vue large : marquées d'un point
      alertes: DATA && !POINTS ? Object.keys(DATA.communes)
        .filter(c => DATA.communes[c][0] === ALERTE && PARCODE[c] && PARCODE[c].t === "metro")
        .map(c => ({ code: c, xy: metro(PARCODE[c].x, PARCODE[c].y) })) : [],
      // mode points : position de chaque point dans ce système (null si son territoire n'a pas d'encart)
      // contour imposé par les données (sinon côte tirée des communes, propre à chaque niveau)
      contour: DATA && DATA.contour ? { france: chemin(DATA.contour.france, DATA.contour.q, metro),
                                        hors: chemin(DATA.contour.hors, DATA.contour.q, metro) } : null,
      pts: POINTS ? DATA.points.map(p => p[1] === "metro" ? metro(p[2], p[3]) : enc[p[1]] ? enc[p[1]](p[2], p[3]) : null) : [],
    };
    return SYS[nom];
  }

  // ---------- Mode points : catégories visibles, dessin, recherche du point sous le curseur ----------
  const CATS = POINTS ? DATA.categories : [];
  const catVisible = CATS.map(() => true);
  // site mis en avant (vol vers un site) : les autres passent en transparence ; -1 = aucun
  let focus = -1;
  const ESTOMPE = 0.22;
  function setFocus(i) { if (i !== focus) { focus = i; cleGlobale = ""; vc = null; rendreBientot(); } }
  const PARCOMMUNE = {}; // code INSEE -> indices des points de la commune
  if (POINTS) DATA.points.forEach((p, i) => { if (p[4]) (PARCOMMUNE[p[4]] = PARCOMMUNE[p[4]] || []).push(i); });
  // rayon écran (px) : grossit avec le zoom, pour rester lisible sans tout couvrir en vue large
  // (les pictos grossissent davantage : leur dessin doit devenir lisible)
  // réglable par carte : VIS_DATA.zoom_pictos = [pente, plafond, plancher_ordinateur]
  // (facteur = min(plafond, max(plancher, 1 + pente × log2(zoom))) ; plancher appliqué seulement sur ordinateur,
  //  pour que les pictos restent reconnaissables en vue large)
  const ZP = (DATA && DATA.zoom_pictos) || [0.3, 2.2];
  const plancherPt = () => (W >= SEUIL_MOBILE && ZP[2]) || 1;
  const rayonPt = k => CATS[k].rayon * (CATS[k].picto ? Math.min(ZP[1], Math.max(plancherPt(), 1 + ZP[0] * Math.log2(z)))
                                                       : Math.min(1.7, 1 + 0.18 * Math.log2(z)));
  // Pictos SVG (option picto: {svg, cx, cy, r} : texte SVG, centre et rayon du disque dans le viewBox) :
  // une image haute définition, puis une copie pré-rendue par taille en pixels (net partout, rapide à dessiner)
  const PICTO_IMG = CATS.map(C => {
    if (!C.picto) return null;
    const img = new Image();
    img.onload = () => { cleGlobale = ""; vc = null; rendreBientot(); majPastilles(); };
    img.src = pictoUrl(C);
    return img;
  });
  function pictoUrl(C) {
    return "data:image/svg+xml;charset=utf-8," +
      encodeURIComponent(C.picto.svg.replace(/<\?xml[^>]*>\s*/, "").replace("<svg ", '<svg width="200" height="200" '));
  }
  const pictoCache = new Map();
  function pictoRaster(k, taillePx) {
    const cle = k + "|" + taillePx;
    let cv2 = pictoCache.get(cle);
    if (!cv2) {
      cv2 = document.createElement("canvas");
      cv2.width = cv2.height = taillePx;
      const g = cv2.getContext("2d");
      g.imageSmoothingQuality = "high";
      g.drawImage(PICTO_IMG[k], 0, 0, taillePx, taillePx);
      pictoCache.set(cle, cv2);
    }
    return cv2;
  }
  function forme(c, k, x, y, px, sombre) {
    const C = CATS[k], r = rayonPt(k) * px, P = C.picto, img = PICTO_IMG[k];
    if (P && img && img.complete && img.naturalWidth) {
      const cote = r / P.r * P.vb;                       // côté du viewBox, en unités de la carte
      const dev = Math.max(4, Math.ceil(cote * c.getTransform().a)); // en pixels de l'appareil
      c.drawImage(pictoRaster(k, dev), x - P.cx / P.vb * cote, y - P.cy / P.vb * cote, cote, cote);
      return;
    }
    c.beginPath();
    if (C.forme === "losange") { const s = r * 1.3; c.moveTo(x, y - s); c.lineTo(x + s, y); c.lineTo(x, y + s); c.lineTo(x - s, y); c.closePath(); }
    else if (C.forme === "carre") c.rect(x - r * 0.9, y - r * 0.9, r * 1.8, r * 1.8);
    else c.arc(x, y, r, 0, 2 * Math.PI);
    const halo = sombre ? "rgba(23,28,30,.9)" : "rgba(255,255,255,.95)";
    if (C.forme === "anneau") {
      c.lineWidth = 3.2 * px; c.strokeStyle = halo; c.stroke();
      c.lineWidth = 1.7 * px; c.strokeStyle = C.couleur; c.stroke();
    } else {
      c.fillStyle = C.couleur; c.fill();
      c.lineWidth = (C.rayon < 3 ? 0.6 : 1) * px; c.strokeStyle = halo; c.stroke();
    }
  }
  function dessinerPoints(c, sy, px, e) {
    if (!POINTS || !e.aplats) return;
    // ordre des catégories = ordre de dessin (la dernière passe dessus)
    CATS.forEach((C, k) => {
      if (!catVisible[k]) return;
      DATA.points.forEach((p, i) => {
        if (p[0] !== k) return;
        const xy = sy.pts[i];
        if (!xy || (p[1] !== "metro" && !e.om) || i === focus) return;
        if (focus >= 0) c.globalAlpha = ESTOMPE;
        forme(c, k, xy[0], xy[1], px, e.sombre);
        c.globalAlpha = 1;
      });
    });
    // le site mis en avant, opaque et par-dessus tous les autres
    const xy = focus >= 0 && catVisible[DATA.points[focus][0]] && sy.pts[focus];
    if (xy && (DATA.points[focus][1] === "metro" || e.om)) forme(c, DATA.points[focus][0], xy[0], xy[1], px, e.sombre);
  }
  // points sous (vx, vy), du plus proche au plus lointain
  function trouverPoints(vx, vy, tolPx = 4) {
    const e = etat(), sy = sysCourant, k = base * z, res = [];
    if (!POINTS || !e.aplats) return res;
    DATA.points.forEach((p, i) => {
      const xy = sy.pts[i];
      if (!xy || !catVisible[p[0]] || (p[1] !== "metro" && !e.om)) return;
      const d = Math.hypot(xy[0] - vx, xy[1] - vy) * k;
      if (d <= rayonPt(p[0]) * 1.3 + tolPx) res.push([d, i]);
    });
    // à égalité de distance, la catégorie dessinée par-dessus d'abord
    return res.sort((a, b) => a[0] - b[0] || DATA.points[b[1]][0] - DATA.points[a[1]][0]).map(r => r[1]);
  }

  // ---------- Niveaux de contours : chargement à la demande ----------
  const BRUT = window.VIS_NIV = window.VIS_NIV || {};
  const enCharge = {};
  function charger(cle) {
    if (BRUT[cle] || enCharge[cle]) return;
    enCharge[cle] = true;
    majChargement();
    const s = document.createElement("script");
    s.src = "donnees-" + cle + ".js";
    s.onerror = () => { delete enCharge[cle]; $("chg").hidden = false; $("chg").textContent = "Échec du chargement de donnees-" + cle + ".js"; };
    s.onload = () => {
      delete enCharge[cle];
      majChargement();
      vc = null;
      rendreBientot();
    };
    document.body.appendChild(s);
  }
  function majChargement() {
    const cles = Object.keys(enCharge);
    $("chg").hidden = !cles.length;
    if (cles.length) $("chg").textContent = "Chargement des contours " + cles.join(", ") + "…";
  }
  // Couche construite pour le système courant ; null si les données ne sont pas encore là
  function couche(sy, cle) {
    if (sy.niveaux[cle]) return sy.niveaux[cle];
    const B = BRUT[cle];
    if (!B) return null;
    const L = {
      cle,
      jeu: jeu(B.communes, B.q, sy.metro),
      limites: chemin(B.limites.lignes, B.limites.q, sy.metro, null, true),
    };
    if (B.cote) {
      L.cote = chemin(B.cote.cote_communes, B.cote.q, sy.metro);
      L.hors = chemin(B.cote.fond_hors_communes, B.cote.q, sy.metro);
    }
    sy.niveaux[cle] = L;
    return L;
  }
  // Niveau voulu à l'échelle courante
  const mParPx = (zz = z) => 1 / (base * zz) / sysCourant.S.A;
  function niveauVoulu(zz = z) {
    const m = mParPx(zz);
    for (const [nom, tol] of NIVEAUX) if (tol <= MARGE_TOL * m) return nom;
    return NIVEAUX[NIVEAUX.length - 1][0];
  }
  // Couche à afficher : celle voulue si chargée, sinon la plus proche déjà disponible (en attendant).
  // Pendant un vol vers une commune, on plafonne au niveau de la vue France (rendu rapide à chaque image).
  let enVol = false;
  function coucheAffichee(version) {
    let voulu = niveauVoulu();
    if (enVol) {
      const rang = n => NIVEAUX.findIndex(x => x[0] === n), plafond = niveauVoulu(1);
      if (rang(voulu) > rang(plafond)) voulu = plafond;
    }
    charger(version + "-" + voulu);
    const iv = NIVEAUX.findIndex(n => n[0] === voulu);
    const ordre = NIVEAUX.map((n, i) => [n[0], Math.abs(i - iv) + (i > iv ? 0.5 : 0)]).sort((a, b) => a[1] - b[1]);
    for (const [nom] of ordre) {
      const L = couche(sysCourant, version + "-" + nom);
      if (L) return L;
    }
    return null;
  }

  // ---------- Vue ----------
  let sysCourant = null;
  let W = 0, H = 0, dpr = 1, base = 1;
  let z = 1, tx = 0, ty = 0;   // écran = vb * base * z + t
  let vc = null;               // vue du dernier rendu complet (image en cache)
  let surligne = null;
  // page habillée : le canevas prend exactement les proportions du fond (hauteur = largeur × H_cadre / W) ;
  // le fond remplit tout le cadre et on ne voit jamais au-delà de ses bords. La page s'allonge d'autant.
  const HABILLE = !!document.querySelector(".habillage");
  // police du texte dessiné sur la carte (noms des encarts) = variable CSS --police de la page (Poppins par défaut)
  const POLICE = getComputedStyle(document.documentElement).getPropertyValue("--police").trim() || "Poppins, sans-serif";
  if (document.fonts) document.fonts.ready.then(() => { cleGlobale = ""; vc = null; rendreBientot(); }); // redessin police chargée
  let pleinEcran = false; // (bascule plus bas, section Plein écran)
  function taille() {
    const r = cv.getBoundingClientRect();
    dpr = window.devicePixelRatio || 1;
    W = r.width; H = r.height;
    const nom = W < SEUIL_MOBILE ? "350" : "700";
    const change = !sysCourant || sysCourant.nom !== nom;
    sysCourant = systeme(nom);
    const ajuste = HABILLE && !pleinEcran;
    const largeurVue = CADRAGE_M && nom === "350" ? CADRAGE_M.x[1] - CADRAGE_M.x[0] : sysCourant.S.W; // largeur montrée à z = 1
    if (ajuste) { H = Math.round(W * sysCourant.S.H_cadre / largeurVue); cv.style.height = H + "px"; }
    cv.width = Math.round(W * dpr);
    cv.height = Math.round(H * dpr);
    base = ajuste ? W / largeurVue : Math.min(W / sysCourant.S.W, H / sysCourant.S.H_cadre) * 0.96;
    vc = null;
    if (change) { surligne = null; reset(); } else { contraindre(); rendreBientot(); }
  }
  function reset() {
    z = 1; tx = CADRAGE_M && sysCourant.nom === "350" && HABILLE && !pleinEcran ? -CADRAGE_M.x[0] * base
                                                                              : (W - sysCourant.S.W * base) / 2; ty = (H - sysCourant.S.H_cadre * base) / 2;
    rendreBientot();
  }
  // Cadre : on ne peut ni dézoomer sous la vue d'ensemble ni sortir du fond dessiné.
  // Sur chaque axe, le fond couvre tout l'écran s'il est plus grand que lui, sinon il reste centré.
  function contraindre() {
    z = Math.max(1, Math.min(ZMAX, z));
    const k = base * z, cw = sysCourant.S.W * k, ch = sysCourant.S.H_cadre * k;
    tx = cw > W ? Math.min(0, Math.max(W - cw, tx)) : (W - cw) / 2;
    ty = ch > H ? Math.min(0, Math.max(H - ch, ty)) : (H - ch) / 2;
  }
  function zoomEn(f, sx, sy, geste) {
    const nz = Math.max(1, Math.min(ZMAX, z * f));
    f = nz / z;
    tx = sx - (sx - tx) * f; ty = sy - (sy - ty) * f; z = nz;
    contraindre();
    fermerBulle();
    geste ? apercu() : rendreBientot();
  }
  const versVb = (sx, sy) => [(sx - tx) / (base * z), (sy - ty) / (base * z)];

  // ---------- État des contrôles ----------
  const etat = () => ({
    fond: $("c-fond").checked, sombre: $("c-sombre").checked, aplats: $("c-aplats").checked,
    limites: $("c-limites").checked, dep: $("c-dep").checked,
    om: $("c-om").checked,
  });
  const MER = { clair: "#ffffff", sombre: "#212327" };

  // ---------- Rendu complet ----------
  function dessiner(c) {
    const e = etat(), sy = sysCourant, S = sy.S, th = e.sombre ? "sombre" : "clair";
    const px = 1 / (base * z), m = mParPx();
    const L = coucheAffichee("reel");

    c.setTransform(1, 0, 0, 1, 0, 0);
    c.fillStyle = MER[th]; c.fillRect(0, 0, c.canvas.width, c.canvas.height);
    c.setTransform(dpr * base * z, 0, 0, dpr * base * z, dpr * tx, dpr * ty);
    c.lineJoin = "round";

    const img = sy.imgs[th];
    if (e.fond && img.complete && img.naturalWidth) c.drawImage(img, 0, 0, S.W, S.H);
    // côte tirée des communes : la terre du fond qui dépasse est masquée
    const CT = sy.contour, hors = CT ? CT.hors : L && L.hors;
    if (e.fond && hors) { c.fillStyle = MER[th]; c.fill(hors, "evenodd"); }

    if (L) {
      if (e.aplats && !POINTS) {
        c.globalAlpha = 0.85;
        L.jeu.parCouleur.forEach((p, i) => { c.fillStyle = PALETTE[i]; c.fill(p, "evenodd"); });
        c.globalAlpha = 1;
      }
      // contour imposé : limites coupées au contour, pour qu'elles ne débordent pas en mer
      if (CT) { c.save(); c.clip(CT.france, "evenodd"); }
      // limites communales : seulement quand les communes sont assez grandes à l'écran
      const [m0, m1] = LIMITES_COMMUNES;
      const a = Math.max(0, Math.min(1, (m0 - m) / (m0 - m1)));
      if (e.limites && a > 0) {
        c.strokeStyle = e.sombre ? "rgba(0,0,0," + 0.5 * a + ")" : "rgba(255,255,255," + 0.9 * a + ")";
        c.lineWidth = 0.6 * px;
        c.stroke(L.jeu.tout);
      }
      if (e.dep) {
        // mode points : limites discrètes, pour que les points ressortent
        c.strokeStyle = e.sombre ? "#cfd8da" : POINTS ? "rgba(0,67,82,.38)" : "#004352";
        c.lineWidth = (POINTS ? 0.8 : 1) * px;
        c.stroke(L.limites);
      }
      if (CT) c.restore();
      if (e.aplats && m > ALERTES_VISIBLES) {
        for (const al of sy.alertes) {
          c.beginPath(); c.arc(al.xy[0], al.xy[1], 4 * px, 0, 2 * Math.PI);
          c.fillStyle = PALETTE[ALERTE]; c.fill();
          c.lineWidth = 1.2 * px; c.strokeStyle = "#fff"; c.stroke();
        }
      }
    }
    c.strokeStyle = e.sombre ? "#ffffff" : "#3a3a3a";
    c.lineWidth = 1.2 * px;
    if (CT) c.stroke(CT.france);
    else if (L && L.cote) c.stroke(L.cote);
    if (e.om) {
      let bas = 0;
      // taille des noms (px écran) : VIS_DATA.taille_noms_encarts = [mobile, ordinateur] (10 px par défaut), réduite
      // pour TOUS les noms si l'un manque de place : en largeur, jusqu'au cadre voisin à sa droite (5 px d'écart),
      // sans dépasser son cadre de plus de 15 % ; en hauteur, sans toucher le cadre au-dessus (2 px d'écart).
      const TN = (DATA && DATA.taille_noms_encarts) || [10, 10], fs0 = (W >= SEUIL_MOBILE ? TN[1] : TN[0]) * px;
      let fs = fs0;
      c.font = "500 " + fs0 + "px " + POLICE;
      for (const t in S.encarts) {
        const [bx, by, bw] = S.encarts[t], lt = c.measureText(D.territoires[t].nom).width;
        let place = bw * 1.15, haut = Infinity;
        for (const u in S.encarts) {
          if (u === t) continue;
          const [x2, y2, w2, h2] = S.encarts[u];
          if (x2 > bx && y2 <= by && y2 + h2 > by - fs0 - 3 * px) place = Math.min(place, x2 - bx - 5 * px); // cadre à droite du nom
          if (x2 < bx + Math.max(bw, lt) && x2 + w2 > bx && y2 + h2 <= by) haut = Math.min(haut, by - (y2 + h2)); // cadre au-dessus
        }
        fs = Math.min(fs, fs0 * Math.min(1, place / lt), (haut - 5 * px) / 0.95);
      }
      for (const t in S.encarts) {
        const [bx, by, bw, bh] = S.encarts[t];
        bas = Math.max(bas, by + bh);
        c.fillStyle = e.sombre ? "#2b2e33" : "#fff";
        c.fillRect(bx, by, bw, bh);
        const O = sy.om[t];
        O.parCouleur.forEach((p, i) => { c.fillStyle = PALETTE[i]; c.fill(p, "evenodd"); });
        c.strokeStyle = "rgba(255,255,255,.9)"; c.lineWidth = 0.5 * px; c.stroke(O.tout);
        c.strokeStyle = "#004352"; c.lineWidth = px; c.strokeRect(bx, by, bw, bh);
        c.fillStyle = e.sombre ? "#fff" : "#004352";
        c.font = "500 " + fs + "px " + POLICE;
        c.fillText(D.territoires[t].nom, bx, by - 3 * px); // nom au-dessus du cadre
      }
      if (!DATA || DATA.echelles_differentes !== false) { // mention masquable : VIS_DATA.echelles_differentes = false
        c.fillStyle = e.sombre ? "#bbb" : "#616161";
        c.font = "italic " + 10 * px + "px " + POLICE;
        c.fillText("Échelles différentes", S.encarts["971"][0], bas + 13 * px);
      }
    }
    dessinerPoints(c, sy, px, e);
    if (surligne) {
      c.strokeStyle = "#E62D2B"; c.lineWidth = 2.5 * px;
      if (surligne.p) c.stroke(surligne.p);
      else { c.beginPath(); c.arc(surligne.xy[0], surligne.xy[1], 6 * px, 0, 2 * Math.PI); c.stroke(); }
    }
  }

  // Pendant un geste, on déplace une image en cache. Pour qu'un déplacement rapide ne découvre pas de vide :
  // l'image est rendue avec une marge autour de l'écran, et une vue d'ensemble de toute la carte
  // (« globale », rendue une fois par réglage) est posée dessous pour ce qui dépasse encore.
  const BUDGET_PX = 12e6; // pixels max d'une image en cache (mémoire des mobiles)
  const globale = document.createElement("canvas"), gctx = globale.getContext("2d");
  let cleGlobale = "";
  function avecVue(v, fn) {
    const s = [z, tx, ty, dpr, surligne];
    if ("z" in v) z = v.z;
    if ("tx" in v) tx = v.tx;
    if ("ty" in v) ty = v.ty;
    if ("dpr" in v) dpr = v.dpr;
    if (v.globale) surligne = null;
    try { fn(); } finally {
      [z, tx, ty, dpr] = s;
      if (v.globale) surligne = s[4];
    }
  }
  function majGlobale() {
    const sy = sysCourant, S = sy.S, img = sy.imgs[etat().sombre ? "sombre" : "clair"];
    const cle = [sy.nom, base, dpr, JSON.stringify(etat()), Object.keys(BRUT).join(), img.complete].join("|");
    if (cle === cleGlobale) return;
    cleGlobale = cle;
    const G = Math.min(base * dpr * 2, 4096 / S.W, Math.sqrt(BUDGET_PX / (S.W * S.H_cadre))); // pixels par unité
    globale.width = Math.round(S.W * G); globale.height = Math.round(S.H_cadre * G);
    avecVue({ z: 1, tx: 0, ty: 0, dpr: G / base, globale: true }, () => dessiner(gctx));
  }
  // direct : rendu de l'écran seul, sans marge ni cache (images d'un vol)
  function rendreComplet(direct) {
    if (direct) { dessiner(ctx); vc = null; }
    else {
      majGlobale();
      const f = Math.max(0, Math.min(0.5, (Math.sqrt(BUDGET_PX / (W * H * dpr * dpr)) - 1) / 2));
      const mx = Math.round(W * f * dpr) / dpr, my = Math.round(H * f * dpr) / dpr;
      const cw = Math.round((W + 2 * mx) * dpr), chh = Math.round((H + 2 * my) * dpr);
      if (cache.width !== cw || cache.height !== chh) { cache.width = cw; cache.height = chh; }
      avecVue({ tx: tx + mx, ty: ty + my }, () => dessiner(cctx));
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.drawImage(cache, Math.round(mx * dpr), Math.round(my * dpr), cv.width, cv.height, 0, 0, cv.width, cv.height);
      vc = { z, tx, ty, mx, my };
    }
  }
  // Aperçu pendant un geste : image en cache déplacée/agrandie
  let rafApercu = 0, minuteur = 0;
  function apercu() {
    if (!vc) { rendreBientot(); return; }
    if (!rafApercu) rafApercu = requestAnimationFrame(() => {
      rafApercu = 0;
      const s = z / vc.z;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = MER[etat().sombre ? "sombre" : "clair"];
      ctx.fillRect(0, 0, cv.width, cv.height);
      const k = dpr * base * z, S = sysCourant.S;
      ctx.drawImage(globale, dpr * tx, dpr * ty, S.W * k, S.H_cadre * k);
      ctx.drawImage(cache, dpr * (tx - (vc.tx + vc.mx) * s), dpr * (ty - (vc.ty + vc.my) * s),
                    cache.width * s, cache.height * s);
    });
    clearTimeout(minuteur);
    minuteur = setTimeout(rendreBientot, ATTENTE_RENDU);
  }
  let rafRendu = 0;
  function rendreBientot() {
    clearTimeout(minuteur);
    if (!rafRendu) rafRendu = requestAnimationFrame(() => { rafRendu = 0; rendreComplet(); });
  }

  // ---------- Survol ----------
  function trouver(vx, vy) {
    const e = etat(), sy = sysCourant;
    const cands = [];
    if (e.om) for (const t in sy.S.encarts) {
      const [bx, by, bw, bh] = sy.S.encarts[t];
      if (vx >= bx && vx <= bx + bw && vy >= by && vy <= by + bh) cands.push(...sy.om[t].items);
    }
    if (!cands.length) {
      const L = coucheAffichee("reel");
      if (L) cands.push(...(L.jeu.grille.get(Math.floor(vx / GRILLE) + "," + Math.floor(vy / GRILLE)) || []));
      const r = 6 / (base * z);
      if (e.aplats && mParPx() > ALERTES_VISIBLES)
        for (const a of sy.alertes) if (Math.hypot(a.xy[0] - vx, a.xy[1] - vy) < r) return { code: a.code };
    }
    ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0);
    let res = null;
    for (const it of cands) {
      if (vx < it.bb[0] || vx > it.bb[2] || vy < it.bb[1] || vy > it.bb[3]) continue;
      if (ctx.isPointInPath(it.p, vx, vy, "evenodd")) { res = it; break; }
    }
    ctx.restore();
    return res;
  }
  // epingler : clic ou toucher, l'infobulle reste ouverte et ses liens sont cliquables
  let epinglee = false;
  // infobulle au survol d'une commune : toujours en mode aplats ; en mode points seulement si VIS_DATA.bulle_communes
  const BULLE_COMMUNES = !POINTS || !!DATA.bulle_communes;
  function fermerBulle() { tt.hidden = true; epinglee = false; tt.classList.remove("epinglee", "tt-bandeau"); }
  function survol(ev, epingler) {
    if (epinglee && !epingler) return;
    const r = cv.getBoundingClientRect(), sx = ev.clientX - r.left, sy = ev.clientY - r.top;
    const [vx, vy] = versVb(sx, sy);
    if (POINTS) {
      const pts = trouverPoints(vx, vy, ev.pointerType === "mouse" ? 4 : 12);
      if (pts.length) { bullePoints(pts, sx, sy, epingler); return; }
      if (!BULLE_COMMUNES) { fermerBulle(); return; } // mode points : pas d'infobulle sur les communes
    }
    const f = trouver(vx, vy);
    if (!f) { fermerBulle(); return; }
    bulle(f.code, sx, sy, epingler);
  }
  // Infobulle d'une commune, placée près de (sx, sy) sans sortir du cadre
  const nb = x => x.toLocaleString("fr-FR");
  const ugl = x => x.toLocaleString("fr-FR", { maximumFractionDigits: 3 }) + " µg/L";
  const echap = s => String(s).replace(/[&<>"]/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]);
  // pastille d'une catégorie (même forme que sur la carte)
  // pastille : le disque du picto (diamètre D px) centré dans une case D × D (le reste du dessin, ombre comprise, déborde)
  const pastille = (k, D = 14) => {
    const C = CATS[k], P = C.picto;
    if (!P) return '<i class="pt pt-' + (C.forme || "rond") + '" style="--c:' + C.couleur + '"></i>';
    const S = D * P.vb / (2 * P.r), l = D / 2 - P.cx / P.vb * S, t = D / 2 - P.cy / P.vb * S;
    return '<span class="pt-box" style="width:' + D + "px;height:" + D + 'px"><img alt="" src="' + pictoUrl(C) +
      '" style="width:' + S.toFixed(1) + "px;height:" + S.toFixed(1) + "px;left:" + l.toFixed(1) + "px;top:" + t.toFixed(1) + 'px"></span>';
  };
  function majPastilles() { /* les <img> des pastilles se chargent seules */ }
  const domaine = u => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch (e) { return u; } };
  function contenuPoint(i, complet) {
    const [k, , , , code, nom, op, statut, texte, urls, drap] = DATA.points[i], C = CATS[k];
    const com = PARCODE[code];
    // infobulle épinglée : le picto est un bouton qui zoome sur le site
    const pic = epinglee ? '<button type="button" class="tt-zoom" data-zoom="' + i + '" title="Zoomer sur ce site" aria-label="Zoomer sur ce site">' +
      pastille(k) + "</button>" : pastille(k);
    let h = '<div class="tt-pt">' + pic + "<div><b>" + echap(nom || C.sans_nom || C.libelle) + "</b>" +
      '<div class="tt-cat">' + echap(DATA.points[i][11] || C.libelle1 || C.libelle) + (com ? " · " + echap(com.n) + " (" + com.d + ")" : "") + "</div>";
    if (complet) {
      if (op) h += '<div class="tt-ligne"><span>Entreprise</span> ' + echap(courtTxt(op, 140)) + "</div>";
      if (statut) h += '<div class="tt-ligne"><span>Statut</span> ' + echap(courtTxt(statut, 170)) + "</div>";
      // texte : les retours à la ligne des données sont gardés (CSS pre-line) ; plus long dans l'infobulle épinglée (elle défile)
      if (texte) h += '<div class="tt-texte">' + echap(courtTxt(texte, epinglee ? 700 : 260)) + "</div>";
      if (drap && drap.length) h += '<div class="tt-drap">' + drap.map(d => "<span>" + echap(d) + "</span>").join("") + "</div>";
      if (urls && urls.length) h += epinglee
        ? '<div class="tt-liens">' + urls.slice(0, 4).map(u => '<a href="' + echap(u) + '" target="_blank" rel="noopener">' +
            echap(domaine(u)) + "</a>").join("") + "</div>"
        : '<div class="tt-note">' + (W < SEUIL_MOBILE ? "Touchez" : "Cliquez") + " pour ouvrir " +
            (urls.length > 1 ? "les " + urls.length + " sources" : "la source") + "</div>";
    }
    return h + "</div></div>";
  }
  // ---------- Écran étroit (mobile), mode points : bandeau, liste des points empilés, fiche plein cadre ----------
  // toucher un point -> bandeau en bas de la carte (en haut si le point est dessous) : nom, catégorie, chiffres clés,
  // « Voir la fiche » ; plusieurs points sous le doigt -> liste (lignes de 44 px, toucher une ligne = zoomer sur ce site)
  // + « Zoomer ici » ;
  // la fiche couvre tout le cadre, défile, et se referme par « ← Retour à la carte ».
  const courtTxt = (t, n) => !t || t.length <= n ? t : t.slice(0, n).replace(/\s+\S*$/, "") + "…";
  const etiquettes = (ch, n) => ch && ch.length
    ? '<div class="tt-chiffres">' + ch.slice(0, n).map(c => "<span>" + echap(c) + "</span>").join("") + "</div>" : "";
  const nomPt = p => p[5] || CATS[p[0]].sans_nom || CATS[p[0]].libelle;
  const lieuPt = p => { const com = PARCODE[p[4]]; return com ? com.n + " (" + com.d + ")" : ""; };
  const fiche = document.createElement("div");
  fiche.className = "fiche"; fiche.hidden = true;
  fiche.setAttribute("role", "dialog"); fiche.setAttribute("aria-label", "Fiche du site");
  cv.parentNode.appendChild(fiche);
  let bandeauXY = null;
  function bandeau(pts, sy) {
    epinglee = true;
    tt.classList.add("epinglee", "tt-bandeau", "tt-fiche");
    let h = '<button class="tt-fermer" type="button" aria-label="Fermer">×</button>';
    if (pts.length === 1) {
      const i = pts[0], p = DATA.points[i], C = CATS[p[0]];
      h += '<div class="tt-pt">' + pastille(p[0], 18) + '<div class="bd-txt"><b>' + echap(nomPt(p)) + "</b>" +
        '<div class="tt-cat">' + echap(p[11] || C.libelle1 || C.libelle) + (lieuPt(p) ? " · " + echap(lieuPt(p)) : "") + "</div></div></div>" +
        etiquettes(p[12], 3) +
        '<button type="button" class="bd-voir" data-fiche="' + i + '">Voir la fiche ›</button>';
    } else {
      h += '<div class="bd-tete"><b>' + pts.length + " sites ici</b>" +
        '<button type="button" class="bd-zoom">Zoomer ici</button></div><div class="bd-liste">' +
        pts.map(i => { const p = DATA.points[i], C = CATS[p[0]];
          // une ligne de la liste = vol jusqu'au site (puis son bandeau seul), pas de fiche directe (2026-11-06)
          return '<button type="button" class="bd-ligne" data-zoom="' + i + '" aria-label="Zoomer sur ' + echap(nomPt(p)) + '">' + pastille(p[0], 16) +
            "<span><b>" + echap(nomPt(p)) + "</b><small>" + echap(C.court || C.libelle) +
            (lieuPt(p) ? " · " + echap(lieuPt(p)) : "") + '</small></span><i aria-hidden="true">›</i></button>'; }).join("") + "</div>";
    }
    const xs = pts.map(i => sysCourant.pts[i]).filter(Boolean);
    bandeauXY = xs.length ? [xs.reduce((a, b) => a + b[0], 0) / xs.length, xs.reduce((a, b) => a + b[1], 0) / xs.length] : null;
    tt.innerHTML = h;
    tt.hidden = false;
    const hh = tt.offsetHeight;
    tt.style.left = "8px";
    tt.style.top = (sy > H - hh - 24 ? 8 : H - hh - 8) + "px";
  }
  function ouvrirFiche(i) {
    const [k, , , , , nom, op, statut, texte, urls, drap, sous, ch] = DATA.points[i], C = CATS[k], p = DATA.points[i];
    fiche.innerHTML = '<div class="fi-barre"><button type="button" class="fi-retour">← Retour à la carte</button></div>' +
      '<div class="fi-corps"><div class="tt-pt">' + pastille(k, 22) + "<div><h2>" + echap(nomPt(p)) + "</h2>" +
      '<div class="tt-cat">' + echap(sous || C.libelle1 || C.libelle) + (lieuPt(p) ? " · " + echap(lieuPt(p)) : "") + "</div></div></div>" +
      etiquettes(ch, 9) +
      (op ? '<div class="fi-champ"><span>Entreprise</span>' + echap(op) + "</div>" : "") +
      (statut ? '<div class="fi-champ"><span>Statut</span>' + echap(statut) + "</div>" : "") +
      (texte ? '<div class="fi-champ fi-texte"><span>Description du collectif</span>' + echap(texte) + "</div>" : "") +
      (drap && drap.length ? '<div class="tt-drap">' + drap.map(d => "<span>" + echap(d) + "</span>").join("") + "</div>" : "") +
      (urls && urls.length ? '<div class="fi-champ"><span>Sources</span><div class="fi-sources">' + urls.map((u, j) => {
        // même site cité plusieurs fois : numéroté (lemonde.fr · 2)
        const dom = domaine(u), rang = urls.slice(0, j + 1).filter(v => domaine(v) === dom).length;
        return '<a href="' + echap(u) + '" target="_blank" rel="noopener">' + echap(dom) + (rang > 1 ? " · " + rang : "") + " ↗</a>";
      }).join("") + "</div></div>" : "") +
      (ch && ch.length ? '<p class="fi-note">Chiffres relevés automatiquement dans la description du collectif.</p>' : "") +
      "</div>";
    fiche.hidden = false;
    fiche.scrollTop = 0;
  }
  const fermerFiche = () => { fiche.hidden = true; };
  fiche.addEventListener("click", ev => { if (ev.target.closest(".fi-retour")) fermerFiche(); });
  document.addEventListener("keydown", ev => { if (ev.key === "Escape" && !fiche.hidden) fermerFiche(); });
  tt.addEventListener("click", ev => {
    const zb = ev.target.closest("[data-zoom]");
    if (zb) { zoomerSur(+zb.dataset.zoom); return; }
    const f = ev.target.closest("[data-fiche]");
    if (f) { ouvrirFiche(+f.dataset.fiche); return; }
    if (ev.target.closest(".bd-zoom") && bandeauXY) {
      const xy = bandeauXY;
      fermerBulle();
      voler(xy, Math.min(ZMAX, Math.max(z * 4, 12)), () => rendreBientot());
    }
  });
  function bullePoints(pts, sx, sy, epingler) {
    if (W < SEUIL_MOBILE && epingler) { bandeau(pts, sy); return; }
    epinglee = !!epingler;
    tt.classList.toggle("epinglee", epinglee);
    // survol : 4 points au plus ; épinglée (clic) : tous, l'infobulle défile
    const MAX = epinglee ? Infinity : 4;
    let h = (epinglee ? '<button class="tt-fermer" type="button" aria-label="Fermer">×</button>' : "") + contenuPoint(pts[0], true);
    if (pts.length > 1) h += '<div class="tt-autres">' + (pts.length - 1) + " autre" + (pts.length > 2 ? "s" : "") +
      " point" + (pts.length > 2 ? "s" : "") + " au même endroit" +
      (epinglee ? " · cliquer sur un picto pour zoomer dessus" : " (cliquer pour tous les voir)") + "</div>" +
      pts.slice(1, MAX).map(i => contenuPoint(i, epinglee)).join("") +
      (pts.length > MAX ? '<div class="tt-note">et ' + (pts.length - MAX) + " autres</div>" : "");
    placerBulle(h, sx, sy);
  }
  function contenuBulle(code) {
    const i = PARCODE[code] || { n: code, d: "", p: 0 };
    let h = "<b>" + echap(i.n) + "</b> <small>(" + i.d + ")" + (i.p ? " · " + nb(i.p) + " hab." : "") + "</small>";
    if (POINTS) {
      const liste = (PARCOMMUNE[code] || []).filter(j => catVisible[DATA.points[j][0]]);
      if (!liste.length) return h + '<div class="tt-note">Aucun site recensé dans la commune' +
        (catVisible.every(v => v) ? "" : " parmi les catégories affichées") + "</div>";
      const parCat = CATS.map((C, k) => [k, liste.filter(j => DATA.points[j][0] === k).length]).filter(x => x[1]);
      return h + parCat.map(([k, n]) => '<div class="tt-statut">' + pastille(k) + n + " · " + echap(n > 1 ? CATS[k].libelle : CATS[k].libelle1 || CATS[k].libelle) + "</div>").join("");
    }
    if (!DATA) return h + "<br>" + code;
    const d = DATA.communes[code];
    const k = d ? d[0] : SANS_DONNEES, cl = DATA.classes[k];
    h += '<div class="tt-statut"><i style="background:' + PALETTE[k] + '"></i>' + cl.libelle + "</div>";
    if (!d || k === SANS_DONNEES) {
      h += '<div class="tt-note">Aucune analyse de pesticides au cours des 12 derniers mois.</div>';
    } else {
      const [, date, rech, quant, total, totalTout, mols, autres] = d;
      h += '<div class="tt-note">Dernier prélèvement le ' +
        new Date(date).toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric" }) +
        " · " + nb(quant) + " molécule" + (quant > 1 ? "s" : "") + " quantifiée" + (quant > 1 ? "s" : "") +
        " sur " + nb(rech) + " recherchées</div>";
      if (mols.length) {
        h += '<table class="tt-mol">' + mols.map(([n, v, np]) =>
          "<tr><td>" + echap(n) + (np ? "*" : "") + "</td><td>" + ugl(v) + "</td></tr>").join("") + "</table>";
        if (autres) h += '<div class="tt-note">et ' + autres + " autre" + (autres > 1 ? "s" : "") + "</div>";
        h += '<div class="tt-note">Total pesticides : ' + ugl(total || 0) +
          (totalTout > (total || 0) ? " (" + ugl(totalTout) + " avec les métabolites non pertinents)" : "") + "</div>";
        if (mols.some(m => m[2])) h += '<div class="tt-note">* métabolite jugé non pertinent : pas de limite réglementaire</div>';
      }
    }
    if (d && d[8]) h += '<div class="tt-note">Bilan ' + DATA.annee_bilan + " : " + nb(d[9] || 0) + " prélèvement" +
      ((d[9] || 0) > 1 ? "s" : "") + " non conforme" + ((d[9] || 0) > 1 ? "s" : "") + " sur " + nb(d[8]) + "</div>";
    return h;
  }
  function bulle(code, sx, sy, epingler) {
    epinglee = !!(epingler && POINTS);
    tt.classList.toggle("epinglee", epinglee);
    placerBulle((epinglee ? '<button class="tt-fermer" type="button" aria-label="Fermer">×</button>' : "") + contenuBulle(code), sx, sy);
  }
  tt.addEventListener("click", ev => { if (ev.target.closest(".tt-fermer")) { fermerBulle(); setFocus(-1); } });
  function placerBulle(html, sx, sy) {
    tt.innerHTML = html;
    // écran étroit : fiche pleine largeur en bas de la carte (en haut si la commune touchée est en bas)
    const fiche = W < SEUIL_MOBILE;
    tt.classList.toggle("tt-fiche", fiche);
    tt.hidden = false;
    if (fiche) {
      const h = tt.offsetHeight;
      tt.style.left = "8px";
      tt.style.top = (sy > H - h - 24 ? 8 : H - h - 8) + "px";
      return;
    }
    const w = tt.offsetWidth, h = tt.offsetHeight, m = 12;
    tt.style.left = Math.max(4, Math.min(W - w - 4, sx + m + w > W ? sx - m - w : sx + m)) + "px";
    tt.style.top = Math.max(4, Math.min(H - h - 4, sy + m + h > H ? sy - m - h : sy + m)) + "px";
  }

  // ---------- Interactions : glisser, molette, pincement, toucher ----------
  const pointeurs = new Map();
  let distPince = 0, milieuPince = [0, 0], bouge = 0;
  cv.addEventListener("pointerdown", ev => {
    try { cv.setPointerCapture(ev.pointerId); } catch (e) { /* pointeur déjà relâché */ }
    pointeurs.set(ev.pointerId, [ev.clientX, ev.clientY]);
    bouge = 0;
    cv.classList.add("drag"); fermerBulle();
  });
  cv.addEventListener("pointermove", ev => {
    if (!pointeurs.has(ev.pointerId)) { if (ev.pointerType === "mouse") survol(ev); return; }
    const prev = pointeurs.get(ev.pointerId);
    pointeurs.set(ev.pointerId, [ev.clientX, ev.clientY]);
    bouge += Math.abs(ev.clientX - prev[0]) + Math.abs(ev.clientY - prev[1]);
    if (pointeurs.size === 2) {
      const [a, b] = [...pointeurs.values()];
      const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
      const r = cv.getBoundingClientRect(), mx = (a[0] + b[0]) / 2 - r.left, my = (a[1] + b[1]) / 2 - r.top;
      if (distPince) {
        tx += mx - milieuPince[0]; ty += my - milieuPince[1]; // deux doigts : déplacement…
        zoomEn(d / distPince, mx, my, true);                   // … et pincement
      }
      distPince = d; milieuPince = [mx, my];
    } else {
      tx += ev.clientX - prev[0]; ty += ev.clientY - prev[1];
      contraindre();
      apercu();
    }
  });
  const fin = ev => {
    pointeurs.delete(ev.pointerId); distPince = 0;
    if (!pointeurs.size) {
      cv.classList.remove("drag");
      if (ev.type === "pointerup" && ev.pointerType !== "mouse" && bouge < 8) survol(ev, POINTS); // toucher = infobulle
      else if (ev.type === "pointerup" && POINTS && bouge < 4) { setFocus(-1); survol(ev, true); } // clic = infobulle épinglée
      rendreBientot();
    }
  };
  cv.addEventListener("pointerup", fin);
  cv.addEventListener("pointercancel", fin);
  cv.addEventListener("pointerleave", ev => { if (ev.pointerType === "mouse" && !epinglee) tt.hidden = true; });
  cv.addEventListener("wheel", ev => {
    ev.preventDefault();
    const r = cv.getBoundingClientRect();
    zoomEn(Math.exp(-ev.deltaY * 0.0015), ev.clientX - r.left, ev.clientY - r.top, true);
  }, { passive: false });
  cv.addEventListener("dblclick", ev => {
    const r = cv.getBoundingClientRect();
    zoomEn(2, ev.clientX - r.left, ev.clientY - r.top);
  });
  $("z-plus").onclick = () => zoomEn(1.6, W / 2, H / 2);
  $("z-moins").onclick = () => zoomEn(1 / 1.6, W / 2, H / 2);
  $("z-reset").onclick = () => { surligne = null; setFocus(-1); reset(); };
  document.querySelectorAll(".panneau input[type=radio], .panneau input[type=checkbox]").forEach(i =>
    i.addEventListener("change", rendreBientot));

  // ---------- Recherche ----------
  const q = $("q"), res = $("res");
  let choix = [], sel = -1;
  q.addEventListener("input", () => {
    const v = norm(q.value);
    if (v.length < 2) { res.hidden = true; return; }
    const num = /^\d/.test(v);
    choix = INDEX.filter(i => num ? i.c.startsWith(v) || (" " + i.cp).includes(" " + v)
                                  : i.cle.startsWith(v) || i.cle.includes(" " + v))
      .sort((a, b) => (b.cle.startsWith(v) - a.cle.startsWith(v)) || b.p - a.p).slice(0, POINTS ? 6 : 10);
    // mode points : les sites dont le nom ou l'entreprise contient la saisie
    const sites = POINTS && !num ? INDEX_PTS.filter(s => catVisible[DATA.points[s.i][0]] && (s.cle.startsWith(v) || s.cle.includes(" " + v)))
      .sort((a, b) => b.cle.startsWith(v) - a.cle.startsWith(v)).slice(0, 6) : [];
    choix = choix.concat(sites);
    sel = -1;
    res.innerHTML = choix.map((i, k) => '<div role="option" data-k="' + k + '">' + ("i" in i
      ? pastille(DATA.points[i.i][0]) + echap(i.n) + " <small>" + echap(i.ou) + "</small>"
      : i.n + " <small>(" + i.d + ") " + (i.p ? i.p.toLocaleString("fr-FR") + " hab." : "") + "</small>") + "</div>").join("") ||
      "<div><small>Aucun résultat</small></div>";
    res.hidden = false;
  });
  // index des sites (mode points) : nom + entreprise, recherchables
  const INDEX_PTS = POINTS ? DATA.points.map((p, i) => {
    const com = PARCODE[p[4]], n = p[5] || CATS[p[0]].sans_nom || CATS[p[0]].libelle;
    return { i, n, ou: (com ? com.n + " · " : "") + (p[6] ? p[6].slice(0, 40) : CATS[p[0]].court), cle: norm(n + " " + (p[6] || "")) };
  }) : [];
  res.addEventListener("click", ev => { const d = ev.target.closest("[data-k]"); if (d) aller(choix[+d.dataset.k]); });
  q.addEventListener("keydown", ev => {
    if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
      sel = Math.max(0, Math.min(choix.length - 1, sel + (ev.key === "ArrowDown" ? 1 : -1)));
      [...res.children].forEach((d, k) => d.classList.toggle("actif", k === sel)); ev.preventDefault();
    } else if (ev.key === "Enter" && choix.length) aller(choix[Math.max(0, sel)]);
    else if (ev.key === "Escape") res.hidden = true;
  });
  function aller(i) {
    res.hidden = true; q.value = i.n; q.blur();
    const sy = sysCourant;
    if ("i" in i) { // un site (mode points)
      if (!sy.pts[i.i]) { $("chg").hidden = false; $("chg").textContent = i.n + " : pas d'encart pour ce territoire"; return; }
      zoomerSur(i.i, DATA.points[i.i][1] === "metro" ? 14 : 5);
      return;
    }
    let xy, zc;
    setFocus(-1);
    if (i.t === "metro") { xy = sy.metro(i.x, i.y); zc = 10; }
    else if (sy.enc[i.t]) { xy = sy.enc[i.t](i.x, i.y); zc = 5; $("c-om").checked = true; }
    else { $("chg").hidden = false; $("chg").textContent = i.n + " : pas d'encart pour ce territoire (" + i.t + ")"; return; }
    // contour d'arrivée chargé pendant le vol ; en attendant, un cercle marque la destination
    const cle = i.t === "metro" ? "reel-" + niveauVoulu(zc) : null;
    if (cle) charger(cle);
    surligne = { xy };
    voler(xy, zc, () => {
      surligne = cle ? { xy, code: i.c, cle } : sy.om[i.t].parCode[i.c] || { xy };
      rendreBientot();
      if (BULLE_COMMUNES) bulle(i.c, xy[0] * base * z + tx, xy[1] * base * z + ty); // infobulle ouverte à l'arrivée
    });
  }

  // Vol jusqu'à un site (recherche, clic sur un picto de l'infobulle), puis son infobulle épinglée.
  // Sans zoom imposé : au moins ×14 (×5 en encart), et toujours ×2 de plus que la vue actuelle.
  function zoomerSur(i, zc) {
    const p = DATA.points[i], xy = sysCourant.pts[i];
    if (!xy) return;
    if (p[1] !== "metro") $("c-om").checked = true;
    surligne = null; // pas de cercle : le site reste opaque, les autres s'estompent
    setFocus(i);
    voler(xy, zc || Math.min(ZMAX, Math.max(p[1] === "metro" ? 14 : 5, z * 2)), () => {
      rendreBientot();
      // mobile : le seul site (bandeau) ; ordinateur : le site puis ses voisins immédiats
      bullePoints(W < SEUIL_MOBILE ? [i] : [i, ...trouverPoints(xy[0], xy[1], 6).filter(j => j !== i)],
                  xy[0] * base * z + tx, xy[1] * base * z + ty, true);
    });
  }

  // ---------- Vol vers une commune : dézoom puis zoom (van Wijk & Nuij 2003, comme d3.interpolateZoom) ----------
  // Vue = centre (ux, uy) et largeur visible w, en unités viewBox.
  const RHO = Math.SQRT2, DUREE_VOL = [700, 2200]; // ms (min, max)
  let volId = 0;
  function interpolerVue([ux0, uy0, w0], [ux1, uy1, w1]) {
    const dx = ux1 - ux0, dy = uy1 - uy0, d2 = dx * dx + dy * dy, r2 = RHO * RHO;
    if (d2 < 1e-12) {
      const S = Math.log(w1 / w0) / RHO;
      return { S, f: t => [ux0 + t * dx, uy0 + t * dy, w0 * Math.exp(RHO * t * S)] };
    }
    const d1 = Math.sqrt(d2);
    const b0 = (w1 * w1 - w0 * w0 + r2 * r2 * d2) / (2 * w0 * r2 * d1);
    const b1 = (w1 * w1 - w0 * w0 - r2 * r2 * d2) / (2 * w1 * r2 * d1);
    const r0 = Math.log(Math.sqrt(b0 * b0 + 1) - b0), r1 = Math.log(Math.sqrt(b1 * b1 + 1) - b1);
    const S = (r1 - r0) / RHO;
    return { S, f: t => {
      const s = t * S, ch = Math.cosh(r0);
      const u = w0 / (r2 * d1) * (ch * Math.tanh(RHO * s + r0) - Math.sinh(r0));
      return [ux0 + u * dx, uy0 + u * dy, w0 * ch / Math.cosh(RHO * s + r0)];
    } };
  }
  function voler(xy, zc, fini) {
    const id = ++volId;
    const k = base * z, depart = [(W / 2 - tx) / k, (H / 2 - ty) / k, W / k];
    const { S, f } = interpolerVue(depart, [xy[0], xy[1], W / (base * zc)]);
    const duree = Math.max(DUREE_VOL[0], Math.min(DUREE_VOL[1], Math.abs(S) * 1000 * RHO / Math.SQRT2));
    const placer = ([ux, uy, w]) => {
      z = W / (base * w); tx = W / 2 - ux * base * z; ty = H / 2 - uy * base * z;
      contraindre();
    };
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) { placer(f(1)); fini(); return; }
    const t0 = performance.now();
    enVol = true;
    fermerBulle();
    (function pas(t) {
      if (id !== volId) return;
      const p = Math.min(1, (t - t0) / duree);
      placer(f(p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2)); // cubique entrée-sortie
      if (p < 1) { rendreComplet(true); requestAnimationFrame(pas); }
      else { enVol = false; fini(); }
    })(t0);
  }
  // un geste de l'utilisateur interrompt le vol là où il en est
  const stopVol = () => { if (enVol) { volId++; enVol = false; rendreBientot(); } };
  cv.addEventListener("pointerdown", stopVol);
  cv.addEventListener("wheel", stopVol, { passive: true });
  ["z-plus", "z-moins", "z-reset"].forEach(b => $(b).addEventListener("click", stopVol, true));
  // le contour surligné suit le niveau affiché
  const dessinerBase = dessiner;
  dessiner = function (c) {
    if (surligne && surligne.cle) {
      const L = couche(sysCourant, surligne.cle);
      if (L && L.jeu.parCode[surligne.code]) surligne = L.jeu.parCode[surligne.code];
    }
    dessinerBase(c);
  };

  // ---------- Légende ----------
  const leg = $("legende");
  function ligneLegende(k) {
    const C = CATS[k];
    return '<button type="button" class="leg-ligne" aria-pressed="true" data-k="' + k + '">' + pastille(k, (DATA && DATA.taille_legende) || 14) +
      '<span class="l-long">' + echap(C.libelle) + " <small>" + nb(C.nb) + "</small></span>" +
      '<span class="l-court">' + echap(C.court || C.libelle) + " <small>" + nb(C.nb) + "</small></span></button>";
  }
  // page habillée : deux colonnes égales (1re moitié des catégories à gauche). Option VIS_DATA.legende_groupe =
  // {titre, cles} : sur écran étroit, ce titre coiffe une colonne dont toutes les catégories sont dans « cles »
  // (ex. « Data center : » au-dessus de Existants / En construction / Projets) ; l'autre colonne garde une ligne vide.
  function colonnesLegende() {
    const m = Math.ceil(CATS.length / 2), G = DATA.legende_groupe;
    const cols = [CATS.map((C, k) => k).slice(0, m), CATS.map((C, k) => k).slice(m)];
    const titres = cols.map(col => G && col.length && col.every(k => G.cles.includes(CATS[k].cle)) ? G.titre : "");
    const tete = titres.some(Boolean);
    return '<div class="leg-classes leg-filtre leg-cols">' + cols.map((col, j) => '<div class="leg-col">' +
      (tete ? '<div class="leg-groupe">' + (titres[j] ? echap(titres[j]) : "&nbsp;") + "</div>" : "") +
      col.map(ligneLegende).join("") + "</div>").join("") + "</div>";
  }
  if (POINTS) {
    // légende = filtre : chaque catégorie se masque / s'affiche d'un clic
    const date = s => new Date(s).toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric" });
    // page habillée (titre, pied avec #pied-source) : la légende n'a pas de titre et la source va dans le pied
    const PIED = $("pied-source");
    leg.innerHTML = (PIED ? "" : "<b>" + echap(DATA.titre) + "</b>") +
      (DATA.sous_titre ? '<div class="leg-sous">' + echap(DATA.sous_titre) + "</div>" : "") +
      (PIED ? colonnesLegende() : '<div class="leg-classes leg-filtre">' + CATS.map((C, k) => ligneLegende(k)).join("") + "</div>") +
      '<div class="leg-astuce">' + (matchMedia("(hover: hover)").matches ? "Cliquez sur" : "Touchez") +
      " une catégorie pour la masquer</div>";
    // source et dates : ligne de crédit sous la carte (hors de la légende, qui doit rester courte)
    const credit = PIED || document.createElement("div");
    if (!PIED) credit.className = "credit";
    credit.textContent = DATA.source + (DATA.maj ? ". Mise à jour du " + date(DATA.maj) : "") +
      ", extrait le " + date(DATA.extraction) + ".";
    if (!PIED) $("carte").parentNode.appendChild(credit);
    leg.addEventListener("click", ev => {
      const b = ev.target.closest("[data-k]");
      if (!b) return;
      const k = +b.dataset.k;
      catVisible[k] = !catVisible[k];
      b.setAttribute("aria-pressed", catVisible[k]);
      fermerBulle(); vc = null; cleGlobale = ""; rendreBientot();
    });
    const majLegende = () => { leg.hidden = !$("c-aplats").checked; };
    $("c-aplats").addEventListener("change", majLegende);
    majLegende();
  } else if (DATA) {
    const mois = s => new Date(s).toLocaleDateString("fr-FR", { month: "short", year: "numeric" });
    const ecrireLegende = () => {
      leg.innerHTML = "<b>" + DATA.titre + "</b>" +
        '<div class="leg-sous">Dernier prélèvement, ' + mois(DATA.periode[0]) + " – " + mois(DATA.periode[1]) + "</div>" +
        '<div class="leg-classes">' +
        DATA.classes.map((k, i) => '<div class="leg-ligne"><i style="background:' + PALETTE[i] + '"></i>' +
          '<span class="l-long">' + k.libelle + " <small>" + nb(k.communes) + "</small></span>" +
          '<span class="l-court">' + (k.court || k.libelle) + "</span></div>").join("") + "</div>" +
        '<div class="leg-source">' + DATA.source + " · extrait le " +
        new Date(DATA.extraction).toLocaleDateString("fr-FR") + "</div>";
    };
    ecrireLegende();
    const majLegende = () => { leg.hidden = !$("c-aplats").checked; };
    $("c-aplats").addEventListener("change", majLegende);
    majLegende();
  }

  // ---------- Plein écran ----------
  function basculerPleinEcran(voulu) {
    pleinEcran = voulu;
    if (pleinEcran) cv.style.height = ""; // plein écran : le canevas suit la fenêtre (taille() le recale à la sortie)
    document.body.classList.toggle("plein-ecran", pleinEcran);
    const b = $("z-plein"), t = pleinEcran ? "Quitter le plein écran" : "Plein écran";
    b.title = t; b.setAttribute("aria-label", t);
    // vrai plein écran si le navigateur l'autorise (pas sur iPhone ni dans certains iframes) ; sinon, la carte couvre la page
    try {
      if (pleinEcran && document.fullscreenEnabled && !document.fullscreenElement)
        document.documentElement.requestFullscreen().catch(() => {});
      else if (!pleinEcran && document.fullscreenElement) document.exitFullscreen().catch(() => {});
    } catch (e) { /* plein écran CSS seul */ }
    fermerBulle();
  }
  $("z-plein").onclick = () => basculerPleinEcran(!pleinEcran);
  document.addEventListener("fullscreenchange", () => { if (!document.fullscreenElement && pleinEcran) basculerPleinEcran(false); });
  document.addEventListener("keydown", ev => { if (ev.key === "Escape" && pleinEcran) basculerPleinEcran(false); });

  // Réglages : repliés sur mobile, toujours ouverts sur ordinateur
  const regl = $("reglages"), LARGE = matchMedia("(min-width: 761px)");
  const majReglages = () => { if (LARGE.matches) regl.open = true; };
  regl.open = LARGE.matches;
  LARGE.addEventListener("change", majReglages);

  // la taille du canevas suit la mise en page (fenêtre, réglages dépliés, légende)
  let tailleVue = "";
  new ResizeObserver(() => {
    const r = cv.getBoundingClientRect(), k = r.width + "x" + r.height;
    if (k !== tailleVue && r.width && r.height) { tailleVue = k; taille(); }
  }).observe(cv);
})();
