import { EventEmitter } from 'node:events';
import { io, type Socket } from 'socket.io-client';
import type { ConnectionStatus, PlayerCommand, YtmdState } from '../shared/types';

/** Contraintes du serveur : appId minuscule alphanumérique 2-32, appVersion en semver. */
export const APP_ID = 'ytmlyricspip';
export const APP_NAME = 'YTM Lyrics PiP';
export const APP_VERSION = '0.1.0';

/** Codes d'erreur renvoyés par le Companion Server, traduits pour l'UI. */
const ERROR_MESSAGES: Record<string, string> = {
  AUTHORIZATION_DISABLED:
    "YTMDesktop refuse les demandes d'autorisation. Active « Enable companion authorization » dans Settings → Integrations → Companion Server.",
  AUTHORIZATION_DENIED: "Autorisation refusée dans YTMDesktop.",
  AUTHORIZATION_TIME_OUT: "Délai dépassé : la demande n'a pas été validée dans YTMDesktop à temps.",
  AUTHORIZATION_INVALID: "Code d'autorisation invalide ou expiré. Recommence l'appairage.",
  AUTHORIZATION_TOO_MANY: "Trop de demandes d'autorisation en cours dans YTMDesktop.",
  UNAUTHENTICATED: "Jeton invalide ou révoqué. Un nouvel appairage est nécessaire.",
  YOUTUBE_MUSIC_UNVAILABLE: 'YouTube Music est momentanément indisponible.',
  YOUTUBE_MUSIC_TIME_OUT: 'YouTube Music a mis trop de temps à répondre.',
};

export class CompanionError extends Error {
  constructor(
    message: string,
    readonly code: string | null,
    readonly status: number | null,
  ) {
    super(message);
    this.name = 'CompanionError';
  }
}

export interface YtmdClientEvents {
  state: (state: YtmdState) => void;
  status: (status: ConnectionStatus) => void;
}

export declare interface YtmdClient {
  on<K extends keyof YtmdClientEvents>(event: K, listener: YtmdClientEvents[K]): this;
  emit<K extends keyof YtmdClientEvents>(
    event: K,
    ...args: Parameters<YtmdClientEvents[K]>
  ): boolean;
}

export class YtmdClient extends EventEmitter {
  private socket: Socket | null = null;
  private host: string;
  private port: number;
  private status: ConnectionStatus = { state: 'disconnected' };

  constructor(host: string, port: number) {
    super();
    this.host = host;
    this.port = port;
  }

  get baseUrl(): string {
    return `http://${this.host}:${this.port}/api/v1`;
  }

  getStatus(): ConnectionStatus {
    return this.status;
  }

  setEndpoint(host: string, port: number): void {
    this.host = host;
    this.port = port;
  }

  private setStatus(status: ConnectionStatus): void {
    this.status = status;
    this.emit('status', status);
  }

  private async request<T>(
    path: string,
    init: RequestInit & { timeoutMs?: number } = {},
  ): Promise<T> {
    return this.requestUrl(`${this.baseUrl}${path}`, init);
  }

  private async requestUrl<T>(
    url: string,
    init: RequestInit & { timeoutMs?: number } = {},
  ): Promise<T> {
    const { timeoutMs = 10_000, ...rest } = init;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetch(url, { ...rest, signal: controller.signal });
    } catch (err) {
      if (controller.signal.aborted) {
        throw new CompanionError('Le Companion Server ne répond pas.', null, null);
      }
      throw new CompanionError(
        `Impossible de joindre YTMDesktop sur ${this.host}:${this.port}. Le Companion Server est-il activé ?`,
        null,
        null,
      );
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      let code: string | null = null;
      let message = `HTTP ${res.status}`;
      try {
        const body = (await res.json()) as { code?: string; message?: string };
        code = body.code ?? null;
        message = body.message ?? message;
      } catch {
        // Corps non-JSON : on garde le message HTTP générique.
      }
      throw new CompanionError(
        (code && ERROR_MESSAGES[code]) || message,
        code,
        res.status,
      );
    }

    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  /**
   * Endpoint public : sert à vérifier que le serveur tourne avant tout appairage.
   * Il vit à la racine, pas sous `/api/v1` — contrairement à ce que laisse croire
   * le wiki, qui le documente sous l'en-tête « Base URL ». Vérifié en direct :
   * `/metadata` répond 200, `/api/v1/metadata` répond 404.
   */
  async getMetadata(): Promise<{ apiVersions: string[] }> {
    return this.requestUrl(`http://${this.host}:${this.port}/metadata`, { timeoutMs: 4000 });
  }

  /** Étape 1 de l'appairage : récupère le code à comparer avec celui affiché par YTMDesktop. */
  async requestCode(): Promise<string> {
    const body = await this.request<{ code: string }>('/auth/requestcode', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appId: APP_ID, appName: APP_NAME, appVersion: APP_VERSION }),
      timeoutMs: 15_000,
    });
    return body.code;
  }

  /**
   * Étape 2 : bloque jusqu'à ce que l'utilisateur valide dans YTMDesktop (30 s max côté serveur).
   */
  async requestToken(code: string): Promise<string> {
    const body = await this.request<{ token: string }>('/auth/request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appId: APP_ID, code }),
      timeoutMs: 45_000,
    });
    return body.token;
  }

  async fetchState(token: string): Promise<YtmdState> {
    return this.request<YtmdState>('/state', { headers: { Authorization: token } });
  }

  async sendCommand(token: string, command: PlayerCommand): Promise<void> {
    await this.request('/command', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: token },
      body: JSON.stringify({ command }),
    });
  }

  /** Ouvre le flux temps réel. `/api/v1/realtime` est un namespace socket.io, pas un path. */
  connect(token: string): void {
    this.disconnect();
    this.setStatus({ state: 'connecting' });

    // IPv4 explicite : « localhost » peut résoudre en ::1 et échouer sur certains systèmes.
    const socket = io(`http://${this.host}:${this.port}/api/v1/realtime`, {
      transports: ['websocket'],
      auth: { token },
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 10_000,
      timeout: 8000,
    });
    this.socket = socket;

    socket.on('connect', () => {
      this.setStatus({ state: 'connected' });
      // Le premier state-update n'arrive qu'au prochain changement : on amorce via REST.
      this.fetchState(token)
        .then((state) => this.emit('state', state))
        .catch(() => undefined);
    });

    socket.on('state-update', (state: YtmdState) => {
      this.emit('state', state);
    });

    socket.on('connect_error', (err: Error & { data?: { code?: string } }) => {
      const code = err.data?.code;
      if (code === 'UNAUTHENTICATED' || /unauthenticated/i.test(err.message)) {
        // Jeton révoqué : inutile de boucler en reconnexion, il faut réappairer.
        socket.disconnect();
        this.setStatus({ state: 'unauthorized', message: ERROR_MESSAGES.UNAUTHENTICATED });
        return;
      }
      this.setStatus({
        state: 'disconnected',
        message: `Connexion à YTMDesktop impossible (${err.message}). Nouvelle tentative…`,
      });
    });

    socket.on('disconnect', (reason: string) => {
      if (this.status.state === 'unauthorized') return;
      this.setStatus({ state: 'disconnected', message: `Déconnecté (${reason})` });
    });
  }

  disconnect(): void {
    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.disconnect();
      this.socket = null;
    }
    this.setStatus({ state: 'disconnected' });
  }
}
