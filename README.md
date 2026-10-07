# Tarkov Tracker

Compagnon pour Escape from Tarkov : position en direct sur la carte, suivi de quêtes synchronisé avec les logs du jeu,
et base de données des objets, conteneurs et loot au sol. Conçu pour peser le moins possible à côté de Tarkov.

## Fonctions

**Quêtes : suivi dynamique et complet**
- **En direct** : dès que tu démarres, termines ou rates une quête en jeu, l'app le voit (via `notifications_000.log`), met la quête à jour,
  coche ses objectifs et te prévient (« Quête terminée : … »).
- **Rattrapage** : à chaque lancement (et avec le bouton *Resynchroniser*), l'app relit tous les logs que le jeu a gardés et remet tes
  quêtes là où tu en es, même si tu n'as pas ouvert l'app depuis longtemps. Les évènements sont rejoués dans l'ordre chronologique.
- **Déduction** : une quête commencée ou terminée implique que ses prérequis sont terminés. Si le jeu n'a gardé aucun log ancien, tout
  l'arbre en amont est déduit automatiquement (marqué « déduite »). Un vrai évènement de log remplace toujours une déduction.
- **Tes réglages manuels sont protégés** : un évènement de log plus ancien que ton dernier réglage ne le défait jamais.
- Tableau de bord (progression, Kappa, à faire maintenant, prochaines quêtes, activité récente), onglets par marchand, puces de statut avec
  compteurs, filtres (map, Kappa, recherche), **niveau** (les quêtes trop avancées passent en « verrouillées », avec la raison affichée).
- Objectifs cochables ; « Voir sur la carte » isole une quête sur sa carte.

**Carte**
- Position et orientation du joueur à chaque capture d'écran (seul le nom du fichier est lu).
- **Suivi du joueur** (touche F) : activé, la carte se recentre sur toi à chaque capture ; désactivé, elle ne bouge jamais toute seule.
  « Centrer sur moi » marche dans les deux cas. Le choix est mémorisé.
- Détection automatique de la map via les logs (launcher BSG ou Steam). La pastille à côté de la liste dit où on en est et se clique pour corriger.
- Calques : extractions, transits, apparitions, conteneurs (filtrables par type), loot au sol, armes fixes, objectifs de tes quêtes en cours.
- Recherche d'un objet : met en évidence tous ses emplacements de loot au sol. Boss et probabilités.

**Objets**
- Tous les objets (liste fluide même avec des milliers de lignes), recherche, catégorie, tri par prix.
- **Liste de courses** : « Utiles à mes quêtes en cours » indique combien en trouver (× 3 FIR), en comptant « trouver puis remettre » une seule fois.
- Quêtes qui utilisent l'objet, cartes où il apparaît au sol.

**Confort**
- Barre de navigation en bas, comme dans le jeu, avec badges : vert = quêtes en cours, gris = objets à trouver.
- Raccourcis : `1` `2` `3` changent d'onglet, `F` active/désactive le suivi, `/` place le curseur dans la recherche.
- Notifications vertes (information) et orange (attention). Réglages et diagnostic en un clic (roue dentée).

## Lancer

Prérequis (Windows 10/11) : [Rust](https://rustup.rs) >= 1.90, [Node.js](https://nodejs.org),
WebView2 (déjà présent sur Windows 11 et la plupart des Windows 10), Visual Studio Build Tools (charge « C++ »).

```
npm install
npm run dev        # lancer en développement
npm run build      # installeur dans src-tauri/target/release/bundle
npm test           # tests Rust + calibration + interface + synchro des quêtes
npm run maps       # re-télécharge les cartes et la calibration (python3 requis)
```

## Si la synchro des quêtes ne marche pas

Ouvre l'onglet **Quêtes** : le bandeau du haut dit où on en est (synchronisé, logs introuvables, aucun évènement…). Puis **Réglages > Diagnostic de
la détection > Lancer le diagnostic** : il indique où sont tes logs, combien de fichiers de notifications existent et combien d'évènements de
quête y sont lus. Si c'est 0 alors que tu as joué des quêtes, clique sur **Copier** et envoie-moi le résultat avec quelques lignes de ton fichier
`…notifications_000.log` autour d'une quête terminée.

Bug corrigé en v0.5 : les versions récentes du jeu nomment le fichier `notifications_000.log` (avec un suffixe de rotation) et l'app ne reconnaissait
que `notifications.log`. Les suffixes `_000`, `_001`… sont désormais acceptés pour tous les fichiers de logs.

Limites connues : le jeu ne garde qu'un nombre limité de sessions de logs, donc l'historique est partiel pour un compte ancien (la déduction des
prérequis comble le reste). Les logs ne distinguent pas toujours un profil PvP d'un profil PvE : si tu joues les deux, les quêtes des deux se mélangent.
La progression *à l'intérieur* d'une quête (« 3 / 7 éliminés ») n'est pas dans les logs : elle se coche à la main.

## Si la map ne se détecte pas

Même diagnostic (**Réglages**). Causes les plus courantes :
- **Dossier des logs introuvable** : colle-le dans Réglages. Avec Steam c'est en général `…\steamapps\common\Escape from Tarkov\build\Logs`.
  L'app cherche aussi via le registre, les bibliothèques Steam et les emplacements habituels du launcher (`Logs` et `build\Logs`).
- **Aucune ligne de map dans le log** : elle apparaît au chargement d'un raid. Lance une partie puis relance le diagnostic.
- **Map inconnue** : le diagnostic affiche son identifiant, envoie-le moi.

Les logs sont surveillés par les notifications de Windows **et** relus toutes les 1,5 s (deux appels système par fichier, aucune lecture tant que
la taille n'a pas changé) : Windows ne prévient pas toujours quand le jeu ajoute des lignes à un fichier qu'il garde ouvert.

## D'où viennent les données

Les quêtes, objets, cartes, extractions, conteneurs et loot au sol viennent de **json.tarkov.dev**, les fichiers JSON qui alimentent le
site tarkov.dev. L'ancienne API GraphQL (api.tarkov.dev) est hors service depuis juillet et n'est plus utilisée. Les fichiers sont gros
(cartes ~9,5 Mo, objets ~17 Mo) : l'app les lit en flux, les réduit à ce dont elle a besoin et ne garde que ce résumé sur le disque. Les textes sont
des clés de traduction, résolues avec les fichiers `_fr` (ou `_en` si la langue manque).

Au premier lancement le téléchargement prend quelques secondes à quelques dizaines de secondes. Ensuite l'app fonctionne hors-ligne et se
rafraîchit au plus une fois par jour, ou à la demande (icône de rafraîchissement en bas à droite). Si le téléchargement échoue, l'app affiche l'erreur
exacte, réessaie après 5, 10, 20 puis 30 minutes, et garde les anciennes données de la partie en échec. Le diagnostic affiche des statistiques sur les
données (quêtes avec marchand, conteneurs nommés, catégories d'objets…) pour repérer un champ mal lu.

## À vérifier à la première utilisation

Le code est testé (Rust, interface, synchro), mais je n'ai pas pu lancer Tarkov ni télécharger les vrais fichiers de données.

1. **Structure des fichiers json.tarkov.dev** : déduite de projets qui les lisent pour de vrai, avec une conversion tolérante (champ absent ou
   inattendu = ignoré). Surveille dans le diagnostic : les **conteneurs nommés** (sinon « Conteneur 5789… », mais filtrables), les **catégories
   d'objets** et les **quêtes avec marchand**. S'il y a un 0 suspect, envoie-moi le diagnostic.
2. **Format de `notifications_000.log`** : type 10/11/12 et identifiant de quête au début de `templateId`, d'après TarkovMonitor.
3. **Identifiants de map** marqués `(?)` dans `crates/core/src/maps.rs` (Labyrinth, Terminal, Icebreaker).
4. **Étages** : la hauteur est lue mais pas encore utilisée.

## Architecture

```
crates/core/   Rust pur, sans Tauri : captures, logs (map + quêtes), conversion des données, diagnostic (testé)
src-tauri/     Coque Tauri : relaie les évènements, télécharge et met en cache les données, relit les logs à la demande
ui/            HTML/JS sans bundler ni framework, Leaflet embarqué
  store.js     données, progression des quêtes, synchro, déduction, statistiques
  mapview.js   carte, suivi, calques      quests.js  onglet quêtes      items.js  onglet objets (liste virtualisée)
  demo/        jeu de données fictif pour prévisualiser l'interface dans un navigateur
tools/         préparation des cartes
tests/         calibration, interface, panne du serveur, synchro des quêtes (jsdom, faux Tauri)
```

Aucun polling pour les captures : le watcher s'appuie sur les notifications du système de fichiers. L'interface ne redessine que lorsqu'un
évènement arrive ; les calques lourds (loot au sol, conteneurs) ne sont construits que lorsque tu les actives.

## Style

L'interface reprend le langage visuel des menus du jeu, avec les couleurs relevées sur des captures : fond vert-noir, texte crème `#eae8d9`, barre de
navigation noire en bas, onglet actif crème, badge vert lime, bandeau orange pour les alertes. Aucun asset de Battlestate Games n'est utilisé. La
police du jeu (Bender) est propriétaire : l'app embarque **Chakra Petch** (SIL OFL), la plus proche parmi les polices libres. Tout est dans
`ui/style.css` (variables de couleur en tête de fichier).
