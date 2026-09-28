'use strict';

/* ═══════════════════════════════════════════════════════════════════════════
   PRISM — preload de las páginas: window.print()
   Un botón "Imprimir" de un sitio (un comprobante, una receta, un boleto)
   llama a window.print(), y Electron abre el diálogo de Windows, que no
   tiene vista previa. Acá print() pide la pantalla de impresión de Prism
   (src/print.cjs, renderer/js/print.js), la misma de Ctrl+P.

   Solo en el documento de arriba: el print() de un iframe imprime solo ese
   iframe, y eso lo sigue haciendo Chromium. A diferencia del original,
   este no bloquea la página hasta que se cierra el diálogo.
   ═══════════════════════════════════════════════════════════════════════════ */

const { contextBridge, ipcRenderer } = require('electron');

if (window.top === window) {
  contextBridge.executeInMainWorld({
    func: (ask) => {
      const print = function print() { ask(); };
      Object.defineProperty(window, 'print', { value: print, writable: true, configurable: true, enumerable: true });
    },
    args: [() => ipcRenderer.send('page:print-request')],
  });
}
