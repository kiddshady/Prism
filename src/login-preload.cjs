'use strict';

/* ═══════════════════════════════════════════════════════════════════════════
   PRISM — preload de las páginas: entrar con Google
   En las páginas de login de Google, Prism se presenta como Firefox (el
   porqué está en src/web.cjs, "Entrar con Google"). La cabecera la cambia el
   proceso principal; esto hace que `navigator` diga lo mismo, en el mundo de
   la página y ANTES de que corra su primer script:

   · userAgent, appVersion, platform, vendor… con los valores de Firefox.
   · Sin navigator.userAgentData ni window.chrome: Firefox no los tiene, y
     que estén contradice todo lo demás.

   En cualquier otra página no hace nada: ni siquiera le pregunta al proceso
   principal. El user agent lo pide por IPC (el principal vuelve a chequear
   el host) para que la versión viva en un solo lugar.
   ═══════════════════════════════════════════════════════════════════════════ */

const { contextBridge, ipcRenderer } = require('electron');

// La misma lista que en src/web.cjs.
const HOSTS = ['accounts.google.com', ...String(process.env.PRISM_LOGIN_HOSTS || '').split(',').filter(Boolean)];

if (HOSTS.includes(location.hostname)) {
  const ua = ipcRenderer.sendSync('login:disguise');
  if (ua) {
    contextBridge.executeInMainWorld({
      func: (firefoxUA) => {
        const nav = Navigator.prototype;
        const values = {
          userAgent: firefoxUA,
          appVersion: '5.0 (Windows)',
          platform: 'Win32',
          vendor: '',
          vendorSub: '',
          productSub: '20100101',
          oscpu: 'Windows NT 10.0; Win64; x64',
          buildID: '20181001000000',
        };
        for (const [k, v] of Object.entries(values)) {
          try { Object.defineProperty(nav, k, { get: () => v, configurable: true, enumerable: true }); } catch { /* sigue */ }
        }
        try { delete nav.userAgentData; } catch { /* sigue */ }
        try { delete window.NavigatorUAData; } catch { /* sigue */ }
        try { delete window.chrome; } catch { /* sigue */ }
        if ('chrome' in window) {
          try { Object.defineProperty(window, 'chrome', { value: undefined, configurable: true }); } catch { /* sigue */ }
        }
      },
      args: [ua],
    });
  }
}
