import type { LyricLine, LyricWord } from '../../shared/types';

/**
 * Horodatage mot à mot de toutes les lignes, juste avant l'envoi à la PiP.
 *
 * Les mots fournis par la source (yrc, LRC « enhanced ») sont gardés tels quels
 * et seulement complétés d'une fin. Les autres lignes sont découpées et
 * estimées. Fait ici plutôt que dans le renderer : c'est testable, et une
 * amélioration profite aussi aux paroles déjà en cache.
 *
 * Paramètres mesurés par `npm run calibrer:mots` contre le mot-à-mot réel de
 * NetEase (22 morceaux, 6 244 débuts de mots, surtout en anglais) : erreur
 * moyenne 442 → 345 ms, et le gain tient en validation croisée (chaque moitié
 * du corpus réglée sur l'autre).
 */

/** Durée de chant d'une ligne : `BASE + caractères / DÉBIT`, bornée par l'écart. */
const WINDOW_BASE_SECONDS = 0.35;
const WINDOW_CHARS_PER_SECOND = 7;

/**
 * Le dernier mot d'une ligne est presque toujours tenu : c'est le facteur le
 * plus rentable de la calibration (à lui seul, ~20 % d'erreur en moins).
 */
const LAST_WORD_WEIGHT = 2;

/** Sans suivante ni durée connue, la dernière ligne dure au plus ça. */
const FALLBACK_LINE_SECONDS = 4;
const MIN_GAP_SECONDS = 0.4;

/** Écritures sans espaces entre les mots : chaque caractère y est une syllabe chantée. */
const CJK_RE = /[぀-ヿ㐀-鿿豈-﫿]/;

const INSTRUMENTAL_NOTES = 3;

function weightOf(text: string): number {
  return Math.max(1, [...text].length);
}

/** Découpe une ligne en mots ; les blocs japonais ou chinois en caractères. */
function tokenize(text: string): LyricWord[] {
  const words: LyricWord[] = [];
  for (const token of text.split(/\s+/)) {
    if (!token) continue;
    if (CJK_RE.test(token) && [...token].length > 1) {
      // Un seul span pour toute une phrase japonaise se remplirait d'un bloc,
      // et sur plusieurs rangées à la fois quand la ligne passe à la ligne.
      const chars = [...token];
      chars.forEach((char, i) => {
        const word: LyricWord = { time: 0, text: char };
        if (i < chars.length - 1) word.space = false;
        words.push(word);
      });
    } else {
      words.push({ time: 0, text: token });
    }
  }
  return words;
}

/** Répartit `words` sur `[start, start + window]` au prorata de leurs poids. */
function spread(words: LyricWord[], weights: number[], start: number, window: number): void {
  const total = weights.reduce((a, b) => a + b, 0);
  let acc = 0;
  words.forEach((word, i) => {
    word.time = start + window * (acc / total);
    acc += weights[i]!;
    word.end = start + window * (acc / total);
  });
}

function estimateLine(line: LyricLine, gap: number): LyricLine {
  const words = tokenize(line.text);
  if (words.length === 0) return line;

  const chars = words.reduce((sum, w) => sum + weightOf(w.text), 0);
  const window = Math.min(gap, WINDOW_BASE_SECONDS + chars / WINDOW_CHARS_PER_SECOND);
  const weights = words.map((w, i) =>
    i === words.length - 1 ? weightOf(w.text) * LAST_WORD_WEIGHT : weightOf(w.text),
  );
  spread(words, weights, line.time, window);
  return { ...line, words, estimated: true };
}

/** Passage instrumental : les notes s'étirent sur tout l'écart, signe que le morceau avance. */
function instrumentalLine(line: LyricLine, gap: number): LyricLine {
  const words: LyricWord[] = Array.from({ length: INSTRUMENTAL_NOTES }, () => ({
    time: 0,
    text: '♪',
  }));
  spread(words, words.map(() => 1), line.time, gap);
  return { ...line, words, estimated: true };
}

/** Complète des mots réels : chacun reçoit une fin, sans jamais déborder la ligne suivante. */
function completeLine(line: LyricLine, lineEnd: number): LyricLine {
  const source = line.words!;
  const words = source.map((word, i) => {
    const next = source[i + 1];
    let end = word.end;
    if (end === undefined) {
      end = next
        ? next.time
        : Math.min(
            lineEnd,
            word.time + (weightOf(word.text) * LAST_WORD_WEIGHT) / WINDOW_CHARS_PER_SECOND + 0.2,
          );
    }
    // Une fin incohérente (avant le début) rendrait le remplissage instantané.
    return { ...word, end: Math.max(end, word.time + 0.05) };
  });
  return { ...line, words };
}

export function timeWords(lines: LyricLine[], durationSeconds: number): LyricLine[] {
  return lines.map((line, i) => {
    const next = lines[i + 1];
    const lineEnd = next
      ? next.time
      : durationSeconds > line.time
        ? durationSeconds
        : line.time + FALLBACK_LINE_SECONDS;
    const gap = Math.max(MIN_GAP_SECONDS, lineEnd - line.time);

    if (!line.text) return instrumentalLine(line, gap);
    if (line.words && line.words.length > 0 && !line.estimated) return completeLine(line, lineEnd);
    return estimateLine(line, gap);
  });
}
