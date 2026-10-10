/**
 * Vérifie l'horloge locale du vrai renderer PiP : entre deux positions
 * rapportées par le lecteur, elle doit rattraper un écart sans jamais reculer.
 * Un recul ferait se vider à moitié un mot en cours de remplissage.
 * Usage : electron scripts/test-horloge.cjs
 * (TEST_PIP_DIR=<dossier> pour viser une autre copie du renderer.)
 */
const { app, BrowserWindow } = require('electron');
const path = require('node:path');

const PIP_DIR = process.env.TEST_PIP_DIR || path.join(__dirname, '..', 'src', 'renderer', 'pip');

const SCENARIO = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const sync = (progress, playing = true) =>
    window.pipTest.sync({ videoId: 'v', title: '', author: '', durationSeconds: 200, progress, playing, adPlaying: false });

  const samples = [];
  const sample = async (ms) => {
    const end = performance.now() + ms;
    while (performance.now() < end) {
      samples.push(rawTime());
      await sleep(10);
    }
  };
  const result = {};

  sync(10);
  await sample(300);

  // Horloge 300 ms en avance sur le lecteur : elle doit ralentir, pas sauter en arrière.
  const ahead = rawTime();
  const t1 = performance.now();
  sync(ahead - 0.3);
  await sample(1500);
  const free1 = ahead - 0.3 + (performance.now() - t1) / 1000;
  result.ecartApresAvance = rawTime() - free1;

  // Horloge 400 ms en retard : elle accélère.
  const behind = rawTime();
  const t2 = performance.now();
  sync(behind + 0.4);
  await sample(1500);
  const free2 = behind + 0.4 + (performance.now() - t2) / 1000;
  result.ecartApresRetard = rawTime() - free2;

  // Gigue de mesure de ±80 ms.
  for (let k = 0; k < 6; k++) {
    sync(rawTime() + (k % 2 ? 0.08 : -0.08));
    await sample(250);
  }

  let reculs = 0;
  let pireRecul = 0;
  for (let i = 1; i < samples.length; i++) {
    const d = samples[i] - samples[i - 1];
    if (d < -1e-6) {
      reculs++;
      pireRecul = Math.min(pireRecul, d);
    }
  }
  result.reculs = reculs;
  result.pireRecul = pireRecul;
  result.echantillons = samples.length;

  // Saut réel (seek) : appliqué tout de suite.
  sync(rawTime() + 30);
  const avant = rawTime();
  result.seek = avant;

  // Pause : la position rapportée fait foi, l'horloge s'arrête dessus.
  sync(77.7, false);
  await sleep(100);
  result.pause = rawTime();
  return result;
})()`;

let failures = 0;
function check(label, ok, detail) {
  if (!ok) failures++;
  console.log(`${ok ? 'OK  ' : 'ECHEC'} ${label}${detail ? ` — ${detail}` : ''}`);
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 320,
    height: 220,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'test-horloge-preload.cjs'),
      contextIsolation: true,
      sandbox: false,
      // Une fenêtre cachée verrait ses minuteries bridées : l'échantillonnage serait faussé.
      backgroundThrottling: false,
    },
  });
  await win.loadFile(path.join(PIP_DIR, 'index.html'));
  await new Promise((r) => setTimeout(r, 300));

  const r = await win.webContents.executeJavaScript(SCENARIO);

  check(
    "l'horloge ne recule jamais",
    r.reculs === 0,
    `${r.reculs} recul(s) sur ${r.echantillons} échantillons, pire ${(r.pireRecul * 1000).toFixed(0)} ms`,
  );
  // La moitié de l'écart est corrigée par mesure : il en reste la moitié, au signe près.
  check(
    'avance de 300 ms : moitié résorbée',
    Math.abs(r.ecartApresAvance - 0.15) < 0.04,
    `reste ${(r.ecartApresAvance * 1000).toFixed(0)} ms (attendu ~150)`,
  );
  check(
    'retard de 400 ms : moitié rattrapée',
    Math.abs(r.ecartApresRetard + 0.2) < 0.04,
    `reste ${(r.ecartApresRetard * 1000).toFixed(0)} ms (attendu ~-200)`,
  );
  check('un seek est appliqué immédiatement', r.seek > 40, `${r.seek.toFixed(2)} s`);
  check('en pause, la position rapportée fait foi', Math.abs(r.pause - 77.7) < 1e-9, `${r.pause} s`);

  app.exit(failures === 0 ? 0 : 1);
});
