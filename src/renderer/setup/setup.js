'use strict';

const api = window.setup;

const $ = (id) => document.getElementById(id);
const els = {
  status: $('status'),
  host: $('host'),
  port: $('port'),
  probe: $('btn-probe'),
  pair: $('btn-pair'),
  unpair: $('btn-unpair'),
  codeBox: $('code-box'),
  code: $('code'),
  toast: $('toast'),
  clearCache: $('btn-clear-cache'),
  resetLook: $('btn-reset-look'),
  clearOffsets: $('btn-clear-offsets'),
  offsetCount: $('offset-count'),
  pipVisible: $('pipVisible'),
  themeGrid: $('theme-grid'),
  frameGrid: $('frame-grid'),
  syncKey: $('syncKey'),
  syncKeyBtn: $('btn-syncKey'),
  calibState: $('calib-state'),
  forgetCalib: $('btn-forget-calib'),
  playerSource: $('playerSource'),
  srcYtmd: $('src-ytmd'),
  srcSpotify: $('src-spotify'),
  srcPear: $('src-pear'),
  pearHost: $('pearHost'),
  pearPort: $('pearPort'),
  pearProbe: $('btn-pear-probe'),
  pearPair: $('btn-pear-pair'),
  pearUnpair: $('btn-pear-unpair'),
  redirectUri: $('redirect-uri'),
  spotifyClientId: $('spotifyClientId'),
  spotifyConnect: $('btn-spotify-connect'),
  spotifyDisconnect: $('btn-spotify-disconnect'),
};

/** Réglages pilotés génériquement : id du champ → conversion et mise en forme. */
const RANGES = {
  fontSize: { parse: Number, format: (v) => `${v} px` },
  fontWeight: { parse: Number, format: (v) => String(v) },
  opacity: { parse: Number, format: (v) => `${Math.round(v * 100)} %` },
  dimOpacity: { parse: Number, format: (v) => `${Math.round(v * 100)} %` },
  cornerRadius: { parse: Number, format: (v) => `${v} px` },
  offsetMs: { parse: Number, format: (v) => `${v > 0 ? '+' : ''}${v} ms` },
  autoHideDelaySeconds: { parse: Number, format: (v) => `${v} s` },
};
const SELECTS = ['fontFamily', 'textAlign'];
const COLORS = ['accentColor', 'textColor', 'backgroundColor'];
const CHECKS = [
  'showTitle',
  'showControls',
  'showOffset',
  'showSource',
  'clickThrough',
  'textGlow',
  'autoHideWhenPaused',
  'autoCalibrate',
];

let themes = [];
let frames = [];
/** Derniers réglages connus, pour réévaluer la vignette active après une retouche. */
let current = {};

// ---------------------------------------------------------------------------
// Onglets
// ---------------------------------------------------------------------------

function showPanel(id) {
  for (const tab of document.querySelectorAll('.tab')) {
    tab.classList.toggle('active', tab.dataset.panel === id);
  }
  for (const panel of document.querySelectorAll('.panel')) {
    panel.classList.toggle('active', panel.id === id);
  }
}

for (const tab of document.querySelectorAll('.tab')) {
  tab.addEventListener('click', () => showPanel(tab.dataset.panel));
}

// ---------------------------------------------------------------------------
// Affichage
// ---------------------------------------------------------------------------

const SOURCE_LABELS = {
  ytmd: 'YouTube Music Desktop',
  pear: 'Pear Desktop',
  spotify: 'Spotify',
};

function setStatus(status) {
  const label = SOURCE_LABELS[els.playerSource.value] ?? SOURCE_LABELS.ytmd;
  const map = {
    connected: ['ok', `Connecté à ${label}.`],
    connecting: ['warn', 'Connexion en cours…'],
    unauthorized: ['err', status.message || 'Application non appairée.'],
    disconnected: ['err', status.message || `${label} est introuvable.`],
  };
  const [cls, text] = map[status.state] ?? ['', 'État inconnu.'];
  els.status.className = `status ${cls}`;
  els.status.textContent = text;
}

let toastTimer = null;

/**
 * Affiche une notification passagère.
 * `sticky` la garde à l'écran : réservé aux étapes qui durent (attente d'une
 * autorisation) et aux erreurs, qu'on ne veut pas voir disparaître trop vite.
 */
function setMessage(text, kind, sticky = false) {
  if (toastTimer) {
    clearTimeout(toastTimer);
    toastTimer = null;
  }
  if (!text) {
    els.toast.classList.add('hidden');
    return;
  }
  els.toast.textContent = text;
  els.toast.className = `toast ${kind ?? ''}`.trim();
  if (sticky) return;
  toastTimer = setTimeout(
    () => els.toast.classList.add('hidden'),
    kind === 'err' ? 9000 : 4000,
  );
}

function syncOutputs() {
  for (const [id, { parse, format }] of Object.entries(RANGES)) {
    const out = $(`${id}-out`);
    if (out) out.textContent = format(parse($(id).value));
  }
}

function setPairedUi(paired) {
  els.pair.textContent = paired ? 'Réappairer' : 'Appairer';
  els.unpair.disabled = !paired;
}

function setOffsetCount(count) {
  els.offsetCount.textContent =
    count > 0
      ? `${count} morceau(x) ont actuellement un décalage propre.`
      : 'Aucun morceau n’a de décalage propre pour l’instant.';
}

// ---------------------------------------------------------------------------
// Galeries
// ---------------------------------------------------------------------------

/** Vignette d'un thème : quelques lignes factices dans ses propres couleurs. */
function buildThemeCard(theme) {
  const { settings } = theme;
  const card = document.createElement('button');
  card.className = 'card';
  card.dataset.themeId = theme.id;

  const preview = document.createElement('div');
  preview.className = 'card-preview';
  preview.style.background = settings.backgroundColor;
  preview.style.fontFamily = settings.fontFamily;

  // Une ligne à l'accent (celle qui est chantée), deux en couleur de texte atténuée.
  const widths = ['62%', '88%', '48%'];
  widths.forEach((width, i) => {
    const line = document.createElement('div');
    line.className = 'card-line';
    line.style.width = width;
    line.style.background = i === 1 ? settings.accentColor : settings.textColor;
    line.style.opacity = i === 1 ? '1' : String(settings.dimOpacity + 0.12);
    if (settings.textAlign === 'center') line.style.margin = '0 auto';
    if (settings.textAlign === 'right') line.style.marginLeft = 'auto';
    preview.appendChild(line);
  });

  const foot = document.createElement('div');
  foot.className = 'card-foot';
  const name = document.createElement('span');
  name.textContent = theme.name;
  foot.appendChild(name);

  card.append(preview, foot);
  card.addEventListener('click', async () => {
    const applied = await api.applyTheme(theme.id);
    applySnapshot(applied);
    setMessage(`Thème « ${theme.name} » appliqué.`, 'ok');
  });
  return card;
}

/** Vignette d'un cadre : le cadre lui-même, sur un aplat neutre. */
function buildFrameCard(frame) {
  const card = document.createElement('button');
  card.className = 'card';
  card.dataset.frameId = frame.id;

  const preview = document.createElement('div');
  preview.className = 'card-preview';
  preview.style.background = '#0c0c10';

  // Aperçu schématique : un rectangle qui suggère le traitement du bord.
  const box = document.createElement('div');
  box.style.cssText =
    'position:absolute;inset:10px;border-radius:8px;border:1px solid rgba(255,255,255,.1)';
  const accent = 'var(--accent)';
  if (frame.id === 'aucun') box.style.border = '1px dashed rgba(255,255,255,.12)';
  if (frame.id === 'lueur' || frame.id === 'lueur-pulse') {
    box.style.border = `1px solid ${accent}`;
    box.style.boxShadow = `0 0 14px -3px ${accent}`;
  }
  if (frame.id === 'double') {
    box.style.border = '1px solid rgba(255,255,255,.28)';
    box.style.boxShadow = 'inset 0 0 0 3px #0c0c10, inset 0 0 0 4px rgba(255,255,255,.2)';
  }
  if (frame.id === 'coins') {
    box.style.border = '0';
    box.style.backgroundImage = `linear-gradient(${accent},${accent}),linear-gradient(${accent},${accent}),linear-gradient(${accent},${accent}),linear-gradient(${accent},${accent})`;
    box.style.backgroundRepeat = 'no-repeat';
    box.style.backgroundSize = '14px 2px, 2px 14px, 14px 2px, 2px 14px';
    box.style.backgroundPosition = 'left top, left top, right bottom, right bottom';
  }
  if (frame.id === 'ruban') {
    box.style.border = '0';
    box.style.backgroundImage = `linear-gradient(90deg, ${accent}, transparent)`;
    box.style.backgroundRepeat = 'no-repeat';
    box.style.backgroundSize = '100% 3px';
    box.style.backgroundPosition = 'top';
  }
  if (frame.id === 'scanlines' || frame.id === 'scanlines-anim') {
    box.style.backgroundImage =
      'repeating-linear-gradient(rgba(255,255,255,0) 0 2px, rgba(255,255,255,.16) 2px 3px)';
  }
  if (frame.id === 'balayage') {
    box.style.border = '0';
    box.style.backgroundImage = `conic-gradient(from 210deg, transparent 0 55%, ${accent} 76%, transparent 92%)`;
    box.style.opacity = '0.85';
  }
  if (frame.id === 'petales') {
    box.style.border = '1px solid rgba(255,255,255,.1)';
    box.style.backgroundImage = `radial-gradient(5px 5px at 22% 30%, ${accent} 60%, transparent 62%),radial-gradient(5px 5px at 58% 62%, ${accent} 60%, transparent 62%),radial-gradient(5px 5px at 80% 24%, ${accent} 60%, transparent 62%)`;
  }
  preview.appendChild(box);

  const foot = document.createElement('div');
  foot.className = 'card-foot';
  const name = document.createElement('span');
  name.textContent = frame.name;
  const tag = document.createElement('span');
  tag.className = `card-tag${frame.animated ? ' anim' : ''}`;
  tag.textContent = frame.animated ? `animé · ${frame.cost}` : 'statique';
  foot.append(name, tag);

  card.append(preview, foot);
  card.addEventListener('click', () => {
    api.setSetting('frameStyle', frame.id);
    noteChange('frameStyle', frame.id);
  });
  return card;
}

function markActiveFrame(id) {
  for (const card of els.frameGrid.querySelectorAll('.card')) {
    card.classList.toggle('active', card.dataset.frameId === id);
  }
}

/**
 * Un thème est « actif » quand tous les réglages qu'il définit correspondent
 * encore à ceux en vigueur : dès que l'utilisateur retouche une couleur, plus
 * aucune vignette n'est marquée, ce qui est l'information juste.
 */
function markActiveTheme(settings) {
  for (const card of els.themeGrid.querySelectorAll('.card')) {
    const theme = themes.find((t) => t.id === card.dataset.themeId);
    const identique =
      theme && Object.entries(theme.settings).every(([key, value]) => settings[key] === value);
    card.classList.toggle('active', Boolean(identique));
  }
}

// ---------------------------------------------------------------------------
// Application d'un instantané de réglages
// ---------------------------------------------------------------------------

function applySnapshot(settings, pipVisible) {
  for (const id of Object.keys(RANGES)) $(id).value = String(settings[id]);
  for (const id of SELECTS) $(id).value = settings[id];
  for (const id of COLORS) $(id).value = settings[id];
  for (const id of CHECKS) $(id).checked = Boolean(settings[id]);
  if (pipVisible !== undefined) els.pipVisible.checked = pipVisible;
  els.syncKey.value = (settings.syncKey || 's').toUpperCase();
  setCalibState(settings);
  markActiveFrame(settings.frameStyle);
  markActiveTheme(settings);
  syncOutputs();
  current = { ...settings };
}

/** Une retouche manuelle peut faire sortir les réglages du thème en cours. */
function noteChange(key, value) {
  current[key] = value;
  markActiveTheme(current);
  if (key === 'frameStyle') markActiveFrame(value);
}

// ---------------------------------------------------------------------------
// Réglages — `input` pour un retour immédiat dans la PiP pendant qu'on fait glisser
// ---------------------------------------------------------------------------

for (const [id, { parse }] of Object.entries(RANGES)) {
  $(id).addEventListener('input', () => {
    syncOutputs();
    const value = parse($(id).value);
    api.setSetting(id, value);
    noteChange(id, value);
  });
}
for (const id of [...SELECTS, ...COLORS]) {
  $(id).addEventListener('input', () => {
    api.setSetting(id, $(id).value);
    noteChange(id, $(id).value);
  });
}
for (const id of CHECKS) {
  $(id).addEventListener('change', () => {
    api.setSetting(id, $(id).checked);
    noteChange(id, $(id).checked);
  });
}

els.pipVisible.addEventListener('change', () => api.togglePip(els.pipVisible.checked));

els.clearCache.addEventListener('click', async () => {
  await api.clearCache();
  setMessage('Cache vidé. Les paroles seront retéléchargées au prochain morceau.', 'ok');
});

els.resetLook.addEventListener('click', async () => {
  applySnapshot(await api.resetAppearance());
  setMessage('Apparence rétablie.', 'ok');
});

els.clearOffsets.addEventListener('click', async () => {
  const count = await api.clearTrackOffsets();
  setOffsetCount(0);
  setMessage(
    count > 0
      ? `${count} décalage(s) par morceau oubliés. Le décalage global est conservé.`
      : 'Aucun décalage par morceau enregistré.',
    'ok',
  );
});

// ---------------------------------------------------------------------------
// Appairage
// ---------------------------------------------------------------------------

function endpoint() {
  return { host: els.host.value.trim() || '127.0.0.1', port: Number(els.port.value) || 9863 };
}

els.probe.addEventListener('click', async () => {
  const { host, port } = endpoint();
  els.probe.disabled = true;
  setMessage('Test en cours…', null, true);
  const res = await api.probe(host, port);
  els.probe.disabled = false;
  setMessage(
    res.ok ? `Companion Server détecté sur ${host}:${port}.` : res.error || 'Serveur injoignable.',
    res.ok ? 'ok' : 'err',
  );
});

els.pair.addEventListener('click', async () => {
  const { host, port } = endpoint();
  els.pair.disabled = true;
  els.probe.disabled = true;
  els.codeBox.classList.add('hidden');
  setMessage('Demande du code… Garde YTMDesktop au premier plan pour autoriser.', null, true);

  const res = await api.pair(host, port);

  els.pair.disabled = false;
  els.probe.disabled = false;
  els.codeBox.classList.add('hidden');

  if (res.ok) {
    setPairedUi(true);
    setMessage('Appairage réussi. La fenêtre PiP se remplira dès la prochaine lecture.', 'ok');
  } else {
    setMessage(res.error || "Échec de l'appairage.", 'err');
  }
});

els.unpair.addEventListener('click', async () => {
  await api.unpair();
  setPairedUi(false);
  setMessage('Jeton supprimé. Pense aussi à révoquer l’application dans YTMDesktop.', 'ok');
});

// ---------------------------------------------------------------------------
// Source de lecture
// ---------------------------------------------------------------------------

/** N'affiche que le bloc de la source retenue : elles ne servent jamais ensemble. */
function showSource(id) {
  els.srcYtmd.classList.toggle('hidden', id !== 'ytmd');
  els.srcPear.classList.toggle('hidden', id !== 'pear');
  els.srcSpotify.classList.toggle('hidden', id !== 'spotify');
}

els.playerSource.addEventListener('change', async () => {
  const id = els.playerSource.value;
  showSource(id);
  await api.setSource(id);
  setMessage(`Source basculée sur ${SOURCE_LABELS[id] ?? id}.`, 'ok');
});

// ---------------------------------------------------------------------------
// Pear Desktop
// ---------------------------------------------------------------------------

function pearEndpoint() {
  return {
    host: els.pearHost.value.trim() || '127.0.0.1',
    port: Number(els.pearPort.value) || 26538,
  };
}

function setPearUi(paired) {
  els.pearPair.textContent = paired ? 'Réappairer' : 'Appairer';
  els.pearUnpair.disabled = !paired;
}

els.pearProbe.addEventListener('click', async () => {
  const { host, port } = pearEndpoint();
  els.pearProbe.disabled = true;
  setMessage('Test en cours…', null, true);
  const res = await api.pearProbe(host, port);
  els.pearProbe.disabled = false;
  setMessage(
    res.ok ? `API Server de Pear détecté sur ${host}:${port}.` : res.error || 'Serveur injoignable.',
    res.ok ? 'ok' : 'err',
  );
});

els.pearPair.addEventListener('click', async () => {
  const { host, port } = pearEndpoint();
  els.pearPair.disabled = true;
  els.pearProbe.disabled = true;
  setMessage('Autorise « ytmlyricspip » dans la fenêtre que Pear vient d’ouvrir…', null, true);

  const res = await api.pearPair(host, port);

  els.pearPair.disabled = false;
  els.pearProbe.disabled = false;
  if (res.ok) {
    els.playerSource.value = 'pear';
    showSource('pear');
    setPearUi(true);
    setMessage('Pear Desktop est appairé. La fenêtre PiP se remplira dès la prochaine lecture.', 'ok');
  } else {
    setMessage(res.error || "Échec de l'appairage.", 'err');
  }
});

els.pearUnpair.addEventListener('click', async () => {
  await api.pearUnpair();
  setPearUi(false);
  setMessage(
    'Jeton supprimé. Pear n’a pas de menu pour révoquer un client : « ytmlyricspip » reste autorisé dans la configuration du plugin.',
    'ok',
  );
});

function setSpotifyUi(connected) {
  els.spotifyDisconnect.disabled = !connected;
  els.spotifyConnect.textContent = connected ? 'Reconnecter Spotify' : 'Connecter Spotify';
}

els.spotifyConnect.addEventListener('click', async () => {
  els.spotifyConnect.disabled = true;
  setMessage('Autorisation ouverte dans le navigateur — reviens ici une fois validée.', null, true);
  const res = await api.spotifyConnect(els.spotifyClientId.value);
  els.spotifyConnect.disabled = false;
  if (res.ok) {
    els.playerSource.value = 'spotify';
    showSource('spotify');
    setSpotifyUi(true);
    setMessage('Spotify est connecté.', 'ok');
  } else {
    setMessage(res.error || 'Échec de la connexion Spotify.', 'err');
  }
});

els.spotifyDisconnect.addEventListener('click', async () => {
  await api.spotifyDisconnect();
  setSpotifyUi(false);
  setMessage('Compte Spotify dissocié.', 'ok');
});

api.onCode((code) => {
  els.code.textContent = code;
  els.codeBox.classList.remove('hidden');
  setMessage('En attente de ton autorisation dans YTMDesktop (30 s)…', null, true);
});

api.onStatus(setStatus);

// ---------------------------------------------------------------------------
// Amorçage
// ---------------------------------------------------------------------------

api.getSnapshot().then((snap) => {
  themes = snap.themes ?? [];
  frames = snap.frames ?? [];
  for (const theme of themes) els.themeGrid.appendChild(buildThemeCard(theme));
  for (const frame of frames) els.frameGrid.appendChild(buildFrameCard(frame));

  els.host.value = snap.host;
  els.port.value = String(snap.port);
  applySnapshot(snap.settings, snap.pipVisible);
  setPairedUi(snap.hasToken);
  setOffsetCount(snap.trackOffsetCount ?? 0);

  els.playerSource.value = snap.playerSource ?? 'ytmd';
  showSource(els.playerSource.value);
  setStatus(snap.status);
  els.pearHost.value = snap.pearHost ?? '127.0.0.1';
  els.pearPort.value = String(snap.pearPort ?? 26538);
  setPearUi(Boolean(snap.pearConnected));
  els.redirectUri.textContent = snap.spotifyRedirectUri ?? '';
  els.spotifyClientId.value = snap.spotifyClientId ?? '';
  setSpotifyUi(Boolean(snap.spotifyConnected));

  // Rien de configuré : la connexion est la seule chose à faire, on y ouvre directement.
  const pret =
    snap.playerSource === 'spotify'
      ? snap.spotifyConnected
      : snap.playerSource === 'pear'
        ? snap.pearConnected
        : snap.hasToken;
  showPanel(pret ? 'p-themes' : 'p-connexion');
});

// ---------------------------------------------------------------------------
// Calage : touche et apprentissage
// ---------------------------------------------------------------------------

/** Réservées par la fenêtre PiP ; les réattribuer casserait une autre commande. */
const TOUCHES_RESERVEES = new Set([' ', '[', ']', 'escape']);
const CALAGES_MINIMUM = 3;

function setCalibState(settings) {
  const n = settings.calibrationSamples ?? 0;
  const global = Math.round(settings.offsetMs ?? 0);

  if (!settings.autoCalibrate) {
    els.calibState.textContent =
      'Apprentissage désactivé : chaque calage ne vaut que pour son morceau.';
    return;
  }
  if (n < CALAGES_MINIMUM) {
    els.calibState.textContent =
      `${n} calage${n > 1 ? 's' : ''} mesuré${n > 1 ? 's' : ''} sur ${CALAGES_MINIMUM} nécessaires. ` +
      'En dessous, la médiane ne veut rien dire et rien n’est appliqué automatiquement.';
    return;
  }
  els.calibState.textContent =
    `Décalage appris : ${global > 0 ? '+' : ''}${global} ms, médiane de ${n} calage${n > 1 ? 's' : ''}. ` +
    'Il s’applique d’office aux morceaux jamais calés ; les autres gardent le leur.';
}

let captureEnCours = false;

function demarrerCapture() {
  if (captureEnCours) return;
  captureEnCours = true;
  els.syncKey.classList.add('capture');
  els.syncKey.value = '…';
  setMessage('Appuie sur la touche à utiliser (Échap pour annuler).', null, true);
}

function arreterCapture(touche) {
  captureEnCours = false;
  els.syncKey.classList.remove('capture');
  els.syncKey.value = (touche ?? current.syncKey ?? 's').toUpperCase();
}

els.syncKey.addEventListener('click', demarrerCapture);
els.syncKeyBtn.addEventListener('click', demarrerCapture);

window.addEventListener('keydown', (event) => {
  if (!captureEnCours) return;
  event.preventDefault();

  // Une touche morte ne peut pas servir de raccourci à elle seule.
  if (['Shift', 'Control', 'Alt', 'Meta'].includes(event.key)) return;

  if (event.key === 'Escape') {
    arreterCapture();
    setMessage('Changement annulé.', null);
    return;
  }
  if (TOUCHES_RESERVEES.has(event.key.toLowerCase())) {
    arreterCapture();
    setMessage('Cette touche est déjà prise par la fenêtre PiP. Choisis-en une autre.', 'err');
    return;
  }

  api.setSetting('syncKey', event.key);
  noteChange('syncKey', event.key);
  arreterCapture(event.key);
  setMessage(`Calage désormais sur « ${event.key.toUpperCase()} ».`, 'ok');
});

els.forgetCalib.addEventListener('click', async () => {
  const settings = await api.forgetCalibration();
  applySnapshot(settings);
  setMessage('Apprentissage effacé et décalage global remis à zéro.', 'ok');
});
