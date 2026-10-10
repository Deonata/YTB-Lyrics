import { contextBridge, ipcRenderer } from 'electron';
import type {
  ConnectionStatus,
  LyricsResult,
  PipSettings,
  PlayerCommand,
  SyncPayload,
} from '../shared/types';

export interface TrackPayload {
  videoId: string | null;
  title: string;
  author: string;
  album: string | null;
  thumbnail: string | null;
  lyrics: LyricsResult;
}

const api = {
  /** Signale que le renderer est prêt ; le main répond en poussant l'état courant. */
  ready: (): void => {
    ipcRenderer.send('pip:ready');
  },
  onTrack: (cb: (payload: TrackPayload) => void) => {
    ipcRenderer.on('pip:track', (_e, payload: TrackPayload) => cb(payload));
  },
  onSync: (cb: (payload: SyncPayload) => void) => {
    ipcRenderer.on('pip:sync', (_e, payload: SyncPayload) => cb(payload));
  },
  onSettings: (cb: (settings: PipSettings) => void) => {
    ipcRenderer.on('pip:settings', (_e, settings: PipSettings) => cb(settings));
  },
  onStatus: (cb: (status: ConnectionStatus) => void) => {
    ipcRenderer.on('pip:status', (_e, status: ConnectionStatus) => cb(status));
  },
  /** Fondu d'escamotage pendant les pauses ; le retrait de la fenêtre suit. */
  onFade: (cb: (faded: boolean) => void) => {
    ipcRenderer.on('pip:fade', (_e, faded: boolean) => cb(faded));
  },
  command: (command: PlayerCommand): void => {
    ipcRenderer.send('pip:command', command);
  },
  hide: (): void => {
    ipcRenderer.send('pip:hide');
  },
  openSettings: (): void => {
    ipcRenderer.send('pip:open-settings');
  },
  resizeBy: (dw: number, dh: number): void => {
    ipcRenderer.send('pip:resize-by', dw, dh);
  },
  /** Ajuste le décalage du morceau courant (ou le global si rien ne joue). */
  nudgeOffset: (deltaMs: number): void => {
    ipcRenderer.send('pip:nudge-offset', deltaMs);
  },
  /** Fixe le décalage total voulu ; le main en déduit la part propre au morceau. */
  setTotalOffset: (totalMs: number): void => {
    ipcRenderer.send('pip:set-total-offset', totalMs);
  },
  resetOffset: (): void => {
    ipcRenderer.send('pip:reset-offset');
  },
};

contextBridge.exposeInMainWorld('pip', api);

export type PipApi = typeof api;
