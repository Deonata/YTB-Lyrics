import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { getConfig } from '../config';
import type { ConnectionStatus, PlayerCommand } from '../../shared/types';
import type { NowPlaying, PlayerSource, PlayerSourceId } from './types';

/**
 * Identifiant présenté au plugin « API Server » de Pear Desktop. Pear le range
 * dans `authorizedClients` : le changer obligerait chaque utilisateur à réappairer.
 */
export const PEAR_CLIENT_ID = 'ytmlyricspip';

/** Le serveur ferme le WebSocket avec ce code quand le jeton est absent ou refusé. */
const WS_POLICY_VIOLATION = 1008;

/** Morceau tel que le décrit Pear (`SongInfo`, plugin api-server, v3.12.0). */
export interface PearSong {
  title: string;
  artist: string;
  album?: string | null;
  imageSrc?: string | null;
  isPaused?: boolean;
  songDuration: number;
  elapsedSeconds?: number;
  videoId: string;
}

/**
 * Messages du WebSocket `/api/v1/ws`. Chacun ne porte que ce qui a changé :
 * l'état complet n'arrive qu'à l'ouverture (`PLAYER_INFO`).
 */
export type PearMessage =
  | { type: 'PLAYER_INFO'; song?: PearSong; isPlaying: boolean; position: number }
  | { type: 'VIDEO_CHANGED'; song: PearSong; position: number }
  | { type: 'PLAYER_STATE_CHANGED'; isPlaying: boolean; position: number }
  | { type: 'POSITION_CHANGED'; position: number }
  | { type: string };

/** Routes POST de l'API ; Pear n'a pas de « like » bascule, `/like` en tient lieu. */
const COMMAND_ROUTES: Record<PlayerCommand, string> = {
  playPause: '/toggle-play',
  play: '/play',
  pause: '/pause',
  next: '/next',
  previous: '/previous',
  toggleLike: '/like',
  toggleDislike: '/dislike',
};

const UNAUTHORIZED_MESSAGE =
  'Pear Desktop a refusé le jeton (révoqué, ou configuration du plugin réinitialisée). Un nouvel appairage est nécessaire.';

export class PearError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message);
    this.name = 'PearError';
  }
}

/**
 * État courant reconstitué à partir des messages partiels. Isolé de la
 * connexion pour être testable sans serveur.
 */
export class PearStateReducer {
  private song: PearSong | null = null;
  private playing = false;
  private position = 0;

  /** Applique un message ; rend le nouvel état, ou `null` s'il ne change rien d'utile. */
  apply(message: PearMessage): NowPlaying | null {
    switch (message.type) {
      case 'PLAYER_INFO': {
        const m = message as Extract<PearMessage, { type: 'PLAYER_INFO' }>;
        this.song = m.song ?? null;
        this.playing = m.isPlaying;
        this.position = m.position;
        break;
      }
      case 'VIDEO_CHANGED': {
        const m = message as Extract<PearMessage, { type: 'VIDEO_CHANGED' }>;
        this.song = m.song;
        this.position = m.position;
        // Pear ne renvoie pas `isPlaying` ici ; `isPaused` du morceau fait foi.
        if (typeof m.song.isPaused === 'boolean') this.playing = !m.song.isPaused;
        break;
      }
      case 'PLAYER_STATE_CHANGED': {
        const m = message as Extract<PearMessage, { type: 'PLAYER_STATE_CHANGED' }>;
        this.playing = m.isPlaying;
        this.position = m.position;
        break;
      }
      case 'POSITION_CHANGED': {
        const m = message as Extract<PearMessage, { type: 'POSITION_CHANGED' }>;
        this.position = m.position;
        break;
      }
      default:
        // Volume, répétition, aléatoire : sans effet sur les paroles.
        return null;
    }
    return this.snapshot();
  }

  /** Amorçage par `GET /api/v1/song`, qui renvoie le morceau seul. */
  seed(song: PearSong): NowPlaying {
    this.song = song;
    this.playing = !song.isPaused;
    this.position = song.elapsedSeconds ?? 0;
    return this.snapshot();
  }

  reset(): void {
    this.song = null;
    this.playing = false;
    this.position = 0;
  }

  private snapshot(): NowPlaying {
    const song = this.song;
    return {
      id: song?.videoId ?? null,
      title: song?.title ?? '',
      artist: song?.artist ?? '',
      album: song?.album ?? null,
      durationSeconds: song?.songDuration ?? 0,
      progressSeconds: this.position,
      playing: song ? this.playing : false,
      // Pear ne signale pas les publicités (il embarque son propre bloqueur).
      adPlaying: false,
      thumbnail: song?.imageSrc ?? null,
    };
  }
}

/**
 * Pear Desktop (ex-« th-ch/youtube-music ») via son plugin « API Server » :
 * REST pour l'appairage et les commandes, WebSocket brut pour le temps réel.
 */
export class PearSource extends EventEmitter implements PlayerSource {
  readonly id: PlayerSourceId = 'pear';
  readonly label = 'Pear Desktop';

  private socket: WebSocket | null = null;
  private status: ConnectionStatus = { state: 'disconnected' };
  private reducer = new PearStateReducer();
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectDelay = 1000;
  private stopped = true;

  constructor(
    private host = getConfig().pearHost,
    private port = getConfig().pearPort,
  ) {
    super();
  }

  private get baseUrl(): string {
    return `http://${this.host}:${this.port}`;
  }

  private setStatus(status: ConnectionStatus): void {
    this.status = status;
    this.emit('status', status);
  }

  getStatus(): ConnectionStatus {
    return this.status;
  }

  isConfigured(): boolean {
    return Boolean(getConfig().pearToken);
  }

  private async request(
    path: string,
    init: RequestInit & { timeoutMs?: number } = {},
  ): Promise<Response> {
    const { timeoutMs = 10_000, ...rest } = init;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(`${this.baseUrl}${path}`, { ...rest, signal: controller.signal });
    } catch {
      if (controller.signal.aborted) {
        throw new PearError('Pear Desktop ne répond pas.', null);
      }
      throw new PearError(
        `Impossible de joindre Pear Desktop sur ${this.host}:${this.port}. Le plugin « API Server » est-il activé ?`,
        null,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Vérifie que l'API répond, sans jeton. `/doc` (spécification OpenAPI) est
   * public quelle que soit la stratégie d'authentification.
   */
  async probe(): Promise<void> {
    const res = await this.request('/doc', { timeoutMs: 4000 });
    if (!res.ok) throw new PearError(`Réponse inattendue (HTTP ${res.status}).`, res.status);
  }

  /**
   * Demande un jeton. Pear affiche alors une boîte « Autoriser / Refuser » ;
   * la requête reste ouverte tant que l'utilisateur n'a pas répondu, d'où
   * l'absence de délai court. Le JWT rendu n'expire pas.
   */
  async requestToken(): Promise<string> {
    const res = await this.request(`/auth/${PEAR_CLIENT_ID}`, {
      method: 'POST',
      timeoutMs: 120_000,
    });
    if (res.status === 403) throw new PearError('Autorisation refusée dans Pear Desktop.', 403);
    if (!res.ok) throw new PearError(`Appairage impossible (HTTP ${res.status}).`, res.status);
    const body = (await res.json()) as { accessToken?: string };
    if (!body.accessToken) throw new PearError('Pear Desktop n’a pas rendu de jeton.', null);
    return body.accessToken;
  }

  private authHeaders(): Record<string, string> {
    const { pearToken } = getConfig();
    return pearToken ? { Authorization: `Bearer ${pearToken}` } : {};
  }

  /** Morceau courant ; `null` si rien ne joue (204). */
  private async fetchSong(): Promise<PearSong | null> {
    const res = await this.request('/api/v1/song', { headers: this.authHeaders() });
    if (res.status === 401) throw new PearError(UNAUTHORIZED_MESSAGE, 401);
    if (res.status === 204 || !res.ok) return null;
    return (await res.json()) as PearSong;
  }

  start(): void {
    const { pearToken, pearHost, pearPort } = getConfig();
    this.host = pearHost;
    this.port = pearPort;
    this.stopped = false;
    if (!pearToken) {
      this.setStatus({
        state: 'unauthorized',
        message: 'Application non appairée à Pear Desktop.',
      });
      return;
    }
    this.connect(pearToken);
  }

  private connect(token: string): void {
    this.closeSocket();
    this.setStatus({ state: 'connecting' });

    const url = `ws://${this.host}:${this.port}/api/v1/ws?token=${encodeURIComponent(token)}`;
    const socket = new WebSocket(url, { handshakeTimeout: 8000 });
    this.socket = socket;

    socket.on('open', () => {
      this.reconnectDelay = 1000;
      this.setStatus({ state: 'connected' });
    });

    socket.on('message', (data) => {
      let message: PearMessage;
      try {
        message = JSON.parse(data.toString()) as PearMessage;
      } catch {
        return;
      }
      const now = this.reducer.apply(message);
      if (now) this.emit('now', now);

      // `PLAYER_INFO` est vide tant que Pear n'a rien diffusé depuis son
      // lancement : on complète par REST.
      if (message.type === 'PLAYER_INFO' && !now?.id) {
        this.fetchSong()
          .then((song) => {
            if (song && this.socket === socket) this.emit('now', this.reducer.seed(song));
          })
          .catch(() => undefined);
      }
    });

    socket.on('close', (code, reason) => {
      if (this.socket !== socket) return;
      this.socket = null;
      if (this.stopped) return;

      if (code === WS_POLICY_VIOLATION) {
        // Jeton refusé : inutile de boucler, il faut réappairer.
        this.setStatus({ state: 'unauthorized', message: UNAUTHORIZED_MESSAGE });
        return;
      }
      const why = reason.toString() || `code ${code}`;
      this.setStatus({
        state: 'disconnected',
        message: `Connexion à Pear Desktop perdue (${why}). Nouvelle tentative…`,
      });
      this.scheduleReconnect(token);
    });

    socket.on('error', (err) => {
      // Toujours suivi d'un `close`, qui décide de la suite ; on précise seulement le message.
      if (this.socket !== socket || this.stopped) return;
      this.setStatus({
        state: 'disconnected',
        message: `Connexion à Pear Desktop impossible (${err.message}). Nouvelle tentative…`,
      });
    });
  }

  private scheduleReconnect(token: string): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.stopped) this.connect(token);
    }, this.reconnectDelay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, 10_000);
  }

  private closeSocket(): void {
    if (this.socket) {
      const socket = this.socket;
      this.socket = null;
      socket.removeAllListeners();
      // Un `error` émis pendant la fermeture ne doit pas remonter sans écouteur.
      socket.on('error', () => undefined);
      socket.terminate();
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.closeSocket();
    this.reducer.reset();
    this.setStatus({ state: 'disconnected' });
  }

  async sendCommand(command: PlayerCommand): Promise<void> {
    if (!getConfig().pearToken) return;
    const res = await this.request(`/api/v1${COMMAND_ROUTES[command]}`, {
      method: 'POST',
      headers: this.authHeaders(),
    });
    if (res.status === 401) throw new PearError(UNAUTHORIZED_MESSAGE, 401);
    if (!res.ok) throw new PearError(`Commande refusée (HTTP ${res.status}).`, res.status);
  }
}
