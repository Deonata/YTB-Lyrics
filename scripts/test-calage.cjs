/**
 * Vérifie le calcul de « Caler ici » sur le vrai renderer.
 * Une erreur de signe donnerait un décalage qui empire les choses au lieu de
 * les corriger, sans que rien ne le signale.
 */
const { app, BrowserWindow } = require('electron');
const path = require('node:path');

// Position de lecture simulée ; la ligne visée démarre à 10 s dans le LRC.
const PROGRESSION = 11.5;
const LIGNE_VISEE = 10;
const REACTION = 0.15;
const ATTENDU = Math.round((LIGNE_VISEE - PROGRESSION + REACTION) * 1000); // -1350 ms

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 320,
    height: 220,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preview-preload.cjs'),
      contextIsolation: true,
      sandbox: false,
      additionalArguments: [`--at=${PROGRESSION}`],
    },
  });

  let obtenu = null;
  win.webContents.on('console-message', (_e, _l, msg) => {
    if (msg.startsWith('CALAGE ')) obtenu = Number(msg.slice(7));
  });

  await win.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'pip', 'index.html'));
  await new Promise((r) => setTimeout(r, 900));
  await win.webContents.executeJavaScript("document.getElementById('btn-sync').click()");
  await new Promise((r) => setTimeout(r, 300));

  const ok = obtenu === ATTENDU;
  console.log(
    `${ok ? 'OK  ' : 'ECHEC'} calage : lecture à ${PROGRESSION}s, ligne entendue à ${LIGNE_VISEE}s` +
      ` → ${obtenu} ms (attendu ${ATTENDU})`,
  );

  // Contrôle du sens : avec ce décalage, la ligne doit s'activer au moment
  // réellement entendu, soit PROGRESSION − REACTION.
  if (ok) {
    const activation = LIGNE_VISEE - obtenu / 1000;
    const entendu = PROGRESSION - REACTION;
    const bon = Math.abs(activation - entendu) < 0.001;
    console.log(
      `${bon ? 'OK  ' : 'ECHEC'} sens : la ligne s'activera à ${activation.toFixed(2)}s,` +
        ` entendue à ${entendu.toFixed(2)}s`,
    );
    app.exit(bon ? 0 : 1);
  }
  app.exit(ok ? 0 : 1);
});
