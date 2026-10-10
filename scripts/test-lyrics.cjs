/**
 * Contrôle du pipeline paroles sans lancer Electron.
 * `electron` est remplacé par un stub car lyrics.ts n'en utilise que app.getPath.
 * Usage : node scripts/test-lyrics.cjs
 */
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');

const stub = { app: { getPath: () => path.join(os.tmpdir(), 'ytmpip-test-cache') } };
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return stub;
  return originalLoad.call(this, request, parent, isMain);
};

const {
  parseLrc,
  parseYrc,
  timeWords,
  alignsWith,
  cleanTitle,
  cleanArtist,
  getLyrics,
  clearLyricsCache,
} = require('../dist/main/lyrics/index.js');

// Sinon les exécutions suivantes reliraient le cache et ne testeraient plus le réseau.
clearLyricsCache();

let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? 'OK  ' : 'ECHEC'} ${label}`);
  if (!ok) console.log(`      attendu ${JSON.stringify(expected)}\n      obtenu  ${JSON.stringify(actual)}`);
}

// --- Parser LRC ---
const lrc = [
  '[ar:Un Artiste]',
  '[ti:Un Titre]',
  '[offset:+500]',
  '[00:12.30]Première ligne',
  '[00:15]Deuxième sans centièmes',
  '[00:18.5]Fraction sur un chiffre',
  '[00:20.00][00:40.00]Refrain répété',
  '[00:25.00]',
  '[01:02.750]<01:02.75>Mot <01:03.00>à mot',
].join('\n');

const lines = parseLrc(lrc);
// offset +500 ms recule les timestamps de 0,5 s.
check('parseLrc : nombre de lignes', lines.length, 7);
check('parseLrc : centièmes', lines[0], { time: 11.8, text: 'Première ligne' });
check('parseLrc : mm:ss sans fraction', lines[1], { time: 14.5, text: 'Deuxième sans centièmes' });
check('parseLrc : fraction à un chiffre (.5 = 500 ms)', lines[2], { time: 18, text: 'Fraction sur un chiffre' });
// Une ligne à deux timestamps devient deux entrées, replacées par le tri chronologique.
const refrain = lines.filter((l) => l.text === 'Refrain répété').map((l) => l.time);
check('parseLrc : timestamps multiples dédoublés', refrain, [19.5, 39.5]);
check('parseLrc : ligne vide conservée (instrumental)', lines.find((l) => l.text === ''), { time: 24.5, text: '' });
const enhanced = lines.find((l) => l.text === 'Mot à mot');
check('parseLrc : texte nettoyé des marqueurs mot-à-mot', Boolean(enhanced), true);
check('parseLrc : mots horodatés extraits', enhanced.words, [
  { time: 62.25, text: 'Mot' },
  { time: 62.5, text: 'à mot' },
]);
// Un refrain répété ne doit pas hériter de timings mot-à-mot désynchronisés.
check(
  'parseLrc : pas de mots sur une ligne à timestamps multiples',
  lines.filter((l) => l.text === 'Refrain répété').every((l) => l.words === undefined),
  true,
);
check(
  'parseLrc : pas de mots sur une ligne ordinaire',
  lines.find((l) => l.text === 'Première ligne').words,
  undefined,
);
check('parseLrc : tri croissant', lines.every((l, i) => i === 0 || lines[i - 1].time <= l.time), true);

// --- Nettoyage des métadonnées ---
// --- Format « yrc » de NetEase, horodaté au mot (millisecondes absolues) ---
const yrc = [
  '{"t":0,"c":[{"tx":"métadonnées JSON à ignorer"}]}',
  '[0,0](0,0,0) 作曲 : Quelqu\'un',
  '[11460,2730](11460,210,0)I (11670,180,0)do (11850,120,0)the (11970,540,0)same',
  '[14190,1500](14190,300,0)thing (14490,200,0)again',
].join('\n');

const yrcLines = parseYrc(yrc);
check('parseYrc : lignes JSON et crédits écartés', yrcLines.length, 2);
check('parseYrc : début de ligne en secondes', yrcLines[0].time, 11.46);
check('parseYrc : texte recomposé', yrcLines[0].text, 'I do the same');
check('parseYrc : mots horodatés, fin comprise', yrcLines[0].words, [
  { time: 11.46, text: 'I', end: 11.67 },
  { time: 11.67, text: 'do', end: 11.85 },
  { time: 11.85, text: 'the', end: 11.97 },
  { time: 11.97, text: 'same', end: 12.51 },
]);

// Un segment yrc sans espace final est une syllabe : le mot continue.
const syllabes = parseYrc('[1000,1100](1000,300,0)beau(1300,300,0)ti(1600,300,0)ful (1900,200,0)day')[0];
check('parseYrc : syllabes recollées dans le texte', syllabes.text, 'beautiful day');
check(
  'parseYrc : syllabes sans espace entre elles',
  syllabes.words.map((w) => [w.text, w.space !== false]),
  [['beau', false], ['ti', false], ['ful', true], ['day', true]],
);
const japonais = parseYrc('[18770,1100](18770,730,0)泥(19500,270,0)だ(19770,350,0)ら(20120,360,0)け')[0];
check('parseYrc : japonais sans espaces parasites', japonais.text, '泥だらけ');

// --- LRC « enhanced » : texte avant le premier marqueur, marqueur de fin, syllabes ---
const prefixe = parseLrc('[00:10.00]Hello <00:10.50>world<00:11.20>')[0];
check('parseLrc : texte avant le 1er marqueur gardé', prefixe.words.map((w) => w.text), ['Hello', 'world']);
check('parseLrc : il démarre avec la ligne', prefixe.words[0].time, 10);
check('parseLrc : marqueur final = fin du dernier mot', prefixe.words[1].end, 11.2);
const enhSyll = parseLrc('[00:10.00]<00:10.00>beau<00:10.30>ti<00:10.60>ful')[0];
check('parseLrc : syllabes enhanced', [enhSyll.text, enhSyll.words.length, enhSyll.words[0].space], ['beautiful', 3, false]);

// --- Horodatage au mot avant envoi ---
const proche = (a, b) => Math.abs(a - b) < 0.005;
const estimees = timeWords(
  [
    { time: 0, text: 'un deux trois' },
    { time: 3, text: '' },
    { time: 9, text: 'こんにちは' },
    { time: 12, text: 'vrai mot', words: [{ time: 12, text: 'vrai' }, { time: 12.4, end: 13, text: 'mot' }] },
  ],
  20,
);
const [l0, l1, l2, l3] = estimees;
check('timeWords : ligne estimée découpée', [l0.estimated, l0.words.map((w) => w.text)], [true, ['un', 'deux', 'trois']]);
// 11 caractères → fenêtre 0,35 + 11/7 = 1,921 s, bien en deçà de l'écart de 3 s.
check('timeWords : fenêtre de chant calibrée', proche(l0.words[2].end, 0.35 + 11 / 7), true);
// Poids 2, 4 et 5×2 : le dernier mot, tenu, prend la plus grosse part.
check('timeWords : dernier mot tenu plus longtemps', proche(l0.words[2].time, (0.35 + 11 / 7) * 6 / 16), true);
check('timeWords : passage instrumental sur tout l’écart', [l1.words.length, proche(l1.words[2].end, 9)], [3, true]);
check('timeWords : japonais découpé par caractère', [l2.words.length, l2.words[0].space], [5, false]);
check('timeWords : mots réels gardés, fin complétée', [l3.estimated, l3.words[0].end, l3.words[1].end], [undefined, 12.4, 13]);
check(
  'timeWords : sans source de mots, le libellé reste « estimé »',
  estimees.filter((l) => l.text && !l.estimated).length,
  1,
);

// --- Alignement de deux synchronisations ---
const ref = ['Un', 'Deux', 'Trois', 'Quatre', 'Cinq'].map((text, i) => ({ time: 10 + i * 4, text }));
const decale = (d) => ref.map((l) => ({ ...l, text: l.text.toUpperCase() + ' !', time: l.time + d }));
check('alignsWith : même version, ponctuation et casse ignorées', alignsWith(ref, decale(0.3)), true);
check('alignsWith : autre version (décalée de 2 s) refusée', alignsWith(ref, decale(2)), false);
check('alignsWith : trop peu de lignes communes pour juger', alignsWith(ref.slice(0, 3), decale(0).slice(0, 3)), false);

// --- Lignes de crédits dans un LRC classique (fréquentes chez NetEase) ---
const avecCredits = parseLrc(
  ['[00:00.000] 作曲 : Quelqu\'un', '[00:01.000]Produced by : Untel', '[00:12.00]Vraie parole'].join('\n'),
);
check('parseLrc : crédits écartés', avecCredits, [{ time: 12, text: 'Vraie parole' }]);

check('cleanTitle', cleanTitle('Song Name (Official Music Video)'), 'Song Name');
check('cleanTitle : remaster', cleanTitle('Song Name (Remastered 2011)'), 'Song Name');
check('cleanTitle : mots-clés combinés', cleanTitle('Song (Official Video Remastered)'), 'Song');
check('cleanTitle : intact', cleanTitle('Song (Radio Edit)'), 'Song (Radio Edit)');
check('cleanTitle : live préservé', cleanTitle('Song (Live at Wembley)'), 'Song (Live at Wembley)');
check('cleanArtist : chaîne Topic', cleanArtist('Daft Punk - Topic'), 'Daft Punk');

// --- Recherche réelle sur LRCLIB ---
(async () => {
  const cases = [
    { id: 'test-getlucky', attendu: 'synced', title: 'Get Lucky', author: 'Daft Punk - Topic', album: 'Random Access Memories', durationSeconds: 369, thumbnails: [] },
    { id: 'test-bohemian', attendu: 'synced', title: 'Bohemian Rhapsody (Official Video Remastered)', author: 'Queen', album: null, durationSeconds: 355, thumbnails: [] },
    { id: 'test-inexistant', attendu: 'none', title: 'Zzzz Morceau Totalement Inexistant 12345', author: 'Personne', album: null, durationSeconds: 200, thumbnails: [] },
    // Titre très courant chez un artiste que LRCLIB n'indexe pas : sans filtre
    // d'artiste, l'homonyme d'un autre interprète était renvoyé.
    { id: 'test-homonyme', attendu: 'none', title: 'Yesterday', author: 'Artiste Inexistant Qwerty', album: null, durationSeconds: 125, thumbnails: [] },
    // Version clip : ~32 s de plus que l'audio (367 s chez LRCLIB). L'artiste et le
    // titre concordent nettement, donc l'écart signale une autre version du bon
    // morceau et doit être accepté.
    { id: 'test-clip', attendu: 'synced', title: 'Get Lucky', author: 'Daft Punk', album: null, durationSeconds: 399, thumbnails: [] },
    // Écart énorme malgré un titre identique : là c'est un autre enregistrement,
    // l'horodatage serait inutilisable.
    { id: 'test-duree', attendu: 'none', title: 'Get Lucky', author: 'Daft Punk', album: null, durationSeconds: 90, thumbnails: [] },
    // Cas réel signalé : LRCLIB n'indexe pas Arankai, mais « I Hope It Hurts »
    // existe chez Jessie Murph (250 s, synchronisé). La durée est ici volontairement
    // dans la tolérance, pour que seul le filtre d'artiste puisse écarter le candidat.
    { id: 'test-arankai', attendu: 'none', title: 'I Hope It Hurts', author: 'Arankai', album: null, durationSeconds: 191, thumbnails: [] },
    // Titres japonais : c'est là que NetEase prend le relais de LRCLIB.
    { id: 'test-yoasobi', attendu: 'synced', title: '夜に駆ける', author: 'YOASOBI', album: null, durationSeconds: 261, thumbnails: [] },
    { id: 'test-kitani', attendu: 'synced', title: '青のすみか', author: 'キタニタツヤ', album: null, durationSeconds: 197, thumbnails: [] },
  ];

  for (const video of cases) {
    const res = await getLyrics(video);
    const head = res.lines[0];
    const ok = res.kind === video.attendu;
    if (!ok) failures++;
    const motAMot = res.lines.some((l) => l.words);
    console.log(
      `\n${ok ? 'OK  ' : 'ECHEC'} « ${video.title} » — ${video.author}` +
        `\n      ${res.kind} (${res.lines.length} lignes${motAMot ? ', mot-à-mot' : ''}), attendu ${video.attendu}` +
        `\n      ${res.source ?? res.message}` +
        (head ? `\n      1re ligne : [${head.time.toFixed(2)}s] ${head.text}` : ''),
    );
  }

  console.log(failures === 0 ? '\nTous les contrôles sont passés.' : `\n${failures} contrôle(s) en échec.`);
  process.exit(failures === 0 ? 0 : 1);
})();
