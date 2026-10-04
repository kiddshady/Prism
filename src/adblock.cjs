'use strict';

/* ═══════════════════════════════════════════════════════════════════════════
   PRISM — bloqueador
   El motor es el de Ghostery (@ghostery/adblocker-electron) con las listas de
   EasyList, EasyPrivacy y uBlock Origin — anuncios, rastreadores y los
   carteles de cookies.

   No se usa su cableado tal cual por dos cosas que un navegador necesita y la
   librería no trae: CONTAR lo bloqueado por pestaña (para el escudo de la
   barra) y APAGARLO por sitio (hay páginas que se rompen). Las dos cosas se
   resuelven envolviendo sus tres manejadores — la librería los llama por
   propiedad en cada request, así que reemplazarlos en la instancia alcanza.

   El motor compilado se cachea en disco: bajar y parsear las listas tarda
   varios segundos, leer el binario, milisegundos. Cada semana se renueva,
   también con Prism abierto, y la renovación va por detrás: el caché de la
   semana pasada bloquea mientras tanto. Antes se borraba primero, y si al
   arrancar no había red (Windows recién prendido) Prism quedaba sin
   bloqueador hasta reiniciarlo. Si bajar falla, se reintenta solo.
   ═══════════════════════════════════════════════════════════════════════════ */

const fsp = require('fs/promises');
const path = require('path');
const { net } = require('electron');
const { ElectronBlocker, fromElectronDetails } = require('@ghostery/adblocker-electron');
const windows = require('./windows.cjs');

/* El preload de los filtros cosméticos, el mismo que usa Ghostery. */
const COSMETIC_PRELOAD = path.resolve(require.resolve('@ghostery/adblocker-electron-preload'));

const MAX_AGE = 7 * 86_400_000;
/** Si no se pudieron bajar las listas: se vuelve a probar a los 1, 5, 15 y 60 min, y después cada hora. */
const RETRY = [1, 5, 15, 60].map((m) => m * 60_000);

/* net.fetch y no el fetch de Node: va por la pila de red de Chromium, que
   hace "happy eyeballs". En esta red IPv6 está agujereado y el fetch de Node
   se cuelga ~63 s antes de caer a IPv4. */
const netFetch = (url, init) => net.fetch(url, init);

function createAdblock(ctx, { cacheFile, fetch = netFetch, retry = RETRY }) {
  let blocker = null;
  let total = 0;
  let refreshTimer = null;
  let failures = 0;
  let lastError = null;
  /* Una lista que contesta 404 o 429 (raw.githubusercontent.com limita los
     pedidos) no es una lista: Ghostery no mira el estado, y parseaba el texto
     del error como filtros y cacheaba el motor una semana como si estuviera
     completo. Así, la descarga entera falla y se reintenta. */
  const fetchOk = async (url, init) => {
    const r = await fetch(url, init);
    if (!r.ok) throw new Error(`${r.status} en ${url}`);
    return r;
  };
  /* Las sesiones donde bloquea: la normal y, mientras exista, la de incógnito.
     Ghostery engancha una sesión registrando canales IPC globales (no se
     pueden registrar dos veces), así que solo la normal va por su camino; las
     demás se cuelgan de esos mismos canales, que despachan al mismo motor, y
     solo suman su preload y sus filtros de red. */
  const sessions = new Map([[ctx.web, null]]);   // session → id de su preload (las extra)
  function hook(session) {
    if (session === ctx.web) { blocker.enableBlockingInSession(session); return; }
    if (sessions.get(session)) return;
    sessions.set(session, session.registerPreloadScript({ type: 'frame', filePath: COSMETIC_PRELOAD }));
    session.webRequest.onHeadersReceived({ urls: ['<all_urls>'] }, (d, cb) => blocker.onHeadersReceived(d, cb));
    session.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (d, cb) => blocker.onBeforeRequest(d, cb));
  }

  /** ¿Bloquea para esta pestaña? Global apagado o sitio permitido → no. */
  function activeFor(wcId) {
    if (!ctx.settings.adblock) return false;
    const tab = wcId != null ? windows.tabOf(wcId)?.tab : null;
    if (!tab) return true;   // service workers, prefetch: sin pestaña, se bloquea igual
    return !isAllowed(tab.url);
  }

  function hostOf(url) {
    try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
  }

  function isAllowed(url) {
    const host = hostOf(url);
    return !!host && (ctx.settings.adblockAllow || []).includes(host);
  }

  function counted(wcId) {
    total += 1;
    windows.tabOf(wcId)?.w.tabs.countBlocked(wcId);
  }

  /** Le pone a un motor los manejadores propios (contar, apagar por sitio). */
  function wrap(engine) {
    const orig = {
      headers: engine.onHeadersReceived,
      cosmetic: engine.onInjectCosmeticFilters,
    };

    engine.onBeforeRequest = (details, callback) => {
      if (!activeFor(details.webContentsId)) return callback({});
      const request = fromElectronDetails(details);
      if (engine.config.guessRequestTypeFromUrl === true && request.type === 'other') request.guessTypeOfRequest();
      // La página misma nunca se bloquea: el que tipeó la dirección quiere verla.
      if (request.isMainFrame()) return callback({});
      const { redirect, match } = engine.match(request);
      if (redirect) { counted(details.webContentsId); return callback({ redirectURL: redirect.dataUrl }); }
      if (match) { counted(details.webContentsId); return callback({ cancel: true }); }
      return callback({});
    };

    engine.onHeadersReceived = (details, callback) => (
      activeFor(details.webContentsId) ? orig.headers(details, callback) : callback({}));

    engine.onInjectCosmeticFilters = async (event, url, msg) => {
      const wc = event.sender;
      const top = windows.tabOf(wc?.id)?.tab;
      if (!ctx.settings.adblock || (top && isAllowed(top.url))) return undefined;
      return orig.cosmetic(event, url, msg);
    };
    return engine;
  }

  /* Un motor nuevo reemplaza al anterior sin hueco: Ghostery engancha la
     sesión con funciones que apuntan a SU instancia, así que se desengancha
     el viejo y se engancha el nuevo en el mismo instante. Las sesiones extra
     (incógnito) llaman por `blocker`: con cambiar la variable alcanza. */
  function install(next) {
    wrap(next);
    if (blocker?.isBlockingEnabled(ctx.web)) blocker.disableBlockingInSession(ctx.web);
    blocker = next;
    for (const s of sessions.keys()) hook(s);
  }

  async function readCache() {
    try {
      const [st, buf] = await Promise.all([fsp.stat(cacheFile), fsp.readFile(cacheFile)]);
      return { engine: ElectronBlocker.deserialize(buf), age: Date.now() - st.mtimeMs };
    } catch {
      return null;   // no hay, o está roto: se baja
    }
  }

  /** Escribir encima directo dejaría un binario cortado si Prism se cierra a mitad. */
  async function writeCache(engine) {
    const tmp = `${cacheFile}.${process.pid}.tmp`;
    await fsp.mkdir(path.dirname(cacheFile), { recursive: true });
    await fsp.writeFile(tmp, engine.serialize());
    await fsp.rename(tmp, cacheFile).catch(async (err) => { await fsp.unlink(tmp).catch(() => {}); throw err; });
  }

  function later(ms) {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => { refresh(); }, Math.max(1000, ms));
    refreshTimer.unref?.();
  }

  /** Baja las listas, y si llegan enteras, cambia el motor y el caché. */
  async function refresh() {
    clearTimeout(refreshTimer);
    try {
      const next = await ElectronBlocker.fromPrebuiltFull(fetchOk);
      install(next);
      failures = 0;
      lastError = null;
      await writeCache(next).catch((err) => console.error('[adblock] no se pudo guardar el caché:', err.message));
      later(MAX_AGE);
      return true;
    } catch (err) {
      lastError = err?.message || String(err);
      console.error('[adblock] no se pudieron bajar las listas:', lastError);
      later(retry[Math.min(failures++, retry.length - 1)]);
      return false;
    }
  }

  /** Arranca con el caché (aunque esté vencido) y renueva por detrás si hace falta. */
  async function load() {
    const cached = await readCache();
    if (cached) install(cached.engine);
    if (cached && cached.age < MAX_AGE) { later(MAX_AGE - cached.age); return true; }
    return refresh();
  }

  /** Bloquear también en otra sesión (incógnito). Si las listas todavía no
      cargaron, se suma cuando carguen. */
  function addSession(session) {
    if (!sessions.has(session)) sessions.set(session, null);
    if (blocker) hook(session);
  }
  function removeSession(session) {
    if (session === ctx.web || !sessions.has(session)) return;
    const id = sessions.get(session);
    sessions.delete(session);
    if (id) session.unregisterPreloadScript(id);
    session.webRequest.onHeadersReceived(null);
    session.webRequest.onBeforeRequest(null);
  }

  return {
    load,
    refresh,
    addSession,
    removeSession,
    isAllowed,
    hostOf,
    get ready() { return !!blocker; },
    /** Por qué no se pudieron bajar las listas la última vez (null si anduvo). */
    get error() { return lastError; },
    get total() { return total; },
  };
}

module.exports = { createAdblock };
