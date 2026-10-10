/** Nettoyage des métadonnées YouTube Music et sélection des candidats. */

/**
 * Parenthèses parasites des titres YouTube. On retire tout le groupe dès qu'il
 * contient un mot-clé parasite, ce qui couvre les combinaisons du type
 * « (Official Video Remastered) ». Les groupes utiles — « (Radio Edit) »,
 * « (Live) », « (Acoustic) » — n'ont aucun mot-clé et sont préservés.
 */
const TITLE_NOISE_RE =
  /\s*[([][^()[\]]*\b(?:official|lyrics?|lyric\s*video|visuali[sz]er|audio|hd|hq|4k|remaster(?:ed)?|explicit|clip\s*officiel|music\s*video|mv)\b[^()[\]]*[)\]]/gi;

export function cleanTitle(title: string): string {
  return title.replace(TITLE_NOISE_RE, '').replace(/\s{2,}/g, ' ').trim();
}

export function cleanArtist(author: string): string {
  return author
    .replace(/\s*-\s*Topic$/i, '') // chaînes auto-générées « Artiste - Topic »
    .replace(/\s*VEVO$/i, '')
    .trim();
}

/** Premier artiste seul : les catalogues indexent rarement « A, B & C ». */
export function primaryArtist(artist: string): string {
  const [first] = artist.split(/\s*(?:,|&|feat\.?|ft\.?|x|\/)\s*/i);
  return (first ?? artist).trim();
}

// ---------------------------------------------------------------------------
// Comparaison
// ---------------------------------------------------------------------------

/** Minuscules, sans diacritiques ni ponctuation, espaces normalisés. */
function normalize(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // diacritiques isolés par la décomposition NFD
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Recouvrement rapporté au plus petit ensemble : « Queen » ≈ « Queen & Bowie ». */
function tokenOverlap(a: string, b: string): number {
  const setA = new Set(a.split(' ').filter(Boolean));
  const setB = new Set(b.split(' ').filter(Boolean));
  if (setA.size === 0 || setB.size === 0) return 0;
  let hits = 0;
  for (const token of setA) if (setB.has(token)) hits++;
  return hits / Math.min(setA.size, setB.size);
}

/** Proximité de deux libellés, entre 0 et 1. */
export function similarity(a: string, b: string): number {
  const na = normalize(a);
  const nb = normalize(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  // Repli par inclusion : le découpage en mots échoue sur les écritures sans
  // espaces (japonais, coréen), fréquentes dans les bibliothèques YouTube Music.
  const [short, long] = na.length <= nb.length ? [na, nb] : [nb, na];
  if (long.includes(short) && short.length >= long.length * 0.6) return 0.9;
  return tokenOverlap(na, nb);
}

/**
 * Tolérance sur la durée.
 *
 * Un même morceau dure rarement pareil en clip et en audio : le clip ajoute
 * intro, outro ou passages parlés. Le Companion Server n'expose pas de champ
 * indiquant lequel est joué (`videoType` est documenté sur le wiki mais absent
 * de la réponse réelle), on module donc la tolérance selon la solidité de la
 * correspondance : quand l'artiste *et* le titre concordent nettement, un gros
 * écart signale une autre **version** du bon morceau, pas un autre morceau.
 */
const DURATION_TOLERANCE_STRICT = 10;
const DURATION_TOLERANCE_STRONG = 45;
const STRONG_MATCH_SIMILARITY = 0.85;

/** Au-delà de cet écart, on prévient que le décalage est probablement à ajuster. */
export const DURATION_HINT_DELTA = 12;

const MIN_ARTIST_SIMILARITY = 0.5;
const MIN_TITLE_SIMILARITY = 0.5;

/**
 * En mode reprise, l'interprète n'est plus un critère : c'est justement quelqu'un
 * d'autre qui chante. On perd donc le garde-fou le plus solide, et on le compense
 * en exigeant un titre nettement plus proche.
 */
const MIN_TITLE_SIMILARITY_COVER = 0.8;

/**
 * `strict` : l'interprète doit correspondre (cas normal).
 * `cover` : on cherche les paroles de l'original, l'interprète est ignoré.
 */
export type MatchMode = 'strict' | 'cover';

export interface MatchTarget {
  /** Titre nettoyé des suffixes parasites. */
  title: string;
  /** Artiste principal, nettoyé. */
  artist: string;
  rawTitle: string;
  rawArtist: string;
  album?: string;
  duration: number;
  mode: MatchMode;
  /**
   * Artiste d'origine deviné dans le titre (« Adele - Someone Like You (Cover) »).
   * Sert à départager les candidats, jamais à en écarter.
   */
  originalArtist?: string;
}

/** Ce que rend une source. `sawRejected` distingue « rien trouvé » de « tout écarté ». */
export interface SourceOutcome {
  result: import('../../shared/types').LyricsResult | null;
  sawRejected: boolean;
  /**
   * La source déclare le morceau instrumental. Simple indice, jamais un verdict :
   * le drapeau de LRCLIB est contributif et se trompe (青のすみか y est marqué
   * instrumental alors que NetEase en a les paroles, horodatées au mot).
   */
  instrumental?: boolean;
}

/** Forme commune à laquelle chaque source ramène ses résultats. */
export interface Candidate {
  artistName: string;
  trackName: string;
  albumName: string | null;
  /** En secondes, ou `null` si la source ne la donne pas. */
  duration: number | null;
}

/**
 * Garde-fou appliqué à *tous* les chemins de recherche, toutes sources confondues.
 * Sans lui, une requête de repli par titre seul ramène volontiers l'homonyme d'un
 * autre artiste — des paroles parfaitement synchronisées, mais celles d'un autre
 * morceau.
 */
export function isAcceptable(candidate: Candidate, target: MatchTarget): boolean {
  if (target.mode === 'cover') {
    // Ni l'interprète ni la durée ne sont exploitables : une reprise est par
    // définition chantée par quelqu'un d'autre, et n'a aucune raison de durer
    // autant que l'original. Le titre porte donc seul la décision, d'où le
    // seuil très relevé.
    return similarity(candidate.trackName, target.title) >= MIN_TITLE_SIMILARITY_COVER;
  }

  const artistSimilarity = similarity(candidate.artistName, target.artist);
  if (artistSimilarity < MIN_ARTIST_SIMILARITY) return false;

  const titleSimilarity = similarity(candidate.trackName, target.title);
  if (titleSimilarity < MIN_TITLE_SIMILARITY) return false;

  if (target.duration > 0 && candidate.duration) {
    const strong =
      artistSimilarity >= STRONG_MATCH_SIMILARITY && titleSimilarity >= STRONG_MATCH_SIMILARITY;
    const tolerance = strong ? DURATION_TOLERANCE_STRONG : DURATION_TOLERANCE_STRICT;
    if (Math.abs(candidate.duration - target.duration) > tolerance) return false;
  }

  return true;
}

/** Classe les candidats *déjà acceptés* par `isAcceptable`. */
export function scoreCandidate(
  candidate: Candidate,
  target: MatchTarget,
  hasSynced: boolean,
  hasPlain: boolean,
): number {
  let score = 0;
  if (hasSynced) score += 1000;
  else if (hasPlain) score += 100;

  score += similarity(candidate.trackName, target.title) * 80;

  if (target.mode === 'cover') {
    // La durée ne dit rien d'une reprise. En revanche, si le titre nommait
    // l'artiste d'origine, un candidat qui lui correspond est le bon original.
    if (target.originalArtist) {
      score += similarity(candidate.artistName, target.originalArtist) * 120;
    }
    return score;
  }

  if (target.duration > 0 && candidate.duration) {
    score += Math.max(0, 120 - Math.abs(candidate.duration - target.duration) * 12);
  }
  score += similarity(candidate.artistName, target.artist) * 80;

  return score;
}

/**
 * Suffixe signalant que les paroles viennent d'une version de durée différente
 * (clip contre audio, le plus souvent) : elles sont les bonnes, mais leur
 * horodatage vient de l'autre enregistrement.
 */
export function describeVersion(candidate: Candidate, target: MatchTarget): string {
  // En reprise, l'écart de durée est attendu : le signaler serait du bruit,
  // et `adjustForCover` pose déjà sa propre mention.
  if (target.mode === 'cover') return '';
  if (target.duration <= 0 || !candidate.duration) return '';
  const delta = Math.round(target.duration - candidate.duration);
  if (Math.abs(delta) < DURATION_HINT_DELTA) return '';
  return ` · autre version (${delta > 0 ? '+' : ''}${delta} s) — ajuste avec [ et ]`;
}

// ---------------------------------------------------------------------------
// Reprises
// ---------------------------------------------------------------------------

/**
 * Marqueurs de reprise. « cover » est aussi un mot courant (« Cover Me »,
 * « Undercover »), d'où les frontières de mot et l'exigence d'un contexte :
 * soit entre parenthèses, soit après un séparateur, soit suivi de « by ».
 */
const COVER_RE =
  /(?:[([][^()[\]]*\b(?:cover|reprise)\b[^()[\]]*[)\]])|(?:[-–—|]\s*(?:\w+\s+)?\b(?:cover|reprise)\b.*$)|(?:\b(?:cover|reprise)\s+by\b.*$)/i;

export function isCoverTitle(title: string, artist = ''): boolean {
  return COVER_RE.test(title) || /\bcovers?\b/i.test(artist);
}

/**
 * Retire ce qui désigne la reprise pour ne garder que le titre de l'original.
 * « Adele - Someone Like You (Piano Cover by X) » → « Someone Like You », avec
 * « Adele » rendu séparément comme artiste probable de l'original.
 */
export function parseCoverTitle(rawTitle: string): { title: string; originalArtist?: string } {
  let titre = rawTitle.replace(COVER_RE, ' ').replace(/\s{2,}/g, ' ').trim();
  titre = cleanTitle(titre).replace(/[\s\-–—|:]+$/, '').trim();

  // Beaucoup de reprises nomment l'original en tête : « Artiste - Morceau ».
  const separe = /^(.{2,40}?)\s+[-–—]\s+(.{2,})$/.exec(titre);
  if (separe) {
    return { title: separe[2]!.trim(), originalArtist: separe[1]!.trim() };
  }
  return { title: titre };
}

/**
 * Écart de tempo au-delà duquel une mise à l'échelle linéaire n'a plus de sens :
 * la reprise a probablement une structure différente (intro ajoutée, couplet
 * sauté), et étirer les timings ferait plus de mal qu'un simple décalage.
 */
const COVER_SCALE_MIN = 0.6;
const COVER_SCALE_MAX = 1.6;

/**
 * Recale les paroles de l'original sur la durée de la reprise.
 *
 * L'hypothèse est volontairement simple : une reprise fidèle suit la même
 * structure à un facteur de tempo près, donc un facteur linéaire suffit. Elle
 * tombe dès que la reprise ajoute une intro ou saute un passage — d'où la
 * mention affichée, qui invite à corriger avec [ et ], et le refus de mettre à
 * l'échelle au-delà d'un écart de tempo plausible.
 */
export function adjustForCover(
  lines: import('../../shared/types').LyricLine[],
  candidate: Candidate,
  target: MatchTarget,
): { lines: import('../../shared/types').LyricLine[]; note: string } {
  if (target.mode !== 'cover') return { lines, note: '' };

  const base = ' · reprise, paroles de l’original';
  if (target.duration <= 0 || lines.length === 0) {
    return { lines, note: `${base} — ajuste avec [ et ]` };
  }

  // Étendue réelle des paroles. La durée déclarée par le catalogue est souvent
  // fausse — on a vu une fiche annoncer 210 s pour un LRC qui court jusqu'à
  // 264 s — alors que le dernier horodatage, lui, vient du fichier même. On
  // garde la plus grande des deux, plus une queue pour l'outro que les paroles
  // ne couvrent jamais.
  const dernierVers = lines[lines.length - 1]!.time;
  const dureeOriginal = Math.max(candidate.duration ?? 0, dernierVers + 5);
  if (dureeOriginal <= 0) return { lines, note: `${base} — ajuste avec [ et ]` };

  const ratio = target.duration / dureeOriginal;
  if (ratio < COVER_SCALE_MIN || ratio > COVER_SCALE_MAX) {
    return { lines, note: `${base}, durées trop différentes pour recaler — ajuste avec [ et ]` };
  }
  // Sous 2 %, l'étirement ne se verrait pas : autant garder les valeurs d'origine.
  if (Math.abs(ratio - 1) < 0.02) return { lines, note: base };

  const etirees = lines.map((line) => ({
    ...line,
    time: line.time * ratio,
    ...(line.words
      ? {
          words: line.words.map((mot) => ({
            ...mot,
            time: mot.time * ratio,
            ...(mot.end !== undefined ? { end: mot.end * ratio } : {}),
          })),
        }
      : {}),
  }));

  return {
    lines: etirees,
    note: `${base}, timings ×${ratio.toFixed(2)} — ajuste avec [ et ]`,
  };
}
