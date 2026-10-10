/**
 * Capture le rendu de la fenêtre PiP à plusieurs instants du morceau,
 * sans YTMDesktop. Usage : node scripts/preview-run.mjs
 */
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '..');
const OUT = process.env.PREVIEW_OUT || path.join(ROOT, 'preview');
// Instant capturé, en secondes dans le morceau (la ligne longue démarre à 10 s).
// Une capture par processus : recharger une seconde fenêtre dans le même
// processus fait échouer loadFile (ERR_FAILED).
const MOMENT = Number(process.env.PREVIEW_AT || '11.5');

async function capture(at) {
  const win = new BrowserWindow({
    width: 300,
    height: 210,
    frame: false,
    show: false,
    backgroundColor: '#101014',
    webPreferences: {
      preload: path.join(__dirname, 'preview-preload.cjs'),
      contextIsolation: true,
      // Le preload lit PREVIEW_STYLE dans process.env, indisponible en bac à sable.
      sandbox: false,
      additionalArguments: [`--at=${at}`],
    },
  });

  await win.loadFile(path.join(ROOT, 'src', 'renderer', 'pip', 'index.html'));

  // La fenêtre est masquée : le compositeur est suspendu et les transitions CSS
  // ne se jouent pas, si bien que la capture figerait le défilement d'avant.
  // On les neutralise pour que chaque transform s'applique immédiatement.
  await win.webContents.insertCSS('*, *::before, *::after { transition: none !important; }');

  // Laisse le temps au premier frame et au calcul des mots.
  await new Promise((r) => setTimeout(r, 900));

  if (process.env.PREVIEW_DEBUG) {
    const probe = `(() => {
      const decrire = (id) => {
        const n = document.getElementById(id);
        if (!n) return 'ABSENT';
        const s = getComputedStyle(n);
        return { classes: n.className, display: s.display, opacity: s.opacity, visibility: s.visibility };
      };
      const active = document.querySelector('.line.active');
      return {
        lignes: document.querySelectorAll('.line').length,
        active: active ? active.textContent : null,
        transform: document.getElementById('lines').style.transform,
        appHover: document.getElementById('app').matches(':hover'),
        bar: decrire('bar'),
        meta: decrire('meta'),
        actions: decrire('actions'),
        foot: decrire('foot'),
        source: decrire('source'),
      };
    })()`;
    console.log('--- sans survol ---');
    console.log(JSON.stringify(await win.webContents.executeJavaScript(probe), null, 2));

    // Survol réel : c'est le sélecteur :hover qu'on veut éprouver, pas une simulation CSS.
    win.webContents.sendInputEvent({ type: 'mouseEnter', x: 150, y: 100 });
    win.webContents.sendInputEvent({ type: 'mouseMove', x: 150, y: 100 });
    await new Promise((r) => setTimeout(r, 400));
    console.log('--- avec survol ---');
    console.log(JSON.stringify(await win.webContents.executeJavaScript(probe), null, 2));
  }

  const image = await win.webContents.capturePage();
  const label = process.env.PREVIEW_THEME || `${at}s`;
  const file = path.join(OUT, `pip-${label}.png`);
  fs.writeFileSync(file, image.toPNG());
  console.log(`capturé ${file}`);
}

app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  await capture(MOMENT);
  app.exit(0);
});
