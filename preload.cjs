'use strict';

/* ═══════════════════════════════════════════════════════════════════════════
   PRISM — preload de la ventana
   La única puerta entre la interfaz y el sistema. Lo que no esté acá, la
   interfaz no lo puede hacer. Las PÁGINAS no tienen este preload: viven en
   otra sesión, sandboxeadas, y no ven `window.prism`.

   Regla heredada de Opal: exponé funciones, nunca objetos de Electron.
   ═══════════════════════════════════════════════════════════════════════════ */

const { contextBridge, ipcRenderer } = require('electron');

/** Desenvuelve {ok,data|error} y convierte el error en una excepción real. */
const call = async (channel, ...args) => {
  const res = await ipcRenderer.invoke(channel, ...args);
  if (!res?.ok) throw new Error(res?.error || `Falló ${channel}`);
  return res.data;
};
const send = (channel, ...args) => ipcRenderer.send(channel, ...args);

/** Suscripción que devuelve su propia baja. */
const listen = (channel) => (cb) => {
  const handler = (_e, ...args) => cb(...args);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.off(channel, handler);
};

contextBridge.exposeInMainWorld('prism', {
  info: () => call('app:info'),
  relaunch: () => call('app:relaunch'),
  openData: () => call('app:open-data'),
  /** Salir de verdad. Cerrar la ventana solo la manda a la bandeja. */
  quit: () => send('app:quit'),

  update: {
    state: () => ipcRenderer.invoke('update:state'),
    check: () => ipcRenderer.invoke('update:check'),
    download: () => ipcRenderer.invoke('update:download'),
    install: () => ipcRenderer.invoke('update:install'),
    onState: listen('update:state'),
  },

  win: {
    minimize: () => send('win:minimize'),
    toggleMaximize: () => send('win:toggle-maximize'),
    close: () => send('win:close'),
    isMaximized: () => ipcRenderer.invoke('win:is-maximized'),
    setBackground: (hex) => send('win:set-bg', hex),
    onMaximized: listen('win:maximized'),
  },

  tabs: {
    state: () => call('tabs:state'),
    onState: listen('tabs:state'),
    create: (url = '', opts = {}) => send('tabs:new', url, opts),
    close: (id) => send('tabs:close', id),
    activate: (id) => send('tabs:activate', id),
    move: (id, to) => send('tabs:move', id, to),
    duplicate: (id) => send('tabs:duplicate', id),
    mute: (id) => send('tabs:mute', id),
    pin: (id, pinned) => send('tabs:pin', id, !!pinned),
    reopen: () => send('tabs:reopen'),
    closeOthers: (id) => send('tabs:close-others', id),
    closeRight: (id) => send('tabs:close-right', id),
    navigate: (id, input) => call('tabs:navigate', id, input),
  },

  nav: {
    back: () => send('nav:back'),
    forward: () => send('nav:forward'),
    reload: (hard = false) => send('nav:reload', hard),
    stop: () => send('nav:stop'),
  },

  page: {
    setInsets: (i) => send('page:insets', i),
    snapshot: () => call('page:snapshot'),
    hold: (on) => call('page:hold', on),
    focus: () => send('page:focus'),
    zoom: (dir) => send('page:zoom', dir),
    devtools: () => send('page:devtools'),
    print: () => send('page:print'),
    find: (text, opts) => send('page:find', text, opts),
    findStop: () => send('page:find-stop'),
    context: (action, payload) => send('page:context', action, payload),
    exitFullscreen: () => send('page:exit-fullscreen'),
    onHover: listen('page:hover'),
    onFind: listen('page:find'),
    onContext: listen('page:context'),
    onFullscreen: listen('page:fullscreen'),
  },

  omni: {
    suggest: (q) => call('omni:suggest', q),
    remote: (q) => call('omni:remote', q),
  },

  history: {
    list: (opts) => call('history:list', opts),
    remove: (ids) => call('history:remove', ids),
    clear: (since) => call('history:clear', since),
    top: (n) => call('history:top', n),
  },

  bookmarks: {
    list: () => call('bookmarks:list'),
    toggle: (info) => call('bookmarks:toggle', info),
    add: (info) => call('bookmarks:add', info),
    update: (id, patch) => call('bookmarks:update', id, patch),
    remove: (id) => call('bookmarks:remove', id),
    move: (id, to) => call('bookmarks:move', id, to),
  },
  onLibraryChanged: listen('library:changed'),

  downloads: {
    list: () => call('downloads:list'),
    onState: listen('downloads:state'),
    onStarted: listen('downloads:started'),
    open: (id) => call('downloads:open', id),
    show: (id) => call('downloads:show', id),
    cancel: (id) => call('downloads:cancel', id),
    pause: (id) => call('downloads:pause', id),
    resume: (id) => call('downloads:resume', id),
    retry: (id) => call('downloads:retry', id),
    remove: (id) => call('downloads:remove', id),
    clear: () => call('downloads:clear'),
    folder: () => call('downloads:folder'),
    dir: () => call('downloads:dir'),
  },

  settings: {
    get: () => call('settings:get'),
    save: (patch) => call('settings:save', patch),
    onChange: listen('settings:changed'),
  },

  adblock: {
    toggleSite: (url) => call('adblock:toggle-site', url),
    stats: () => call('adblock:stats'),
  },

  permissions: {
    revoke: (origin, key) => call('permissions:revoke', origin, key),
  },

  data: {
    clear: (what) => call('data:clear', what),
    chooseFolder: (current) => call('dialog:folder', current),
  },

  prompts: {
    onAsk: listen('prompt:ask'),
    onCancel: listen('prompt:cancel'),
    answer: (id, answer) => send('prompt:answer', id, answer),
  },

  /** Comandos que resuelve la interfaz (enfocar la omnibox, abrir el buscador…). */
  onCommand: listen('cmd'),
  onStatus: listen('status:msg'),
});
