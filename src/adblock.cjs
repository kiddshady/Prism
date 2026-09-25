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
   varios segundos, leer el binario, milisegundos. Cada semana se renueva.
   ═══════════════════════════════════════════════════════════════════════════ */

const fsp = require('fs/promises');
const path = require('path');
const { net } = require('electron');
const { ElectronBlocker, fromElectronDetails } = require('@ghostery/adblocker-electron');

const MAX_AGE = 7 * 86_400_000;

function createAdblock(ctx, { cacheFile }) {
  let blocker = null;
  let total = 0;

  /** ¿Bloquea para esta pestaña? Global apagado o sitio permitido → no. */
  function activeFor(wcId) {
    if (!ctx.settings.adblock) return false;
    const tab = wcId != null ? ctx.tabs?.byWebContents(wcId) : null;
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
    ctx.tabs?.countBlocked(wcId);
  }

  async function load() {
    // Una semana de vida: pasado eso se borra el caché y se baja de nuevo.
    const st = await fsp.stat(cacheFile).catch(() => null);
    if (st && Date.now() - st.mtimeMs > MAX_AGE) await fsp.unlink(cacheFile).catch(() => {});

    /* net.fetch y no el fetch de Node: va por la pila de red de Chromium, que
       hace "happy eyeballs". En esta red IPv6 está agujereado y el fetch de
       Node se cuelga ~63 s antes de caer a IPv4. */
    blocker = await ElectronBlocker.fromPrebuiltFull(net.fetch.bind(net), {
      path: cacheFile,
      read: fsp.readFile,
      write: async (p, buf) => {
        await fsp.mkdir(path.dirname(p), { recursive: true });
        await fsp.writeFile(p, buf);
      },
    });

    const orig = {
      headers: blocker.onHeadersReceived,
      cosmetic: blocker.onInjectCosmeticFilters,
    };

    blocker.onBeforeRequest = (details, callback) => {
      if (!activeFor(details.webContentsId)) return callback({});
      const request = fromElectronDetails(details);
      if (blocker.config.guessRequestTypeFromUrl === true && request.type === 'other') request.guessTypeOfRequest();
      // La página misma nunca se bloquea: el que tipeó la dirección quiere verla.
      if (request.isMainFrame()) return callback({});
      const { redirect, match } = blocker.match(request);
      if (redirect) { counted(details.webContentsId); return callback({ redirectURL: redirect.dataUrl }); }
      if (match) { counted(details.webContentsId); return callback({ cancel: true }); }
      return callback({});
    };

    blocker.onHeadersReceived = (details, callback) => (
      activeFor(details.webContentsId) ? orig.headers(details, callback) : callback({}));

    blocker.onInjectCosmeticFilters = async (event, url, msg) => {
      const wc = event.sender;
      const top = ctx.tabs?.byWebContents(wc?.id);
      if (!ctx.settings.adblock || (top && isAllowed(top.url))) return undefined;
      return orig.cosmetic(event, url, msg);
    };

    blocker.enableBlockingInSession(ctx.web);
    return true;
  }

  return {
    load,
    isAllowed,
    hostOf,
    get ready() { return !!blocker; },
    get total() { return total; },
  };
}

module.exports = { createAdblock };
