import { EventEmitter } from 'node:events';
import { getConfig } from '../config';
import { YtmdClient } from '../ytmd';
import { TrackState, type ConnectionStatus, type PlayerCommand } from '../../shared/types';
import type { NowPlaying, PlayerSource, PlayerSourceId } from './types';

/** Adapte le client Companion Server à l'interface commune des sources. */
export class YtmdSource extends EventEmitter implements PlayerSource {
  readonly id: PlayerSourceId = 'ytmd';
  readonly label = 'YouTube Music Desktop';

  private client: YtmdClient;

  constructor() {
    super();
    const { host, port } = getConfig();
    this.client = new YtmdClient(host, port);

    this.client.on('status', (status) => this.emit('status', status));
    this.client.on('state', (state) => {
      const video = state.video;
      const player = state.player;
      const thumbnail =
        [...(video?.thumbnails ?? [])].sort((a, b) => b.width - a.width)[0]?.url ?? null;

      const now: NowPlaying = {
        id: video?.id ?? null,
        title: video?.title ?? '',
        artist: video?.author ?? '',
        album: video?.album ?? null,
        durationSeconds: video?.durationSeconds ?? 0,
        progressSeconds: player?.videoProgress ?? 0,
        playing: player?.trackState === TrackState.Playing,
        adPlaying: Boolean(player?.adPlaying),
        thumbnail,
      };
      this.emit('now', now);
    });
  }

  /** Le client sous-jacent, pour l'appairage qui reste propre à cette source. */
  get companion(): YtmdClient {
    return this.client;
  }

  isConfigured(): boolean {
    return Boolean(getConfig().token);
  }

  start(): void {
    const { token, host, port } = getConfig();
    this.client.setEndpoint(host, port);
    if (!token) {
      this.emit('status', {
        state: 'unauthorized',
        message: 'Application non appairée à YouTube Music Desktop.',
      } satisfies ConnectionStatus);
      return;
    }
    this.client.connect(token);
  }

  stop(): void {
    this.client.disconnect();
  }

  getStatus(): ConnectionStatus {
    return this.client.getStatus();
  }

  async sendCommand(command: PlayerCommand): Promise<void> {
    const { token } = getConfig();
    if (!token) return;
    await this.client.sendCommand(token, command);
  }
}
