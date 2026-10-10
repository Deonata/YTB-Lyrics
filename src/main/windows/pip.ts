import { BrowserWindow, screen } from 'electron';
import path from 'node:path';
import { getConfig, updateConfig } from '../config';

const MIN_WIDTH = 320;
const MIN_HEIGHT = 110;

let win: BrowserWindow | null = null;

export function getPipWindow(): BrowserWindow | null {
  return win && !win.isDestroyed() ? win : null;
}

/** Recale la fenêtre si l'écran qui l'accueillait a disparu depuis la dernière session. */
function sanitizeBounds(bounds: { x?: number; y?: number; width: number; height: number }) {
  const width = Math.max(MIN_WIDTH, Math.round(bounds.width));
  const height = Math.max(MIN_HEIGHT, Math.round(bounds.height));
  if (bounds.x === undefined || bounds.y === undefined) {
    return { width, height, x: undefined, y: undefined };
  }
  const point = { x: Math.round(bounds.x), y: Math.round(bounds.y) };
  const area = screen.getDisplayMatching({ ...point, width, height }).workArea;
  const visible =
    point.x + width > area.x + 40 &&
    point.x < area.x + area.width - 40 &&
    point.y + height > area.y &&
    point.y < area.y + area.height - 20;
  if (!visible) return { width, height, x: undefined, y: undefined };
  return { width, height, x: point.x, y: point.y };
}

export function createPipWindow(appRoot: string): BrowserWindow {
  const existing = getPipWindow();
  if (existing) return existing;

  const config = getConfig();
  const bounds = sanitizeBounds(config.pipBounds);

  win = new BrowserWindow({
    width: bounds.width,
    height: bounds.height,
    ...(bounds.x !== undefined && bounds.y !== undefined ? { x: bounds.x, y: bounds.y } : {}),
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: true,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    show: false,
    title: 'YTM Lyrics PiP',
    webPreferences: {
      preload: path.join(appRoot, 'dist', 'preload', 'pip.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.setMenu(null);
  // « screen-saver » place la fenêtre au-dessus des applis en plein écran, pas juste des fenêtres normales.
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  applyClickThrough(config.clickThrough);

  const persistBounds = () => {
    const w = getPipWindow();
    if (!w || w.isMinimized()) return;
    const b = w.getBounds();
    updateConfig({ pipBounds: { x: b.x, y: b.y, width: b.width, height: b.height } });
  };
  win.on('move', persistBounds);
  win.on('resize', persistBounds);

  win.on('closed', () => {
    win = null;
  });

  void win.loadFile(path.join(appRoot, 'src', 'renderer', 'pip', 'index.html'));

  win.once('ready-to-show', () => {
    if (getConfig().pipVisible) win?.showInactive();
  });

  return win;
}

export function applyClickThrough(enabled: boolean): void {
  const w = getPipWindow();
  if (!w) return;
  // `forward` laisse la fenêtre recevoir les événements de survol malgré le passe-clic.
  w.setIgnoreMouseEvents(enabled, { forward: true });
}

export function togglePip(appRoot: string, visible?: boolean): boolean {
  const w = getPipWindow() ?? createPipWindow(appRoot);
  const next = visible ?? !w.isVisible();
  if (next) {
    w.showInactive();
    w.setAlwaysOnTop(true, 'screen-saver');
  } else {
    w.hide();
  }
  updateConfig({ pipVisible: next });
  return next;
}

/** Redimensionnement par la poignée du renderer : les bords natifs sont peu fiables sur une fenêtre transparente. */
export function resizeBy(dw: number, dh: number): void {
  const w = getPipWindow();
  if (!w) return;
  const b = w.getBounds();
  w.setBounds({
    x: b.x,
    y: b.y,
    width: Math.max(MIN_WIDTH, Math.round(b.width + dw)),
    height: Math.max(MIN_HEIGHT, Math.round(b.height + dh)),
  });
}
