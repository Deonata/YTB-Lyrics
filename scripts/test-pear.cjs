/**
 * Vérifie la source Pear Desktop contre un faux « API Server » qui reproduit
 * le protocole du plugin (pear-desktop v3.12.0) : appairage, WebSocket,
 * amorçage REST, commandes, jeton refusé et reconnexion.
 * Usage : electron scripts/test-pear.cjs
 */
const { app } = require('electron');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { WebSocketServer } = require('ws');

// Configuration jetable : ne jamais toucher à celle de l'utilisateur.
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'ytmlyricspip-test-'));
app.setPath('userData', userData);

const BON_JETON = 'jeton-de-test';
const MORCEAU_A = {
  title: 'Titre A',
  artist: 'Artiste A',
  album: 'Album A',
  imageSrc: 'https://exemple.invalid/a.jpg',
  isPaused: false,
  songDuration: 200,
  elapsedSeconds: 12,
  videoId: 'videoA',
};
const MORCEAU_B = { ...MORCEAU_A, title: 'Titre B', videoId: 'videoB', elapsedSeconds: 0 };

let failures = 0;
function check(label, ok, detail = '') {
  if (!ok) failures++;
  console.log(`${ok ? 'OK  ' : 'ECHEC'} ${label}${ok || !detail ? '' : ` — ${detail}`}`);
}

const attendre = (ms) => new Promise((r) => setTimeout(r, ms));
async function jusqua(predicat, delaiMs = 3000) {
  const fin = Date.now() + delaiMs;
  while (Date.now() < fin) {
    if (predicat()) return true;
    await attendre(20);
  }
  return predicat();
}

/** Faux serveur ; `refuserAppairage` simule le bouton « Refuser » de Pear. */
function demarrerFauxPear() {
  const etat = { commandes: [], refuserAppairage: false, sockets: new Set() };

  const server = http.createServer((req, res) => {
    const auth = req.headers.authorization;
    if (req.method === 'GET' && req.url === '/doc') {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"openapi":"3.1.0"}');
      return;
    }
    if (req.method === 'POST' && req.url === '/auth/ytmlyricspip') {
      if (etat.refuserAppairage) return void res.writeHead(403).end();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ accessToken: BON_JETON }));
      return;
    }
    if (req.url.startsWith('/api/')) {
      if (auth !== `Bearer ${BON_JETON}`) return void res.writeHead(401).end('Unauthorized');
      if (req.method === 'GET' && req.url === '/api/v1/song') {
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(MORCEAU_A));
        return;
      }
      if (req.method === 'POST') {
        etat.commandes.push(req.url);
        return void res.writeHead(204).end();
      }
    }
    res.writeHead(404).end();
  });

  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname !== '/api/v1/ws') return socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws) => {
      // Comme Pear : la connexion s'ouvre, puis se ferme en 1008 si le jeton est mauvais.
      if (url.searchParams.get('token') !== BON_JETON) return ws.close(1008, 'Unauthorized');
      etat.sockets.add(ws);
      ws.on('close', () => etat.sockets.delete(ws));
      // Pear vient de démarrer : rien n'a encore été diffusé, `song` est absent.
      ws.send(JSON.stringify({ type: 'PLAYER_INFO', isPlaying: false, muted: false, position: 0, volume: 100, repeat: 'NONE', shuffle: false }));
    });
  });

  etat.diffuser = (message) => {
    for (const ws of etat.sockets) ws.send(JSON.stringify(message));
  };

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      etat.port = server.address().port;
      etat.server = server;
      etat.wss = wss;
      resolve(etat);
    });
  });
}

app.whenReady().then(async () => {
  const { updateConfig } = require('../dist/main/config.js');
  const { PearSource, PearStateReducer } = require('../dist/main/players/pear.js');

  // --- Réducteur seul -------------------------------------------------------
  const r = new PearStateReducer();
  check('message sans effet sur les paroles ignoré', r.apply({ type: 'VOLUME_CHANGED', volume: 3 }) === null);
  const apres = r.apply({ type: 'VIDEO_CHANGED', song: MORCEAU_B, position: 0 });
  check('VIDEO_CHANGED → morceau et lecture', apres.id === 'videoB' && apres.playing === true);
  const pos = r.apply({ type: 'POSITION_CHANGED', position: 42.5 });
  check('POSITION_CHANGED garde le morceau', pos.id === 'videoB' && pos.progressSeconds === 42.5);

  // --- Contre le faux serveur -----------------------------------------------
  const pear = await demarrerFauxPear();
  const host = '127.0.0.1';

  await new PearSource(host, pear.port).probe().then(
    () => check('test du serveur', true),
    (e) => check('test du serveur', false, e.message),
  );

  // Contrôle négatif : un port fermé doit échouer, avec un message utile.
  const portFerme = pear.port === 1 ? 2 : 1;
  await new PearSource(host, portFerme).probe().then(
    () => check('port fermé détecté', false, 'aucune erreur'),
    (e) => check('port fermé détecté', /API Server/.test(e.message), e.message),
  );

  pear.refuserAppairage = true;
  await new PearSource(host, pear.port).requestToken().then(
    () => check('refus d’appairage détecté', false, 'jeton rendu'),
    (e) => check('refus d’appairage détecté', e.status === 403, e.message),
  );
  pear.refuserAppairage = false;
  const jeton = await new PearSource(host, pear.port).requestToken();
  check('appairage rend le jeton', jeton === BON_JETON, jeton);

  updateConfig({ pearHost: host, pearPort: pear.port, pearToken: jeton, playerSource: 'pear' });
  const source = new PearSource();
  const etats = [];
  const statuts = [];
  source.on('now', (n) => etats.push(n));
  source.on('status', (s) => statuts.push(s.state));
  source.start();

  check('connexion établie', await jusqua(() => source.getStatus().state === 'connected'));
  check(
    'PLAYER_INFO vide complété par REST',
    await jusqua(() => etats.some((n) => n.id === 'videoA' && n.progressSeconds === 12 && n.playing)),
    JSON.stringify(etats.at(-1)),
  );
  const a = etats.find((n) => n.id === 'videoA');
  check(
    'champs normalisés',
    a && a.title === 'Titre A' && a.artist === 'Artiste A' && a.album === 'Album A' &&
      a.durationSeconds === 200 && a.thumbnail === MORCEAU_A.imageSrc && a.adPlaying === false,
    JSON.stringify(a),
  );

  pear.diffuser({ type: 'VIDEO_CHANGED', song: MORCEAU_B, position: 0 });
  pear.diffuser({ type: 'POSITION_CHANGED', position: 3.25 });
  check('changement de morceau suivi', await jusqua(() => etats.at(-1)?.id === 'videoB' && etats.at(-1).progressSeconds === 3.25));
  pear.diffuser({ type: 'PLAYER_STATE_CHANGED', isPlaying: false, position: 4 });
  check('pause suivie', await jusqua(() => etats.at(-1)?.playing === false && etats.at(-1).progressSeconds === 4));

  for (const c of ['playPause', 'next', 'previous', 'toggleLike']) await source.sendCommand(c);
  check(
    'commandes routées',
    pear.commandes.join(',') === '/api/v1/toggle-play,/api/v1/next,/api/v1/previous,/api/v1/like',
    pear.commandes.join(','),
  );

  // Coupure côté Pear (redémarrage) : la source doit revenir seule.
  statuts.length = 0;
  for (const ws of pear.sockets) ws.close(1001, 'Pear redémarre');
  check(
    'reconnexion après coupure',
    await jusqua(() => statuts.includes('disconnected') && source.getStatus().state === 'connected', 5000),
    statuts.join(' → '),
  );
  source.stop();

  // Jeton refusé : statut « non autorisé », et surtout pas de boucle de reconnexion.
  updateConfig({ pearToken: 'jeton-revoque' });
  const revoquee = new PearSource();
  const tentatives = [];
  revoquee.on('status', (s) => tentatives.push(s.state));
  revoquee.start();
  check('jeton refusé → réappairage demandé', await jusqua(() => revoquee.getStatus().state === 'unauthorized'));
  await attendre(2500);
  check(
    'aucune reconnexion après refus',
    tentatives.filter((s) => s === 'connecting').length === 1,
    tentatives.join(' → '),
  );
  revoquee.stop();

  pear.wss.close();
  pear.server.close();
  fs.rmSync(userData, { recursive: true, force: true });

  console.log(failures === 0 ? '\nTous les contrôles Pear passent.' : `\n${failures} échec(s).`);
  app.exit(failures === 0 ? 0 : 1);
});
