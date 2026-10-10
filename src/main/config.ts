import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import type { FrameStyle, TextAlign } from '../shared/types';

export interface PipBounds {
  x?: number;
  y?: number;
  width: number;
  height: number;
}

/** Au-delà, on oublie les plus anciens décalages par morceau. */
const MAX_TRACK_OFFSETS = 400;

export interface Config {
  /** Source de lecture active. */
  playerSource: 'ytmd' | 'spotify';

  // YouTube Music Desktop
  host: string;
  port: number;
  token: string | null;

  // Spotify — l'identifiant client est public par construction dans le flux PKCE.
  spotifyClientId: string | null;
  spotifyRefreshToken: string | null;
  spotifyAccessToken: string | null;
  spotifyExpiresAt: number;
  pipBounds: PipBounds;
  pipVisible: boolean;

  // Apparence
  opacity: number;
  fontSize: number;
  fontFamily: string;
  fontWeight: number;
  textAlign: TextAlign;
  accentColor: string;
  textColor: string;
  backgroundColor: string;
  dimOpacity: number;
  cornerRadius: number;
  frameStyle: FrameStyle;
  textGlow: boolean;

  // Éléments visibles
  showControls: boolean;
  showOffset: boolean;
  showTitle: boolean;
  showSource: boolean;

  clickThrough: boolean;
  /** Escamotage automatique pendant les pauses. Comportement, pas apparence :
      « Rétablir l'apparence » ne doit pas y toucher. */
  autoHideWhenPaused: boolean;
  autoHideDelaySeconds: number;
  syncKey: string;
  autoCalibrate: boolean;
  /** Calages successifs (décalages totaux), du plus ancien au plus récent. */
  calibrationHistory: number[];

  /** Décalage global, en ms. Positif = les paroles arrivent plus tôt. */
  offsetMs: number;
  /** Décalage par videoId, cumulé au global. Corrige une version, pas la configuration. */
  trackOffsets: Record<string, number>;
}

export const DEFAULT_FONT_FAMILY =
  '"Segoe UI Variable Display", "Segoe UI", Inter, system-ui, sans-serif';

/** Isolé pour que « Rétablir l'apparence » ne touche ni à l'appairage ni aux décalages. */
export const APPEARANCE_DEFAULTS = {
  opacity: 0.92,
  fontSize: 26,
  fontFamily: DEFAULT_FONT_FAMILY,
  fontWeight: 600,
  textAlign: 'left' as TextAlign,
  accentColor: '#ff2e5b',
  textColor: '#ffffff',
  backgroundColor: '#0c0c10',
  dimOpacity: 0.32,
  cornerRadius: 14,
  frameStyle: 'fin' as FrameStyle,
  textGlow: false,
  showControls: true,
  showOffset: true,
  showTitle: true,
  showSource: true,
};

const DEFAULTS: Config = {
  playerSource: 'ytmd',

  host: '127.0.0.1',
  port: 9863,
  token: null,

  spotifyClientId: null,
  spotifyRefreshToken: null,
  spotifyAccessToken: null,
  spotifyExpiresAt: 0,
  pipBounds: { width: 520, height: 220 },
  pipVisible: true,

  ...APPEARANCE_DEFAULTS,

  clickThrough: false,
  autoHideWhenPaused: true,
  autoHideDelaySeconds: 5,
  syncKey: 's',
  autoCalibrate: true,
  calibrationHistory: [],

  offsetMs: 0,
  trackOffsets: {},
};

let cache: Config | null = null;
let saveTimer: NodeJS.Timeout | null = null;

function configPath(): string {
  return path.join(app.getPath('userData'), 'config.json');
}

export function getConfig(): Config {
  if (cache) return cache;
  let loaded: Partial<Config> = {};
  try {
    loaded = JSON.parse(fs.readFileSync(configPath(), 'utf8')) as Partial<Config>;
  } catch {
    // Premier lancement ou fichier corrompu : on repart des valeurs par défaut.
  }
  cache = {
    ...DEFAULTS,
    ...loaded,
    pipBounds: { ...DEFAULTS.pipBounds, ...loaded.pipBounds },
    trackOffsets: { ...loaded.trackOffsets },
    calibrationHistory: [...(loaded.calibrationHistory ?? [])],
  };
  return cache;
}

export function updateConfig(patch: Partial<Config>): Config {
  const next = { ...getConfig(), ...patch };
  cache = next;
  // Les bounds de fenêtre changent à chaque pixel déplacé : on temporise l'écriture.
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(flushConfig, 400);
  return next;
}

/** Décalage effectif d'un morceau : global + correction propre à sa version. */
export function effectiveOffsets(videoId: string | null): {
  offsetMs: number;
  trackOffsetMs: number;
} {
  const config = getConfig();
  return {
    offsetMs: config.offsetMs,
    trackOffsetMs: videoId ? (config.trackOffsets[videoId] ?? 0) : 0,
  };
}

export function setTrackOffset(videoId: string, offsetMs: number): void {
  const trackOffsets = { ...getConfig().trackOffsets };
  if (offsetMs === 0) {
    delete trackOffsets[videoId];
  } else {
    // Réinsérer place la clé en fin d'objet : l'ordre d'insertion sert d'ancienneté.
    delete trackOffsets[videoId];
    trackOffsets[videoId] = offsetMs;
  }

  const keys = Object.keys(trackOffsets);
  if (keys.length > MAX_TRACK_OFFSETS) {
    for (const stale of keys.slice(0, keys.length - MAX_TRACK_OFFSETS)) {
      delete trackOffsets[stale];
    }
  }

  updateConfig({ trackOffsets });
}

export function flushConfig(): void {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  if (!cache) return;
  try {
    fs.mkdirSync(path.dirname(configPath()), { recursive: true });
    fs.writeFileSync(configPath(), JSON.stringify(cache, null, 2), 'utf8');
  } catch (err) {
    console.error('[config] écriture impossible :', err);
  }
}
