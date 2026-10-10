import { app, ipcMain, Menu, nativeImage, shell, Tray } from 'electron';
import path from 'node:path';
import {
  APPEARANCE_DEFAULTS,
  effectiveOffsets,
  flushConfig,
  getConfig,
  setTrackOffset,
  updateConfig,
} from './config';
import { decideAutoHide } from './autohide';
import { calibrate } from './calibration';
import { clearLyricsCache, getLyrics, pruneCache } from './lyrics';
import { FRAME_STYLES, THEMES } from '../shared/themes';
import { CompanionError, YtmdClient } from './ytmd';
import { SpotifySource, REDIRECT_URI } from './players/spotify';
import { YtmdSource } from './players/ytmd-source';
import type { NowPlaying, PlayerSource } from './players/types';
import {
  applyClickThrough,
  createPipWindow,
  getPipWindow,
  resizeBy,
  togglePip,
} from './windows/pip';
import { createSetupWindow, getSetupWindow } from './windows/setup';
import type {
  ConnectionStatus,
  LyricsResult,
  PipSettings,
  PlayerCommand,
  SyncPayload,
} from '../shared/types';

const APP_ROOT = app.getAppPath();

if (!app.requestSingleInstanceLock()) {
  app.quit();
}

let tray: Tray | null = null;
/** Source de lecture active : YouTube Music Desktop ou Spotify. */
let source: PlayerSource | null = null;

/** Durée du fondu côté renderer ; on attend qu'il se joue avant de retirer la fenêtre. */
const FADE_MS = 380;

/**
 * Escamotage pendant les pauses. Piloté depuis le processus principal : les
 * minuteries d'un renderer masqué sont bridées par Chromium, celles-ci non.
 * `autoHidden` distingue « caché par nous » de « caché par l'utilisateur » —
 * seule la première situation autorise un retour automatique.
 */
let autoHidden = false;
let fadeTimer: NodeJS.Timeout | null = null;
let hideTimer: NodeJS.Timeout | null = null;

/** Dernier état poussé au renderer PiP, rejoué quand la fenêtre (ré)apparaît. */
let currentVideoId: string | null = null;
let lastTrackPayload: unknown = null;
let lastSync: SyncPayload | null = null;
let lastStatus: ConnectionStatus = { state: 'disconnected' };

function pipSettings(): PipSettings {
  const c = getConfig();
  const { offsetMs, trackOffsetMs } = effectiveOffsets(currentVideoId);
  return {
    opacity: c.opacity,
    fontSize: c.fontSize,
    fontFamily: c.fontFamily,
    fontWeight: c.fontWeight,
    textAlign: c.textAlign,
    accentColor: c.accentColor,
    textColor: c.textColor,
    backgroundColor: c.backgroundColor,
    dimOpacity: c.dimOpacity,
    cornerRadius: c.cornerRadius,
    frameStyle: c.frameStyle,
    textGlow: c.textGlow,
    showControls: c.showControls,
    showOffset: c.showOffset,
    showTitle: c.showTitle,
    showSource: c.showSource,
    clickThrough: c.clickThrough,
    autoHideWhenPaused: c.autoHideWhenPaused,
    autoHideDelaySeconds: c.autoHideDelaySeconds,
    syncKey: c.syncKey,
    autoCalibrate: c.autoCalibrate,
    calibrationSamples: c.calibrationHistory.length,
    offsetMs,
    trackOffsetMs,
  };
}

function sendToPip(channel: string, payload: unknown): void {
  const win = getPipWindow();
  if (win && !win.webContents.isDestroyed()) win.webContents.send(channel, payload);
}

function sendToSetup(channel: string, payload: unknown): void {
  const win = getSetupWindow();
  if (win && !win.webContents.isDestroyed()) win.webContents.send(channel, payload);
}

function broadcastSettings(): void {
  sendToPip('pip:settings', pipSettings());
}

// ---------------------------------------------------------------------------
// Escamotage automatique
// ---------------------------------------------------------------------------

function clearFadeTimers(): void {
  if (fadeTimer) {
    clearTimeout(fadeTimer);
    fadeTimer = null;
  }
  if (hideTimer) {
    clearTimeout(hideTimer);
    hideTimer = null;
  }
}

/** Annule tout escamotage en cours et ramène la fenêtre. */
function cancelAutoHide(): void {
  clearFadeTimers();
  const win = getPipWindow();
  if (!win) return;
  if (autoHidden) {
    autoHidden = false;
    if (getConfig().pipVisible) win.showInactive();
  }
  sendToPip('pip:fade', false);
}

/** Bascule demandée par l'utilisateur : elle prime sur tout escamotage en cours. */
function togglePipManual(visible?: boolean): void {
  clearFadeTimers();
  autoHidden = false;
  sendToPip('pip:fade', false);
  togglePip(APP_ROOT, visible);
  buildTrayMenu();
}

function updateAutoHide(playing: boolean): void {
  const config = getConfig();

  const decision = decideAutoHide({
    playing,
    enabled: config.autoHideWhenPaused,
    pipVisible: config.pipVisible,
    autoHidden,
    pending: Boolean(fadeTimer || hideTimer),
  });

  if (decision === 'annuler') {
    cancelAutoHide();
    return;
  }
  if (decision !== 'programmer') return;

  fadeTimer = setTimeout(() => {
    fadeTimer = null;
    sendToPip('pip:fade', true);
    // On laisse le fondu se jouer avant de retirer la fenêtre pour de bon.
    hideTimer = setTimeout(() => {
      hideTimer = null;
      const win = getPipWindow();
      if (!win || !getConfig().pipVisible) return;
      autoHidden = true;
      win.hide();
    }, FADE_MS);
  }, Math.max(1, config.autoHideDelaySeconds) * 1000);
}

// ---------------------------------------------------------------------------
// Orchestration de l'état lecteur
// ---------------------------------------------------------------------------

async function handleState(now: NowPlaying): Promise<void> {
  const sync: SyncPayload = {
    videoId: now.id,
    title: now.title,
    author: now.artist,
    durationSeconds: now.durationSeconds,
    progress: now.progressSeconds,
    playing: now.playing,
    adPlaying: now.adPlaying,
  };
  lastSync = sync;
  sendToPip('pip:sync', sync);

  // Une publicité n'est qu'une interruption : la musique reprend juste après,
  // escamoter la fenêtre pour si peu ferait clignoter l'affichage.
  updateAutoHide(now.playing || now.adPlaying);

  if (!now.id) {
    if (currentVideoId !== null) {
      currentVideoId = null;
      lastTrackPayload = null;
      sendToPip('pip:track', {
        videoId: null,
        title: '',
        author: '',
        album: null,
        thumbnail: null,
        lyrics: { kind: 'none', lines: [], source: null, message: 'Aucun morceau en lecture.' },
      });
    }
    return;
  }

  if (now.id === currentVideoId) return;
  currentVideoId = now.id;
  // Le décalage par morceau fait partie des réglages poussés : il change avec le morceau.
  broadcastSettings();

  // On affiche le titre tout de suite, les paroles suivront.
  const pending = {
    videoId: now.id,
    title: now.title,
    author: now.artist,
    album: now.album,
    thumbnail: now.thumbnail,
    lyrics: {
      kind: 'none',
      lines: [],
      source: null,
      message: 'Recherche des paroles…',
    } as LyricsResult,
  };
  lastTrackPayload = pending;
  sendToPip('pip:track', pending);

  const lyrics = await getLyrics({
    id: now.id,
    title: now.title,
    author: now.artist,
    album: now.album,
    durationSeconds: now.durationSeconds,
  });
  // Le morceau a pu changer pendant la requête réseau : on jette le résultat périmé.
  if (currentVideoId !== now.id) return;

  const payload = { ...pending, lyrics };
  lastTrackPayload = payload;
  sendToPip('pip:track', payload);
}

// ---------------------------------------------------------------------------
// Source de lecture
// ---------------------------------------------------------------------------

/** (Re)construit la source selon le réglage et s'y abonne. */
function useSource(): void {
  source?.stop();
  source?.removeAllListeners();

  source = getConfig().playerSource === 'spotify' ? new SpotifySource() : new YtmdSource();

  source.on('now', (now) => {
    void handleState(now);
  });
  source.on('status', (status) => {
    lastStatus = status;
    sendToPip('pip:status', status);
    sendToSetup('setup:status', status);
    if (status.state === 'unauthorized') createSetupWindow(APP_ROOT);
  });

  // Le morceau courant appartenait à l'ancienne source : on repart de zéro.
  currentVideoId = null;
  lastTrackPayload = null;
  source.start();
}

// ---------------------------------------------------------------------------
// Tray
// ---------------------------------------------------------------------------

function buildTrayMenu(): void {
  if (!tray) return;
  const c = getConfig();
  const pipVisible = getPipWindow()?.isVisible() ?? false;

  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: pipVisible ? 'Masquer la fenêtre PiP' : 'Afficher la fenêtre PiP',
        click: () => togglePipManual(),
      },
      {
        label: 'Verrouiller (passe-clic)',
        type: 'checkbox',
        checked: c.clickThrough,
        click: (item) => {
          updateConfig({ clickThrough: item.checked });
          applyClickThrough(item.checked);
          broadcastSettings();
        },
      },
      { type: 'separator' },
      { label: 'Réglages…', click: () => createSetupWindow(APP_ROOT) },
      { label: 'Reconnecter', click: () => useSource() },
      {
        label: 'Vider le cache des paroles',
        click: () => {
          clearLyricsCache();
          currentVideoId = null;
        },
      },
      { type: 'separator' },
      {
        label: 'Quitter',
        click: () => {
          flushConfig();
          app.exit(0);
        },
      },
    ]),
  );
}

function createTray(): void {
  const icon = nativeImage
    .createFromPath(path.join(APP_ROOT, 'assets', 'icon.png'))
    .resize({ width: 16, height: 16 });
  tray = new Tray(icon);
  tray.setToolTip('YTM Lyrics PiP');
  tray.on('click', () => togglePipManual());
  buildTrayMenu();
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

function registerIpc(): void {
  ipcMain.on('pip:ready', () => {
    sendToPip('pip:settings', pipSettings());
    sendToPip('pip:status', lastStatus);
    if (lastTrackPayload) sendToPip('pip:track', lastTrackPayload);
    if (lastSync) sendToPip('pip:sync', lastSync);
  });

  ipcMain.on('pip:command', (_e, command: PlayerCommand) => {
    source?.sendCommand(command).catch((err: Error) => {
      console.warn('[command] échec :', err.message);
    });
  });

  ipcMain.on('pip:hide', () => {
    clearFadeTimers();
    autoHidden = false;
    togglePip(APP_ROOT, false);
    buildTrayMenu();
  });

  ipcMain.on('pip:open-settings', () => createSetupWindow(APP_ROOT));

  ipcMain.on('pip:resize-by', (_e, dw: number, dh: number) => resizeBy(dw, dh));

  // Depuis la PiP, l'ajustement vise le morceau courant : il corrige presque
  // toujours une version (clip contre audio), pas la configuration globale.
  // Plage large car une intro de clip peut décaler de plusieurs dizaines de secondes.
  ipcMain.on('pip:nudge-offset', (_e, deltaMs: number) => {
    const clamp = (value: number) => Math.max(-30_000, Math.min(30_000, value));
    if (currentVideoId) {
      const { trackOffsetMs } = effectiveOffsets(currentVideoId);
      setTrackOffset(currentVideoId, clamp(trackOffsetMs + deltaMs));
    } else {
      updateConfig({ offsetMs: clamp(getConfig().offsetMs + deltaMs) });
    }
    broadcastSettings();
  });

  // Le renderer calcule le décalage TOTAL voulu ; le décalage global reste un
  // réglage de configuration, on n'ajuste donc que la part propre au morceau.
  ipcMain.on('pip:set-total-offset', (_e, totalMs: number) => {
    if (!currentVideoId) return;
    const c = getConfig();
    const clamp = (v: number) => Math.max(-30_000, Math.min(30_000, v));

    // Chaque calage est une mesure : elle affine le décalage systématique appris,
    // qui servira ensuite aux morceaux jamais calés.
    const resultat = calibrate({
      total: clamp(Math.round(totalMs)),
      history: c.calibrationHistory,
      currentGlobal: c.offsetMs,
      trackOffsets: c.trackOffsets,
      videoId: currentVideoId,
      enabled: c.autoCalibrate,
    });

    updateConfig({
      calibrationHistory: resultat.history,
      offsetMs: resultat.global,
      trackOffsets: resultat.trackOffsets,
    });
    flushConfig();
    broadcastSettings();
  });

  ipcMain.on('pip:reset-offset', () => {
    if (currentVideoId) setTrackOffset(currentVideoId, 0);
    broadcastSettings();
  });

  ipcMain.handle('setup:snapshot', () => {
    const c = getConfig();
    return {
      host: c.host,
      port: c.port,
      hasToken: Boolean(c.token),
      status: lastStatus,
      settings: pipSettings(),
      pipVisible: getPipWindow()?.isVisible() ?? false,
      themes: THEMES,
      frames: FRAME_STYLES,
      trackOffsetCount: Object.keys(c.trackOffsets).length,
      playerSource: c.playerSource,
      spotifyClientId: c.spotifyClientId ?? '',
      spotifyConnected: Boolean(c.spotifyRefreshToken),
      spotifyRedirectUri: REDIRECT_URI,
    };
  });

  ipcMain.handle('setup:apply-theme', (_e, themeId: string) => {
    const theme = THEMES.find((t) => t.id === themeId);
    if (!theme) return pipSettings();
    updateConfig(theme.settings);
    broadcastSettings();
    return pipSettings();
  });

  ipcMain.handle('setup:probe', async (_e, host: string, port: number) => {
    const probe = new YtmdClient(host, port);
    try {
      const meta = await probe.getMetadata();
      if (!meta.apiVersions?.includes('v1')) {
        return { ok: false, error: "Ce serveur ne propose pas l'API v1." };
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('setup:pair', async (_e, host: string, port: number) => {
    updateConfig({ host, port, playerSource: 'ytmd' });
    // L'appairage est propre au Companion Server : on parle au client dédié.
    const companion = new YtmdClient(host, port);
    try {
      const code = await companion.requestCode();
      sendToSetup('setup:code', code);
      // Bloque jusqu'à validation de l'utilisateur dans YTMDesktop.
      const token = await companion.requestToken(code);
      updateConfig({ token });
      flushConfig();
      useSource();
      return { ok: true };
    } catch (err) {
      const message =
        err instanceof CompanionError ? err.message : (err as Error).message || 'Échec inconnu.';
      return { ok: false, error: message };
    }
  });

  ipcMain.handle('setup:unpair', () => {
    updateConfig({ token: null });
    flushConfig();
    source?.stop();
    currentVideoId = null;
    lastTrackPayload = null;
    lastStatus = { state: 'unauthorized', message: 'Application non appairée à YTMDesktop.' };
    sendToPip('pip:status', lastStatus);
    sendToSetup('setup:status', lastStatus);
  });

  // --- Spotify ---

  ipcMain.handle('setup:spotify-connect', async (_e, clientId: string) => {
    const id = (clientId ?? '').trim();
    if (!id) return { ok: false, error: 'Renseigne d’abord l’identifiant client Spotify.' };
    const spotify = new SpotifySource();
    try {
      await spotify.authorize(id);
      updateConfig({ playerSource: 'spotify' });
      flushConfig();
      useSource();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('setup:spotify-disconnect', () => {
    updateConfig({ spotifyRefreshToken: null, spotifyAccessToken: null, spotifyExpiresAt: 0 });
    flushConfig();
    useSource();
  });

  ipcMain.handle('setup:set-source', (_e, playerSource: 'ytmd' | 'spotify') => {
    updateConfig({ playerSource });
    flushConfig();
    useSource();
    return playerSource;
  });

  ipcMain.on('setup:set-setting', <K extends keyof PipSettings>(
    _e: Electron.IpcMainEvent,
    key: K,
    value: PipSettings[K],
  ) => {
    // `trackOffsetMs` est dérivé du morceau courant, pas un réglage persistable.
    if (key === 'trackOffsetMs') return;
    updateConfig({ [key]: value } as never);
    if (key === 'clickThrough') applyClickThrough(value as boolean);
    // Désactiver l'escamotage doit ramener la fenêtre tout de suite, sans quoi
    // le réglage n'aurait d'effet qu'à la prochaine lecture.
    if (key === 'autoHideWhenPaused' && !value) cancelAutoHide();
    broadcastSettings();
    buildTrayMenu();
  });

  ipcMain.on('setup:toggle-pip', (_e, visible: boolean) => togglePipManual(visible));

  ipcMain.handle('setup:clear-cache', () => {
    clearLyricsCache();
    currentVideoId = null;
  });

  ipcMain.handle('setup:reset-appearance', () => {
    updateConfig(APPEARANCE_DEFAULTS);
    applyClickThrough(getConfig().clickThrough);
    broadcastSettings();
    return pipSettings();
  });

  ipcMain.handle('setup:forget-calibration', () => {
    updateConfig({ calibrationHistory: [], offsetMs: 0 });
    flushConfig();
    broadcastSettings();
    return pipSettings();
  });

  ipcMain.handle('setup:clear-track-offsets', () => {
    const count = Object.keys(getConfig().trackOffsets).length;
    updateConfig({ trackOffsets: {} });
    flushConfig();
    broadcastSettings();
    return count;
  });
}

// ---------------------------------------------------------------------------
// Cycle de vie
// ---------------------------------------------------------------------------

app.on('second-instance', () => createSetupWindow(APP_ROOT));

app.whenReady().then(() => {
  const c = getConfig();

  registerIpc();
  createTray();

  // Entretien du cache hors du chemin critique du démarrage : purge les entrées
  // d'une version de correspondance périmée, les absences expirées et le surplus.
  setTimeout(() => {
    const { supprimees, restantes } = pruneCache();
    if (supprimees > 0) {
      console.log(`[cache] ${supprimees} entrée(s) purgée(s), ${restantes} conservée(s)`);
    }
  }, 3000);

  const pip = createPipWindow(APP_ROOT);
  // La fenêtre n'apparaît qu'au « ready-to-show » : le libellé du tray doit suivre.
  pip.on('show', buildTrayMenu);
  pip.on('hide', buildTrayMenu);

  useSource();
  // Rien pour se connecter : la fenêtre de réglages est le seul endroit utile.
  if (!source?.isConfigured()) createSetupWindow(APP_ROOT);
});

// L'app vit dans le tray : fermer les fenêtres ne doit pas la quitter.
app.on('window-all-closed', () => {
  // volontairement vide
});

app.on('before-quit', () => {
  flushConfig();
  source?.stop();
});

// Aucune navigation externe ne doit s'ouvrir dans nos fenêtres.
app.on('web-contents-created', (_e, contents) => {
  contents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  contents.on('will-navigate', (event) => event.preventDefault());
});
