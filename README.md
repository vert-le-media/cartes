# Cartes interactives de Vert

Cartes publiées sur GitHub Pages et intégrées par iframe dans les articles de [vert.eco](https://vert.eco).
Une carte par sous-dossier. Les pages ne sont pas indexées par les moteurs de recherche (`noindex`).

## data-centers

Data center en France : sites existants, projets et mobilisations.

- Page : https://infographievert.github.io/cartes/data-centers/
- Source : Le Nuage était sous nos pieds (carte collaborative), d'après OpenStreetMap (ODbL) pour les data center existants.
- Fichiers générés par `2026-10_data-centers/06_scripts/02_carte_interactive.py` puis copiés par `03_copier_depot_github.py` : ne pas les modifier ici.

Code d'intégration (bloc HTML personnalisé dans WordPress) :

```html
<iframe src="https://infographievert.github.io/cartes/data-centers/" title="Carte des data centers en France" width="100%" height="1000" style="border:0; max-width:100%;" loading="lazy"> </iframe>
<script>
/* hauteur automatique : la carte envoie sa hauteur, l'iframe s'ajuste (sans ce script : hauteur fixe de 1000 px) */
addEventListener("message", function (e) {
  if (e.origin !== "https://infographievert.github.io" || !e.data || e.data.type !== "vert-carte-hauteur") return;
  document.querySelectorAll("iframe").forEach(function (f) { if (f.contentWindow === e.source) f.style.height = e.data.h + "px"; });
});
</script>
```

Le script est commun à toutes les cartes de ce dépôt : une seule fois par article suffit, même avec plusieurs cartes.
