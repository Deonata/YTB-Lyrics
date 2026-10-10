/**
 * Source d'appoint : NetEase Cloud Music.
 *
 * Bien meilleure couverture que LRCLIB sur le japonais, le coréen et le chinois,
 * et fournit parfois du mot-à-mot réel (format « yrc »). L'API n'est pas
 * officielle : elle peut changer ou être restreinte, d'où le traitement en
 * appoint — toute erreur se solde par « pas de résultat », jamais par un échec.
 */
import type { LyricsResult } from '../../shared/types';
import { fetchJson, qs } from './http';
import { parseLrc, parseYrc } from './lrc';
import {
  adjustForCover,
  describeVersion,
  isAcceptable,
  scoreCandidate,
  type Candidate,
  type MatchTarget,
  type SourceOutcome,
} from './match';

const BASE = 'https://music.163.com/api';
// Le Referer est obligatoire : sans lui l'API renvoie une erreur d'autorisation.
const HEADERS = {
  Referer: 'https://music.163.com',
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
};

interface NeteaseSong {
  id: number;
  name: string;
  /** En millisecondes, contrairement à LRCLIB. */
  duration: number;
  artists?: Array<{ name: string }>;
  album?: { name: string };
}

interface NeteaseSearch {
  result?: { songs?: NeteaseSong[] };
}

interface NeteaseLyric {
  lrc?: { lyric?: string };
  yrc?: { lyric?: string };
  klyric?: { lyric?: string };
  /** `true` quand NetEase connaît le morceau mais n'a aucune parole. */
  uncollected?: boolean;
}

const toCandidate = (song: NeteaseSong): Candidate => ({
  artistName: (song.artists ?? []).map((a) => a.name).join(', '),
  trackName: song.name,
  albumName: song.album?.name ?? null,
  duration: Math.round(song.duration / 1000),
});

async function fetchLyrics(id: number): Promise<NeteaseLyric | null> {
  return fetchJson<NeteaseLyric>(
    `${BASE}/song/lyric?${qs({ id, lv: 1, kv: 1, tv: -1, yv: 1 })}`,
    { headers: HEADERS, label: 'netease' },
  );
}

function toResult(song: NeteaseSong, lyric: NeteaseLyric, target: MatchTarget): LyricsResult | null {
  const candidate = toCandidate(song);
  const base = `NetEase · ${candidate.artistName} — ${song.name}${describeVersion(candidate, target)}`;

  const finaliser = (kind: 'synced' | 'plain', lines: ReturnType<typeof parseLrc>): LyricsResult => {
    const ajuste = adjustForCover(lines, candidate, target);
    return { kind, lines: ajuste.lines, source: base + ajuste.note };
  };

  // Le « yrc » est horodaté au mot : c'est ce qui donne le meilleur rendu.
  const yrc = lyric.yrc?.lyric;
  if (yrc) {
    const lines = parseYrc(yrc);
    if (lines.length > 0) return finaliser('synced', lines);
  }

  const lrc = lyric.lrc?.lyric;
  if (lrc) {
    const lines = parseLrc(lrc);
    // NetEase sert parfois un « LRC » sans aucun timestamp exploitable : tout
    // se retrouve alors à 0 s, ce qui n'est pas du synchronisé.
    if (lines.length > 1 && lines[lines.length - 1]!.time > 0) {
      return finaliser('synced', lines);
    }
    if (lines.length > 0) return finaliser('plain', lines);
  }

  return null;
}

export async function searchNetease(target: MatchTarget): Promise<SourceOutcome> {
  const { title, artist, rawTitle } = target;
  const queries = [`${artist} ${title}`.trim(), title, rawTitle];

  let sawRejected = false;
  const tried = new Set<string>();

  for (const query of queries) {
    if (!query || tried.has(query)) continue;
    tried.add(query);

    const search = await fetchJson<NeteaseSearch>(
      `${BASE}/search/get?${qs({ s: query, type: 1, limit: 10 })}`,
      { headers: HEADERS, label: 'netease' },
    );
    const songs = search?.result?.songs;
    if (!songs || songs.length === 0) continue;

    const accepted = songs.filter((song) => {
      if (isAcceptable(toCandidate(song), target)) return true;
      sawRejected = true;
      return false;
    });
    if (accepted.length === 0) continue;

    // On ignore la présence de paroles ici : elle n'est connue qu'après un second
    // appel, qu'on ne fait que pour les meilleurs candidats.
    const ranked = accepted
      .map((song) => ({ song, score: scoreCandidate(toCandidate(song), target, false, false) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 3);

    let plainFallback: LyricsResult | null = null;
    for (const { song } of ranked) {
      const lyric = await fetchLyrics(song.id);
      if (!lyric || lyric.uncollected) continue;
      const result = toResult(song, lyric, target);
      if (result?.kind === 'synced') return { result, sawRejected };
      if (result && !plainFallback) plainFallback = result;
    }
    if (plainFallback) return { result: plainFallback, sawRejected };
  }

  return { result: null, sawRejected };
}
