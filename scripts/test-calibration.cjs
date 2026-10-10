/** Apprentissage du décalage systématique. Usage : node scripts/test-calibration.cjs */
const { calibrate, median } = require('../dist/main/calibration.js');

let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? 'OK  ' : 'ECHEC'} ${label}`);
  if (!ok) console.log(`      attendu ${JSON.stringify(expected)}\n      obtenu  ${JSON.stringify(actual)}`);
}

check('médiane impaire', median([300, 100, 200]), 200);
check('médiane paire', median([100, 200, 300, 400]), 250);
check('médiane insensible à une valeur aberrante', median([200, 210, 190, 9000, 205]), 205);

const base = { history: [], currentGlobal: 0, trackOffsets: {}, videoId: 'a', enabled: true };

// Sous le seuil, on ne conclut rien : le global reste inchangé.
let r = calibrate({ ...base, total: 250 });
check('1er calage : rien appris', { global: r.global, track: r.trackOffsets.a }, { global: 0, track: 250 });

r = calibrate({ ...base, total: 260, history: [250], trackOffsets: { a: 250 } });
check('2e calage : toujours rien appris', r.global, 0);

// Au 3e, la médiane devient le décalage global.
r = calibrate({ ...base, total: 240, history: [250, 260], trackOffsets: { a: 250, b: 260 } });
check('3e calage : médiane promue en global', r.global, 250);
check('  résiduel du morceau courant', r.trackOffsets.c ?? r.trackOffsets.a, -10);

// LE point délicat : promouvoir le global ne doit RIEN changer aux morceaux
// déjà calés, sinon chaque apprentissage dérèglerait tout le travail précédent.
const avant = { a: 250, b: 260 };
r = calibrate({ ...base, total: 240, history: [250, 260], trackOffsets: { ...avant }, videoId: 'c' });
for (const [id, valeur] of Object.entries(avant)) {
  const effectifAvant = 0 + valeur;
  const effectifApres = r.global + r.trackOffsets[id];
  check(`  morceau « ${id} » inchangé (${effectifAvant} ms)`, effectifApres, effectifAvant);
}

// Une latence absurde ne doit pas se propager à toute la bibliothèque.
r = calibrate({ ...base, total: 9000, history: [8000, 9500], trackOffsets: {} });
check('global borné à ±3 s', r.global, 3000);

// Apprentissage désactivé : seul le morceau courant bouge.
r = calibrate({ ...base, total: 400, history: [250, 260, 240], enabled: false });
check('désactivé : global intact', r.global, 0);
check('désactivé : morceau ajusté quand même', r.trackOffsets.a, 400);

// Fenêtre glissante : les mesures anciennes sortent.
r = calibrate({ ...base, total: 5, history: Array.from({ length: 20 }, (_, i) => i) });
check('historique plafonné à 20', r.history.length, 20);
check('  la plus ancienne est sortie', r.history[0], 1);

// Résiduel nul : pas d'entrée inutile conservée.
r = calibrate({ ...base, total: 250, history: [250, 250, 250], trackOffsets: {} });
check('résiduel nul : aucune entrée créée', r.trackOffsets.a, undefined);

console.log(failures === 0 ? '\nTous les contrôles sont passés.' : `\n${failures} contrôle(s) en échec.`);
process.exit(failures === 0 ? 0 : 1);
