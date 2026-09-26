'use strict';

/* ═══════════════════════════════════════════════════════════════════════════
   PRISM — preload de las páginas: el estado de los permisos
   Electron solo sabe contestar sí o no al "¿tengo permiso?". Lo que la
   persona todavía no decidió le llega a la página como "denied", y eso
   rompe justo lo que más importa: una videollamada que lee la cámara como
   bloqueada muestra "tu navegador bloqueó la cámara" y ni la pide, y un
   sitio que ve las notificaciones bloqueadas no las ofrece.

   Acá se corrige lo que LEE la página, con el estado de verdad que da el
   proceso principal (src/web.cjs) para este documento:
   · navigator.permissions.query(): "prompt" en vez de "denied" si nadie
     decidió todavía.
   · Notification.permission: "default" en vez de "denied", por lo mismo.

   Solo se toca un "denied" que en realidad es "prompt": lo concedido y lo
   bloqueado a propósito pasan tal cual. Pedir el permiso sigue yendo por la
   pregunta de Prism de siempre.
   ═══════════════════════════════════════════════════════════════════════════ */

const { contextBridge, ipcRenderer } = require('electron');

if (window.top === window) {
  // Una sola vez al cargar: Notification.permission se lee de forma sincrónica.
  const initial = ipcRenderer.sendSync('perm:states');
  if (initial) {
    contextBridge.executeInMainWorld({
      func: (states, ask) => {
        const NAMES = new Set(['camera', 'microphone', 'geolocation', 'notifications']);
        const query = Permissions.prototype.query;
        Permissions.prototype.query = async function (desc) {
          const status = await query.call(this, desc);
          const name = desc && desc.name;
          if (NAMES.has(name) && status.state === 'denied' && (await ask(name)) === 'prompt') {
            Object.defineProperty(status, 'state', { get: () => 'prompt', configurable: true, enumerable: true });
          }
          return status;
        };

        const perm = Object.getOwnPropertyDescriptor(Notification, 'permission');
        if (perm && perm.get) {
          Object.defineProperty(Notification, 'permission', {
            configurable: true,
            enumerable: perm.enumerable,
            get() {
              const v = perm.get.call(this);
              return v === 'denied' && states.notifications === 'prompt' ? 'default' : v;
            },
          });
        }
      },
      args: [initial, (name) => ipcRenderer.invoke('perm:state', name)],
    });
  }
}
