import { BrowserWindow } from 'electron';
import path from 'node:path';

let win: BrowserWindow | null = null;

export function getSetupWindow(): BrowserWindow | null {
  return win && !win.isDestroyed() ? win : null;
}

export function createSetupWindow(appRoot: string): BrowserWindow {
  const existing = getSetupWindow();
  if (existing) {
    existing.show();
    existing.focus();
    return existing;
  }

  win = new BrowserWindow({
    // Large : à 560 px la colonne de contenu était trop étroite pour les galeries
    // et faisait apparaître une barre de défilement horizontale.
    width: 800,
    height: 700,
    minWidth: 620,
    minHeight: 480,
    resizable: true,
    show: false,
    title: 'YTM Lyrics PiP — Réglages',
    icon: path.join(appRoot, 'assets', 'icon.png'),
    backgroundColor: '#141418',
    webPreferences: {
      preload: path.join(appRoot, 'dist', 'preload', 'setup.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.setMenu(null);
  void win.loadFile(path.join(appRoot, 'src', 'renderer', 'setup', 'index.html'));
  win.once('ready-to-show', () => win?.show());
  win.on('closed', () => {
    win = null;
  });

  return win;
}
