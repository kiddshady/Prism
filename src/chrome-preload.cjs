'use strict';

/* ═══════════════════════════════════════════════════════════════════════════
   PRISM — preload de las páginas: window.chrome
   En Chrome, toda página tiene window.chrome con `app`, `csi` y `loadTimes`.
   En Electron está vacío, y eso es lo que usa el login de Google para decir
   "No puedes acceder: este navegador no es seguro" (ver src/web.cjs,
   "Entrar con Google"). Acá se completa, en el mundo de la página y antes de
   su primer script, con la misma forma que en Chrome.

   No toca nada que la página ya tenga: si window.chrome trae algo, se
   respeta.
   ═══════════════════════════════════════════════════════════════════════════ */

const { contextBridge } = require('electron');

contextBridge.executeInMainWorld({
  func: () => {
    const c = window.chrome || {};
    const nav = () => performance.getEntriesByType('navigation')[0] || {};
    const origin = performance.timeOrigin;

    if (!c.app) {
      c.app = {
        isInstalled: false,
        InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' },
        RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' },
        getDetails() { return null; },
        getIsInstalled() { return false; },
        installState(cb) { if (typeof cb === 'function') cb('not_installed'); },
        runningState() { return 'cannot_run'; },
      };
    }
    if (!c.csi) {
      c.csi = function csi() {
        const n = nav();
        return { startE: Math.round(origin), onloadT: Math.round(origin + (n.loadEventEnd || 0)), pageT: performance.now(), tran: 15 };
      };
    }
    if (!c.loadTimes) {
      c.loadTimes = function loadTimes() {
        const n = nav();
        const s = (ms) => (origin + (ms || 0)) / 1000;
        const proto = n.nextHopProtocol || 'http/1.1';
        return {
          requestTime: s(n.requestStart),
          startLoadTime: s(n.startTime),
          commitLoadTime: s(n.responseStart),
          finishDocumentLoadTime: s(n.domContentLoadedEventEnd),
          finishLoadTime: s(n.loadEventEnd),
          firstPaintTime: s(performance.getEntriesByName('first-paint')[0]?.startTime),
          firstPaintAfterLoadTime: 0,
          navigationType: 'Other',
          wasFetchedViaSpdy: proto === 'h2' || proto === 'h3',
          wasNpnNegotiated: proto === 'h2' || proto === 'h3',
          npnNegotiatedProtocol: proto === 'http/1.1' ? 'unknown' : proto,
          wasAlternateProtocolAvailable: false,
          connectionInfo: proto,
        };
      };
    }
    window.chrome = c;
  },
});
