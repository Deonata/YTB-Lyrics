import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import type { LyricsResult, TrackQuery } from '../../shared/types';
import { searchLrclib } from './lrclib';
import { searchNetease } from './netease';
import {
  cleanArtist,
  cleanTitle,
  isCoverTitle,
  parseCoverTitle,
  primaryArtist,
  type MatchTarget,
} from './match';

export { parseLrc, parseYrc, parsePlain } from './lrc';
export { cleanArtist, cleanTitle, isCoverTitle, parseCoverTitle } from './match';

/** Durée de vie d'un « pas de paroles » en cache, pour ne pas marteler les sources. */
const NEGATIVE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * À incrémenter dès que la correspondance ou l'analyse change de comportement.
 * Les entrées d'une autre version sont ignorées puis supprimées : une amélioration
 * du filtrage profite ainsi immédiatement, sans purge manuelle — sans quoi une
 * mauvaise correspondance mise en cache resterait servie indéfiniment.
 */
const CACHE_VERSION = 4;

/** Plafonds au-delà desquels les entrées les plus anciennes sont supprimées. */
const MAX_CACHE_ENTRIES = 1200;
const MAX_CACHE_BYTES = 24 * 1024 * 1024;

interface CacheEntry {
  /** Absent sur les entrées écrites avant l'introduction du versionnage. */
  v?: number;
  savedAt: number;
  result: LyricsResult;
}

function buildTarget(video: TrackQuery): MatchTarget {
  const rawTitle = video.title ?? '';
  const rawArtist = cleanArtist(video.author ?? '');
  return {
    title: cleanTitle(rawTitle),
    artist: primaryArtist(rawArtist),
    rawTitle,
    rawArtist,
    album: video.album ?? undefined,
    duration: Math.round(video.durationSeconds ?? 0),
    mode: 'strict',
  };
}

/**
 * Cible de repli pour une reprise : on vise l'original.
 *
 * Le titre est débarrassé de ce qui désigne la reprise, et l'artiste devient
 * celui deviné dans le titre — pas l'interprète, qui n'écrira jamais ces paroles.
 */
function buildCoverTarget(target: MatchTarget): MatchTarget {
  const { title, originalArtist } = parseCoverTitle(target.rawTitle);
  return {
    ...target,
    title,
    artist: originalArtist ?? '',
    originalArtist,
    mode: 'cover',
  };
}

/** Interroge les sources dans l'ordre et rend le meilleur résultat trouvé. */
async function runSources(target: MatchTarget): Promise<{
  result: LyricsResult | null;
  sawRejected: boolean;
  instrumental: boolean;
}> {
  let sawRejected = false;
  let instrumental = false;
  let plainFallback: LyricsResult | null = null;

  // LRCLIB d'abord : catalogue ouvert, métadonnées propres, API stable.
  // NetEase ensuite : bien meilleure couverture sur le japonais et le coréen.
  for (const search of [searchLrclib, searchNetease]) {
    const outcome = await search(target);
    if (outcome.sawRejected) sawRejected = true;
    if (outcome.instrumental) instrumental = true;

    const result = outcome.result;
    if (!result) continue;
    if (result.kind === 'synced') return { result, sawRejected, instrumental };
    // On garde le texte brut mais on laisse sa chance à la source suivante,
    // qui a peut-être une version synchronisée.
    if (!plainFallback) plainFallback = result;
  }

  return { result: plainFallback, sawRejected, instrumental };
}

async function searchAllSources(video: TrackQuery): Promise<LyricsResult> {
  const target = buildTarget(video);
  if (!target.title) {
    return { kind: 'none', lines: [], source: null, message: 'Titre du morceau inconnu.' };
  }

  const strict = await runSources(target);
  if (strict.result) return strict.result;

  // Repli reprise : la recherche normale a échoué parce que l'interprète ne
  // correspond à rien dans les catalogues, alors que les paroles existent sous
  // le nom de l'original. On ne tente ce chemin qu'ici, jamais en premier :
  // ignorer l'artiste est précisément ce qui ramène les paroles d'un autre
  // morceau, et ce n'est acceptable que quand le titre annonce une reprise.
  if (isCoverTitle(target.rawTitle, target.rawArtist)) {
    const coverTarget = buildCoverTarget(target);
    if (coverTarget.title) {
      const cover = await runSources(coverTarget);
      if (cover.result) return cover.result;
    }
  }

  // Le verdict « instrumental » n'est retenu qu'ici : aucune source n'a de paroles.
  if (strict.instrumental) {
    return { kind: 'none', lines: [], source: null, message: 'Morceau instrumental.' };
  }

  return {
    kind: 'none',
    lines: [],
    source: null,
    message: strict.sawRejected
      ? `Aucune correspondance fiable pour « ${target.title} » (résultats écartés : autre artiste ou autre durée).`
      : `Aucune parole trouvée pour « ${target.title} » sur LRCLIB ni NetEase.`,
  };
}

// ---------------------------------------------------------------------------
// Cache disque
// ---------------------------------------------------------------------------

function cacheDir(): string {
  return path.join(app.getPath('userData'), 'lyrics-cache');
}

function cacheFile(videoId: string): string {
  // Les videoId YouTube peuvent contenir « - » et « _ » : sûrs pour un nom de fichier.
  return path.join(cacheDir(), `${videoId.replace(/[^A-Za-z0-9_-]/g, '_')}.json`);
}

function readCache(videoId: string): LyricsResult | null {
  try {
    const entry = JSON.parse(fs.readFileSync(cacheFile(videoId), 'utf8')) as CacheEntry;
    // Entrée produite par une logique de correspondance périmée.
    if (entry.v !== CACHE_VERSION) return null;
    if (entry.result.kind === 'none' && Date.now() - entry.savedAt > NEGATIVE_TTL_MS) return null;
    return entry.result;
  } catch {
    return null;
  }
}

function writeCache(videoId: string, result: LyricsResult): void {
  try {
    fs.mkdirSync(cacheDir(), { recursive: true });
    const entry: CacheEntry = { v: CACHE_VERSION, savedAt: Date.now(), result };
    fs.writeFileSync(cacheFile(videoId), JSON.stringify(entry), 'utf8');
  } catch (err) {
    console.warn('[lyrics] mise en cache impossible :', (err as Error).message);
  }
}

/**
 * Entretien du cache, à lancer au démarrage. Supprime les entrées d'une autre
 * version, les absences de paroles expirées, puis les plus anciennes tant que
 * les plafonds sont dépassés. Silencieux et sans effet de bord visible.
 */
export function pruneCache(): { supprimees: number; restantes: number } {
  const dir = cacheDir();
  let supprimees = 0;

  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith('.json'));
  } catch {
    return { supprimees: 0, restantes: 0 }; // pas encore de cache
  }

  const now = Date.now();
  const survivants: Array<{ file: string; savedAt: number; size: number }> = [];

  for (const name of names) {
    const file = path.join(dir, name);
    let obsolete = false;
    let savedAt = 0;
    let size = 0;
    try {
      size = fs.statSync(file).size;
      const entry = JSON.parse(fs.readFileSync(file, 'utf8')) as CacheEntry;
      savedAt = entry.savedAt ?? 0;
      obsolete =
        entry.v !== CACHE_VERSION ||
        (entry.result?.kind === 'none' && now - savedAt > NEGATIVE_TTL_MS);
    } catch {
      obsolete = true; // fichier illisible ou tronqué
    }

    if (obsolete) {
      try {
        fs.rmSync(file, { force: true });
        supprimees++;
      } catch {
        // Fichier verrouillé : il sera repris au prochain démarrage.
      }
    } else {
      survivants.push({ file, savedAt, size });
    }
  }

  // Plafonds : on sacrifie les plus anciennes d'abord.
  survivants.sort((a, b) => a.savedAt - b.savedAt);
  let total = survivants.reduce((sum, e) => sum + e.size, 0);
  while (survivants.length > MAX_CACHE_ENTRIES || total > MAX_CACHE_BYTES) {
    const oldest = survivants.shift();
    if (!oldest) break;
    try {
      fs.rmSync(oldest.file, { force: true });
      supprimees++;
      total -= oldest.size;
    } catch {
      // idem
    }
  }

  return { supprimees, restantes: survivants.length };
}

/** Évite deux recherches simultanées pour le même morceau (reconnexion, double state-update). */
const inFlight = new Map<string, Promise<LyricsResult>>();

export async function getLyrics(video: TrackQuery, force = false): Promise<LyricsResult> {
  const videoId = video.id;
  if (!videoId) {
    return { kind: 'none', lines: [], source: null, message: 'Aucun morceau en lecture.' };
  }

  if (!force) {
    const cached = readCache(videoId);
    if (cached) return cached;

    const pending = inFlight.get(videoId);
    if (pending) return pending;
  }

  const task = searchAllSources(video)
    .then((result) => {
      writeCache(videoId, result);
      return result;
    })
    .catch((err: Error) => {
      console.error('[lyrics] recherche échouée :', err);
      const result: LyricsResult = {
        kind: 'none',
        lines: [],
        source: null,
        message: 'Erreur pendant la recherche des paroles.',
      };
      return result;
    })
    .finally(() => {
      inFlight.delete(videoId);
    });

  inFlight.set(videoId, task);
  return task;
}

export function clearLyricsCache(): void {
  try {
    fs.rmSync(cacheDir(), { recursive: true, force: true });
  } catch (err) {
    console.warn('[lyrics] purge du cache impossible :', (err as Error).message);
  }
}
