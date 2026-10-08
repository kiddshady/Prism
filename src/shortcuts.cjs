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

/* Dejar apretado un atajo lo repite (Windows, ~25 veces por segundo). Solo
   lo que avanza de a pasos tiene sentido repetido; el resto son
   interruptores: Ctrl+Mayús+P apretado un rato abría y cerraba la ventanita
   sin parar. Y cerrar o abrir pestañas en ráfaga no lo quiere nadie. */
const REPEATS = new Set(['tab:next', 'tab:prev', 'nav:back', 'nav:forward', 'zoom:in', 'zoom:out', 'find:next', 'find:prev']);

/** El comando del input, o null si no es atajo. Una repetición de un
    interruptor devuelve 'repeat': la tecla se come (no le llega a la página)
    pero no hace nada. */
function match(i) {
  const cmd = commandOf(i);
  return cmd && i.isAutoRepeat && !REPEATS.has(cmd) ? 'repeat' : cmd;
}

function commandOf(i) {
  if (!i || i.type !== 'keyDown') return null;
  const k = String(i.key || '').toLowerCase();
  const code = String(i.code || '');
  const ctrl = !!(i.control || i.meta);
  const { shift, alt } = i;

  if (ctrl && !alt) {
    if (k === 't') return shift ? 'tab:reopen' : 'tab:new';
    if (k === 'n' && shift) return 'win:incognito';
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
    if (k === 'b' && shift) return 'bookmarks:bar';
    if (k === 'h') return 'open:historial';
    if (k === 'j') return 'open:descargas';
    if (k === 'f') return 'find:open';
    if (k === 'g') return shift ? 'find:prev' : 'find:next';
    if (k === '=' || k === '+' || code === 'NumpadAdd') return 'zoom:in';
    if (k === '-' || code === 'NumpadSubtract') return 'zoom:out';
    if ((k === '0' && code.startsWith('Digit')) || code === 'Numpad0') return 'zoom:reset';
    if (k === 'p') return shift ? 'page:pip' : 'page:print';
    if (k === 's' && shift) return 'page:capture-full';
    if (k === 'u') return 'page:source';
    if (k === 'i' && shift) return 'page:devtools';
    if (k === 'delete' && shift) return 'open:ajustes';
    if (k === 'q' && shift) return 'app:quit';
    /* La ñ por la letra, y por la tecla por si Windows la manda sin traducir
       con el Ctrl apretado (en español la ñ ocupa la tecla del ; inglés). */
    if ((k === 'ñ' || code === 'Semicolon') && !shift) return 'term:toggle';
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

/* Con la terminal enfocada, Ctrl+letra es de la línea de comandos: Ctrl+R
   busca en el historial, Ctrl+L limpia, Ctrl+W y Ctrl+U borran, Ctrl+D sale.
   Esos atajos del navegador se le dejan pasar a la shell. Ctrl+W además
   cerraba la pestaña, y con ella la shell, a mitad de una palabra. Alt con
   las flechas mueve de a palabra (y "atrás" se iba de la terminal). Lo demás
   (pestañas, Ctrl+T, Ctrl+Ñ, Ctrl+Mayús, las F) sigue siendo de Prism. El
   zoom también pasa: la terminal agranda su letra. */
const SHELL_KEEPS = new Set([
  'tab:close', 'omni:focus', 'page:reload', 'page:hard-reload', 'bookmark:toggle',
  'open:historial', 'open:descargas', 'find:open', 'find:next', 'find:prev',
  'page:print', 'page:source', 'zoom:in', 'zoom:out', 'zoom:reset',
  'nav:back', 'nav:forward', 'nav:home',
]);

/** Si el input le toca a la shell cuando la terminal tiene el foco. Mira el
    comando y no lo que devuelve match: dejar apretado Ctrl+W es una
    repetición, y también es de la shell. */
function forShell(i) {
  const cmd = commandOf(i);
  if (!cmd || !SHELL_KEEPS.has(cmd)) return false;
  const ctrl = !!(i.control || i.meta);
  // Solo Ctrl+tecla y Alt+tecla: F3, F5 y F6 siguen siendo del navegador.
  return (ctrl || !!i.alt) && !i.shift;
}

/** La tabla que muestra Ajustes: se deriva del mismo lugar para no mentir. */
const TABLE = [
  ['Nueva pestaña', 'Ctrl+T'],
  ['Nueva ventana de incógnito', 'Ctrl+Mayús+N'],
  ['Cerrar pestaña', 'Ctrl+W'],
  ['Reabrir la última cerrada', 'Ctrl+Mayús+T'],
  ['Pestaña siguiente / anterior', 'Ctrl+Tab · Ctrl+Mayús+Tab'],
  ['Ir a la pestaña 1–8 / la última', 'Ctrl+1…8 · Ctrl+9'],
  ['Ir a la barra de direcciones', 'Ctrl+L · Alt+D · F6'],
  ['Atrás / adelante', 'Alt+Izq · Alt+Der'],
  ['Ir a la nueva pestaña', 'Alt+Inicio'],
  ['Recargar / sin caché', 'F5 · Ctrl+Mayús+R'],
  ['Buscar en la página', 'Ctrl+F · F3'],
  ['Agregar a favoritos', 'Ctrl+D'],
  ['Mostrar u ocultar la barra de favoritos', 'Ctrl+Mayús+B'],
  ['Historial', 'Ctrl+H'],
  ['Descargas', 'Ctrl+J'],
  ['Ajustes (para borrar datos de navegación)', 'Ctrl+Mayús+Supr'],
  ['Zoom', 'Ctrl++ · Ctrl+- · Ctrl+0'],
  ['Imprimir', 'Ctrl+P'],
  ['Capturar la página entera', 'Ctrl+Mayús+S'],
  ['Ver el video en una ventanita (o traerlo de vuelta)', 'Ctrl+Mayús+P'],
  ['Código fuente', 'Ctrl+U'],
  ['Herramientas de desarrollo', 'F12'],
  ['Terminal (o volver a donde estabas)', 'Ctrl+Ñ'],
  ['Pantalla completa', 'F11'],
  ['Salir de Prism (cerrar lo manda a la bandeja)', 'Ctrl+Mayús+Q'],
  ['Mostrar u ocultar Prism, desde cualquier lado de Windows', 'Ctrl+Alt+P'],
];

/** El único atajo global: lo escucha Windows entero, no solo la ventana
    (ver main.cjs). En formato de Electron, no el de la tabla. */
const GLOBAL_TOGGLE = 'CommandOrControl+Alt+P';

module.exports = { match, forShell, TABLE, GLOBAL_TOGGLE };
