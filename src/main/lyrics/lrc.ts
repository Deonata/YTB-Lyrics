import type { LyricLine, LyricWord } from '../../shared/types';

const TIMESTAMP_RE = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
const METADATA_RE = /^\[(ar|ti|al|au|by|re|ve|length|offset|tool):(.*)\]$/i;
/** Marqueurs mot-à-mot du LRC « enhanced » : `<mm:ss.xx>` devant chaque mot. */
const WORD_TIMING_RE = /<(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?>/g;

/**
 * Lignes de crédits que NetEase place en tête du LRC, horodatées comme des
 * paroles (« 作曲 : … », « Produced by : … »). Elles s'afficheraient sinon
 * comme les premières paroles du morceau.
 */
const CREDIT_LINE_RE =
  /^\s*(作曲|作詞|作词|編曲|编曲|制作人|製作人|出品人?|发行|發行|录音|錄音|混音|母带|母帶|吉他|贝斯|貝斯|鼓|键盘|鍵盤|和声|和聲|监制|監製|统筹|統籌|策划|策劃|企划|企劃|录音室|錄音室|OP|SP|Producer|Produced by|Composed by|Written by|Lyrics by|Arranged by|Mixed by|Mastered by|Recorded by)\s*[:：]/i;

/** « .5 » = 500 ms, « .50 » = 500 ms, « .500 » = 500 ms. */
function toSeconds(min: string | undefined, sec: string | undefined, frac: string | undefined) {
  const f = frac ?? '0';
  return Number(min ?? 0) * 60 + Number(sec ?? 0) + Number(f) / 10 ** f.length;
}

/**
 * Ajoute un segment de texte horodaté à la liste des mots, en respectant
 * l'espacement d'origine : un segment sans espace final est une syllabe (ou un
 * caractère japonais) collée au suivant, pas un mot à part.
 */
function pushSegment(words: LyricWord[], raw: string, time: number, end?: number): void {
  const text = raw.trim();
  const previous = words[words.length - 1];
  if (!text) {
    // Segment blanc : il ne porte qu'un espace, rattaché au mot précédent.
    if (previous && raw) delete previous.space;
    return;
  }
  if (previous && /^\s/.test(raw)) delete previous.space;
  const word: LyricWord = { time, text };
  if (end !== undefined) word.end = end;
  if (!/\s$/.test(raw)) word.space = false;
  words.push(word);
}

/** Le dernier mot n'a rien à suivre : son espacement n'a pas de sens. */
function finishWords(words: LyricWord[]): LyricWord[] | undefined {
  if (words.length === 0) return undefined;
  delete words[words.length - 1]!.space;
  return words;
}

/** Recompose le texte d'une ligne à partir de ses mots. */
export function joinWords(words: LyricWord[]): string {
  return words
    .map((w, i) => (i < words.length - 1 && w.space !== false ? `${w.text} ` : w.text))
    .join('');
}

/**
 * Extrait les mots horodatés d'une ligne « enhanced », ou `undefined` s'il n'y
 * en a pas. Le texte placé avant le premier marqueur commence avec la ligne ;
 * un marqueur final sans texte donne la fin du dernier mot.
 */
function parseWordTimings(
  rest: string,
  lineTime: number,
  offsetSeconds: number,
): LyricWord[] | undefined {
  WORD_TIMING_RE.lastIndex = 0;
  const markers: Array<{ at: number; length: number; time: number }> = [];
  let match: RegExpExecArray | null;
  while ((match = WORD_TIMING_RE.exec(rest)) !== null) {
    markers.push({
      at: match.index,
      length: match[0].length,
      time: toSeconds(match[1], match[2], match[3]),
    });
  }
  if (markers.length === 0) return undefined;

  const words: LyricWord[] = [];
  const shift = (t: number) => Math.max(0, t + offsetSeconds);

  const prefix = rest.slice(0, markers[0]!.at);
  if (prefix.trim()) pushSegment(words, prefix, shift(lineTime));

  for (let i = 0; i < markers.length; i++) {
    const marker = markers[i]!;
    // Le texte du mot court jusqu'au marqueur suivant.
    const raw = rest.slice(marker.at + marker.length, markers[i + 1]?.at ?? rest.length);
    const isLast = i === markers.length - 1;
    if (isLast && !raw.trim()) {
      // Marqueur de fin : il borne le dernier mot au lieu d'en ouvrir un.
      const previous = words[words.length - 1];
      if (previous) previous.end = shift(marker.time);
      continue;
    }
    pushSegment(words, raw, shift(marker.time));
  }
  return finishWords(words);
}

export function isCreditLine(text: string): boolean {
  return CREDIT_LINE_RE.test(text);
}

export function parseLrc(lrc: string): LyricLine[] {
  const lines: LyricLine[] = [];
  let offsetSeconds = 0;

  for (const rawLine of lrc.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;

    const meta = METADATA_RE.exec(trimmed);
    if (meta) {
      // [offset:+/-ms] décale toutes les lignes ; positif = paroles plus tôt.
      if (meta[1]?.toLowerCase() === 'offset') {
        const ms = Number.parseInt((meta[2] ?? '').trim(), 10);
        if (Number.isFinite(ms)) offsetSeconds = -ms / 1000;
      }
      continue;
    }

    TIMESTAMP_RE.lastIndex = 0;
    const stamps: number[] = [];
    let match: RegExpExecArray | null;
    let lastEnd = 0;
    while ((match = TIMESTAMP_RE.exec(trimmed)) !== null) {
      // Un timestamp n'est valide qu'en préfixe : « [00:12.00] » au milieu du texte n'en est pas un.
      if (match.index !== lastEnd) break;
      lastEnd = match.index + match[0].length;
      stamps.push(toSeconds(match[1], match[2], match[3]));
    }
    if (stamps.length === 0) continue;

    const rest = trimmed.slice(lastEnd);
    const text = rest.replace(WORD_TIMING_RE, '').replace(/\s{2,}/g, ' ').trim();
    if (isCreditLine(text)) continue;

    // Des timings mot-à-mot n'ont de sens que pour une occurrence unique : une ligne
    // à plusieurs timestamps (refrain répété) les rejouerait au mauvais moment.
    const words = stamps.length === 1 ? parseWordTimings(rest, stamps[0]!, offsetSeconds) : undefined;

    for (const time of stamps) {
      const line: LyricLine = { time: Math.max(0, time + offsetSeconds), text };
      if (words) line.words = words;
      lines.push(line);
    }
  }

  lines.sort((a, b) => a.time - b.time);
  return lines;
}

/**
 * Format « yrc » de NetEase, horodaté au mot :
 * `[débutLigneMs,duréeMs](débutMotMs,duréeMs,0)texte(…)texte`
 * Un segment est souvent une syllabe : c'est son espace final qui dit si le
 * mot continue.
 */
const YRC_LINE_RE = /^\[(\d+),(\d+)\](.*)$/;
const YRC_WORD_RE = /\((\d+),(\d+),\d+\)([^(]*)/g;

export function parseYrc(yrc: string): LyricLine[] {
  const lines: LyricLine[] = [];

  for (const rawLine of yrc.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    // Les métadonnées JSON de NetEase partagent le fichier avec les paroles.
    if (!trimmed || trimmed.startsWith('{')) continue;

    const head = YRC_LINE_RE.exec(trimmed);
    if (!head) continue;

    const segments: LyricWord[] = [];
    YRC_WORD_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = YRC_WORD_RE.exec(head[3] ?? '')) !== null) {
      const start = Number(match[1]);
      pushSegment(segments, match[3] ?? '', start / 1000, (start + Number(match[2])) / 1000);
    }
    const words = finishWords(segments);
    if (!words) continue;

    // L'espacement vient du yrc lui-même : « beau|ti|ful » reste un mot, et le
    // japonais n'est pas éclaté en caractères séparés par des espaces.
    const text = joinWords(words);
    if (isCreditLine(text)) continue;

    lines.push({ time: Number(head[1]) / 1000, text, words });
  }

  lines.sort((a, b) => a.time - b.time);
  return lines;
}

/** Paroles non synchronisées : une ligne par vers, sans timing exploitable. */
export function parsePlain(plain: string): LyricLine[] {
  return plain
    .split(/\r?\n/)
    .map((text) => ({ time: 0, text: text.trim() }))
    .filter((line) => !isCreditLine(line.text))
    .filter((line, i, arr) => line.text !== '' || (arr[i - 1]?.text ?? '') !== '');
}
