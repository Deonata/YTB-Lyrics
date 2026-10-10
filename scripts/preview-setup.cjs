/**
 * Capture la fenêtre de réglages, onglet par onglet.
 * Usage : electron scripts/preview-setup.cjs   (PREVIEW_PANEL=p-themes pour cibler)
 */
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'preview');
const PANEL = process.env.PREVIEW_PANEL || 'p-themes';

app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true });

  const win = new BrowserWindow({
    width: 800,
    height: 700,
    show: false,
    backgroundColor: '#141418',
    webPreferences: {
      preload: path.join(__dirname, 'preview-setup-preload.cjs'),
      contextIsolation: true,
      sandbox: false,
    },
  });

  await win.loadFile(path.join(ROOT, 'src', 'renderer', 'setup', 'index.html'));
  await new Promise((r) => setTimeout(r, 800));

  await win.webContents.executeJavaScript(`
    document.querySelector('.tab[data-panel="${PANEL}"]').click();
  `);
  await new Promise((r) => setTimeout(r, 300));

  // Déborde-t-on latéralement ? C'est ce qui faisait apparaître la barre horizontale.
  const debord = await win.webContents.executeJavaScript(`(() => {
    const c = document.getElementById('content');
    return { scrollWidth: c.scrollWidth, clientWidth: c.clientWidth,
             scrollHeight: c.scrollHeight, clientHeight: c.clientHeight };
  })()`);
  console.log(`${PANEL} → débord horizontal : ${debord.scrollWidth - debord.clientWidth}px`);

  const image = await win.webContents.capturePage();
  fs.writeFileSync(path.join(OUT, `reglages-${PANEL}.png`), image.toPNG());
  console.log(`capturé reglages-${PANEL}.png`);
  app.exit(0);
});
