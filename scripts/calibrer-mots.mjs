/**
 * Mesure l'estimation mot à mot (src/main/lyrics/words.ts, compilé) contre du
 * mot-à-mot réel : le « yrc » de NetEase, horodaté à la syllabe.
 *
 * Méthode : pour chaque ligne yrc, on ne garde que ce qu'aurait un LRC
 * classique (début de ligne et texte), on estime, puis on compare le début
 * estimé de chaque mot à son début réel. Le premier mot, calé d'office sur la
 * ligne, n'est pas compté. L'ancien estimateur du renderer sert de référence.
 *
 * Limite : le corpus est surtout anglophone (NetEase n'a de yrc que pour une
 * partie des titres occidentaux, et presque aucun en français).
 *
 * Usage : npm run build && npm run calibrer:mots
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { parseYrc } = require('../dist/main/lyrics/lrc.js');
const { timeWords } = require('../dist/main/lyrics/words.js');

const MORCEAUX = [
  ['Daft Punk', 'Get Lucky'],
  ['Queen', 'Bohemian Rhapsody'],
  ['Adele', 'Someone Like You'],
  ['The Weeknd', 'Blinding Lights'],
  ['Billie Eilish', 'bad guy'],
  ['Nirvana', 'Smells Like Teen Spirit'],
  ['Linkin Park', 'In The End'],
  ['Dua Lipa', 'Levitating'],
  ['Harry Styles', 'As It Was'],
  ['Eminem', 'Lose Yourself'],
  ['Rihanna', 'Diamonds'],
  ['Post Malone', 'Circles'],
  ['Olivia Rodrigo', 'drivers license'],
  ['Lewis Capaldi', 'Someone You Loved'],
  ['Sia', 'Chandelier'],
  ['Michael Jackson', 'Billie Jean'],
  ['ABBA', 'Dancing Queen'],
  ['Oasis', 'Wonderwall'],
  ['Arctic Monkeys', 'Do I Wanna Know?'],
  ['LiSA', '紅蓮華'],
];

const HEADERS = {
  Referer: 'https://music.163.com',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0',
};

async function fetchYrc(artist, title) {
  const q = encodeURIComponent(`${artist} ${title}`);
  const search = await (
    await fetch(`https://music.163.com/api/search/get?s=${q}&type=1&limit=3`, { headers: HEADERS })
  ).json();
  const song = search?.result?.songs?.[0];
  if (!song) return null;
  const lyric = await (
    await fetch(`https://music.163.com/api/song/lyric?id=${song.id}&lv=1&kv=1&tv=-1&yv=1`, {
      headers: HEADERS,
    })
  ).json();
  return lyric?.yrc?.lyric ?? null;
}

/** Regroupe les syllabes yrc en mots, comme le ferait un découpage aux espaces. */
function mergeSyllables(words) {
  const merged = [];
  let glued = false;
  for (const w of words) {
    if (glued) merged[merged.length - 1].text += w.text;
    else merged.push({ time: w.time, text: w.text });
    glued = w.space === false;
  }
  return merged;
}

/** L'estimateur du renderer avant la calibration, pour comparaison. */
function ancien(line, gap) {
  const tokens = line.text.split(/\s+/).filter(Boolean);
  const weights = tokens.map((t) => Math.max(1, t.length));
  const total = weights.reduce((a, b) => a + b, 0);
  const window = Math.min(gap, 2 * (0.35 + total / 11.8));
  let acc = 0;
  return weights.map((w) => {
    const start = line.time + window * (acc / total);
    acc += w;
    return start;
  });
}

const erreurs = { actuel: [], ancien: [] };
let morceaux = 0;
let lignes = 0;

for (const [artist, title] of MORCEAUX) {
  let yrc;
  try {
    yrc = await fetchYrc(artist, title);
  } catch (err) {
    console.log(`${title.padEnd(26)} erreur réseau (${err.message})`);
    continue;
  }
  if (!yrc) {
    console.log(`${title.padEnd(26)} pas de yrc`);
    continue;
  }
  morceaux++;

  const reel = parseYrc(yrc);
  const nu = reel.map((l) => ({ time: l.time, text: l.text }));
  const estime = timeWords(nu, 0);
  let locales = 0;

  for (let i = 0; i < reel.length - 1; i++) {
    const verite = mergeSyllables(reel[i].words);
    const motsEstimes = estime[i].words;
    // Lignes dont le découpage diffère (japonais groupé, ponctuation isolée) : non comparables.
    if (verite.length < 3 || motsEstimes.length !== verite.length) continue;
    const gap = reel[i + 1].time - reel[i].time;
    if (gap <= 0) continue;

    const anciens = ancien(nu[i], gap);
    for (let j = 1; j < verite.length; j++) {
      erreurs.actuel.push(Math.abs(motsEstimes[j].time - verite[j].time));
      erreurs.ancien.push(Math.abs(anciens[j] - verite[j].time));
    }
    lignes++;
    locales++;
  }
  console.log(`${title.padEnd(26)} ${String(locales).padStart(3)} lignes comparées`);
  await new Promise((r) => setTimeout(r, 250));
}

const quantile = (values, q) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(q * (sorted.length - 1))] ?? Number.NaN;
};
const resume = (values) => {
  const moyenne = values.reduce((a, b) => a + b, 0) / values.length;
  const proches = values.filter((e) => e <= 0.15).length / values.length;
  return (
    `médiane ${(quantile(values, 0.5) * 1000).toFixed(0).padStart(4)} ms · ` +
    `moyenne ${(moyenne * 1000).toFixed(0).padStart(4)} ms · ` +
    `à 150 ms près ${(proches * 100).toFixed(0).padStart(3)} %`
  );
};

console.log(
  `\n${morceaux} morceaux, ${lignes} lignes, ${erreurs.actuel.length} débuts de mots (hors 1er mot de chaque ligne)`,
);
if (erreurs.actuel.length === 0) {
  console.log('Rien à mesurer : NetEase injoignable ou sans yrc.');
  process.exit(1);
}
console.log(`ancien  ${resume(erreurs.ancien)}`);
console.log(`actuel  ${resume(erreurs.actuel)}`);
