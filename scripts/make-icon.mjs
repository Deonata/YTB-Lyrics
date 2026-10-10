// Génère assets/icon.png (256x256) sans dépendance externe : encodeur PNG minimal.
// Motif : carré arrondi dégradé rouge YouTube Music + 3 « lignes de paroles » blanches.
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const S = 256;
const px = Buffer.alloc(S * S * 4); // RGBA

const clamp01 = (v) => Math.min(1, Math.max(0, v));

// Distance signée à un carré arrondi centré, pour l'anticrénelage des bords.
function roundedRectSdf(x, y, halfW, halfH, r) {
  const qx = Math.abs(x) - halfW + r;
  const qy = Math.abs(y) - halfH + r;
  const ax = Math.max(qx, 0);
  const ay = Math.max(qy, 0);
  return Math.hypot(ax, ay) + Math.min(Math.max(qx, qy), 0) - r;
}

// Les 3 barres de « paroles » : [yCentre, xDébut, xFin] en pixels, la 2e est la ligne active.
const BARS = [
  [96, 62, 194],
  [128, 62, 162],
  [160, 62, 178],
];
const BAR_H = 15;
const BAR_R = BAR_H / 2;

for (let y = 0; y < S; y++) {
  for (let x = 0; x < S; x++) {
    const cx = x + 0.5 - S / 2;
    const cy = y + 0.5 - S / 2;

    // Fond : carré arrondi, dégradé diagonal.
    const d = roundedRectSdf(cx, cy, 116, 116, 56);
    const bgA = clamp01(0.5 - d);
    const t = clamp01((x + y) / (2 * S));
    let r = Math.round(255 * (1 - t) + 194 * t);
    let g = Math.round(46 * (1 - t) + 24 * t);
    let b = Math.round(64 * (1 - t) + 91 * t);
    let a = bgA;

    // Barres blanches par-dessus (la 2e à pleine opacité = ligne courante).
    for (let i = 0; i < BARS.length; i++) {
      const [by, x0, x1] = BARS[i];
      const bd = roundedRectSdf(
        x + 0.5 - (x0 + x1) / 2,
        y + 0.5 - by,
        (x1 - x0) / 2,
        BAR_H / 2,
        BAR_R,
      );
      const cov = clamp01(0.5 - bd) * (i === 1 ? 1 : 0.55) * bgA;
      if (cov > 0) {
        r = Math.round(r * (1 - cov) + 255 * cov);
        g = Math.round(g * (1 - cov) + 255 * cov);
        b = Math.round(b * (1 - cov) + 255 * cov);
        a = Math.max(a, cov);
      }
    }

    const o = (y * S + x) * 4;
    px[o] = r;
    px[o + 1] = g;
    px[o + 2] = b;
    px[o + 3] = Math.round(a * 255);
  }
}

// --- Encodage PNG ---
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(S, 0);
ihdr.writeUInt32BE(S, 4);
ihdr[8] = 8; // profondeur
ihdr[9] = 6; // RGBA
ihdr[10] = 0;
ihdr[11] = 0;
ihdr[12] = 0;

// Chaque scanline est préfixée de son octet de filtre (0 = aucun).
const raw = Buffer.alloc(S * (S * 4 + 1));
for (let y = 0; y < S; y++) {
  raw[y * (S * 4 + 1)] = 0;
  px.copy(raw, y * (S * 4 + 1) + 1, y * S * 4, (y + 1) * S * 4);
}

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'icon.png');
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, png);
console.log(`Écrit ${out} (${png.length} octets)`);
