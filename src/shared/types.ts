/** Types partagés entre le main, le preload et les renderers. */

/** Companion Server : -1 inconnu, 0 pause, 1 lecture, 2 buffering. */
export const TrackState = {
  Unknown: -1,
  Paused: 0,
  Playing: 1,
  Buffering: 2,
} as const;

export interface YtmdThumbnail {
  url: string;
  width: number;
  height: number;
}

export interface YtmdVideo {
  author: string;
  channelId: string;
  title: string;
  album: string | null;
  albumId: string | null;
  likeStatus: number | null;
  thumbnails: YtmdThumbnail[];
  durationSeconds: number;
  id: string;
}

export interface YtmdPlayer {
  trackState: number;
  videoProgress: number;
  volume: number;
  adPlaying: boolean;
  queue: unknown | null;
}

export interface YtmdState {
  player: YtmdPlayer;
  video: YtmdVideo | null;
  playlistId: string;
}

/** Ce dont la recherche de paroles a besoin, indépendamment de la source de lecture. */
export interface TrackQuery {
  id: string;
  title: string;
  author: string;
  album: string | null;
  durationSeconds: number;
}

/** Un mot horodaté, quand la source fournit des timings mot-à-mot (« enhanced LRC »). */
export interface LyricWord {
  time: number;
  /** Fin du mot, quand elle est connue : sans elle, un mot finit au début du suivant. */
  end?: number;
  text: string;
  /**
   * `false` quand aucun espace ne suit : syllabes d'un même mot, écritures sans
   * espaces (japonais, chinois). Absent = un espace suit, ce qui couvre aussi
   * les entrées mises en cache avant l'apparition de ce champ.
   */
  space?: false;
}

/** Une ligne de paroles horodatée. `time` en secondes depuis le début du morceau. */
export interface LyricLine {
  time: number;
  text: string;
  /**
   * Mots horodatés. Fournis par la source (yrc, LRC « enhanced ») ou, avant
   * l'envoi à la PiP, estimés à partir de la ligne : `estimated` les distingue.
   */
  words?: LyricWord[];
  estimated?: boolean;
}

export interface LyricsResult {
  /** `synced` = LRC horodaté, `plain` = texte brut sans timing, `none` = introuvable. */
  kind: 'synced' | 'plain' | 'none';
  lines: LyricLine[];
  source: string | null;
  /** Renseigné quand `kind === 'none'` : pourquoi la recherche a échoué. */
  message?: string;
}

/** Point de synchronisation envoyé au renderer PiP. */
export interface SyncPayload {
  videoId: string | null;
  title: string;
  author: string;
  durationSeconds: number;
  /** Progression rapportée par YTMD, en secondes. */
  progress: number;
  playing: boolean;
  adPlaying: boolean;
}

export type TextAlign = 'left' | 'center' | 'right';

/**
 * Décoration du cadre.
 *
 * Les variantes statiques sont peintes une seule fois et ne coûtent plus rien
 * ensuite. Les variantes animées (suffixées ou nommées à part) tournent en
 * continu : `lueur-pulse`, `scanlines-anim` et `petales` n'animent que
 * `transform` et `opacity`, donc restent sur le fil du compositeur ; `balayage`
 * repeint un dégradé conique, et est volontairement cadencé par `steps()` pour
 * limiter le nombre de repeints.
 */
export type FrameStyle =
  | 'aucun'
  | 'fin'
  | 'lueur'
  | 'double'
  | 'coins'
  | 'ruban'
  | 'scanlines'
  | 'lueur-pulse'
  | 'balayage'
  | 'scanlines-anim'
  | 'petales';

export interface PipSettings {
  // Apparence
  opacity: number;
  fontSize: number;
  fontFamily: string;
  fontWeight: number;
  textAlign: TextAlign;
  accentColor: string;
  textColor: string;
  backgroundColor: string;
  /** Opacité des lignes non courantes, entre 0 et 1. */
  dimOpacity: number;
  cornerRadius: number;
  frameStyle: FrameStyle;
  /** Halo sur la ligne chantée. Léger surcoût de peinture, d'où le réglage. */
  textGlow: boolean;

  // Éléments visibles. Les boutons ⚙ et ✕ ne sont volontairement pas masquables :
  // ils sont le seul chemin de retour vers les réglages depuis la fenêtre.
  showControls: boolean;
  showOffset: boolean;
  showTitle: boolean;
  showSource: boolean;

  // Comportement
  clickThrough: boolean;
  /**
   * Escamote la fenêtre après un temps de pause, et la ramène à la reprise.
   * Une fenêtre cachée ne rend plus rien : c'est l'économie la plus franche.
   */
  autoHideWhenPaused: boolean;
  autoHideDelaySeconds: number;
  /** Touche du calage manuel, telle que rapportée par KeyboardEvent.key. */
  syncKey: string;
  /** Apprend le décalage systématique à partir des calages et l'applique partout. */
  autoCalibrate: boolean;
  /** Nombre de calages déjà mesurés, pour l'affichage seul. */
  calibrationSamples: number;
  /** Décalage global, en ms. Positif = les paroles arrivent plus tôt. */
  offsetMs: number;
  /**
   * Décalage propre au morceau courant, en ms. Cumulé au global.
   * Vit à part car il corrige une version (clip contre audio), pas la configuration.
   */
  trackOffsetMs: number;
}

export type ConnectionStatus =
  | { state: 'disconnected'; message?: string }
  | { state: 'connecting' }
  | { state: 'connected' }
  | { state: 'unauthorized'; message?: string };

export type PlayerCommand =
  | 'playPause'
  | 'play'
  | 'pause'
  | 'next'
  | 'previous'
  | 'toggleLike'
  | 'toggleDislike';
