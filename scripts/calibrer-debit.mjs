/**
 * Calibre la cadence de chant utilisée pour estimer les timings mot-à-mot
 * quand la source ne les fournit pas.
 *
 * Méthode : sur de vraies paroles synchronisées, l'écart entre deux lignes
 * successives majore la durée de chant de la première. En ne retenant que les
 * écarts courts — ceux où le chant occupe manifestement tout l'intervalle, sans
 * passage instrumental — le rapport caractères/écart approche la cadence réelle.
 */
const UA = 'YTM-Lyrics-PiP/0.2.0 (calibration)';

const MORCEAUX = [
  ['Daft Punk', 'Get Lucky'],
  ['Queen', 'Bohemian Rhapsody'],
  ['Adele', 'Someone Like You'],
  ['The Weeknd', 'Blinding Lights'],
  ['Coldplay', 'Viva La Vida'],
  ['Billie Eilish', 'bad guy'],
  ['Ed Sheeran', 'Shape of You'],
  ['Nirvana', 'Smells Like Teen Spirit'],
  ['YOASOBI', '夜に駆ける'],
  ['Linkin Park', 'In The End'],
];

const TIMESTAMP = /^\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/;

function parse(lrc) {
  const lignes = [];
  for (const brute of lrc.split(/\r?\n/)) {
    const m = TIMESTAMP.exec(brute.trim());
    if (!m) continue;
    const frac = m[3] ?? '0';
    const t = Number(m[1]) * 60 + Number(m[2]) + Number(frac) / 10 ** frac.length;
    const texte = brute.trim().slice(m[0].length).trim();
    lignes.push({ t, texte });
  }
  return lignes.sort((a, b) => a.t - b.t);
}

const ratios = [];

for (const [artiste, titre] of MORCEAUX) {
  const url = `https://lrclib.net/api/get?artist_name=${encodeURIComponent(artiste)}&track_name=${encodeURIComponent(titre)}`;
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) {
    console.log(`${titre.padEnd(26)} introuvable`);
    continue;
  }
  const rec = await res.json();
  if (!rec.syncedLyrics) {
    console.log(`${titre.padEnd(26)} pas de version synchronisée`);
    continue;
  }

  const lignes = parse(rec.syncedLyrics);
  const locaux = [];
  for (let i = 0; i < lignes.length - 1; i++) {
    const { t, texte } = lignes[i];
    const ecart = lignes[i + 1].t - t;
    // Écart court et ligne substantielle : le chant remplit tout l'intervalle.
    if (!texte || texte.length < 12 || ecart < 0.8 || ecart > 5) continue;
    locaux.push(texte.length / ecart);
  }
  if (locaux.length === 0) continue;
  locaux.sort((a, b) => a - b);
  const median = locaux[Math.floor(locaux.length / 2)];
  ratios.push(...locaux);
  console.log(
    `${titre.padEnd(26)} ${String(locaux.length).padStart(3)} intervalles · médiane ${median.toFixed(1)} car/s`,
  );
}

ratios.sort((a, b) => a - b);
const q = (p) => ratios[Math.floor(ratios.length * p)];
console.log(`\n${ratios.length} intervalles retenus au total`);
console.log(`  1er quartile : ${q(0.25).toFixed(1)} car/s`);
console.log(`  médiane      : ${q(0.5).toFixed(1)} car/s`);
console.log(`  3e quartile  : ${q(0.75).toFixed(1)} car/s`);
