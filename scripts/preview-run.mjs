// Capture le rendu de la fenêtre PiP à plusieurs instants, sans YTMDesktop.
// Un processus Electron par instant : recharger une seconde fenêtre dans le
// même processus fait échouer loadFile (ERR_FAILED).
import { spawnSync } from 'node:child_process';
import electron from 'electron';

const moments = process.argv.slice(2);
// Par défaut : la longue ligne qui démarre à 10 s, capturée en cours de remplissage.
const at = moments.length > 0 ? moments : ['10.4', '11.6', '12.8', '14.2'];

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

// PREVIEW_THEMES=id1,id2 capture un instant unique pour chacun de ces thèmes.
const themeIds = (process.env.PREVIEW_THEMES ?? '').split(',').filter(Boolean);
const runs = themeIds.length > 0 ? themeIds.map((id) => ({ id })) : at.map((m) => ({ at: m }));

for (const run of runs) {
  const res = spawnSync(electron, ['scripts/preview.cjs'], {
    stdio: 'inherit',
    env: {
      ...env,
      PREVIEW_AT: run.at ?? at[0],
      ...(run.id ? { PREVIEW_THEME: run.id } : {}),
    },
  });
  if (res.status !== 0) process.exit(res.status ?? 1);
}
