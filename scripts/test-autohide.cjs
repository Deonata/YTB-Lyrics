/** Table de vérité de l'escamotage automatique. Usage : node scripts/test-autohide.cjs */
const { decideAutoHide } = require('../dist/main/autohide.js');

let failures = 0;

/** @param {string} label @param {object} state @param {string} attendu */
function check(label, state, attendu) {
  const obtenu = decideAutoHide(state);
  const ok = obtenu === attendu;
  if (!ok) failures++;
  console.log(`${ok ? 'OK  ' : 'ECHEC'} ${label}${ok ? '' : ` — attendu ${attendu}, obtenu ${obtenu}`}`);
}

const base = {
  playing: false,
  enabled: true,
  pipVisible: true,
  autoHidden: false,
  pending: false,
};
const etat = (patch) => ({ ...base, ...patch });

// --- En pause ---
check('pause, rien en cours → programme', etat({}), 'programmer');
check('pause, escamotage déjà programmé → ne reprogramme pas', etat({ pending: true }), 'rien');
check('pause, déjà escamotée → ne fait rien', etat({ autoHidden: true }), 'rien');
check(
  'pause, fenêtre masquée par l’utilisateur → ne la touche pas',
  etat({ pipVisible: false }),
  'rien',
);
check('pause, fonction désactivée → ne fait rien', etat({ enabled: false }), 'rien');

// --- En lecture ---
check('lecture, rien en cours → ne fait rien', etat({ playing: true }), 'rien');
check('lecture, escamotée par nous → ramène', etat({ playing: true, autoHidden: true }), 'annuler');
check('lecture, fondu en cours → annule', etat({ playing: true, pending: true }), 'annuler');
check(
  'lecture, masquée par l’utilisateur et rien en cours → ne la ressort pas',
  etat({ playing: true, pipVisible: false }),
  'rien',
);

// --- Désactivation à chaud ---
check(
  'désactivée alors que la fenêtre était escamotée → la ramène',
  etat({ enabled: false, autoHidden: true }),
  'annuler',
);
check(
  'désactivée pendant un fondu → annule',
  etat({ enabled: false, pending: true }),
  'annuler',
);

// --- Combinaison délicate ---
// L'utilisateur a fermé la fenêtre pendant qu'elle était escamotée : la reprise
// de lecture doit défaire notre état interne, mais `cancelAutoHide` ne rouvrira
// pas la fenêtre puisqu'il vérifie `pipVisible` de son côté.
check(
  'lecture, escamotée par nous mais fermée depuis → annule (nettoyage d’état)',
  etat({ playing: true, autoHidden: true, pipVisible: false }),
  'annuler',
);

console.log(
  failures === 0 ? '\nTous les contrôles sont passés.' : `\n${failures} contrôle(s) en échec.`,
);
process.exit(failures === 0 ? 0 : 1);
