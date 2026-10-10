/**
 * Source Spotify.
 *
 * Deux différences de fond avec YouTube Music Desktop :
 *
 * 1. Spotify ne pousse rien : il faut sonder l'API Web. On sonde vite pendant
 *    la lecture, lentement en pause, et on se met en retrait sur un 429.
 * 2. L'autorisation passe par OAuth. On utilise le flux PKCE, prévu pour les
 *    applications installées : aucun secret client n'est nécessaire, donc rien
 *    de sensible n'est embarqué dans l'exécutable.
 */
import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import http from 'node:http';
import { shell } from 'electron';
import { getConfig, updateConfig } from '../config';
import type { ConnectionStatus, PlayerCommand } from '../../shared/types';
import type { NowPlaying, PlayerSource, PlayerSourceId } from './types';

const AUTH_URL = 'https://accounts.spotify.com/authorize';
const TOKEN_URL = 'https://accounts.spotify.com/api/token';
const API = 'https://api.spotify.com/v1';

/**
 * Spotify impose une adresse de bouclage explicite pour les applications
 * installées ; « localhost » est refusé depuis 2025.
 */
export const REDIRECT_PORT = 8888;
export const REDIRECT_URI = `http://127.0.0.1:${REDIRECT_PORT}/callback`;

const SCOPES = [
  'user-read-playback-state',
  'user-read-currently-playing',
  'user-modify-playback-state',
].join(' ');

const POLL_PLAYING_MS = 1000;
const POLL_IDLE_MS = 5000;

interface SpotifyTrack {
  id: string | null;
  name: string;
  duration_ms: number;
  artists?: Array<{ name: string }>;
  album?: { name?: string; images?: Array<{ url: string; width: number }> };
}

interface SpotifyPlayer {
  is_playing: boolean;
  progress_ms: number | null;
  currently_playing_type?: string;
  item: SpotifyTrack | null;
}

function base64url(buffer: Buffer): string {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export class SpotifySource extends EventEmitter implements PlayerSource {
  readonly id: PlayerSourceId = 'spotify';
  readonly label = 'Spotify';

  private timer: NodeJS.Timeout | null = null;
  private status: ConnectionStatus = { state: 'disconnected' };
  private stopped = true;
  /** Report imposé par un 429 : on ne sonde plus avant cette date. */
  private backoffUntil = 0;

  isConfigured(): boolean {
    const c = getConfig();
    return Boolean(c.spotifyClientId && c.spotifyRefreshToken);
  }

  getStatus(): ConnectionStatus {
    return this.status;
  }

  private setStatus(status: ConnectionStatus): void {
    this.status = status;
    this.emit('status', status);
  }

  // -------------------------------------------------------------------------
  // Autorisation (PKCE)
  // -------------------------------------------------------------------------

  /**
   * Ouvre le navigateur, attend le retour sur l'adresse de bouclage, puis
   * échange le code contre des jetons. Rejette si l'utilisateur refuse.
   */
  async authorize(clientId: string): Promise<void> {
    const verifier = base64url(crypto.randomBytes(64));
    const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
    const stateToken = base64url(crypto.randomBytes(16));

    const code = await new Promise<string>((resolve, reject) => {
      const server = http.createServer((req, res) => {
        const url = new URL(req.url ?? '/', REDIRECT_URI);
        if (url.pathname !== '/callback') {
          res.writeHead(404).end();
          return;
        }

        const erreur = url.searchParams.get('error');
        const recu = url.searchParams.get('code');
        const etat = url.searchParams.get('state');

        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(
          `<!doctype html><meta charset="utf-8"><body style="font-family:system-ui;background:#141418;color:#f2f2f5;display:grid;place-items:center;height:100vh;margin:0">
           <p>${erreur || !recu ? 'Autorisation refusée.' : 'Spotify est connecté. Tu peux fermer cet onglet.'}</p></body>`,
        );

        server.close();
        if (erreur || !recu) reject(new Error(erreur ?? 'Aucun code reçu.'));
        // Le paramètre `state` protège d'une réponse forgée arrivant sur le port local.
        else if (etat !== stateToken) reject(new Error('Réponse d’autorisation inattendue.'));
        else resolve(recu);
      });

      server.on('error', (err) =>
        reject(
          new Error(
            `Impossible d'écouter sur le port ${REDIRECT_PORT} (${err.message}). Une autre application l'occupe peut-être.`,
          ),
        ),
      );

      server.listen(REDIRECT_PORT, '127.0.0.1', () => {
        const params = new URLSearchParams({
          client_id: clientId,
          response_type: 'code',
          redirect_uri: REDIRECT_URI,
          code_challenge_method: 'S256',
          code_challenge: challenge,
          state: stateToken,
          scope: SCOPES,
        });
        void shell.openExternal(`${AUTH_URL}?${params}`);
      });

      // Sans limite, un onglet oublié laisserait le serveur ouvert indéfiniment.
      setTimeout(() => {
        server.close();
        reject(new Error("Délai dépassé : l'autorisation n'a pas abouti."));
      }, 180_000);
    });

    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT_URI,
        client_id: clientId,
        code_verifier: verifier,
      }),
    });
    if (!res.ok) {
      const detail = await res.text();
      throw new Error(`Échange du code refusé par Spotify (${res.status}) : ${detail.slice(0, 200)}`);
    }

    const body = (await res.json()) as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
    };
    updateConfig({
      spotifyClientId: clientId,
      spotifyRefreshToken: body.refresh_token,
      spotifyAccessToken: body.access_token,
      spotifyExpiresAt: Date.now() + body.expires_in * 1000,
    });
  }

  /** Jeton d'accès valide, renouvelé si besoin. */
  private async accessToken(): Promise<string | null> {
    const c = getConfig();
    if (!c.spotifyClientId || !c.spotifyRefreshToken) return null;
    // Marge d'une minute : un jeton qui expire pendant la requête serait rejeté.
    if (c.spotifyAccessToken && Date.now() < c.spotifyExpiresAt - 60_000) {
      return c.spotifyAccessToken;
    }

    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: c.spotifyRefreshToken,
        client_id: c.spotifyClientId,
      }),
    });
    if (!res.ok) {
      // Jeton de rafraîchissement révoqué : il faut une nouvelle autorisation.
      if (res.status === 400 || res.status === 401) {
        updateConfig({ spotifyRefreshToken: null, spotifyAccessToken: null, spotifyExpiresAt: 0 });
        this.setStatus({
          state: 'unauthorized',
          message: 'Autorisation Spotify expirée. Reconnecte le compte.',
        });
      }
      return null;
    }

    const body = (await res.json()) as {
      access_token: string;
      expires_in: number;
      refresh_token?: string;
    };
    updateConfig({
      spotifyAccessToken: body.access_token,
      spotifyExpiresAt: Date.now() + body.expires_in * 1000,
      // Spotify fait parfois tourner le jeton de rafraîchissement.
      ...(body.refresh_token ? { spotifyRefreshToken: body.refresh_token } : {}),
    });
    return body.access_token;
  }

  disconnect(): void {
    this.stop();
    updateConfig({ spotifyRefreshToken: null, spotifyAccessToken: null, spotifyExpiresAt: 0 });
    this.setStatus({ state: 'unauthorized', message: 'Compte Spotify dissocié.' });
  }

  // -------------------------------------------------------------------------
  // Sondage
  // -------------------------------------------------------------------------

  start(): void {
    this.stop();
    this.stopped = false;

    if (!getConfig().spotifyClientId) {
      this.setStatus({
        state: 'unauthorized',
        message: 'Identifiant client Spotify manquant : renseigne-le dans les réglages.',
      });
      return;
    }
    if (!getConfig().spotifyRefreshToken) {
      this.setStatus({ state: 'unauthorized', message: 'Compte Spotify non connecté.' });
      return;
    }

    this.setStatus({ state: 'connecting' });
    void this.poll();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.poll(), delayMs);
  }

  private async poll(): Promise<void> {
    if (this.stopped) return;

    const attente = this.backoffUntil - Date.now();
    if (attente > 0) {
      this.schedule(attente);
      return;
    }

    let token: string | null;
    try {
      token = await this.accessToken();
    } catch (err) {
      this.setStatus({ state: 'disconnected', message: (err as Error).message });
      this.schedule(POLL_IDLE_MS);
      return;
    }
    if (!token) {
      this.schedule(POLL_IDLE_MS);
      return;
    }

    try {
      const res = await fetch(`${API}/me/player`, {
        headers: { Authorization: `Bearer ${token}` },
      });

      if (res.status === 429) {
        // Spotify indique en secondes combien de temps se taire.
        const retry = Number(res.headers.get('retry-after') ?? '5');
        this.backoffUntil = Date.now() + (Number.isFinite(retry) ? retry : 5) * 1000 + 500;
        this.schedule(retry * 1000);
        return;
      }

      if (res.status === 401) {
        updateConfig({ spotifyAccessToken: null, spotifyExpiresAt: 0 });
        this.schedule(1000);
        return;
      }

      if (this.status.state !== 'connected') this.setStatus({ state: 'connected' });

      // 204 : Spotify est joignable mais aucun appareil ne lit quoi que ce soit.
      if (res.status === 204) {
        this.emit('now', this.silence());
        this.schedule(POLL_IDLE_MS);
        return;
      }

      if (!res.ok) {
        this.schedule(POLL_IDLE_MS);
        return;
      }

      const body = (await res.json()) as SpotifyPlayer;
      const now = this.toNowPlaying(body);
      this.emit('now', now);
      this.schedule(now.playing ? POLL_PLAYING_MS : POLL_IDLE_MS);
    } catch (err) {
      this.setStatus({
        state: 'disconnected',
        message: `Spotify injoignable (${(err as Error).message}).`,
      });
      this.schedule(POLL_IDLE_MS);
    }
  }

  private silence(): NowPlaying {
    return {
      id: null,
      title: '',
      artist: '',
      album: null,
      durationSeconds: 0,
      progressSeconds: 0,
      playing: false,
      adPlaying: false,
      thumbnail: null,
    };
  }

  private toNowPlaying(body: SpotifyPlayer): NowPlaying {
    const item = body.item;
    if (!item) return { ...this.silence(), playing: Boolean(body.is_playing) };

    const thumbnail =
      [...(item.album?.images ?? [])].sort((a, b) => (b.width ?? 0) - (a.width ?? 0))[0]?.url ??
      null;

    return {
      id: item.id,
      title: item.name ?? '',
      artist: (item.artists ?? []).map((a) => a.name).join(', '),
      album: item.album?.name ?? null,
      durationSeconds: Math.round((item.duration_ms ?? 0) / 1000),
      progressSeconds: (body.progress_ms ?? 0) / 1000,
      playing: Boolean(body.is_playing),
      // Les publicités du compte gratuit ne sont pas des pistes musicales.
      adPlaying: body.currently_playing_type === 'ad',
      thumbnail,
    };
  }

  // -------------------------------------------------------------------------
  // Commandes
  // -------------------------------------------------------------------------

  async sendCommand(command: PlayerCommand): Promise<void> {
    const token = await this.accessToken();
    if (!token) return;

    const routes: Partial<Record<PlayerCommand, { method: string; path: string }>> = {
      play: { method: 'PUT', path: '/me/player/play' },
      pause: { method: 'PUT', path: '/me/player/pause' },
      next: { method: 'POST', path: '/me/player/next' },
      previous: { method: 'POST', path: '/me/player/previous' },
    };

    // Spotify n'a pas de bascule : on choisit d'après l'état courant.
    const effectif =
      command === 'playPause' ? (this.lastPlaying ? 'pause' : 'play') : command;
    const route = routes[effectif as PlayerCommand];
    if (!route) return;

    const res = await fetch(`${API}${route.path}`, {
      method: route.method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Length': '0' },
    });

    // 403 = compte gratuit : le contrôle de lecture est réservé aux abonnés Premium.
    if (res.status === 403) {
      throw new Error('Spotify refuse le contrôle de lecture (compte non Premium).');
    }
    if (res.status === 404) {
      throw new Error('Aucun appareil Spotify actif à contrôler.');
    }
  }

  /** Dernier état connu, pour donner un sens à « lecture/pause ». */
  private lastPlaying = false;

  constructor() {
    super();
    this.on('now', (state: NowPlaying) => {
      this.lastPlaying = state.playing;
    });
  }
}
