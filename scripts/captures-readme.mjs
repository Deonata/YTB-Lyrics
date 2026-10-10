// Régénère les captures du README dans docs/captures, à partir du vrai
// renderer et de paroles fictives. Usage : npm run build && npm run captures
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import electron from 'electron';

const OUT = path.join('docs', 'captures');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ytmpip-captures-'));
fs.mkdirSync(OUT, { recursive: true });

// Taille par défaut de la PiP dans l'application, en double densité.
const env = { ...process.env, PREVIEW_SCALE: '2', PREVIEW_SIZE: '520x220' };
delete env.ELECTRON_RUN_AS_NODE;

function run(script, extra, args = []) {
  const res = spawnSync(electron, [script, ...args], { stdio: 'inherit', env: { ...env, ...extra } });
  if (res.status !== 0) process.exit(res.status ?? 1);
}

const pip = (label, extra) =>
  run('scripts/preview.cjs', { PREVIEW_OUT: OUT, PREVIEW_LABEL: label, ...extra });

// Fenêtre PiP : remplissage au mot, syllabes, survol avec commandes.
// (preview.cjs préfixe déjà « pip- ».)
pip('remplissage', { PREVIEW_AT: '12.4' });
pip('syllabes', { PREVIEW_AT: '26.75' });
pip('survol', { PREVIEW_AT: '12.4', PREVIEW_HOVER: '1' });

// Les huit thèmes, assemblés en mosaïque.
const { THEMES } = await import('../dist/shared/themes.js').then((m) => m.default ?? m);
for (const theme of THEMES) {
  run('scripts/preview.cjs', {
    PREVIEW_OUT: TMP,
    PREVIEW_AT: '12.4',
    PREVIEW_THEME: theme.id,
  });
}
run(
  'scripts/preview-mosaique.cjs',
  {},
  [
    path.join(OUT, 'themes.png'),
    '2',
    ...THEMES.map((t) => `${path.join(TMP, `pip-${t.id}.png`)}=${t.name}`),
  ],
);

// Fenêtre de réglages.
const reglages = (label, panel, extra = {}) =>
  run('scripts/preview-setup.cjs', { PREVIEW_OUT: OUT, PREVIEW_LABEL: label, PREVIEW_PANEL: panel, ...extra });
reglages('reglages-themes', 'p-themes');
reglages('reglages-connexion', 'p-connexion', { PREVIEW_SOURCE: 'pear' });

fs.rmSync(TMP, { recursive: true, force: true });
