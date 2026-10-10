import { contextBridge, ipcRenderer } from 'electron';
import type { ConnectionStatus, PipSettings } from '../shared/types';
import type { FrameOption, PipTheme } from '../shared/themes';

export interface SetupSnapshot {
  host: string;
  port: number;
  hasToken: boolean;
  status: ConnectionStatus;
  settings: PipSettings;
  pipVisible: boolean;
  themes: PipTheme[];
  frames: FrameOption[];
  trackOffsetCount: number;
  playerSource: 'ytmd' | 'spotify';
  spotifyClientId: string;
  spotifyConnected: boolean;
  /** À déclarer tel quel dans le tableau de bord Spotify. */
  spotifyRedirectUri: string;
}

export interface PairResult {
  ok: boolean;
  error?: string;
}

const api = {
  getSnapshot: (): Promise<SetupSnapshot> => ipcRenderer.invoke('setup:snapshot'),
  /** Vérifie que le Companion Server répond, sans authentification. */
  probe: (host: string, port: number): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('setup:probe', host, port),
  /** Lance l'appairage ; le code à comparer arrive via `onCode` avant la résolution. */
  pair: (host: string, port: number): Promise<PairResult> =>
    ipcRenderer.invoke('setup:pair', host, port),
  unpair: (): Promise<void> => ipcRenderer.invoke('setup:unpair'),
  /** Bascule la source de lecture et rebranche l'application dessus. */
  setSource: (source: 'ytmd' | 'spotify'): Promise<'ytmd' | 'spotify'> =>
    ipcRenderer.invoke('setup:set-source', source),
  /** Ouvre le navigateur pour l'autorisation Spotify ; se résout au retour. */
  spotifyConnect: (clientId: string): Promise<PairResult> =>
    ipcRenderer.invoke('setup:spotify-connect', clientId),
  spotifyDisconnect: (): Promise<void> => ipcRenderer.invoke('setup:spotify-disconnect'),
  onCode: (cb: (code: string) => void) => {
    ipcRenderer.on('setup:code', (_e, code: string) => cb(code));
  },
  onStatus: (cb: (status: ConnectionStatus) => void) => {
    ipcRenderer.on('setup:status', (_e, status: ConnectionStatus) => cb(status));
  },
  setSetting: <K extends keyof PipSettings>(key: K, value: PipSettings[K]): void => {
    ipcRenderer.send('setup:set-setting', key, value);
  },
  togglePip: (visible: boolean): void => {
    ipcRenderer.send('setup:toggle-pip', visible);
  },
  clearCache: (): Promise<void> => ipcRenderer.invoke('setup:clear-cache'),
  /** Applique un thème d'un coup ; rend les réglages résultants. */
  applyTheme: (themeId: string): Promise<PipSettings> =>
    ipcRenderer.invoke('setup:apply-theme', themeId),
  /** Rétablit les valeurs d'apparence par défaut et rend les réglages appliqués. */
  resetAppearance: (): Promise<PipSettings> => ipcRenderer.invoke('setup:reset-appearance'),
  /** Oublie les décalages par morceau ; rend le nombre d'entrées supprimées. */
  clearTrackOffsets: (): Promise<number> => ipcRenderer.invoke('setup:clear-track-offsets'),
  /** Efface les calages appris et remet le décalage global à zéro. */
  forgetCalibration: (): Promise<PipSettings> => ipcRenderer.invoke('setup:forget-calibration'),
};

contextBridge.exposeInMainWorld('setup', api);

export type SetupApi = typeof api;
