# Crédits et licences

| Élément | Source | Licence |
|---|---|---|
| Calibration des cartes (`transform`, `coordinateRotation`, `bounds`) et convention de projection | [the-hideout/tarkov-dev](https://github.com/the-hideout/tarkov-dev) | MIT |
| Cartes SVG (`ui/maps/*.svg`, générées par `tools/prepare_maps.py`) | [the-hideout/tarkov-dev-svg-maps](https://github.com/the-hideout/tarkov-dev-svg-maps), auteurs listés dans ce dépôt | **CC BY-NC-SA 4.0** : usage non commercial, attribution, partage dans les mêmes conditions |
| Données de jeu (quêtes, objets, cartes, loot) | [json.tarkov.dev](https://json.tarkov.dev/endpoints), téléchargées à l'usage et mises en cache localement | Voir les conditions de tarkov.dev ; ne pas redistribuer le cache |
| Police Chakra Petch (`ui/fonts`) | [Chakra Petch Project Authors](https://github.com/m4rc1e/Chakra-Petch) | SIL OFL 1.1 (`ui/fonts/OFL.txt`) |
| Leaflet 1.9.4 | https://leafletjs.com | BSD-2-Clause (`ui/vendor/LEAFLET-LICENSE.txt`) |
| Formats de logs et de captures d'écran | Observés dans le code de [TarkovMonitor](https://github.com/the-hideout/TarkovMonitor) (GPL-3.0) | Aucun code n'a été copié ; seuls les formats (des faits) ont servi de référence |

## Attention : les cartes SVG

Le dépôt des cartes interdit explicitement leur usage dans tout logiciel facilitant la triche
(radars en jeu, overlays ESP, bots...). Cette app ne lit que des fichiers écrits par le jeu
(logs et captures d'écran). Garde-la ainsi. Si tu veux distribuer ou monétiser l'app,
il faudra d'autres cartes ou l'accord des auteurs.

Projet indépendant, non affilié à Battlestate Games.
