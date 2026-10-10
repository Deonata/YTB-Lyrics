// Stub minimal de `window.pip` : le test pousse lui-même les positions de lecture.
const { contextBridge } = require('electron');

const handlers = {};

contextBridge.exposeInMainWorld('pip', {
  ready() {},
  onFade: (cb) => (handlers.fade = cb),
  onTrack: (cb) => (handlers.track = cb),
  onSync: (cb) => (handlers.sync = cb),
  onSettings: (cb) => (handlers.settings = cb),
  onStatus: (cb) => (handlers.status = cb),
  command() {},
  hide() {},
  openSettings() {},
  resizeBy() {},
  nudgeOffset() {},
  setTotalOffset() {},
  resetOffset() {},
});

contextBridge.exposeInMainWorld('pipTest', {
  sync: (payload) => handlers.sync?.(payload),
});
