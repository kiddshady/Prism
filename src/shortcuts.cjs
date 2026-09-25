'use strict';

/* ═══════════════════════════════════════════════════════════════════════════
   PRISM — atajos
   Un navegador tiene dos lugares donde el teclado puede estar: la ventana
   (pestañas, omnibox) y la página. Cuando el foco está en la página, las
   teclas van a SU proceso y la ventana ni se entera — por eso los atajos no
   pueden vivir en el DOM de la ventana: se interceptan acá, con
   `before-input-event`, en los dos webContents, y se resuelven en un solo lugar.

   Pura: recibe el input de Electron y devuelve el nombre del comando (o null).
   ═══════════════════════════════════════════════════════════════════════════ */

function match(i) {
  if (!i || i.type !== 'keyDown') return null;
  const k = String(i.key || '').toLowerCase();
  const code = String(i.code || '');
  const ctrl = !!(i.control || i.meta);
  const { shift, alt } = i;

  if (ctrl && !alt) {
    if (k === 't') return shift ? 'tab:reopen' : 'tab:new';
    if (k === 'w' || k === 'f4') return 'tab:close';
    if (k === 'tab') return shift ? 'tab:prev' : 'tab:next';
    if (k === 'pagedown') return 'tab:next';
    if (k === 'pageup') return 'tab:prev';
    if (/^[1-8]$/.test(k) && code.startsWith('Digit')) return `tab:goto:${k}`;
    if (k === '9' && code.startsWith('Digit')) return 'tab:last';
    if (k === 'l') return 'omni:focus';
    if (k === 'r') return shift ? 'page:hard-reload' : 'page:reload';
    if (k === 'f5') return 'page:hard-reload';
    if (k === 'd') return 'bookmark:toggle';
    if (k === 'h') return 'open:historial';
    if (k === 'j') return 'open:descargas';
    if (k === 'f') return 'find:open';
    if (k === 'g') return shift ? 'find:prev' : 'find:next';
    if (k === '=' || k === '+' || code === 'NumpadAdd') return 'zoom:in';
    if (k === '-' || code === 'NumpadSubtract') return 'zoom:out';
    if ((k === '0' && code.startsWith('Digit')) || code === 'Numpad0') return 'zoom:reset';
    if (k === 'p') return 'page:print';
    if (k === 'u') return 'page:source';
    if (k === 'i' && shift) return 'page:devtools';
    if (k === 'delete' && shift) return 'open:ajustes';
    if (k === 'q' && shift) return 'app:quit';
    return null;
  }

  if (alt && !ctrl) {
    if (k === 'arrowleft') return 'nav:back';
    if (k === 'arrowright') return 'nav:forward';
    if (k === 'd') return 'omni:focus';
    if (k === 'home') return 'nav:home';
    return null;
  }

  if (!ctrl && !alt) {
    if (k === 'f5') return shift ? 'page:hard-reload' : 'page:reload';
    if (k === 'f6') return 'omni:focus';
    if (k === 'f11') return 'win:fullscreen';
    if (k === 'f12') return 'page:devtools';
    if (k === 'f3') return shift ? 'find:prev' : 'find:next';
  }
  return null;
}

/** La tabla que muestra Ajustes: se deriva del mismo lugar para no mentir. */
const TABLE = [
  ['Nueva pestaña', 'Ctrl+T'],
  ['Cerrar pestaña', 'Ctrl+W'],
  ['Reabrir la última cerrada', 'Ctrl+Mayús+T'],
  ['Pestaña siguiente / anterior', 'Ctrl+Tab · Ctrl+Mayús+Tab'],
  ['Ir a la pestaña 1–8 / la última', 'Ctrl+1…8 · Ctrl+9'],
  ['Ir a la barra de direcciones', 'Ctrl+L · Alt+D · F6'],
  ['Atrás / adelante', 'Alt+Izq · Alt+Der'],
  ['Recargar / sin caché', 'F5 · Ctrl+Mayús+R'],
  ['Buscar en la página', 'Ctrl+F · F3'],
  ['Agregar a favoritos', 'Ctrl+D'],
  ['Historial', 'Ctrl+H'],
  ['Descargas', 'Ctrl+J'],
  ['Zoom', 'Ctrl++ · Ctrl+- · Ctrl+0'],
  ['Imprimir', 'Ctrl+P'],
  ['Código fuente', 'Ctrl+U'],
  ['Herramientas de desarrollo', 'F12'],
  ['Pantalla completa', 'F11'],
  ['Salir de Prism (cerrar lo manda a la bandeja)', 'Ctrl+Mayús+Q'],
];

module.exports = { match, TABLE };
