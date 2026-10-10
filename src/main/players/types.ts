import type { EventEmitter } from 'node:events';
import type { ConnectionStatus, PlayerCommand } from '../../shared/types';

/** Identifiant de la source de lecture. */
export type PlayerSourceId = 'ytmd' | 'spotify';

/**
 * État de lecture, normalisé pour être indépendant de la source.
 *
 * YouTube Music Desktop pousse cet état par socket ; Spotify demande un
 * sondage périodique. Le reste de l'application ignore cette différence :
 * l'horloge locale du renderer interpole entre deux mises à jour, quelle que
 * soit leur cadence.
 */
export interface NowPlaying {
  /** Identifiant du morceau chez la source ; sert de clé de cache et de décalage. */
  id: string | null;
  title: string;
  artist: string;
  album: string | null;
  durationSeconds: number;
  progressSeconds: number;
  playing: boolean;
  /** Publicité en cours : pas de paroles à afficher, mais la lecture continue. */
  adPlaying: boolean;
  thumbnail: string | null;
}

export interface PlayerSourceEvents {
  now: (state: NowPlaying) => void;
  status: (status: ConnectionStatus) => void;
}

export interface PlayerSource extends EventEmitter {
  readonly id: PlayerSourceId;
  /** Nom affichable, pour les messages d'état. */
  readonly label: string;
  /** Ouvre la connexion ou démarre le sondage. */
  start(): void;
  stop(): void;
  getStatus(): ConnectionStatus;
  /** Certaines sources refusent les commandes (Spotify gratuit) : l'échec est normal. */
  sendCommand(command: PlayerCommand): Promise<void>;
  /** Y a-t-il de quoi se connecter (jeton, identifiant client…) ? */
  isConfigured(): boolean;
}
