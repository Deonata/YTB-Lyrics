import type { LyricsResult } from '../../shared/types';
import { fetchJson, qs } from './http';
import { parseLrc, parsePlain } from './lrc';
import {
  adjustForCover,
  describeVersion,
  isAcceptable,
  scoreCandidate,
  type Candidate,
  type MatchTarget,
  type SourceOutcome,
} from './match';

const BASE = 'https://lrclib.net/api';
const USER_AGENT = 'YTM-Lyrics-PiP/0.1.0 (https://github.com/MRbab/ytm-lyrics-pip)';

interface LrclibRecord {
  id: number;
  trackName: string;
  artistName: string;
  albumName: string | null;
  duration: number | null;
  instrumental: boolean;
  plainLyrics: string | null;
  syncedLyrics: string | null;
}

const toCandidate = (rec: LrclibRecord): Candidate => ({
  artistName: rec.artistName,
  trackName: rec.trackName,
  albumName: rec.albumName,
  duration: rec.duration,
});

function get(path: string) {
  return fetchJson<LrclibRecord>(`${BASE}${path}`, {
    headers: { 'User-Agent': USER_AGENT },
    label: 'lrclib',
  });
}

function toResult(rec: LrclibRecord, target: MatchTarget): LyricsResult | null {
  const candidate = toCandidate(rec);
  const base = `LRCLIB · ${rec.artistName} — ${rec.trackName}${describeVersion(candidate, target)}`;

  // En mode reprise, `adjustForCover` étire les timings de l'original sur la
  // durée jouée et signale l'opération dans le libellé de source.
  const finaliser = (
    kind: 'synced' | 'plain',
    lines: ReturnType<typeof parseLrc>,
  ): LyricsResult => {
    const ajuste = adjustForCover(lines, candidate, target);
    return { kind, lines: ajuste.lines, source: base + ajuste.note };
  };

  if (rec.syncedLyrics) {
    const lines = parseLrc(rec.syncedLyrics);
    if (lines.length > 0) return finaliser('synced', lines);
  }
  if (rec.plainLyrics) {
    const lines = parsePlain(rec.plainLyrics);
    if (lines.length > 0) return finaliser('plain', lines);
  }
  return null;
}

async function searchBest(target: MatchTarget): Promise<SourceOutcome> {
  const { title, artist } = target;
  const queries = [
    `/search?${qs({ track_name: title, artist_name: artist })}`,
    `/search?${qs({ q: `${artist} ${title}`.trim() })}`,
    // Titre seul : large, donc entièrement tributaire du filtre d'acceptation.
    `/search?${qs({ q: title })}`,
  ];

  let sawRejected = false;

  for (const query of queries) {
    const records = await fetchJson<LrclibRecord[]>(`${BASE}${query}`, {
      headers: { 'User-Agent': USER_AGENT },
      label: 'lrclib',
    });
    if (!records || records.length === 0) continue;

    const accepted = records.filter((rec) => {
      if (isAcceptable(toCandidate(rec), target)) return true;
      sawRejected = true;
      return false;
    });
    if (accepted.length === 0) continue;

    const ranked = accepted
      .map((rec) => ({
        rec,
        score: scoreCandidate(
          toCandidate(rec),
          target,
          Boolean(rec.syncedLyrics),
          Boolean(rec.plainLyrics),
        ),
      }))
      .sort((a, b) => b.score - a.score);

    for (const { rec } of ranked) {
      const result = toResult(rec, target);
      if (result?.kind === 'synced') return { result, sawRejected };
    }
    const fallback = ranked
      .map(({ rec }) => toResult(rec, target))
      .find((r): r is LyricsResult => r !== null);
    if (fallback) return { result: fallback, sawRejected };
  }

  return { result: null, sawRejected };
}

export async function searchLrclib(target: MatchTarget): Promise<SourceOutcome> {
  const { title, artist, rawTitle, rawArtist, album, duration } = target;
  let sawRejected = false;
  let instrumental = false;
  let plainFallback: LyricsResult | null = null;

  // 1) Correspondance exacte : c'est la seule qui garantit le bon enregistrement.
  const exactAttempts: Array<Record<string, string | number | undefined>> = [
    { track_name: title, artist_name: artist, album_name: album, duration },
    { track_name: title, artist_name: artist, duration },
    { track_name: rawTitle, artist_name: rawArtist, duration },
    { track_name: title, artist_name: artist },
  ];

  for (const params of exactAttempts) {
    const rec = await get(`/get?${qs(params)}`);
    if (!rec) continue;
    // Même sur /get, la dernière tentative omet la durée : le disque renvoyé peut
    // être une autre version, dont l'horodatage ne collerait pas.
    if (!isAcceptable(toCandidate(rec), target)) {
      sawRejected = true;
      continue;
    }
    // Indice seulement : on le remonte sans court-circuiter les autres sources.
    if (rec.instrumental) {
      instrumental = true;
      continue;
    }
    const result = toResult(rec, target);
    if (result?.kind === 'synced') return { result, sawRejected };
    if (result && !plainFallback) plainFallback = result;
  }

  // 2) Recherche floue, soumise au même garde-fou.
  const best = await searchBest(target);
  if (best.result) return { result: best.result, sawRejected: sawRejected || best.sawRejected };

  return {
    result: plainFallback,
    sawRejected: sawRejected || best.sawRejected,
    instrumental,
  };
}
