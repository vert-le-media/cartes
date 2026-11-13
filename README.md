# Cartes interactives de Vert

Cartes publiées sur GitHub Pages et intégrées par iframe dans les articles de [vert.eco](https://vert.eco).
Une carte par sous-dossier. Les pages ne sont pas indexées par les moteurs de recherche (`noindex`).

## data-centers

Data center en France : sites existants, projets et mobilisations.

- Page : https://vert-le-media.github.io/cartes/data-centers/
- Source : Le Nuage était sous nos pieds (carte collaborative), d'après OpenStreetMap (ODbL) pour les data center existants.
- Fichiers générés par `2026-10_data-centers/06_scripts/02_carte_interactive.py` puis copiés par `03_copier_depot_github.py` : ne pas les modifier ici.

Code d'intégration (bloc HTML personnalisé dans WordPress) :

```html
<iframe src="https://vert-le-media.github.io/cartes/data-centers/" title="Carte des data centers en France" width="100%" height="1000" style="border:0; max-width:100%;" loading="lazy"> </iframe>
<script>
/* hauteur automatique : la carte envoie sa hauteur, l'iframe s'ajuste (sans ce script : hauteur fixe de 1000 px) */
addEventListener("message", function (e) {
  if (e.origin !== "https://vert-le-media.github.io" || !e.data || e.data.type !== "vert-carte-hauteur") return;
  document.querySelectorAll("iframe").forEach(function (f) { if (f.contentWindow === e.source) f.style.height = e.data.h + "px"; });
});
</script>
```

Le script est commun à toutes les cartes de ce dépôt : une seule fois par article suffit, même avec plusieurs cartes.

## nappes

État des nappes souterraines en France métropolitaine, mois par mois (carte animée, glissière temporelle).

- Page : https://vert-le-media.github.io/cartes/nappes/
- Source : BRGM, MétéEAU Nappes (indicateur piézométrique standardisé, bulletins mensuels de situation hydrogéologique).
- Mise à jour mensuelle : `2026-11_nappes-brgm/06_scripts/01_telecharger_bsh.py`, `02_preparer_indicateurs.py`,
  puis copie par `04_copier_depot_github.py` : ne pas modifier les fichiers ici.

Code d'intégration (bloc HTML personnalisé dans WordPress ; ajouter le script de hauteur ci-dessus s'il n'est pas déjà dans l'article) :

```html
<iframe src="https://vert-le-media.github.io/cartes/nappes/" title="Carte de l'état des nappes souterraines en France" width="100%" height="1000" style="border:0; max-width:100%;" loading="lazy"> </iframe>
```

## galaxie-totalenergies

Les lobbies financés par TotalEnergies qui attaquent les réglementations sur le méthane (galaxie interactive : TotalEnergies →
région → pays du siège → associations professionnelles, taille des bulles selon la tranche de cotisation 2024).

- Page : https://vert-le-media.github.io/cartes/galaxie-totalenergies/
- Source : Analyse de Vert & DeSmog, montant des adhésions estimé sur la base de déclarations de TotalEnergies.
- Fichiers générés par `2026-11_enquete-toto/06_scripts/04_donnees_galaxie.py` (données) et copiés depuis
  `2026-11_enquete-toto/03_espace-de-travail/galaxie/` : ne pas les modifier ici.

Code d'intégration (bloc HTML personnalisé dans WordPress ; ajouter le script de hauteur ci-dessus s'il n'est pas déjà dans l'article) :

```html
<iframe src="https://vert-le-media.github.io/cartes/galaxie-totalenergies/" title="Les lobbies financés par TotalEnergies qui attaquent les réglementations sur le méthane" width="100%" height="1000" style="border:0; max-width:100%;" loading="lazy"> </iframe>
```

## jets-cop31

Jets privés arrivés à Antalya pendant la COP31 (globe interactif : un trait par jet, de l'aéroport de départ à Antalya).

- Page : https://vert-le-media.github.io/cartes/jets-cop31/
- Source : PolluterJets (The Stats Guy), d'après les signaux ADS-B d'opendata.adsb.fi.
- Fichier autonome (données, contours et logo embarqués), généré dans le projet `2026-11_cop31-jets-prives`
  (dépôt privé `vert-le-media/jets-cop31`) par `03_injecte_globe.py`, puis copié par `04_copier_depot_github.py` : ne pas le modifier ici.
- Mise à jour pendant la COP : `01_telecharge_polluterjets.py`, `02_prepare_donnees.py`, `03_injecte_globe.py`, `04_copier_depot_github.py`, puis commit + push.

Code d'intégration (bloc HTML personnalisé dans WordPress ; ajouter le script de hauteur ci-dessus s'il n'est pas déjà dans l'article) :

```html
<iframe src="https://vert-le-media.github.io/cartes/jets-cop31/" title="Globe des jets privés arrivés à Antalya pendant la COP31" width="100%" height="900" style="border:0; max-width:100%;" loading="lazy"> </iframe>
```
