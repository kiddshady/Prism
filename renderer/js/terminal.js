/* ═══════════════════════════════════════════════════════════════════════════
   PRISM — la terminal
   La pestaña prism://terminal: una PowerShell 7 de verdad (la shell vive en
   el proceso principal, src/term.cjs) dibujada con xterm.js directo sobre la
   hoja de la página. No va en un pozo adentro de la hoja: la hoja ES la
   terminal, con una línea de luz arriba (la pestaña de la shell) y otra abajo
   (cpu, memoria, branch, carpeta y hora).

   Se divide en dos (Alt+Mayús+D, o el botón de arriba): dos mitades lado a
   lado, cada una con su shell y su xterm. La de abajo muestra lo de la mitad
   que tiene el teclado.

   Cada mitad tiene UNA xterm para toda la vida de la ventana. La página las
   monta y las desmonta (cambiar de pestaña, pasarla a una mitad de la vista
   dividida), pero no las rehace: lo escrito, el scroll y la selección siguen
   ahí.
   ═══════════════════════════════════════════════════════════════════════════ */

import { api, S, on, activeTab } from './state.js';
import { Icons } from './icons.js';
import { roll, swapText, exit } from './motion.js';
import { menu, pointAnchor } from './layers.js';
import { say } from './status.js';

const VENDOR = '../vendor/xterm';
const FONT = "'Roboto Mono', 'Cascadia Mono', Consolas, monospace";
const SIZE = { def: 13, min: 9, max: 24 };
/** Las mitades posibles: el proceso principal tiene una shell por cada una. */
const IDS = ['a', 'b'];

/* La paleta: los colores de siempre de una terminal (git en rojo y verde, las
   carpetas en azul, los avisos en amarillo, el resaltado de PSReadLine), con
   color de verdad. Salen de oklch: los normales con croma .12–.17 a luz
   .68–.84 (el amarillo y el cian más claros, que si no se ven sucios), los
   brillantes un escalón más de luz y un poco menos de croma. Apagados (croma
   .07) se veía todo igual de gris. El prompt sigue en grises: ese lo pinta
   src/term-init.ps1 con truecolor, no con esta paleta. */
const THEME = {
  background: '#00000000',
  foreground: '#e8e8ea',
  cursor: '#f0f3f7',
  cursorAccent: '#161618',
  selectionBackground: 'rgba(240, 243, 247, 0.22)',
  selectionInactiveBackground: 'rgba(240, 243, 247, 0.12)',
  scrollbarSliderBackground: 'rgba(255, 255, 255, 0.10)',
  scrollbarSliderHoverBackground: 'rgba(255, 255, 255, 0.20)',
  scrollbarSliderActiveBackground: 'rgba(255, 255, 255, 0.28)',
  black: '#3a3a3e', brightBlack: '#84848c',   // el gris oscuro se lee: PSReadLine pinta ahí los parámetros
  red: '#ef6567', brightRed: '#fe9b98',
  green: '#66d37a', brightGreen: '#93e9a0',
  yellow: '#f0c551', brightYellow: '#fcda86',
  blue: '#67a6fb', brightBlue: '#9ec7fe',
  magenta: '#ce81e5', brightMagenta: '#e5abf7',
  cyan: '#40d0df', brightCyan: '#7de8f3',
  white: '#cdcdd1', brightWhite: '#f4f4f6',   // white es el texto que tipeás (PSReadLine): que no quede apagado
};

/* ── Estado ───────────────────────────────────────────────────────────────── */

let XT = null;             // los módulos de xterm.js, cargados una vez
let booting = null;        // esa carga
let restored = false;      // ya se le preguntó al proceso principal qué mitades viven
/** Las mitades, de izquierda a derecha. Cada una: { id, xterm, fit, screen,
    session, dead, opened, cwd, branch, runSince, runTimer, el }. */
const panes = [];
let current = null;        // la mitad que tiene (o tuvo último) el teclado
let page = null;           // la .pr-view montada ahora, o null
let mounted = null;        // lo de este montaje: { ro, gone }

/* El «run» aparece recién pasado el primer segundo: un cd o un ls no tienen
   por qué hacer parpadear un «run 0s» en la barra. */
const RUN_SHOW = 1000;

const html = () => `
  <div class="pr-term">
    <div class="pr-term__panes"></div>
    <footer class="pr-term__foot">
      <span class="pr-term__stat"><b>cpu</b><span class="pr-term__gauge op-num" data-k="cpu">0%</span></span>
      <span class="pr-term__stat"><b>mem</b><span class="pr-term__gauge op-num" data-k="mem">0%</span></span>
      <span class="pr-term__stat pr-term__branch">${Icons.svg('branch')}<span class="pr-term__val op-swap--truncate"></span></span>
      <span class="pr-term__stat pr-term__cwd">${Icons.svg('folder')}<span class="pr-term__val op-swap--truncate"></span></span>
      <span class="pr-term__stat pr-term__run"><b>run</b><span class="pr-term__val op-num"></span></span>
      <span class="pr-term__end"><span class="pr-term__live"></span><span class="pr-term__clock op-num"></span></span>
    </footer>
  </div>`;

/* Una mitad: su pestaña arriba, apoyada en la línea, y la pantalla. A la
   derecha de la pestaña, dividir (con una sola) o cerrar esta mitad (con
   dos): el CSS pliega el que no va. */
const paneHtml = (n) => `
  <section class="pr-term__pane">
    <header class="pr-term__head">
      <div class="pr-term__tab">
        <svg class="pr-term__tri" viewBox="0 0 8 10" aria-hidden="true"><path d="M1.6 1.4 6.6 5l-5 3.6z"/></svg>
        <span class="pr-term__num op-num">${num(n)}</span>
        <span class="pr-term__name">PowerShell 7</span>
        <span class="pr-term__where"><span class="pr-term__dash"></span><span class="pr-term__short op-swap--truncate"></span></span>
      </div>
      <button class="pr-term__act" data-act="split" tabindex="-1" data-tip="Dividir en dos · Alt+Mayús+D" aria-label="Dividir en dos">${Icons.svg('splitView')}</button>
      <button class="pr-term__act" data-act="close" tabindex="-1" data-tip="Cerrar esta mitad" aria-label="Cerrar esta mitad">${Icons.svg('close')}</button>
    </header>
    <div class="pr-term__body"></div>
  </section>`;

const num = (n) => String(n).padStart(2, '0');

/* ── Rutas ────────────────────────────────────────────────────────────────── */

/** La carpeta de la persona como ~, como en el prompt. */
function tilde(p) {
  const home = S.info?.home;
  if (home && p.toLowerCase().startsWith(home.toLowerCase())) return `~${p.slice(home.length)}`;
  return p;
}

/** La cola de la ruta para la pestaña de arriba: …\tools\Prism. */
function tail(p) {
  const parts = tilde(p).split('\\').filter(Boolean);
  return parts.length > 2 ? `…\\${parts.slice(-2).join('\\')}` : tilde(p);
}

/* ── Cargar xterm ─────────────────────────────────────────────────────────── */

async function boot() {
  const [{ Terminal }, { FitAddon }, { Unicode11Addon }, { WebLinksAddon }] = await Promise.all([
    import(`${VENDOR}/xterm.mjs`),
    import(`${VENDOR}/addon-fit.mjs`),
    import(`${VENDOR}/addon-unicode11.mjs`),
    import(`${VENDOR}/addon-web-links.mjs`),
  ]);
  /* La letra tiene que estar cargada antes de abrir: xterm mide la celda una
     vez, y con la de reserva medida quedaban columnas corridas. Los bloques
     (fonts.css) también: xterm se guarda el ancho de cada carácter la primera
     vez que lo ve, y medido con el respaldo quedaba corrido para siempre. */
  await Promise.all([
    document.fonts.load(`13px 'Roboto Mono'`),
    document.fonts.load(`500 13px 'Roboto Mono'`),
    document.fonts.load(`13px 'Roboto Mono'`, '█'),
    document.fonts.load(`500 13px 'Roboto Mono'`, '█'),
    document.fonts.load(`13px 'Roboto Mono'`, '😀'),
    document.fonts.load(`500 13px 'Roboto Mono'`, '😀'),
  ]).catch(() => {});
  XT = { Terminal, FitAddon, Unicode11Addon, WebLinksAddon };

  // Lo que escriben las shells, cada cosa a su mitad.
  api.term.onData((m) => {
    const p = byId(m.pane);
    if (!p || m.session < p.session) return;
    p.session = m.session;
    p.xterm.write(m.data);
  });
  api.term.onExit((m) => {
    const p = byId(m.pane);
    if (!p || m.session !== p.session) return;
    setRun(p, false);
    // Con la pestaña dividida, la mitad cuya shell terminó (un `exit`) se cierra.
    if (panes.length > 1) { closePane(p); return; }
    p.dead = true;
    p.el?.classList.add('is-dead');
    p.xterm.write(`\r\n\x1b[38;2;150;150;156mLa sesión terminó${m.code ? ` (código ${m.code})` : ''}. Enter abre otra.\x1b[0m\r\n`);
  });
}

const byId = (id) => panes.find((p) => p.id === id) || null;

/** Una mitad nueva, con su xterm armada (todavía sin shell). */
function makePane(id) {
  const p = {
    id, xterm: null, fit: null, screen: null,
    session: 0, dead: false, opened: false,
    cwd: '', branch: null, runSince: null, runTimer: 0, el: null,
  };
  const xterm = new XT.Terminal({
    fontFamily: FONT,
    fontSize: fontSize(),
    fontWeight: 400,
    fontWeightBold: 500,
    // Alto de celda justo: las esquinas del prompt (┌─ y └>) se tocan.
    lineHeight: 1,
    letterSpacing: 0,
    cursorStyle: 'block',
    cursorBlink: true,
    cursorInactiveStyle: 'outline',   // terminal.css lo dibuja como el bloque, apagado
    scrollback: 10000,
    allowTransparency: true,
    allowProposedApi: true,
    drawBoldTextInBrightColors: false,
    minimumContrastRatio: 1,
    smoothScrollDuration: 120,
    theme: THEME,
  });
  p.xterm = xterm;
  p.fit = new XT.FitAddon();
  xterm.loadAddon(p.fit);
  const uni = new XT.Unicode11Addon();
  xterm.loadAddon(uni);
  xterm.unicode.activeVersion = '11';
  // Un link en la salida (un npm start que dice http://localhost:5173) se abre en una pestaña.
  xterm.loadAddon(new XT.WebLinksAddon((e, uri) => {
    e.preventDefault();
    api.tabs.create(uri, { active: !e.ctrlKey });
  }));

  p.screen = document.createElement('div');
  p.screen.className = 'pr-term__screen';
  xterm.open(p.screen);

  /* Un emoji tipeado (con el teclado o con Win+.) llega en dos tandas: Windows
     manda las dos mitades del par sustituto como dos teclas. Mandada sola, la
     mitad no se puede pasar a UTF-8 y la shell recibía dos �: la primera
     espera a la segunda. */
  let half = '';
  xterm.onData((chunk) => {
    let d = half + chunk;
    half = '';
    const last = d.charCodeAt(d.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) {
      half = d.slice(-1);
      d = d.slice(0, -1);
      if (!d) return null;
    }
    if (!p.dead) return api.term.write(p.id, d);
    if (d === '\r') restart(p);          // con la shell terminada, Enter abre otra
    return null;
  });
  xterm.onResize(({ cols, rows }) => { if (!p.dead) api.term.resize(p.id, cols, rows); });
  xterm.onSelectionChange(() => p.screen.classList.toggle('has-selection', xterm.hasSelection()));

  // OSC 7: el prompt avisa la carpeta (src/term-init.ps1).
  xterm.parser.registerOscHandler(7, (data) => {
    const m = /^file:\/\/[^/]*\/?(.*)$/.exec(data);
    if (m) {
      let path = m[1];
      try { path = decodeURIComponent(path); } catch { /* tal cual */ }
      setCwd(p, path.replace(/\//g, '\\'));
    }
    return true;
  });

  // OSC 133: C arranca un comando, D vuelve el prompt (src/term-init.ps1).
  xterm.parser.registerOscHandler(133, (data) => {
    if (data[0] === 'C') setRun(p, true);
    else if (data[0] === 'D') setRun(p, false);
    return true;
  });

  xterm.attachCustomKeyEventHandler((e) => onKey(p, e));

  const ta = xterm.textarea;
  ta.addEventListener('focus', () => {
    api.term.focused(true);
    p.el?.classList.add('is-focus');
    if (current !== p) { current = p; paintFoot(); }
  });
  ta.addEventListener('blur', () => { api.term.focused(false); p.el?.classList.remove('is-focus'); });

  // Click derecho: el menú de la terminal, no el de los campos de texto.
  p.screen.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    contextMenu(p, e.clientX, e.clientY);
  });
  return p;
}

/* ── Teclado ──────────────────────────────────────────────────────────────── */

function onKey(p, e) {
  if (e.type !== 'keydown') return true;
  const k = e.key.toLowerCase();
  const ctrl = e.ctrlKey && !e.altKey;
  // Copiar: con algo marcado, Ctrl+C copia (sin nada, es el Ctrl+C de siempre: cortar lo que corre).
  if (ctrl && k === 'c' && (e.shiftKey || p.xterm.hasSelection())) {
    e.preventDefault();
    copy(p);
    return false;
  }
  /* Pegar: lo hace el evento paste de Chromium, que xterm convierte en un
     pegado de verdad. Sin esto, además le llegaba un ^V a PSReadLine, que
     pega por su cuenta, y salía todo dos veces. */
  if (ctrl && k === 'v') return false;
  if (ctrl && !e.shiftKey && (k === '=' || k === '+' || e.code === 'NumpadAdd')) { e.preventDefault(); zoom(1); return false; }
  if (ctrl && !e.shiftKey && (k === '-' || e.code === 'NumpadSubtract')) { e.preventDefault(); zoom(-1); return false; }
  if (ctrl && !e.shiftKey && (e.code === 'Digit0' || e.code === 'Numpad0')) { e.preventDefault(); zoom(0); return false; }
  return true;
}

async function copy(p) {
  const text = p.xterm.getSelection();
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    p.xterm.clearSelection();
  } catch (err) {
    say(`No se pudo copiar: ${err.message}`, { icon: 'alert', tone: 'error' });
  }
}

async function paste(p) {
  try {
    const text = await api.clip.read();
    if (text) p.xterm.paste(text);
  } catch (err) {
    say(`No se pudo pegar: ${err.message}`, { icon: 'alert', tone: 'error' });
  }
  p.xterm.focus();
}

function contextMenu(p, x, y) {
  const has = p.xterm.hasSelection();
  menu(pointAnchor(x, y), [
    { label: 'Copiar', icon: 'copy', key: 'Ctrl+C', disabled: !has, onSelect: () => copy(p) },
    { label: 'Pegar', icon: 'clipboard', key: 'Ctrl+V', onSelect: () => paste(p) },
    { label: 'Seleccionar todo', onSelect: () => p.xterm.selectAll() },
    { sep: true },
    panes.length > 1
      ? { label: 'Cerrar esta mitad', icon: 'close', onSelect: () => closePane(p) }
      : { label: 'Dividir en dos', icon: 'splitView', key: 'Alt+Mayús+D', onSelect: () => split() },
    { label: 'Limpiar', key: 'Ctrl+L', onSelect: () => { p.xterm.clear(); p.xterm.focus(); } },
    { label: 'Reiniciar la shell', icon: 'reload', onSelect: () => restart(p) },
  ], { align: 'start' });
}

/* ── Tamaño de la letra ───────────────────────────────────────────────────── */

function fontSize() {
  const n = Number(S.settings?.termFontSize);
  return Number.isFinite(n) ? Math.max(SIZE.min, Math.min(SIZE.max, n)) : SIZE.def;
}

/** La letra es una sola para las dos mitades. */
function applyFont(size) {
  for (const p of panes) {
    if (p.xterm.options.fontSize === size) continue;
    p.xterm.options.fontSize = size;
    refit(p);
  }
}

function zoom(dir) {
  const next = dir === 0 ? SIZE.def : Math.max(SIZE.min, Math.min(SIZE.max, fontSize() + dir));
  if (next === (current || panes[0])?.xterm.options.fontSize) return;
  applyFont(next);
  api.settings.save({ termFontSize: next }).catch(() => {});
  say(`Letra de la terminal: ${next} px`, { icon: 'terminal' });
}

/* ── La shell ─────────────────────────────────────────────────────────────── */

/* Las filas son enteras: lo que no llega a una fila sobra (de 0 a casi una
   fila entera, según el alto de la ventana). Pegado abajo hacía el hueco de
   abajo más alto que el de arriba; repartido mitad y mitad, los dos quedan
   iguales. Va como padding de .xterm, que fit descuenta: no cambia las filas. */
function refit(p) {
  const { xterm, screen } = p;
  if (!xterm || !screen?.isConnected || !screen.clientWidth || !screen.clientHeight) return;
  xterm.element.style.paddingTop = '';
  try { p.fit.fit(); } catch { /* sin medidas todavía */ }
  const rows = xterm.element.querySelector('.xterm-screen');
  const spare = rows ? screen.clientHeight - rows.offsetHeight : 0;
  if (spare > 1) xterm.element.style.paddingTop = `${Math.floor(spare / 2)}px`;
}

async function open(p) {
  refit(p);
  const fresh = !p.opened;
  p.opened = true;
  try {
    const r = await api.term.open(p.id, p.xterm.cols, p.xterm.rows, fresh);
    if (r.started) {
      p.xterm.reset();
      setCwd(p, '');
      setRun(p, false);
    } else if (r.backlog) {
      p.xterm.write(r.backlog);
    }
    p.session = r.session;
    p.dead = false;
    p.el?.classList.remove('is-dead');
  } catch (err) {
    p.dead = true;
    p.el?.classList.add('is-dead');
    p.xterm.write(`\x1b[38;2;212;103;107m${String(err.message || err)}\x1b[0m\r\n`);
  }
}

async function restart(p) {
  try {
    p.xterm.reset();
    setCwd(p, '');
    setRun(p, false);
    const r = await api.term.restart(p.id, p.xterm.cols, p.xterm.rows);
    p.session = r.session;
    p.dead = false;
    p.el?.classList.remove('is-dead');
  } catch (err) {
    p.xterm.write(`\x1b[38;2;212;103;107m${String(err.message || err)}\x1b[0m\r\n`);
  }
  p.xterm.focus();
}

/* ── Dividir y juntar ─────────────────────────────────────────────────────── */

/** Le arma a la mitad su lugar en la página montada y le pasa la pantalla. */
function place(p, { entering = false } = {}) {
  const box = page?.querySelector('.pr-term__panes');
  if (!box) return;
  const tpl = document.createElement('template');
  tpl.innerHTML = paneHtml(panes.indexOf(p) + 1).trim();
  const el = tpl.content.firstElementChild;
  p.el = el;
  el.classList.toggle('is-dead', p.dead);
  if (entering) {
    el.classList.add('is-entering');
    el.addEventListener('animationend', (e) => { if (e.target === el) el.classList.remove('is-entering'); });
  }
  // Los botones no se llevan el foco: el teclado se queda en la shell.
  el.querySelectorAll('.pr-term__act').forEach((b) => b.addEventListener('pointerdown', (e) => e.preventDefault()));
  el.querySelector('[data-act="split"]').addEventListener('click', () => split());
  el.querySelector('[data-act="close"]').addEventListener('click', () => closePane(p));
  // La pestaña de arriba también lleva el teclado a su mitad.
  el.querySelector('.pr-term__tab').addEventListener('click', () => p.xterm.focus());
  const body = el.querySelector('.pr-term__body');
  body.appendChild(p.screen);
  box.appendChild(el);
  mounted?.ro.observe(body);
  paintPlace(p);
}

/** Los números de las pestañas (01, 02) siguen el orden: si se va la de la
    izquierda, la otra pasa a ser la 01. */
function renumber() {
  panes.forEach((p, i) => {
    const el = p.el?.querySelector('.pr-term__num');
    if (el && el.textContent !== num(i + 1)) swapText(el, num(i + 1));
  });
  page?.querySelector('.pr-term')?.classList.toggle('is-split', panes.length > 1);
}

/** Divide la pestaña en dos: la mitad nueva (a la derecha) arranca su shell y
    se lleva el teclado. Con dos ya está: no se divide más. */
export async function split() {
  if (!visible() || !XT) return;
  if (panes.length >= IDS.length) {
    say('La terminal ya está dividida en dos.', { icon: 'terminal' });
    return;
  }
  const id = IDS.find((x) => !byId(x));
  const p = makePane(id);
  panes.push(p);
  place(p, { entering: true });
  renumber();
  // Primero el lugar nuevo (las dos se acomodan), después la shell con su tamaño.
  await new Promise((r) => requestAnimationFrame(r));
  panes.forEach(refit);
  await open(p);
  p.xterm.focus();
}

/** Cierra una mitad: su shell termina y la otra se queda con toda la pestaña. */
export function closePane(p) {
  if (panes.length < 2 || !panes.includes(p)) return;
  panes.splice(panes.indexOf(p), 1);
  api.term.close(p.id).catch(() => {});
  setRun(p, false);
  const rest = panes[0];
  const hadKeys = current === p || p.el?.classList.contains('is-focus');
  if (current === p) { current = rest; paintFoot(); }
  const dispose = () => { try { p.xterm.dispose(); } catch { /* ya estaba */ } };
  if (p.el?.isConnected) {
    exit(p.el, { fallback: 260, onDone: () => { dispose(); renumber(); panes.forEach(refit); } });
  } else {
    dispose();
  }
  p.el = null;
  renumber();
  if (hadKeys) rest.xterm.focus();
}

/** Alt+Mayús con las flechas: el teclado pasa a la otra mitad. */
export function cycle(dir) {
  if (panes.length < 2 || !visible()) return;
  const i = Math.max(0, panes.indexOf(current));
  panes[(i + dir + panes.length) % panes.length].xterm.focus();
}

/* ── Las barras ───────────────────────────────────────────────────────────── */

function setCwd(p, path) {
  if (path === p.cwd) return;
  p.cwd = path;
  paintPlace(p);
  if (!path) { setBranch(p, null); return; }
  api.term.branch(path).then((b) => { if (path === p.cwd) setBranch(p, b); }).catch(() => setBranch(p, null));
}

function setBranch(p, b) {
  if (b === p.branch) return;
  p.branch = b;
  paintPlace(p);
}

/** Relevo, no salto: la ruta de la pestaña cambia en su lugar. Y si es la
    mitad que tiene el teclado, también la barra de abajo. */
function paintPlace(p) {
  const where = p.el?.querySelector('.pr-term__where');
  if (where) {
    where.classList.toggle('is-on', !!p.cwd);
    if (p.cwd) swapText(p.el.querySelector('.pr-term__short'), tail(p.cwd));
  }
  if (p === (current || panes[0])) paintFoot();
}

/** La barra de abajo: carpeta, branch y «run» de la mitad con el teclado. */
function paintFoot() {
  if (!page) return;
  const p = current || panes[0];
  const cwd = p?.cwd || '';
  const branch = p?.branch || null;
  const cwdEl = page.querySelector('.pr-term__cwd');
  cwdEl.classList.toggle('is-on', !!cwd);
  if (cwd) {
    swapText(cwdEl.querySelector('.pr-term__val'), tilde(cwd));
    cwdEl.dataset.tip = cwd;
  }
  const br = page.querySelector('.pr-term__branch');
  br.classList.toggle('is-on', !!branch);
  if (branch) swapText(br.querySelector('.pr-term__val'), branch);
  paintRun();
}

/** 6s · 1m 14s · 1h 03m: segundos enteros, que es lo que corre. */
function fmtRun(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

/** Lo que lleva el comando que corre en la mitad con el teclado. Al terminar
    se esfuma con su último número, no se borra antes. */
function paintRun() {
  const el = page?.querySelector('.pr-term__run');
  if (!el) return;
  const p = current || panes[0];
  const since = p?.runSince ?? null;
  const ms = since == null ? 0 : Date.now() - since;
  const shown = since != null && ms >= RUN_SHOW;
  if (shown) {
    const val = el.querySelector('.pr-term__val');
    const text = fmtRun(ms);
    if (val.textContent !== text) val.textContent = text;
  }
  el.classList.toggle('is-on', shown);
}

function setRun(p, running) {
  if (running === (p.runSince != null)) return;
  p.runSince = running ? Date.now() : null;
  clearInterval(p.runTimer);
  p.runTimer = running ? setInterval(paintRun, 250) : 0;
  paintRun();
}

const visible = () => !!page && page.isConnected && !page.classList.contains('is-parked');

async function tickStats() {
  if (!visible()) return;
  try {
    const s = await api.term.stats();
    for (const k of ['cpu', 'mem']) {
      const el = page?.querySelector(`.pr-term__gauge[data-k="${k}"]`);
      if (el) roll(el, s[k], (v) => { el.textContent = `${Math.round(v)}%`; }, { duration: 600 });
    }
  } catch { /* la próxima */ }
}

function tickClock() {
  const el = page?.querySelector('.pr-term__clock');
  if (!el || !visible()) return;
  const d = new Date();
  const p2 = (n) => String(n).padStart(2, '0');
  el.textContent = `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
}

/* ── Montar y desmontar ───────────────────────────────────────────────────── */

/** La primera vez, las mitades salen de las shells que ya viven (la interfaz
    se recargó con la terminal dividida); si no hay ninguna, una sola. */
async function restore() {
  if (restored) return;
  restored = true;
  let alive = [];
  try { alive = await api.term.panes(); } catch { /* una sola */ }
  const ids = IDS.filter((id) => alive.includes(id));
  for (const id of ids.length ? ids : ['a']) panes.push(makePane(id));
}

/**
 * Monta la terminal en la página recién armada (pages.js). Devuelve la
 * limpieza, que la desmonta sin cerrar las shells: se van cuando se cierra
 * la pestaña (lo decide src/term.cjs).
 */
export function attach(el) {
  page = el;
  const me = { ro: new ResizeObserver(() => requestAnimationFrame(() => panes.forEach(refit))), gone: false };
  mounted = me;
  const timers = [setInterval(tickStats, 2000), setInterval(tickClock, 1000)];
  tickClock();
  tickStats();

  booting = booting || boot();
  booting.then(restore).then(async () => {
    if (me.gone) return;
    panes.forEach((p) => place(p));
    renumber();
    paintFoot();
    /* Siempre se pide: si la shell corre, se engancha (y toma el tamaño
       nuevo); si se cerró con su pestaña, abre otra. */
    await Promise.all(panes.map(open));
    if (me.gone) return;
    if (activeTab()?.internal === 'terminal') (current || panes[0])?.xterm.focus();
  }).catch((err) => {
    console.error('[terminal]', err);
    const box = el.querySelector('.pr-term__panes');
    box.innerHTML = '<div class="pr-term__fail"></div>';
    box.firstChild.textContent = `La terminal no pudo arrancar: ${err?.message || err}`;
  });

  return () => {
    me.gone = true;
    me.ro.disconnect();
    timers.forEach(clearInterval);
    if (mounted === me) mounted = null;
    if (page === el) page = null;
    for (const p of panes) {
      if (p.screen.parentElement && el.contains(p.screen)) p.screen.remove();
      if (p.el && el.contains(p.el)) p.el = null;
    }
  };
}

/** Le da el teclado a la terminal (a la mitad que lo tuvo último), si está a la vista. */
export function focus() {
  const p = current || panes[0];
  if (!p || !visible()) return;
  requestAnimationFrame(() => p.xterm.focus());
}

export { html };

/* Volver a la pestaña de la terminal (un click en la pestaña, Ctrl+Tab) le
   devuelve el teclado: la pestaña es para escribir. */
let wasActive = false;
on('tabs', () => {
  const now = activeTab()?.internal === 'terminal';
  if (now && !wasActive) setTimeout(focus, 60);
  wasActive = now;
});
on('settings', () => applyFont(fontSize()));
