/* Galaxie des associations professionnelles financées par TotalEnergies.
   TotalEnergies (centre) → continent → pays du siège → association (bulle avec logo).
   Données : donnees.js (généré par 06_scripts/04_donnees_galaxie.py). Dépendance : D3 v7 (copie locale). */
(function () {
  "use strict";
  const D = window.GALAXIE;
  // ?statique : état final sans animation (captures d'écran, vignettes)
  const MOINS_DE_MOUVEMENT = window.matchMedia("(prefers-reduced-motion: reduce)").matches ||
    new URLSearchParams(location.search).has("statique");

  // ---------- Échelles ----------
  // Une seule échelle pour toutes les bulles (associations, continents, total) :
  // surface proportionnelle au milieu de la fourchette (rayon = K·√montant).
  const K = 2; // classe < 50 k€ (milieu 25 k€) → rayon 10
  const rayon = (keur) => K * Math.sqrt(keur);
  const R_CLASSES = D.classes.map((c) => rayon((c.min_keur + c.max_keur) / 2));
  const R_MIN = R_CLASSES[0];
  const rayonAsso = (a) => rayon(a.cout_milieu_keur);
  const R_CENTRE = rayon(d3.sum(D.associations, (a) => a.cout_milieu_keur));
  const LOGO_CENTRE_MAX = 130; // le logo du centre ne grossit pas avec la bulle

  const fmt = (keur) => keur >= 1000
    ? (keur / 1000).toLocaleString("fr-FR", { maximumFractionDigits: 2 }) + " M€"
    : Math.round(keur).toLocaleString("fr-FR") + " k€";
  const fourchette = (min, max) => min === 0 ? "moins de " + fmt(max) : fmt(min) + " à " + fmt(max);
  const fourchetteLongue = (min, max) => min === 0 ? "moins de " + fmt(max) : "entre " + fmt(min) + " et " + fmt(max);

  // ---------- Hiérarchie ----------
  const noeuds = [], liens = [];
  const centre = { id: "centre", type: "centre", nom: D.centre.nom, logo: D.centre.logo, r: R_CENTRE,
    min: D.total.min_keur, max: D.total.max_keur, nb: D.total.nb, profondeur: 0, fx: 0, fy: 0 };
  noeuds.push(centre);

  const parContinent = d3.group(D.associations, (a) => a.continent, (a) => a.pays);
  const somme = (as, k) => d3.sum(as, (a) => a[k]);
  const parMontant = (a, b) => b.milieu - a.milieu;
  const continents = Array.from(parContinent, ([nom, pays]) => {
    const as = Array.from(pays.values()).flat();
    const listePays = Array.from(pays, ([n, l]) => ({ nom: n, as: l.slice().sort((x, y) => y.cout_milieu_keur - x.cout_milieu_keur),
      milieu: somme(l, "cout_milieu_keur") })).sort(parMontant);
    return { nom, pays: listePays, as, milieu: somme(as, "cout_milieu_keur") };
  }).sort(parMontant);

  // ---------- Disposition : chaque continent est une petite galaxie autour de sa bulle ----------
  // TotalEnergies au centre ; l'Europe (de loin le plus gros montant) au-dessus, les autres continents en dessous.
  // Autour de chaque continent, pays puis associations s'étalent en éventail, à l'opposé de TotalEnergies :
  // chaque association occupe sur l'anneau extérieur un arc égal à son diamètre (+ marge).
  const MARGE_ASSO = 10, MARGE_PAYS = 26;
  const polaire = (r, a) => [Math.cos(a) * r, Math.sin(a) * r];
  const autres = continents.slice(1);
  continents[0].dir = -Math.PI / 2;
  autres.forEach((c, i) => { c.dir = Math.PI / 2 + (i - (autres.length - 1) / 2) * Math.min(1.05, 2.6 / Math.max(1, autres.length - 1)); }); // éventail sous TotalEnergies // petits continents bien écartés

  continents.forEach((c, i) => {
    const rc = 22 + 18 * Math.sqrt(c.milieu / continents[0].milieu); // bulles régions : NON proportionnelles (repères)
    c.largeur = d3.sum(c.pays, (p) => MARGE_PAYS + d3.sum(p.as, (a) => 2 * rayonAsso(a) + MARGE_ASSO));
    const ouvertureMax = i === 0 ? 2 * Math.PI * 0.74 : Math.PI * 0.9;
    const ra = Math.max(rc + 155, c.largeur / ouvertureMax);   // anneau des associations
    const rp = Math.max(rc + 45, ra * 0.5);                    // anneau des pays, à mi-chemin
    const dist = R_CENTRE + rc + (i === 0 ? 170 : 120); // place pour l'étiquette Europe
    const [xc, yc] = polaire(dist, c.dir);
    const nc = { id: "c:" + c.nom, type: "continent", nom: c.nom, r: rc, profondeur: 1, parent: centre,
      min: somme(c.as, "cout_min_keur"), max: somme(c.as, "cout_max_keur"), milieu: c.milieu, nb: c.as.length,
      sx: xc, sy: yc, x: xc, y: yc };
    noeuds.push(nc);
    liens.push({ source: centre, target: nc, flux: c.milieu, type: "continent" });

    let s = -c.largeur / 2;
    c.pays.forEach((p) => {
      s += MARGE_PAYS / 2;
      p.as.forEach((a) => { const r = rayonAsso(a); a._ang = c.dir + (s + r + MARGE_ASSO / 2) / ra; s += 2 * r + MARGE_ASSO; });
      s += MARGE_PAYS / 2;
      const [dxp, dyp] = polaire(rp, d3.mean(p.as, (a) => a._ang));
      const np = { id: "p:" + c.nom + ":" + p.nom, type: "pays", nom: p.nom, r: 5, profondeur: 2, parent: nc,
        min: somme(p.as, "cout_min_keur"), max: somme(p.as, "cout_max_keur"), milieu: p.milieu, nb: p.as.length,
        sx: xc + dxp, sy: yc + dyp, x: xc + dxp, y: yc + dyp };
      noeuds.push(np);
      liens.push({ source: nc, target: np, flux: p.milieu, type: "pays" });
      p.as.forEach((a) => {
        const r = rayonAsso(a);
        const [dxa, dya] = polaire(ra + (r - R_MIN) * 0.5, a._ang); // les grosses bulles un peu plus loin
        const na = Object.assign({}, a, { id: "a:" + a.id, type: "asso", r, profondeur: 3, parent: np, ident: a.id,
          sx: xc + dxa, sy: yc + dya, x: xc + dxa, y: yc + dya });
        noeuds.push(na);
        liens.push({ source: np, target: na, flux: a.cout_milieu_keur, type: "asso" });
      });
    });
  });

  const fluxMax = d3.max(liens, (l) => l.flux);
  const epaisseur = (f) => 1 + 13 * Math.sqrt(f / fluxMax);

  // Forces : chaque nœud est rappelé vers sa place ; les collisions écartent les bulles qui se touchent.
  // Relâché après un glisser-déposer, un nœud revient à sa place.
  const sim = d3.forceSimulation(noeuds)
    .force("x", d3.forceX((n) => n.sx || 0).strength(0.25))
    .force("y", d3.forceY((n) => n.sy || 0).strength(0.25))
    .force("collision", d3.forceCollide((n) => n.r + (n.type === "asso" ? 3 : n.type === "pays" ? 6 : 10)).iterations(3))
    .stop();
  for (let i = 0; i < 300; i++) sim.tick();
  noeuds.forEach((n) => { n.cx = n.x; n.cy = n.y; }); // positions finales

  // ---------- SVG ----------
  const svg = d3.select("#carte");
  const scene = document.getElementById("scene");
  const monde = svg.append("g");
  const gLiens = monde.append("g");
  const gNoeuds = monde.append("g");
  const defs = svg.append("defs");

  const selLiens = gLiens.selectAll("line").data(liens).join("line")
    .attr("class", "lien").attr("stroke-width", (l) => epaisseur(l.flux));

  const selNoeuds = gNoeuds.selectAll("g").data(noeuds, (n) => n.id).join("g")
    .attr("class", (n) => ["noeud", n.type, n.te_au_ca ? "ca" : "", n.estimation ? "estimation" : "",
      n.fond_sombre ? "sombre" : ""].join(" "))
    .attr("tabindex", (n) => n.type === "asso" || n.type === "centre" ? 0 : null)
    .attr("role", (n) => n.type === "asso" ? "button" : null)
    .attr("aria-label", (n) => n.type === "asso"
      ? `${n.nom}, ${n.pays} : ${fourchetteLongue(n.cout_min_keur, n.cout_max_keur)} en 2024` : null);

  // centre et associations : disque blanc + logo détouré dans le cercle
  const avecDisque = selNoeuds.filter((n) => n.type === "asso" || n.type === "centre");
  avecDisque.each(function (n) {
    const g = d3.select(this);
    const clipId = "clip-" + n.id.replace(/[^a-z0-9-]/gi, "_");
    defs.append("clipPath").attr("id", clipId).append("circle").attr("r", n.r - 1);
    g.append("circle").attr("class", "disque").attr("r", n.r);
    if (n.logo) {
      const cote = n.type === "centre" ? Math.min(LOGO_CENTRE_MAX, n.r * 1.5) : n.r * 1.42; // carré inscrit (≈ r·√2)
      g.append("image")
        .attr("href", "logos/" + n.logo)
        .attr("x", -cote / 2).attr("y", -cote / 2).attr("width", cote).attr("height", cote)
        .attr("preserveAspectRatio", "xMidYMid meet")
        .attr("clip-path", `url(#${clipId})`);
    } else {
      g.append("text").attr("class", "sigle").attr("text-anchor", "middle").attr("dy", "0.35em")
        .attr("font-size", Math.max(8, Math.min(12, n.r * 0.5))).text(n.sigle);
    }
  });

  selNoeuds.filter((n) => n.type === "continent" || n.type === "pays")
    .append("circle").attr("class", "coeur").attr("r", (n) => n.r);

  // étiquettes : du côté opposé au centre
  selNoeuds.filter((n) => n.type === "continent").each(function (n) {
    const g = d3.select(this);
    const poids = Math.sqrt(n.milieu / continents[0].milieu); // Europe : la plus grosse étiquette
    n.taillesTexte = [13 + 7 * poids, 10 + 4 * poids];
    g.append("text").attr("class", "nom").attr("font-size", n.taillesTexte[0]).text(n.nom.toUpperCase());
    // 2026-11-09 : plus de montant agrégé sous le nom des régions (demande de Sébastien)
  });
  selNoeuds.filter((n) => n.type === "pays").append("text").text((n) => n.nom);
  // régions dessinées en dernier : leurs étiquettes (liseré blanc) passent devant les noms de pays et les bulles
  selNoeuds.filter((n) => n.type === "continent").raise();

  let facteurTexte = 1;
  function placerEtiquettes() {
    // Continents : texte horizontal, côté centre. Pays : texte dans l'axe du rayon, côté centre
    // (l'extérieur est occupé par les associations), retourné sur la moitié gauche pour rester lisible.
    selNoeuds.filter((n) => n.type === "continent").each(function (n) {
      // écart cercle-texte : 12 px à l'écran, même quand les étiquettes sont agrandies (dézoom)
      const a = Math.atan2(n.y, n.x), c = Math.cos(a), sn = Math.sin(a), ecart = n.r + 12 * facteurTexte;
      let ancre, x = 0, dessous = false, dessus = false;
      if (sn < 0) {            // moitié haute : côté centre (l'extérieur est encombré)
        if (c > 0.5) { ancre = "end"; x = -ecart; }
        else if (c < -0.5) { ancre = "start"; x = ecart; }
        else { ancre = "middle"; dessous = true; }
      } else {                 // moitié basse (petits continents) : vers l'extérieur
        // jamais dessous ni vers l'extérieur : c'est là que partent ses pays et associations
        // sur les côtés : au-dessus de la pastille, vers l'extérieur ;
        // pile en bas : à gauche (au-dessus, TotalEnergies ; dessous, ses pays)
        if (Math.abs(c) < 0.2) { ancre = "end"; x = -ecart; }
        else { ancre = c < 0 ? "end" : "start"; x = 0; dessus = true; }
      }
      // dessous : le haut des lettres commence à « ecart » sous le cercle ; dessus : le bas des lettres à « ecart » ;
      // à côté : le nom centré sur la pastille
      const base = n.taillesTexte[0] * facteurTexte;
      d3.select(this).selectAll("text").attr("text-anchor", ancre).attr("x", x)
        .attr("y", dessous ? ecart + 0.75 * base : dessus ? -ecart - 0.25 * base : 0.35 * base)
        .attr("dy", (d, i) => i * 1.25 * (base / (n.taillesTexte[i] * facteurTexte)) + "em");
    });
    selNoeuds.filter((n) => n.type === "pays").select("text").each(function (n) {
      const deg = Math.atan2(n.y - n.parent.y, n.x - n.parent.x) * 180 / Math.PI, droite = Math.abs(deg) <= 90, ecart = n.r + 4;
      d3.select(this).attr("text-anchor", droite ? "end" : "start").attr("x", 0).attr("y", 0).attr("dy", "0.35em")
        .attr("transform", `rotate(${droite ? deg : deg + 180}) translate(${droite ? -ecart : ecart},0)`);
    });
  }

  function dessiner() {
    selLiens.attr("x1", (l) => l.source.x).attr("y1", (l) => l.source.y)
      .attr("x2", (l) => l.target.x).attr("y2", (l) => l.target.y);
    selNoeuds.attr("transform", (n) => `translate(${n.x},${n.y})`);
  }

  // ---------- Zoom (Ctrl/Cmd + molette, pincement, boutons : la page reste défilable) ----------
  const zoom = d3.zoom().scaleExtent([0.1, 6])
    .filter((e) => {
      if (e.type === "wheel") return e.ctrlKey || e.metaKey;
      // tactile : un doigt déplace, deux doigts zooment (la page défile hors du graphique)
      return !e.button;
    })
    .on("zoom", (e) => {
      monde.attr("transform", e.transform);
      // étiquettes des régions : jamais plus petites que 65 % de leur taille à l'écran (petits écrans, dézoom)
      facteurTexte = Math.max(1, 0.55 / e.transform.k);
      selNoeuds.filter((n) => n.type === "continent").selectAll("text")
        .attr("font-size", (d, i) => d.taillesTexte[i] * facteurTexte);
      placerEtiquettes();
    });
  svg.call(zoom).on("dblclick.zoom", null);

  // À l'ouverture (et avec ⟲) : TotalEnergies au centre de la vue, toute la galaxie visible.
  // Emprise de la galaxie (bulles + place pour les étiquettes des régions) ; la scène prend sa hauteur
  // à la largeur disponible : pas de vide sous le graphique. TotalEnergies reste au centre horizontalement.
  const emprise = {
    x0: d3.min(noeuds, (n) => n.cx - n.r) - 70, x1: d3.max(noeuds, (n) => n.cx + n.r) + 70,
    y0: d3.min(noeuds, (n) => n.cy - n.r) - 10, y1: d3.max(noeuds, (n) => n.cy + n.r) + 10,
  };
  const demiLargeur = Math.max(-emprise.x0, emprise.x1);
  function ajusterHauteur() {
    const HAUTEUR_MAX = 620; // ordinateur : la galaxie entière tient sans faire défiler la page
    const l = scene.clientWidth, k = Math.min(1, l / (2 * demiLargeur), HAUTEUR_MAX / (emprise.y1 - emprise.y0));
    scene.style.height = Math.round(Math.max(300, (emprise.y1 - emprise.y0) * k)) + "px";
  }
  ajusterHauteur();
  function cadrage() {
    ajusterHauteur();
    const l = scene.clientWidth, h = scene.clientHeight;
    const k = Math.min(1, l / (2 * demiLargeur), h / (emprise.y1 - emprise.y0));
    return d3.zoomIdentity.translate(l / 2, (h - k * (emprise.y1 - emprise.y0)) / 2 - k * emprise.y0).scale(k);
  }
  const echelleInitiale = cadrage().k;
  const recentrer = (duree) => svg.transition().duration(duree).call(zoom.transform, cadrage());
  document.getElementById("zoom-plus").onclick = () => svg.transition().duration(300).call(zoom.scaleBy, 1.5);
  document.getElementById("zoom-moins").onclick = () => svg.transition().duration(300).call(zoom.scaleBy, 1 / 1.5);
  document.getElementById("zoom-reset").onclick = () => recentrer(500);
  let attente;
  window.addEventListener("resize", () => { clearTimeout(attente); attente = setTimeout(() => recentrer(0), 150); });

  // ---------- Déploiement : chaque niveau jaillit de son parent ----------
  svg.call(zoom.transform, cadrage());
  let deploye = false;
  function finDeploiement() {
    noeuds.forEach((n) => { n.x = n.cx; n.y = n.cy; });
    dessiner(); placerEtiquettes();
    deploye = true;
  }
  if (MOINS_DE_MOUVEMENT) {
    finDeploiement();
  } else {
    const ordre = noeuds.slice().sort((a, b) => a.profondeur - b.profondeur);
    const retard = (n) => n.profondeur === 0 ? 0 : 150 + (n.profondeur - 1) * 450;
    const DUREE = 900;
    noeuds.forEach((n) => { n.x = 0; n.y = 0; });
    placerEtiquettes();
    selNoeuds.attr("opacity", (n) => n.profondeur === 0 ? 1 : 0);
    const t = d3.timer((ecoule) => {
      ordre.forEach((n) => {
        if (!n.parent) return;
        const p = Math.max(0, Math.min(1, (ecoule - retard(n)) / DUREE));
        const e = d3.easeCubicOut(p);
        n.x = n.parent.x + (n.cx - n.parent.cx) * e;
        n.y = n.parent.y + (n.cy - n.parent.cy) * e;
        n._op = Math.min(1, p * 3);
      });
      selNoeuds.attr("opacity", (n) => n.profondeur === 0 ? 1 : n._op);
      selLiens.attr("opacity", (l) => l.target._op);
      dessiner();
      if (ecoule > retard({ profondeur: 3 }) + DUREE) {
        t.stop();
        selNoeuds.attr("opacity", null); selLiens.attr("opacity", null);
        finDeploiement();
      }
    });
  }

  // ---------- Glisser-déposer (simulation relancée doucement) ----------
  sim.on("tick", () => { dessiner(); placerEtiquettes(); });
  selNoeuds.filter((n) => n.type !== "centre").call(d3.drag()
    .filter((e) => deploye && !e.button && e.type !== "touchstart") // au doigt, glisser déplace la vue
    .on("start", (e, n) => { if (!e.active) sim.alphaTarget(0.15).restart(); n.fx = n.x; n.fy = n.y; })
    .on("drag", (e, n) => { n.fx = e.x; n.fy = e.y; })
    .on("end", (e, n) => { if (!e.active) sim.alphaTarget(0); n.fx = null; n.fy = null; }));

  // ---------- Mise en évidence et fiche ----------
  const fiche = document.getElementById("fiche");
  let selection = null;

  function chemin(n) {
    const ids = new Set();
    // vers le centre
    for (let m = n; m; m = m.parent) ids.add(m.id);
    // et toute la descendance (continent ou pays survolé)
    noeuds.forEach((m) => { for (let p = m.parent; p; p = p.parent) if (p === n) ids.add(m.id); });
    return ids;
  }

  function surligner(n) {
    if (!n || n.type === "centre") {
      selNoeuds.classed("attenue", false).classed("actif", false);
      selLiens.classed("attenue", false).classed("actif", false);
      return;
    }
    const ids = chemin(n);
    selNoeuds.classed("attenue", (m) => !ids.has(m.id)).classed("actif", (m) => m === n);
    const dans = (l) => ids.has(l.source.id) && ids.has(l.target.id);
    selLiens.classed("attenue", (l) => !dans(l)).classed("actif", dans);
  }

  const echapper = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  function contenuFiche(n) {
    if (n.type === "asso") {
      const regs = n.regulations.length
        ? (n.regulations.length === 1
          ? `<p class="etiquette">Réglementation visée par son lobbying</p><p>${echapper(n.regulations[0])}</p>`
          : `<p class="etiquette">Réglementations visées par son lobbying</p><ul>${n.regulations.map((r) => `<li>${echapper(r)}</li>`).join("")}</ul>`) : "";
      return `<h3>${echapper(n.nom)}</h3>
        <p class="lieu">Siège : ${echapper(n.pays)} · ${echapper(n.continent)}</p>
        <p class="montant">${fourchette(n.cout_min_keur, n.cout_max_keur)}</p>
        <p class="note">${n.estimation ? "Montant estimé" : "Cotisation 2024 de TotalEnergies, fourchette publiée par le groupe"}</p>
        ${regs}
        <p><a href="${echapper(n.site)}" target="_blank" rel="noopener">Site de l'association ↗</a></p>`;
    }
    // Bulle TotalEnergies : chiffre de l'article (somme des fourchettes publiées par TotalEnergies, 5,65–10,59 M€,
    // script 01), et non la somme des classes de la galaxie (4,85–10,95 M€).
    if (n.type === "centre") {
      return `<h3>${echapper(n.nom)}</h3>
      <p class="montant">Entre 5,6 et 10,6 millions d'euros</p>
      <p>de frais d'adhésion en 2024</p>
      <p>${n.nb} associations</p>`;
    }
    const quoi = n.type === "centre" ? "Total des cotisations 2024" : n.type === "continent" ? "Cotisations 2024" : "Cotisations 2024 · pays du siège";
    return `<h3>${echapper(n.nom)}</h3>
      ${n.type === "continent" ? "" : `<p class="lieu">${quoi}</p>
      <p class="montant">${fourchette(n.min, n.max)}</p>`}
      <p>${n.nb} association${n.nb > 1 ? "s" : ""}</p>
      ${n.nom.startsWith("Belgique") ? '<p class="note">Bruxelles accueille les fédérations européennes : leur lobbying vise surtout les institutions de l\'UE.</p>' : ""}`;
  }

  function montrerFiche(n, evt) {
    fiche.innerHTML = (selection ? '<button type="button" class="fermer" aria-label="Fermer">×</button>' : "") + contenuFiche(n);
    fiche.hidden = false;
    const b = fiche.querySelector(".fermer");
    if (b) b.onclick = () => deselectionner();
    if (window.innerWidth <= 560) return; // en bas de la scène (CSS)
    const rect = scene.getBoundingClientRect();
    let x, y;
    if (evt && evt.clientX !== undefined) { x = evt.clientX - rect.left; y = evt.clientY - rect.top; }
    else { const t = d3.zoomTransform(svg.node()); x = t.applyX(n.x); y = t.applyY(n.y); }
    const lf = fiche.offsetWidth, hf = fiche.offsetHeight;
    let gauche = x + 16, haut = y - hf / 2;
    if (gauche + lf > rect.width) gauche = x - lf - 16;
    gauche = Math.max(0, gauche);
    haut = Math.max(0, Math.min(haut, rect.height - hf));
    fiche.style.left = gauche + "px"; fiche.style.top = haut + "px";
  }

  function cacherFiche() { if (!selection) { fiche.hidden = true; } }
  function deselectionner() { selection = null; fiche.hidden = true; surligner(null); }

  selNoeuds
    .on("pointerenter", (e, n) => {
      if (!deploye || selection || e.pointerType === "touch") return;
      surligner(n); montrerFiche(n, e);
    })
    .on("pointermove", (e, n) => { if (!selection && e.pointerType !== "touch" && !fiche.hidden) montrerFiche(n, e); })
    .on("pointerleave", (e) => { if (!selection && e.pointerType !== "touch") { surligner(null); cacherFiche(); } })
    .on("click", (e, n) => {
      if (!deploye) return;
      e.stopPropagation();
      if (selection === n) { deselectionner(); return; }
      selection = n; surligner(n); montrerFiche(n, e);
    })
    .on("keydown", (e, n) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); selection = n; surligner(n); montrerFiche(n); }
      if (e.key === "Escape") deselectionner();
    })
    .on("focus", (e, n) => { if (!selection) { surligner(n); montrerFiche(n); } })
    .on("blur", () => { if (!selection) { surligner(null); cacherFiche(); } });
  svg.on("click", () => deselectionner());
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") deselectionner(); });

  // ---------- Légende des tailles ----------
  (function legende() {
    // Trois classes côte à côte (la plus basse, celle du milieu, la plus haute), à l'échelle de l'affichage
    // d'ouverture ; libellés tirés des données
    const g = d3.select("#legende-tailles");
    const k = echelleInitiale;
    const nb = (v) => v.toLocaleString("fr-FR");
    const libelles = D.classes.map((c) => c.min_keur === 0 ? "moins de " + nb(c.max_keur) : nb(c.min_keur) + " à " + nb(c.max_keur));
    const bas = 20 + 2 * R_CLASSES[R_CLASSES.length - 1] * k;
    g.append("text").attr("x", 0).attr("y", 9).attr("class", "titre").text("Cotisation 2024, en milliers d'euros");
    let x = 0;
    const n = R_CLASSES.length;
    [0, Math.floor((n - 1) / 2), n - 1].forEach((i) => {
      const rr = R_CLASSES[i] * k;
      const t = g.append("text").attr("y", bas + 13).attr("text-anchor", "middle").text(libelles[i]);
      const larg = Math.max(2 * rr, t.node().getComputedTextLength() || 50) + 8;
      t.attr("x", x + larg / 2);
      g.append("circle").attr("cx", x + larg / 2).attr("cy", bas - rr).attr("r", rr).attr("fill", "none").attr("stroke", "#888");
      x += larg;
    });
    g.attr("width", Math.ceil(Math.max(x, 220))).attr("height", Math.ceil(bas + 17));
  })();

  // ---------- Hauteur automatique de l'iframe (même message que les autres cartes de Vert) ----------
  // La page envoie sa hauteur à l'article ({ type: "vert-carte-hauteur", h }) ; le script d'intégration ajuste l'iframe.
  if (window.parent !== window) {
    const bloc = document.getElementById("galaxie");
    let hEnvoyee = 0;
    const envoyerHauteur = () => {
      const h = Math.ceil(bloc.getBoundingClientRect().bottom + window.scrollY) + 2;
      if (h && h !== hEnvoyee) { hEnvoyee = h; window.parent.postMessage({ type: "vert-carte-hauteur", h }, "*"); }
    };
    new ResizeObserver(envoyerHauteur).observe(bloc);
    addEventListener("load", envoyerHauteur);
    envoyerHauteur();
  }
})();
