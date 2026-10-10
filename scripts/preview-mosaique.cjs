/**
 * Assemble des captures en une mosaïque légendée, rendue par Chromium.
 * Usage : electron scripts/preview-mosaique.cjs <sortie.png> <colonnes> <image>=<légende>...
 * Les tuiles sont réduites à ECHELLE de leur taille en pixels : prises en
 * double densité (PREVIEW_SCALE=2), elles restent nettes, et la mosaïque tient
 * dans la largeur d'affichage d'un README GitHub (~880 px).
 */
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const [sortie, colonnesArg, ...entrees] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const colonnes = Number(colonnesArg) || 4;
const GAP = 16;
const LEGENDE = 30;
// Même hors écran, Windows plafonne la fenêtre à la taille de l'écran : une
// mosaïque plus haute serait rognée en bas.
const ECHELLE = 0.4;

const echapper = (s) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

/** Dimensions d'un PNG, lues dans son en-tête IHDR. */
function taillePng(buffer) {
  return { w: buffer.readUInt32BE(16), h: buffer.readUInt32BE(20) };
}

app.whenReady().then(async () => {
  const images = entrees.map((entree) => {
    const [fichier, legende = ''] = entree.split('=');
    const buffer = fs.readFileSync(fichier);
    return { buffer, legende, ...taillePng(buffer) };
  });
  const tuileW = Math.round(images[0].w * ECHELLE);
  const tuileH = Math.round(images[0].h * ECHELLE);

  const tuiles = images.map(
    (img) =>
      `<figure><img src="data:image/png;base64,${img.buffer.toString('base64')}">` +
      `<figcaption>${echapper(img.legende)}</figcaption></figure>`,
  );

  const rangees = Math.ceil(tuiles.length / colonnes);
  const largeur = colonnes * tuileW + (colonnes + 1) * GAP;
  const hauteur = rangees * (tuileH + LEGENDE) + (rangees + 1) * GAP;

  const html = `<!doctype html><meta charset="utf-8"><style>
    html, body { margin: 0; background: #08080b; overflow: hidden; }
    body { display: grid; grid-template-columns: repeat(${colonnes}, ${tuileW}px); gap: ${GAP}px; padding: ${GAP}px; }
    figure { margin: 0; }
    img { display: block; width: ${tuileW}px; height: ${tuileH}px; border-radius: 12px; }
    figcaption { font: 600 13px "Segoe UI", system-ui, sans-serif; color: #b8b8c4;
      text-align: center; height: ${LEGENDE}px; line-height: ${LEGENDE}px; }
  </style>${tuiles.join('')}`;

  // Hors écran : une fenêtre ordinaire serait ramenée à la taille de l'écran.
  const win = new BrowserWindow({
    width: largeur,
    height: hauteur,
    show: false,
    useContentSize: true,
    webPreferences: { offscreen: true },
  });
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  await new Promise((r) => setTimeout(r, 500));
  const image = await win.webContents.capturePage({ x: 0, y: 0, width: largeur, height: hauteur });
  fs.mkdirSync(path.dirname(sortie), { recursive: true });
  fs.writeFileSync(sortie, image.toPNG());
  console.log(`capturé ${sortie} (${image.getSize().width}×${image.getSize().height})`);
  app.exit(0);
});
