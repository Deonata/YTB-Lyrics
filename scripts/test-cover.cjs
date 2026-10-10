/** Détection des reprises et recalage temporel. Usage : node scripts/test-cover.cjs */
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');

const stub = { app: { getPath: () => path.join(os.tmpdir(), 'ytmpip-test-cache') } };
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return stub;
  return originalLoad.call(this, request, parent, isMain);
};

const { isCoverTitle, parseCoverTitle, getLyrics, clearLyricsCache } = require('../dist/main/lyrics/index.js');
clearLyricsCache();

let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? 'OK  ' : 'ECHEC'} ${label}`);
  if (!ok) console.log(`      attendu ${JSON.stringify(expected)}\n      obtenu  ${JSON.stringify(actual)}`);
}

// --- Détection : ce qui EST une reprise ---
for (const titre of [
  'Someone Like You (Cover)',
  'Someone Like You [Acoustic Cover]',
  'Adele - Someone Like You - Piano Cover',
  'Someone Like You | Cover by Jane Doe',
  'Someone Like You (Reprise française)',
  'Hello - cover by someone',
]) {
  check(`reprise détectée : « ${titre} »`, isCoverTitle(titre), true);
}

// --- Détection : ce qui n'en est PAS une ---
// « cover » est un mot courant ; le confondre ferait chercher les paroles d'un
// autre morceau en ignorant l'interprète, exactement ce qu'on veut éviter.
for (const titre of [
  'Cover Me In Sunshine',
  'Undercover Martyn',
  'Discover',
  'Cover Girl',
  'The Cover Is Not The Book',
]) {
  check(`pas une reprise : « ${titre} »`, isCoverTitle(titre), false);
}

// --- Extraction du titre d'origine ---
check('titre nettoyé', parseCoverTitle('Someone Like You (Cover)'), { title: 'Someone Like You' });
check('artiste d’origine deviné', parseCoverTitle('Adele - Someone Like You (Piano Cover)'), {
  title: 'Someone Like You',
  originalArtist: 'Adele',
});
check('« cover by X » retiré', parseCoverTitle('Hello | Cover by Jane Doe'), { title: 'Hello' });

// --- Bout en bout, avec recalage ---
(async () => {
  // Reprise d'un morceau qu'aucun catalogue n'attribue à cet interprète : sans
  // le mode reprise, la recherche stricte échoue et l'on n'affiche rien.
  const reprise = await getLyrics({
    id: 'test-cover-1',
    title: 'Adele - Someone Like You (Piano Cover)',
    author: 'Un Pianiste Inconnu Qwerty',
    album: null,
    durationSeconds: 210, // l'original fait ~285 s : ratio ≈ 0,74
  });
  const ok = reprise.kind === 'synced';
  if (!ok) failures++;
  console.log(
    `\n${ok ? 'OK  ' : 'ECHEC'} reprise « Someone Like You » → ${reprise.kind} (${reprise.lines.length} lignes)` +
      `\n      ${reprise.source ?? reprise.message}`,
  );
  if (reprise.lines.length > 0) {
    console.log(`      1re ligne : [${reprise.lines[0].time.toFixed(2)}s] ${reprise.lines[0].text}`);
    const derniere = reprise.lines[reprise.lines.length - 1];
    const dansLaDuree = derniere.time <= 210;
    if (!dansLaDuree) failures++;
    console.log(
      `      ${dansLaDuree ? 'OK  ' : 'ECHEC'} dernière ligne à ${derniere.time.toFixed(1)}s, tient dans les 210 s de la reprise`,
    );
  }

  // Un titre contenant « cover » sans être une reprise ne doit PAS déclencher
  // le mode permissif : l'interprète inconnu doit rester sans paroles.
  const faux = await getLyrics({
    id: 'test-cover-2',
    title: 'Cover Me In Sunshine',
    author: 'Artiste Inexistant Qwerty',
    album: null,
    durationSeconds: 145,
  });
  const okFaux = faux.kind === 'none';
  if (!okFaux) failures++;
  console.log(
    `\n${okFaux ? 'OK  ' : 'ECHEC'} « Cover Me In Sunshine » d'un inconnu → ${faux.kind}, attendu none` +
      `\n      ${faux.source ?? faux.message}`,
  );

  console.log(failures === 0 ? '\nTous les contrôles sont passés.' : `\n${failures} contrôle(s) en échec.`);
  process.exit(failures === 0 ? 0 : 1);
})();
