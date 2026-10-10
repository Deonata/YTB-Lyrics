// Stub de l'API `window.pip` pour piloter le vrai renderer hors YTMDesktop.
const { contextBridge } = require('electron');

const handlers = {};

const { parseYrc } = require('../dist/main/lyrics/lrc.js');
const { timeWords } = require('../dist/main/lyrics/words.js');

// Paroles fictives, écrites pour l'aperçu : les captures du README sont publiques.

// Ligne yrc découpée en syllabes, pour voir l'espacement réel à l'écran.
const [syllabes] = parseYrc(
  '[26000,3000](26000,500,0)Lu(26500,400,0)miè(26900,400,0)re (27300,300,0)du (27600,1400,0)soir',
);

// Comme le processus principal : l'horodatage au mot est fait avant l'envoi.
const LYRICS = {
  kind: 'synced',
  source: 'Aperçu local',
  lines: timeWords(
    [
      { time: 4, text: 'On roule sans savoir où la nuit nous mène' },
      { time: 10, text: "Les néons s'allument un à un sur la ville encore endormie" },
      { time: 16, text: '' }, // passage instrumental de 6 s
      { time: 22, text: "Et la radio fredonne ce qu'on n'ose pas dire" },
      syllabes,
    ],
    200,
  ),
};

const TRACK = {
  videoId: 'preview',
  title: 'Néons',
  author: 'Démo · paroles fictives',
  album: null,
  thumbnail: null,
  lyrics: LYRICS,
};

// Position de départ passée par le main via argv, pour capturer plusieurs instants.
const progress = Number(process.argv.find((a) => a.startsWith('--at='))?.slice(5) ?? '11.5');

const SETTINGS_DEFAUT = {
  opacity: 0.95,
  fontSize: 24,
  fontFamily: '"Segoe UI Variable Display", "Segoe UI", Inter, system-ui, sans-serif',
  fontWeight: 600,
  textAlign: 'left',
  accentColor: '#ff2e5b',
  textColor: '#ffffff',
  backgroundColor: '#0c0c10',
  dimOpacity: 0.32,
  cornerRadius: 14,
  showControls: true,
  showTitle: true,
  showSource: true,
  clickThrough: false,
  offsetMs: 0,
  trackOffsetMs: 0,
};

// PREVIEW_STYLE surcharge librement ; PREVIEW_THEME applique un thème du catalogue.
let surcharge = {};
try {
  if (process.env.PREVIEW_STYLE) surcharge = JSON.parse(process.env.PREVIEW_STYLE);
} catch (err) {
  console.error('PREVIEW_STYLE illisible :', err.message);
}
if (process.env.PREVIEW_THEME) {
  const { THEMES } = require('../dist/shared/themes.js');
  const theme = THEMES.find((t) => t.id === process.env.PREVIEW_THEME);
  if (theme) surcharge = { ...theme.settings, ...surcharge };
  else console.error('Thème inconnu :', process.env.PREVIEW_THEME);
}

contextBridge.exposeInMainWorld('pip', {
  ready() {
    setTimeout(() => {
      handlers.settings?.({ ...SETTINGS_DEFAUT, ...surcharge });
      handlers.status?.({ state: 'connected' });
      handlers.track?.(TRACK);
      handlers.sync?.({
        videoId: 'preview',
        title: 'Aperçu',
        author: 'Rendu local',
        durationSeconds: 200,
        progress,
        playing: false, // figé : la capture doit être déterministe
        adPlaying: false,
      });
    }, 30);
  },
  onFade: (cb) => {
    handlers.fade = cb;
    // PREVIEW_FADE=1 capture l'état escamoté, à mi-fondu ou une fois éteint.
    if (process.env.PREVIEW_FADE) setTimeout(() => cb(true), 60);
  },
  onTrack: (cb) => (handlers.track = cb),
  onSync: (cb) => (handlers.sync = cb),
  onSettings: (cb) => (handlers.settings = cb),
  onStatus: (cb) => (handlers.status = cb),
  command() {},
  hide() {},
  openSettings() {},
  resizeBy() {},
  nudgeOffset() {},
  resetOffset() {},
  setTotalOffset(ms) { console.log('CALAGE ' + ms); },
});
