/* ═══════════════════════════════════════════════════════════════════════════
   Los atajos: el mismo input de Electron tiene que dar el mismo comando venga
   de la ventana o de la página. Y lo que NO es atajo no se puede comer: si
   Ctrl+C devolviera un comando, copiar en una página dejaría de andar.
   ═══════════════════════════════════════════════════════════════════════════ */

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { match, forShell, TABLE } = require('../src/shortcuts.cjs');

let pass = 0; let fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log(`  ok   ${n}`); } else { fail++; console.log(`  FALLA ${n} ${x}`); } };

const key = (k, mods = {}, code) => ({ type: 'keyDown', key: k, code: code || (/^\d$/.test(k) ? `Digit${k}` : `Key${k.toUpperCase()}`), ...mods });
const is = (name, input, expected) => { const got = match(input); ok(`${name} → ${expected}`, got === expected, String(got)); };

console.log('\n1. Pestañas');
is('Ctrl+T', key('t', { control: true }), 'tab:new');
is('Ctrl+Mayús+T', key('T', { control: true, shift: true }), 'tab:reopen');
is('Ctrl+W', key('w', { control: true }), 'tab:close');
is('Ctrl+Tab', key('Tab', { control: true }, 'Tab'), 'tab:next');
is('Ctrl+Mayús+Tab', key('Tab', { control: true, shift: true }, 'Tab'), 'tab:prev');
is('Ctrl+3', key('3', { control: true }), 'tab:goto:3');
is('Ctrl+9', key('9', { control: true }), 'tab:last');
is('Ctrl+0 del teclado numérico es zoom, no pestaña', key('0', { control: true }, 'Numpad0'), 'zoom:reset');

console.log('\n2. Navegación y página');
is('Alt+Izquierda', key('ArrowLeft', { alt: true }, 'ArrowLeft'), 'nav:back');
is('F5', key('F5', {}, 'F5'), 'page:reload');
is('Mayús+F5', key('F5', { shift: true }, 'F5'), 'page:hard-reload');
is('Ctrl+L', key('l', { control: true }), 'omni:focus');
is('F6', key('F6', {}, 'F6'), 'omni:focus');
is('Ctrl+F', key('f', { control: true }), 'find:open');
is('F3', key('F3', {}, 'F3'), 'find:next');
is('Ctrl++ (teclado en castellano)', key('+', { control: true }, 'BracketRight'), 'zoom:in');
is('Ctrl+-', key('-', { control: true }, 'Slash'), 'zoom:out');
is('F12', key('F12', {}, 'F12'), 'page:devtools');
is('Ctrl+Mayús+Q sale de verdad', key('Q', { control: true, shift: true }), 'app:quit');
is('Ctrl+Mayús+S captura la página entera', key('S', { control: true, shift: true }), 'page:capture-full');
is('Ctrl+Mayús+B muestra u oculta la barra de favoritos', key('B', { control: true, shift: true }), 'bookmarks:bar');
is('Ctrl+Mayús+N abre la ventana de incógnito', key('N', { control: true, shift: true }), 'win:incognito');
is('Ctrl+Mayús+P saca el video a la ventanita', key('P', { control: true, shift: true }), 'page:pip');
is('Ctrl+P sigue imprimiendo', key('p', { control: true }), 'page:print');
is('Ctrl+N solo no hace nada', key('n', { control: true }), null);
is('Ctrl+B solo no hace nada (negrita en un editor)', key('b', { control: true }), null);
is('Ctrl+S solo no hace nada (es de la página)', key('s', { control: true }), null);
is('Ctrl+Q solo no hace nada (no se sale por accidente)', key('q', { control: true }), null);

console.log('\n3. Lo que NO es atajo pasa de largo');
is('Ctrl+C', key('c', { control: true }), null);
is('Ctrl+V', key('v', { control: true }), null);
is('Ctrl+A', key('a', { control: true }), null);
is('Ctrl+Z', key('z', { control: true }), null);
is('una letra sola', key('t'), null);
is('Escape', key('Escape', {}, 'Escape'), null);
is('keyUp nunca', { ...key('t', { control: true }), type: 'keyUp' }, null);
is('AltGr+2 (arroba) no es "ir a la pestaña 2"', key('@', { control: true, alt: true }, 'Digit2'), null);

console.log('\n3b. Dejar apretado');
const rep = (k, mods, code) => ({ ...key(k, mods, code), isAutoRepeat: true });
is('Ctrl+Mayús+P repetido no abre y cierra la ventanita', rep('P', { control: true, shift: true }), 'repeat');
is('Ctrl+W repetido no cierra pestañas en ráfaga', rep('w', { control: true }), 'repeat');
is('Ctrl+T repetido no abre pestañas en ráfaga', rep('t', { control: true }), 'repeat');
is('Ctrl+Tab repetido sí sigue pasando de pestaña', rep('Tab', { control: true }, 'Tab'), 'tab:next');
is('Ctrl++ repetido sí sigue acercando', rep('+', { control: true }, 'BracketRight'), 'zoom:in');
is('F3 repetido sí sigue buscando', rep('F3', {}, 'F3'), 'find:next');
is('Ctrl+C repetido sigue siendo de la página', rep('c', { control: true }), null);

console.log('\n3c. La terminal');
is('Ctrl+Ñ abre la terminal', key('ñ', { control: true }, 'Semicolon'), 'term:toggle');
is('Ctrl+Ñ aunque Windows mande la tecla sin traducir', key(';', { control: true }, 'Semicolon'), 'term:toggle');
is('Ctrl+Mayús+Ñ no', key('Ñ', { control: true, shift: true }, 'Semicolon'), null);
is('Ctrl+Ñ repetido no abre y cierra', rep('ñ', { control: true }, 'Semicolon'), 'repeat');
const shell = (name, input, expected) => ok(`${name} → ${expected ? 'shell' : 'Prism'}`, forShell(input) === expected);
shell('Ctrl+R (buscar en el historial de la shell)', key('r', { control: true }), true);
shell('Ctrl+L (limpiar)', key('l', { control: true }), true);
shell('Ctrl+W (borrar palabra; no cierra la pestaña con la shell)', key('w', { control: true }), true);
shell('Ctrl+W repetido también', rep('w', { control: true }), true);
ok('Ctrl+U, Ctrl+D, Ctrl+F, Ctrl+H, Ctrl+J → shell', ['u', 'd', 'f', 'h', 'j'].every((k) => forShell(key(k, { control: true }))));
shell('Alt+Izquierda (palabra atrás; no se va de la terminal)', key('ArrowLeft', { alt: true }, 'ArrowLeft'), true);
shell('Alt+D (borrar palabra)', key('d', { alt: true }), true);
shell('Ctrl++ (agranda la letra de la terminal)', key('+', { control: true }, 'BracketRight'), true);
shell('Ctrl+T sigue abriendo pestaña', key('t', { control: true }), false);
shell('Ctrl+Tab sigue pasando de pestaña', key('Tab', { control: true }, 'Tab'), false);
shell('Ctrl+Ñ sigue siendo de Prism', key('ñ', { control: true }, 'Semicolon'), false);
shell('Ctrl+Mayús+R sigue siendo de Prism', key('R', { control: true, shift: true }), false);
shell('F5 sigue siendo de Prism', key('F5', {}, 'F5'), false);
shell('F6 sigue siendo de Prism (para salir a la barra)', key('F6', {}, 'F6'), false);

console.log('\n4. La tabla de Ajustes');
ok('tiene filas', TABLE.length > 10);
ok('sin glifos raros (solo texto de teclado)', TABLE.every(([, k]) => !/[←-⇿−⌃⌘⌫]/.test(k)));

console.log(`\n═══ ${pass} ok · ${fail} fallas ═══`);
process.exit(fail ? 1 : 0);
