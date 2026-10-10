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

/** Extrait les mots horodatés d'une ligne « enhanced », ou `undefined` s'il n'y en a pas. */
function parseWordTimings(rest: string, offsetSeconds: number): LyricWord[] | undefined {
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
  for (let i = 0; i < markers.length; i++) {
    const marker = markers[i]!;
    // Le texte du mot court jusqu'au marqueur suivant.
    const end = markers[i + 1]?.at ?? rest.length;
    const text = rest.slice(marker.at + marker.length, end).trim();
    if (!text) continue;
    words.push({ time: Math.max(0, marker.time + offsetSeconds), text });
  }
  return words.length > 0 ? words : undefined;
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
    const words = stamps.length === 1 ? parseWordTimings(rest, offsetSeconds) : undefined;

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

    const words: LyricWord[] = [];
    YRC_WORD_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = YRC_WORD_RE.exec(head[3] ?? '')) !== null) {
      const text = (match[3] ?? '').trim();
      if (!text) continue;
      words.push({ time: Number(match[1]) / 1000, text });
    }
    if (words.length === 0) continue;

    const text = words.map((w) => w.text).join(' ');
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
