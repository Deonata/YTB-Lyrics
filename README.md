# YTM Lyrics PiP

Paroles synchronisées en Picture-in-Picture pour **YouTube Music Desktop App**
([ytmdesktop/ytmdesktop](https://github.com/ytmdesktop/ytmdesktop)).

Une petite fenêtre sans cadre, toujours au-dessus des autres, qui affiche la ligne
en cours du morceau joué dans YTMDesktop, avec remplissage progressif façon karaoké.

## Sources de lecture

| Source | Transport | Sync | Contrôles |
| --- | --- | --- | --- |
| **YouTube Music Desktop** | Socket.IO, poussé | ~1 push/s | Oui |
| **Spotify** | API Web, sondée | ~1 requête/s en lecture, 1/5 s en pause | Premium seulement |

Spotify n'expose rien en local : la connexion passe par son API Web en OAuth
**PKCE** (aucun secret client, rien de sensible dans l'exécutable). Chaque
utilisateur doit enregistrer une application gratuite sur le
[tableau de bord Spotify](https://developer.spotify.com/dashboard), y déclarer
l'URI de redirection `http://127.0.0.1:8888/callback`, et coller le Client ID dans
les réglages. Le sondage recule automatiquement sur un `429`, en respectant
l'en-tête `Retry-After`.

La synchronisation est un peu moins fine qu'avec YTMDesktop — sondage plutôt que
push, plus la latence réseau. L'horloge locale lisse l'essentiel.

## Pourquoi une app compagnon et pas un plugin

ytmdesktop **n'a pas de système de plugins**. En revanche, il expose un
*Companion Server* (REST + Socket.IO) conçu pour les intégrations tierces. Ce projet
est donc une application Electron autonome qui s'y connecte : rien à modifier ni à
patcher dans YTMDesktop.

## Fonctionnement

```
YTMDesktop ──Companion Server──> app compagnon ──> fenêtre PiP always-on-top
 (état du     socket.io              │
  lecteur)    "state-update"         └──> LRCLIB (paroles .lrc horodatées)
```

Le serveur ne pousse la progression qu'environ **une fois par seconde**, ce qui est
trop grossier pour surligner ligne par ligne. Le renderer maintient donc une horloge
locale (ancre + `performance.now()`), recalée en douceur (30 % de l'écart) à chaque
mise à jour et resynchronisée sèchement en cas de saut réel (seek, changement de
morceau, dérive > 1,2 s).

### Remplissage mot par mot

Chaque mot est un `<span>` distinct et porte sa propre progression. Un dégradé
`background-clip: text` posé sur la ligne entière serait calculé sur sa boîte : dès
qu'une ligne revient à la ligne, toutes les rangées rejoueraient le même dégradé
horizontal et se rempliraient simultanément.

Quand la source fournit des timings mot-à-mot — LRC *enhanced* (`<mm:ss.xx>`) ou
`yrc` de NetEase — ils sont utilisés tels quels. Le pied de la fenêtre indique
« horodaté au mot » ou « mots estimés », pour savoir quand la précision est réelle.

Sinon, la durée de la ligne est répartie entre les mots au prorata de leur nombre de
caractères. La borne de temps retenue est **l'écart jusqu'à la ligne suivante**,
seule limite sûre : c'est là que la ligne cesse d'être chantée. On ne s'arrête avant
que si cet écart dépasse le double d'une durée de chant plausible — signe qu'un
passage instrumental suit.

`scripts/calibrer-debit.mjs` (`npm run calibrer`) mesure la cadence de chant sur de
vraies paroles synchronisées : sur 401 intervalles, médiane **11,8 caractères/s**,
1er quartile 7,9. Cette mesure ne retient que les écarts courts, donc elle décrit les
passages rapides — c'est une borne haute, d'où le facteur 2 avant de conclure à un
silence. Prendre systématiquement le minimum entre écart et estimation, comme dans
une version antérieure, revenait à supposer le débit rapide partout : le remplissage
terminait avant la voix sur toute ligne chantée posément.

Les passages instrumentaux (lignes vides du LRC) affichent `♪ ♪ ♪`, eux aussi rendus
comme des mots pour qu'ils se remplissent. Ceux-là s'étirent en revanche sur **tout**
l'écart : c'est ce qui signale que le morceau avance pendant le silence.

## Prérequis

- Node.js 20+ et npm
- YouTube Music Desktop App **v2+**

## Installation

```bash
npm install
npm start
```

## Appairage (une seule fois)

1. Dans **YTMDesktop** → `Settings` → `Integrations` :
   - active **Companion Server** ;
   - active **Enable companion authorization** (juste avant d'appairer — YTMDesktop
     le redésactive ensuite, c'est normal).
2. Dans la fenêtre de réglages de l'app, clique **Appairer**.
3. Un code s'affiche des deux côtés : vérifie qu'ils correspondent, puis autorise
   dans YTMDesktop. Tu as 30 secondes.

Le jeton est stocké dans `%APPDATA%/ytm-lyrics-pip/config.json`.

## Utilisation

| Action | Comment |
| --- | --- |
| Déplacer la fenêtre | Glisser n'importe où sur la carte |
| Redimensionner | Poignée en bas à droite (visible au survol) |
| Lecture / pause | `Espace`, ou les boutons au survol |
| Ajuster la synchro | `[` et `]` (±100 ms), ou les boutons `−` / `+` — porte sur le **morceau courant** |
| Réinitialiser ce morceau | Clic sur la valeur de décalage affichée dans la barre |
| Masquer | `Échap`, le bouton `✕`, ou clic sur l'icône du tray |
| Passe-clic | Menu du tray → *Verrouiller* (la fenêtre n'intercepte plus les clics) |
| Réglages | Menu du tray → *Réglages*, ou le bouton `⚙` |

## Décalage : global et par morceau

Deux réglages distincts, parce que deux problèmes distincts se cachent derrière un
même symptôme :

- le **décalage global** (fenêtre de réglages) corrige une latence constante de ta
  configuration et s'applique partout ;
- le **décalage par morceau** (`[` / `]` dans la PiP) corrige une version précise —
  typiquement un clip dont l'intro décale tout — et n'est mémorisé que pour ce
  `videoId`.

Les deux se cumulent. La valeur affichée dans la barre passe à la couleur d'accent
quand une correction propre au morceau est active ; un clic dessus la remet à zéro.
Les 400 derniers morceaux ajustés sont conservés, les plus anciens sont oubliés.

## Apparence

La fenêtre de réglages est organisée en onglets, avec application immédiate de
chaque changement.

**Thèmes** — huit préréglages qui remplissent couleurs, police et cadre d'un coup :
Minimal, Néon, Sakura, Cyberpunk, Rétro CRT, Minuit, Vinyle, Papier. Tout reste
modifiable ensuite.

**Cadres** — sept statiques (aucun, liseré fin, lueur néon, double filet, équerres,
ruban, scanlines) et quatre animés, chacun étiqueté avec son coût dans l'interface :

| Cadre animé | Coût | Pourquoi |
| --- | --- | --- |
| Lueur pulsée | très léger | N'anime que `opacity` : entièrement pris en charge par le compositeur |
| Scanlines défilantes | très léger | N'anime que `transform` |
| Pétales | léger | Huit éléments, `transform` et `opacity` uniquement, créés seulement si ce cadre est choisi |
| Balayage rotatif | modéré | Repeint un dégradé conique ; cadencé par `steps(40)`, soit 8 repeints/s au lieu de 60 |

Les animations s'arrêtent quand la fenêtre est masquée et sont désactivées si le
système est réglé sur « animations réduites ».

**Texte & couleurs** — taille, police, graisse, alignement, couleurs d'accent, de
texte et de fond, opacité du fond, opacité des lignes secondaires, rayon des coins.

**Fenêtre** — quels éléments montrer au survol. Les boutons ⚙ et ✕ ne sont
volontairement pas masquables : ils sont le seul chemin de retour vers les réglages.

Sous le capot, chaque réglage est une variable CSS réécrite par `applySettings()` ;
les couleurs sont converties en triplets `R, G, B` pour rester utilisables dans les
`rgba()` du thème.

## Économie de ressources

La boucle de rendu ne fait qu'une chose par frame : écrire la progression d'un seul
mot. Rien de décoratif n'y entre — cadres, dégradés et halos sont peints une fois.
S'y ajoutent quatre mesures :

- **escamotage pendant les pauses** (activé par défaut, délai réglable) : la fenêtre
  disparaît en fondu après quelques secondes de pause et revient à la reprise. C'est
  l'économie la plus franche, puisqu'une fenêtre masquée ne rend plus rien du tout —
  boucle d'animation et cadres animés compris ;
- **en pause**, tant que la fenêtre est encore là, l'horloge est figée : la boucle
  détecte que rien ne peut avoir changé et rend la main immédiatement ;
- **fenêtre masquée**, la boucle est annulée puis relancée à la réapparition ;
- la progression est **arrondie au dixième de pour-cent** avant écriture, pour ne pas
  réécrire un style identique — ce qui déclencherait quand même un recalcul.

L'escamotage est piloté depuis le processus principal : les minuteries d'un renderer
masqué sont bridées par Chromium, pas celles du main. Sa machine à états distingue
« masquée par nous » de « masquée par l'utilisateur » — seule la première autorise un
retour automatique — et fait l'objet d'une table de vérité dans
`scripts/test-autohide.cjs`. Les publicités comptent comme de la lecture : escamoter
la fenêtre pour quelques secondes ferait clignoter l'affichage.

## Sources des paroles

**[LRCLIB](https://lrclib.net)** d'abord — catalogue ouvert, sans clé d'API,
métadonnées propres. **[NetEase](https://music.163.com)** en appoint : nettement
meilleure couverture sur le japonais, le coréen et le chinois, et fournit parfois du
`yrc`, horodaté **au mot**, qui alimente directement le rendu mot-à-mot.

> L'API NetEase n'est pas officielle : elle peut changer ou être restreinte. Elle est
> traitée en appoint — toute erreur se solde par « pas de résultat », jamais par un
> échec de la recherche.

La recherche essaie plusieurs stratégies : correspondance exacte
artiste/titre/album/durée, puis titre nettoyé (suffixes `(Official Video)`,
`(Remastered 2011)`…, chaînes `- Topic`), puis recherche floue.

Le drapeau « instrumental » de LRCLIB est contributif et se trompe : il n'est retenu
comme verdict qu'après avoir consulté **toutes** les sources. Les lignes de crédits
que NetEase horodate en tête de fichier (`作曲 : …`, `Produced by : …`) sont écartées,
sans quoi elles s'afficheraient comme les premières paroles.

Tous ces chemins passent ensuite par un **filtre d'acceptation** commun, qui exige
une ressemblance suffisante sur l'artiste *et* sur le titre. Sans ce filtre, la
requête de repli par titre seul ramène volontiers l'homonyme d'un autre interprète :
des paroles parfaitement synchronisées, mais celles d'un autre morceau.

### Clip contre audio

La tolérance sur la durée est **modulée**, car un même morceau ne dure pas pareil en
clip et en audio (intro, outro, passages parlés) :

| Correspondance artiste + titre | Écart de durée toléré |
| --- | --- |
| Nette (≥ 0,85 sur les deux) | 45 s — c'est une autre *version* du bon morceau |
| Approximative | 10 s — le doute porte sur l'identité du morceau |

Le Companion Server n'expose pas de quoi distinguer les deux : `videoType` est
documenté sur le wiki mais absent de la réponse réelle de l'API. D'où cette
heuristique fondée sur la solidité de la correspondance.

Quand la version retenue diffère de plus de 12 s, le pied de la fenêtre PiP l'indique
(`autre version (+29 s)`) : les paroles sont les bonnes, mais leur horodatage vient de
l'autre version et le décalage est à ajuster avec `[` et `]`. C'est aussi pourquoi la
plage de décalage va jusqu'à ±30 s.

### Cache auto-entretenu

Les résultats sont mis en cache dans `%APPDATA%/ytm-lyrics-pip/lyrics-cache/`.
L'entretien est automatique, au démarrage :

- chaque entrée porte la **version de la logique de recherche** qui l'a produite ;
  quand cette logique évolue, les entrées périmées sont supprimées et les paroles
  retéléchargées. Sans cela, une mauvaise correspondance mise en cache resterait
  servie indéfiniment, même après correction du filtrage ;
- les « pas de paroles » sont réessayés après 24 h ;
- au-delà de 1200 fichiers ou 24 Mo, les plus anciennes entrées sautent.

Le bouton « Vider le cache » ne sert donc qu'à forcer une reprise immédiate.

> **Limite connue :** le Companion Server n'expose **aucun endpoint de paroles**. Les
> paroles natives de YouTube Music sont donc inaccessibles depuis une application
> externe. Quand LRCLIB n'a pas de version synchronisée, l'app bascule sur le texte
> brut, défilant proportionnellement à l'avancement du morceau.

## Scripts

| Commande | Effet |
| --- | --- |
| `npm start` | Compile et lance l'application |
| `npm run build` | Compile TypeScript → `dist/` |
| `npm run watch` | Compilation en continu |
| `npm test` | Vérifie le parser LRC et la recherche LRCLIB (accès réseau) |
| `npm run preview` | Capture le rendu de la PiP dans `preview/`, sans YTMDesktop |
| `npm run icon` | Régénère `assets/icon.png` |
| `npm run dist` | Construit l'installeur et l'exe portable dans `release/` |

`npm start` passe par `scripts/start.mjs`, qui retire `ELECTRON_RUN_AS_NODE` de
l'environnement : VSCode l'exporte à `1`, et hérité par npm il fait démarrer Electron
comme un simple Node (`Cannot read properties of undefined (reading 'getAppPath')`).

## Distribution

`npm run dist` produit deux fichiers dans `release/`, ~78 Mo chacun :

| Fichier | Usage |
| --- | --- |
| `YTM-Lyrics-PiP-0.1.0-Portable.exe` | Un seul exécutable, rien à installer — le plus simple à partager |
| `YTM-Lyrics-PiP-0.1.0-Setup.exe` | Installeur classique, avec choix du dossier et raccourci bureau |

> **Les exécutables ne sont pas signés.** Windows SmartScreen affichera donc
> « Windows a protégé votre ordinateur » au premier lancement : il faut passer par
> *Informations complémentaires* → *Exécuter quand même*. Prévenir les personnes à qui
> tu l'envoies évite bien des inquiétudes. Signer supposerait un certificat de
> signature de code payant.

Les réglages et le cache restent dans `%APPDATA%/ytm-lyrics-pip`, y compris pour la
version portable : chaque personne devra faire son propre appairage.

## Structure

```
src/
  main/
    index.ts          Cycle de vie, tray, IPC, orchestration de l'état
    ytmd.ts           Client Companion Server (auth, socket.io, commandes)
    config.ts         Configuration persistée, décalages par morceau
    lyrics/
      index.ts        Orchestration des sources, cache disque
      match.ts        Nettoyage des métadonnées, similarité, filtre d'acceptation
      lrc.ts          Parsers LRC, LRC enhanced et yrc
      lrclib.ts       Source LRCLIB
      netease.ts      Source NetEase (appoint)
      http.ts         Requêtes JSON tolérantes
    windows/          Création des fenêtres PiP et réglages
  preload/            Ponts contextIsolation
  renderer/
    pip/              Fenêtre PiP (horloge locale, rendu synchronisé)
    setup/            Fenêtre d'appairage et de réglages
  shared/types.ts     Types partagés
```

## Licence

MIT

## Reprises

Quand le titre annonce une reprise — `(Cover)`, `[Acoustic Cover]`, `- Piano Cover`,
`| Cover by X`, `Reprise…` — et que la recherche normale n'a rien donné, une seconde
passe cherche les paroles de **l'original**.

Ce second passage n'intervient jamais en premier : il ignore l'interprète, ce qui est
précisément ce qui ramène les paroles d'un autre morceau. Pour compenser la perte de
ce garde-fou, l'exigence sur le titre passe de 0,5 à **0,8** de similarité, et la
détection réclame un contexte — entre parenthèses, après un séparateur, ou suivi de
« by ». Sans quoi « Cover Me In Sunshine », « Undercover Martyn » ou « Cover Girl »
déclencheraient le mode permissif.

Quand le titre nomme l'original (`Adele - Someone Like You (Cover)`), l'artiste est
extrait et sert à départager les candidats — jamais à en écarter.

### Recalage sur la reprise

Les timings de l'original ne collent pas à la reprise. Ils sont donc **étirés
linéairement** sur la durée jouée, en supposant une structure identique à un facteur
de tempo près. Le libellé de source affiche le facteur appliqué (`timings ×0.78`).

La référence n'est pas la durée déclarée par le catalogue, souvent fausse — une fiche
LRCLIB annonce 210 s pour un LRC qui court jusqu'à 264 s. On retient le maximum entre
cette durée et le dernier horodatage du fichier, plus une queue de 5 s pour l'outro
que les paroles ne couvrent jamais.

L'hypothèse tombe dès que la reprise ajoute une intro ou saute un couplet : au-delà
d'un écart de tempo de ×0,6 à ×1,6, aucune mise à l'échelle n'est appliquée et le
libellé invite à corriger avec `[` et `]`.

## Caler les paroles en un geste

Le réglage fin à coups de `[` / `]` reste disponible, mais le chemin normal est
**« Caler ici »** : dans la fenêtre PiP, appuyer sur `S` — ou sur le bouton `⏱` — *au
moment où l'on entend une ligne commencer*. Le décalage est calculé d'un coup et
mémorisé pour ce morceau.

La ligne visée est celle dont l'horodatage est le plus proche de la position affichée :
l'erreur qu'on corrige est par construction plus petite que l'écart entre deux lignes,
donc la plus proche est la bonne. Le temps de réaction humain (150 ms) est compensé,
sans quoi chaque calage placerait les paroles systématiquement trop tard.

`scripts/test-calage.cjs` éprouve le calcul sur le vrai renderer, y compris son
**sens** : une erreur de signe donnerait un décalage qui aggrave l'écart au lieu de le
corriger, et rien ne le signalerait.

### Pourquoi pas une détection par le son

Capter le son du système pour aligner les paroles sur les attaques vocales est
techniquement possible — vérifié : `setDisplayMediaRequestHandler` avec
`audio: 'loopback'` fonctionne sans module natif. L'idée a été écartée pour une raison
d'usage : le loopback capte **tout** le son de la machine. Une notification, une vidéo
dans un autre onglet, et l'alignement se fausse sans prévenir. La plupart des gens ont
plusieurs sources sonores actives ; une correction silencieusement fausse est pire
qu'un réglage manuel qui, lui, est prévisible.

### Calage automatique

Chaque calage manuel est une **mesure** : l'utilisateur affirme « à cet instant, cette
ligne commence ». Quand plusieurs calages convergent, l'écart commun ne vient pas des
paroles mais de la chaîne de lecture — latence de sortie audio, retard de la position
rapportée. Cette part vaut pour *tous* les morceaux et n'a aucune raison d'être
ressaisie à chaque fois.

À partir du **3ᵉ calage**, la **médiane** des mesures devient le décalage global et
s'applique d'office aux morceaux jamais calés. Médiane et non moyenne : une frappe
ratée ne doit pas déplacer l'estimation. La valeur est bornée à ±3 s — une latence de
chaîne audio dépasse rarement la seconde, au-delà l'écart est propre au morceau.

Le point délicat est ailleurs : **promouvoir la médiane ne doit rien changer aux
morceaux déjà calés**, sinon chaque apprentissage déréglerait le travail précédent.
Leurs décalages propres sont donc rebasés de l'écart exact, si bien que leur résultat
effectif reste identique. `scripts/test-calibration.cjs` vérifie précisément cette
invariance, ainsi que le bornage, la fenêtre glissante de 20 mesures et le
comportement quand l'apprentissage est désactivé.

La touche de calage est configurable (**Réglages → Synchro**) ; les touches déjà
prises par la fenêtre PiP (`[`, `]`, espace, Échap) sont refusées.
