// Vide dist/ avant chaque compilation.
//
// tsc ne supprime pas les sorties devenues obsolètes. Quand `lyrics.ts` est
// devenu le dossier `lyrics/`, l'ancien `dist/main/lyrics.js` est resté : Node
// résout `require('./lyrics')` vers `./lyrics.js` AVANT `./lyrics/index.js`,
// si bien que l'ancien module masquait le nouveau et l'application plantait au
// démarrage sur une fonction absente.
import { rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
rmSync(dist, { recursive: true, force: true });
