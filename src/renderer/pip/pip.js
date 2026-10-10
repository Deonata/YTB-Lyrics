'use strict';

/**
 * Renderer de la fenêtre PiP.
 *
 * Le Companion Server ne pousse la progression qu'environ une fois par seconde :
 * bien trop grossier pour un surlignage ligne par ligne. On maintient donc une
 * horloge locale (« ancre » + performance.now()) recalée en douceur à chaque
 * mise à jour, et on ne resynchronise brutalement qu'en cas de saut réel.
 */

const api = window.pip;

const el = {
  app: document.getElementById('app'),
  bar: document.getElementById('bar'),
  meta: document.getElementById('meta'),
  title: document.getElementById('title'),
  author: document.getElementById('author'),
  actions: document.getElementById('actions'),
  offsetGroup: document.getElementById('offset-group'),
  transport: document.getElementById('transport'),
  viewport: document.getElementById('viewport'),
  lines: document.getElementById('lines'),
  message: document.getElementById('message'),
  source: document.getElementById('source'),
  grip: document.getElementById('grip'),
  offsetLabel: document.getElementById('offset-label'),
  btnPlay: document.getElementById('btn-play'),
};

let settings = {
  opacity: 0.92,
  fontSize: 26,
  fontFamily: '"Segoe UI Variable Display", "Segoe UI", Inter, system-ui, sans-serif',
  fontWeight: 600,
  textAlign: 'left',
  accentColor: '#ff2e5b',
  textColor: '#ffffff',
  backgroundColor: '#0c0c10',
  dimOpacity: 0.32,
  cornerRadius: 14,
  frameStyle: 'fin',
  textGlow: false,
  showControls: true,
  showOffset: true,
  showTitle: true,
  showSource: true,
  clickThrough: false,
  syncKey: 's',
  offsetMs: 0,
  trackOffsetMs: 0,
};

let lyrics = { kind: 'none', lines: [], source: null, message: 'Connexion à YouTube Music…' };
let lineEls = [];
/** Un tableau de spans (un par mot) pour chaque ligne, parallèle à `lineEls`. */
let lineSpans = [];
/** Bornes temporelles des mots de la ligne courante : { starts: number[], ends: number[] }. */
let wordTiming = null;
let activeWordIndex = -2;

/**
 * Cadence de chant, en caractères/seconde, mesurée sur 401 intervalles de
 * paroles réelles (`npm run calibrer`) : médiane 11,8.
 *
 * Attention à ce que ce chiffre décrit : la mesure ne retient que les écarts
 * courts entre lignes, donc elle caractérise les passages **rapides**. C'est une
 * borne haute du débit, pas une moyenne.
 */
const CHARS_PER_SECOND = 11.8;

/**
 * Une ligne peut se chanter bien plus lentement que cette borne haute — le 1er
 * quartile mesuré tombe à 7,9 car/s, soit une durée une fois et demie plus
 * longue. On autorise donc jusqu'au double de l'estimation avant de considérer
 * que le reste de l'écart est un passage instrumental.
 */
const SLOW_SINGING_FACTOR = 2;

/** Ancre d'horloge : le morceau était à `t` secondes à l'instant `at` (performance.now). */
let anchor = null;
let playing = false;
let duration = 0;
let syncVideoId = null;
let activeIndex = -2;
let status = { state: 'disconnected' };

// --- Économie de ressources ---
// `dirty` force un recalcul après un changement d'état ; sinon la boucle
// s'arrête net dès que l'horloge n'avance plus (pause, rien en lecture).
let rafId = 0;
let dirty = true;
let lastPlayhead = Number.NaN;
/** Dernière valeur écrite dans --p, pour ne pas réécrire un style identique. */
let lastPercent = -1;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// ---------------------------------------------------------------------------
// Horloge
// ---------------------------------------------------------------------------

/** Position brute dans le morceau, telle que rapportée par YTMDesktop. */
function rawTime() {
  if (!anchor) return 0;
  if (!playing) return anchor.t;
  return anchor.t + (performance.now() - anchor.at) / 1000;
}

/** Position utilisée pour choisir la ligne, décalages utilisateur inclus. */
function playhead() {
  return rawTime() + (settings.offsetMs + settings.trackOffsetMs) / 1000;
}

// ---------------------------------------------------------------------------
// Rendu
// ---------------------------------------------------------------------------

/** Découpe une ligne en spans de mots ; les espaces restent de simples nœuds texte. */
function buildLine(line) {
  const p = document.createElement('p');
  p.className = line.text ? 'line' : 'line instrumental';
  const spans = [];

  const push = (text) => {
    const span = document.createElement('span');
    span.className = 'w';
    span.textContent = text;
    p.appendChild(span);
    spans.push(span);
  };

  if (!line.text) {
    // Passage instrumental : des symboles traités comme des mots, pour qu'ils
    // se remplissent aussi (un pseudo-élément resterait hors du dégradé).
    for (let i = 0; i < 3; i++) {
      if (i > 0) p.appendChild(document.createTextNode(' '));
      push('♪');
    }
  } else if (line.words && line.words.length > 0) {
    line.words.forEach((word, i) => {
      if (i > 0) p.appendChild(document.createTextNode(' '));
      push(word.text);
    });
  } else {
    for (const part of line.text.split(/(\s+)/)) {
      if (!part) continue;
      if (/^\s+$/.test(part)) p.appendChild(document.createTextNode(part));
      else push(part);
    }
  }

  return { p, spans };
}

function renderLines() {
  el.lines.replaceChildren();
  lineSpans = [];
  lineEls = lyrics.lines.map((line) => {
    const { p, spans } = buildLine(line);
    lineSpans.push(spans);
    el.lines.appendChild(p);
    return p;
  });

  el.lines.classList.toggle('plain', lyrics.kind === 'plain');

  const empty = lineEls.length === 0;
  el.message.textContent = empty ? lyrics.message || statusMessage() : '';
  el.message.classList.toggle('hidden', !empty);
  // Indique si le remplissage suit des timings réels ou une estimation : c'est
  // la différence entre un surlignage exact et un surlignage seulement plausible.
  const motAMot = lyrics.lines.some((line) => line.words);
  el.source.textContent = lyrics.source
    ? `${lyrics.source} · ${motAMot ? 'horodaté au mot' : 'mots estimés'}`
    : '';

  activeIndex = -2; // force le recalcul au prochain frame
  activeWordIndex = -2;
  lastPercent = -1;
  wordTiming = null;
  dirty = true;
  el.lines.style.transform = 'translateY(0px)';
}

function statusMessage() {
  switch (status.state) {
    case 'connected':
      return 'En attente de lecture…';
    case 'connecting':
      return 'Connexion à YouTube Music Desktop…';
    case 'unauthorized':
      return status.message || 'Application non appairée. Ouvre les réglages.';
    default:
      return status.message || 'YouTube Music Desktop est introuvable.';
  }
}

/** Recherche binaire de la dernière ligne dont le timestamp est déjà passé. */
function findActiveIndex(t) {
  const lines = lyrics.lines;
  let lo = 0;
  let hi = lines.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid].time <= t) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

function centerOn(index) {
  const vpHeight = el.viewport.clientHeight;
  if (index < 0 || !lineEls[index]) {
    el.lines.style.transform = `translateY(${vpHeight / 2 - 20}px)`;
    return;
  }
  const node = lineEls[index];
  const y = vpHeight / 2 - (node.offsetTop + node.offsetHeight / 2);
  el.lines.style.transform = `translateY(${y}px)`;
}

/** Paroles non synchronisées : défilement proportionnel à l'avancement du morceau. */
function scrollPlain() {
  const vpHeight = el.viewport.clientHeight;
  const overflow = Math.max(0, el.lines.scrollHeight - vpHeight);
  const frac = duration > 0 ? clamp(rawTime() / duration, 0, 1) : 0;
  el.lines.style.transform = `translateY(${-frac * overflow}px)`;
}

/** Calcule les bornes de chaque mot de la ligne `index`. */
function computeWordTiming(index) {
  const line = lyrics.lines[index];
  const spans = lineSpans[index];
  if (!line || !spans || spans.length === 0) return null;

  const start = line.time;
  const next = lyrics.lines[index + 1];
  const lineEnd = next ? next.time : duration > start ? duration : start + 4;
  const gap = Math.max(0.4, lineEnd - start);

  // Timings réels fournis par la source : rien à estimer.
  if (line.words && line.words.length === spans.length) {
    const starts = line.words.map((w) => w.time);
    const ends = starts.map((s, i) =>
      i + 1 < starts.length ? starts[i + 1] : Math.min(lineEnd, s + 2),
    );
    return { starts, ends };
  }

  // Sinon : répartition proportionnelle au nombre de caractères.
  const weights = spans.map((s) => Math.max(1, s.textContent.length));
  const total = weights.reduce((a, b) => a + b, 0);

  // Durée de chant la plus courte plausible pour cette ligne.
  const chantRapide = 0.35 + total / CHARS_PER_SECOND;

  // On remplit sur tout l'écart jusqu'à la ligne suivante, car c'est la seule
  // borne sûre : c'est là que la ligne cesse d'être chantée. On ne s'arrête
  // avant que si l'écart dépasse largement toute vitesse de chant plausible —
  // signe qu'un passage instrumental suit.
  //
  // Prendre systématiquement le minimum des deux, comme je le faisais, revenait
  // à supposer le débit rapide partout : le remplissage terminait avant la voix
  // dès qu'une ligne était chantée posément. C'était la cause du surlignage en avance.
  const window = line.text
    ? Math.min(gap, chantRapide * SLOW_SINGING_FACTOR)
    : gap; // passage instrumental : les notes s'étirent sur tout l'écart

  const starts = [];
  const ends = [];
  let acc = 0;
  for (const weight of weights) {
    starts.push(start + window * (acc / total));
    acc += weight;
    ends.push(start + window * (acc / total));
  }
  return { starts, ends };
}

function clearLineFill(index) {
  const node = lineEls[index];
  if (!node) return;
  node.classList.remove('active');
  for (const span of lineSpans[index] ?? []) span.style.removeProperty('--p');
}

function tick() {
  rafId = requestAnimationFrame(tick);
  if (lineEls.length === 0) return;

  const t = playhead();
  // En pause l'horloge est figée : rien ne peut avoir changé, on rend la main
  // immédiatement plutôt que de recalculer un état identique 60 fois par seconde.
  if (!dirty && t === lastPlayhead) return;
  dirty = false;
  lastPlayhead = t;

  if (lyrics.kind === 'plain') {
    scrollPlain();
    return;
  }

  const index = findActiveIndex(t);

  if (index !== activeIndex) {
    clearLineFill(activeIndex);
    if (lineEls[index]) lineEls[index].classList.add('active');
    activeIndex = index;
    activeWordIndex = -2;
    lastPercent = -1;
    wordTiming = computeWordTiming(index);
    centerOn(index);
  }

  if (!wordTiming) return;

  const spans = lineSpans[index];
  const { starts, ends } = wordTiming;

  let current = -1;
  for (let i = 0; i < starts.length; i++) {
    if (t >= starts[i]) current = i;
    else break;
  }

  // Les mots déjà passés / à venir ne changent qu'au franchissement d'une frontière.
  if (current !== activeWordIndex) {
    for (let i = 0; i < spans.length; i++) {
      spans[i].style.setProperty('--p', i < current ? '100%' : '0%');
    }
    activeWordIndex = current;
    lastPercent = -1;
  }

  if (current >= 0) {
    // Plancher à 0,12 s : sur un mot très court le remplissage serait sinon instantané.
    const ratio = clamp((t - starts[current]) / Math.max(0.12, ends[current] - starts[current]), 0, 1);
    // Arrondi au dixième de pour-cent : sur un mot long, deux frames voisines
    // donnent souvent la même valeur, et réécrire un style identique déclenche
    // quand même un recalcul de style.
    const percent = Math.round(ratio * 1000) / 10;
    if (percent !== lastPercent) {
      spans[current].style.setProperty('--p', `${percent}%`);
      lastPercent = percent;
    }
  }
}

/** « #ff2e5b » → « 255, 46, 91 », pour rester utilisable dans rgba(). */
function hexToTriplet(hex, fallback) {
  const match = /^#?([\da-f]{3}|[\da-f]{6})$/i.exec(String(hex ?? '').trim());
  if (!match) return fallback;
  let digits = match[1];
  if (digits.length === 3) digits = digits.replace(/./g, (c) => c + c);
  const value = Number.parseInt(digits, 16);
  return `${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255}`;
}

let currentFrame = null;
let petalsEl = null;

/** La distance de chute dépend de la hauteur : recalculée au redimensionnement. */
function updateFallDistance() {
  document.documentElement.style.setProperty('--fall', `${el.app.clientHeight + 30}px`);
}

/** Les pétales sont les seuls éléments réels ajoutés, et seulement si ce cadre est choisi. */
function ensurePetals(enabled) {
  if (!enabled) {
    if (petalsEl) {
      petalsEl.remove();
      petalsEl = null;
    }
    return;
  }
  if (petalsEl) return;

  petalsEl = document.createElement('div');
  petalsEl.id = 'petals';
  for (let i = 0; i < 9; i++) {
    const petal = document.createElement('span');
    // Positions, tailles, durées et retards tous distincts : sans quoi les
    // pétales tombent en rang d'oignons et l'effet paraît mécanique.
    petal.style.left = `${(i * 11 + 4) % 92}%`;
    petal.style.setProperty('--taille', `${7 + (i % 4) * 2}px`);
    petal.style.animationDuration = `${7 + ((i * 3) % 5) * 1.6}s`;
    petal.style.animationDelay = `${-i * 1.7}s`;
    petalsEl.appendChild(petal);
  }
  el.app.appendChild(petalsEl);
  updateFallDistance();
}

function applyFrame(style) {
  if (style === currentFrame) return;
  if (currentFrame) el.app.classList.remove(`frame-${currentFrame}`);
  el.app.classList.add(`frame-${style}`);
  currentFrame = style;
  ensurePetals(style === 'petales');
}

function applySettings() {
  const root = document.documentElement.style;
  root.setProperty('--font-size', `${settings.fontSize}px`);
  root.setProperty('--font-family', settings.fontFamily);
  root.setProperty('--font-weight', String(settings.fontWeight));
  root.setProperty('--text-align', settings.textAlign);
  root.setProperty('--card-opacity', String(settings.opacity));
  root.setProperty('--dim-opacity', String(settings.dimOpacity));
  root.setProperty('--radius', `${settings.cornerRadius}px`);
  root.setProperty('--accent', settings.accentColor);
  root.setProperty('--accent-rgb', hexToTriplet(settings.accentColor, '255, 46, 91'));
  root.setProperty('--fg', hexToTriplet(settings.textColor, '255, 255, 255'));
  root.setProperty('--bg', hexToTriplet(settings.backgroundColor, '12, 12, 16'));

  applyFrame(settings.frameStyle ?? 'fin');
  el.app.classList.toggle('glow', Boolean(settings.textGlow));

  // La barre elle-même n'est jamais masquée : #window-actions (⚙ et ✕) est le
  // seul chemin de retour vers les réglages depuis la fenêtre.
  el.transport.classList.toggle('hidden', !settings.showControls);
  el.offsetGroup.classList.toggle('hidden', !settings.showOffset);
  el.meta.style.visibility = settings.showTitle ? '' : 'hidden';
  el.source.classList.toggle('hidden', !settings.showSource);

  const total = Math.round(settings.offsetMs + settings.trackOffsetMs);
  const perTrack = Math.round(settings.trackOffsetMs) !== 0;
  el.offsetLabel.textContent = `${total > 0 ? '+' : ''}${total} ms`;
  el.offsetLabel.classList.toggle('per-track', perTrack);
  document.getElementById('btn-sync').title =
    `Caler ici (${(settings.syncKey || 's').toUpperCase()}) — appuie quand tu entends la ligne commencer`;
  el.offsetLabel.title = perTrack
    ? `Décalage global ${settings.offsetMs} ms + ${settings.trackOffsetMs} ms pour ce morceau — cliquer pour réinitialiser ce morceau`
    : 'Décalage des paroles — les ajustements portent sur le morceau courant';

  // La taille de police change la hauteur des lignes : le recentrage doit être refait.
  activeIndex = -2;
  dirty = true;
}

// ---------------------------------------------------------------------------
// Événements venant du main
// ---------------------------------------------------------------------------

api.onSettings((next) => {
  settings = next;
  applySettings();
});

api.onStatus((next) => {
  status = next;
  if (lineEls.length === 0) {
    el.message.textContent = lyrics.message || statusMessage();
    el.message.classList.remove('hidden');
  }
});

api.onFade((faded) => {
  el.app.classList.toggle('faded', faded);
});

api.onTrack((payload) => {
  el.title.textContent = payload.title || '—';
  el.author.textContent = payload.author || '';
  lyrics = payload.lyrics;
  renderLines();
});

api.onSync((payload) => {
  duration = payload.durationSeconds || 0;
  const nowPlaying = payload.playing && !payload.adPlaying;

  // L'estimation doit être lue avec l'ancien état de lecture, avant de le remplacer.
  const estimate = anchor ? rawTime() : null;
  const trackChanged = payload.videoId !== syncVideoId;
  syncVideoId = payload.videoId;

  if (estimate === null || trackChanged || Math.abs(payload.progress - estimate) > 1.2) {
    // Nouveau morceau, seek, ou dérive trop forte : on recale sec.
    anchor = { t: payload.progress, at: performance.now() };
  } else {
    // Dérive normale : on rattrape 30 % de l'écart pour rester fluide.
    anchor = { t: estimate + (payload.progress - estimate) * 0.3, at: performance.now() };
  }

  playing = nowPlaying;
  dirty = true;
  el.btnPlay.textContent = playing ? '⏸' : '▶';
});

// ---------------------------------------------------------------------------
// Interactions
// ---------------------------------------------------------------------------

document.getElementById('btn-prev').addEventListener('click', () => api.command('previous'));
document.getElementById('btn-next').addEventListener('click', () => api.command('next'));
el.btnPlay.addEventListener('click', () => api.command('playPause'));
document.getElementById('btn-settings').addEventListener('click', () => api.openSettings());
document.getElementById('btn-close').addEventListener('click', () => api.hide());
/**
 * Temps de réaction humain entre le moment où la ligne se fait entendre et
 * l'appui sur la touche. Sans cette compensation, chaque calage placerait les
 * paroles systématiquement trop tard.
 */
const REACTION_S = 0.15;

/**
 * Cale les paroles sur ce que l'utilisateur entend, en un seul geste.
 *
 * Il appuie au moment où une ligne commence réellement ; on en déduit le
 * décalage exact au lieu de le faire chercher à coups de ±100 ms.
 *
 * La ligne visée est celle dont l'horodatage est le plus proche de la position
 * affichée : l'erreur qu'on corrige est justement plus petite que l'écart entre
 * deux lignes, donc la plus proche est la bonne.
 */
function calerIci() {
  if (lyrics.kind !== 'synced' || lineEls.length === 0 || !anchor) return;

  const affiche = playhead();
  let cible = null;
  let meilleure = Infinity;
  for (const line of lyrics.lines) {
    if (!line.text) continue; // les marqueurs instrumentaux ne se chantent pas
    const distance = Math.abs(line.time - affiche);
    if (distance < meilleure) {
      meilleure = distance;
      cible = line;
    }
  }
  if (!cible) return;

  // On veut que cette ligne s'active quand la lecture atteint le moment entendu.
  const total = Math.round((cible.time - rawTime() + REACTION_S) * 1000);
  api.setTotalOffset(total);

  el.offsetLabel.classList.add('flash');
  setTimeout(() => el.offsetLabel.classList.remove('flash'), 450);
}

document.getElementById('btn-sync').addEventListener('click', calerIci);
document.getElementById('btn-offset-down').addEventListener('click', () => api.nudgeOffset(-100));
document.getElementById('btn-offset-up').addEventListener('click', () => api.nudgeOffset(100));
el.offsetLabel.addEventListener('click', () => api.resetOffset());

// Poignée de redimensionnement : on envoie des deltas incrémentaux au main,
// qui applique les bornes minimales sur la fenêtre.
el.grip.addEventListener('pointerdown', (event) => {
  event.preventDefault();
  el.grip.setPointerCapture(event.pointerId);
  let last = { x: event.screenX, y: event.screenY };

  const onMove = (moveEvent) => {
    const dw = moveEvent.screenX - last.x;
    const dh = moveEvent.screenY - last.y;
    if (dw === 0 && dh === 0) return;
    last = { x: moveEvent.screenX, y: moveEvent.screenY };
    api.resizeBy(dw, dh);
  };

  const onUp = () => {
    el.grip.removeEventListener('pointermove', onMove);
    el.grip.removeEventListener('pointerup', onUp);
    el.grip.removeEventListener('pointercancel', onUp);
  };

  el.grip.addEventListener('pointermove', onMove);
  el.grip.addEventListener('pointerup', onUp);
  el.grip.addEventListener('pointercancel', onUp);
});

document.addEventListener('keydown', (event) => {
  if (event.key === ' ') {
    event.preventDefault();
    api.command('playPause');
  } else if (event.key === '[') {
    api.nudgeOffset(-100);
  } else if (event.key === ']') {
    api.nudgeOffset(100);
  } else if (event.key.toLowerCase() === (settings.syncKey || 's').toLowerCase()) {
    calerIci();
  } else if (event.key === 'Escape') {
    api.hide();
  }
});

// Le recentrage dépend de la hauteur du viewport : à recalculer après un redimensionnement.
window.addEventListener('resize', () => {
  activeIndex = -2;
  dirty = true;
  updateFallDistance();
  if (lyrics.kind === 'plain') scrollPlain();
});

// Fenêtre masquée : aucun rendu n'est visible, la boucle est purement gaspillée.
// Chromium bride déjà les fenêtres cachées, mais l'arrêt franc est gratuit.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    cancelAnimationFrame(rafId);
    rafId = 0;
  } else if (!rafId) {
    dirty = true;
    rafId = requestAnimationFrame(tick);
  }
});

applySettings();
renderLines();
updateFallDistance();
rafId = requestAnimationFrame(tick);
api.ready();
