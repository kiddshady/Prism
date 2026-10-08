/* ═══════════════════════════════════════════════════════════════════════════
   PRISM — la terminal
   La pestaña prism://terminal: una PowerShell 7 de verdad (la shell vive en
   el proceso principal, src/term.cjs) dibujada con xterm.js directo sobre la
   hoja de la página. No va en un pozo adentro de la hoja: la hoja ES la
   terminal, con una línea de luz arriba (la pestaña de la shell) y otra abajo
   (cpu, memoria, branch, carpeta y hora).

   Hay UNA xterm para toda la vida de la ventana. La página la monta y la
   desmonta (cambiar de pestaña, pasarla a una mitad de la vista dividida),
   pero no la rehace: lo escrito, el scroll y la selección siguen ahí.
   ═══════════════════════════════════════════════════════════════════════════ */

import { api, S, on, activeTab } from './state.js';
import { Icons } from './icons.js';
import { roll, swapText } from './motion.js';
import { menu, pointAnchor } from './layers.js';
import { say } from './status.js';

const VENDOR = '../vendor/xterm';
const FONT = "'Roboto Mono', 'Cascadia Mono', Consolas, monospace";
const SIZE = { def: 13, min: 9, max: 24 };

/* La paleta: los colores de siempre de una terminal (git en rojo y verde, las
   carpetas en azul, los avisos en amarillo, el resaltado de PSReadLine), pero
   apagados, con la luz y la saturación del rojo de error de Prism
   (--op-danger), que es el ancla. El prompt sigue en grises: ese lo pinta
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
  red: '#d4676b', brightRed: '#e08a8d',
  green: '#8cba94', brightGreen: '#a9d1af',
  yellow: '#d4bc84', brightYellow: '#e6d3a1',
  blue: '#86a2cf', brightBlue: '#a5bce0',
  magenta: '#b693c8', brightMagenta: '#cdaedb',
  cyan: '#7fb9bc', brightCyan: '#a0d0d2',
  white: '#cdcdd1', brightWhite: '#f4f4f6',   // white es el texto que tipeás (PSReadLine): que no quede apagado
};

/* ── Estado de la única xterm ─────────────────────────────────────────────── */

let xterm = null;          // Terminal de xterm.js
let fit = null;
let screen = null;         // el div donde vive xterm: se pasa de una página a otra
let booting = null;        // la carga de xterm, una sola vez
let session = 0;           // de qué shell es lo que se dibuja
let dead = false;          // la shell terminó: Enter abre otra
let opened = false;        // ya se le pidió una shell a esta xterm
let page = null;           // la .pr-view montada ahora, o null
let cwd = '';
let branch = null;
let runSince = null;       // cuándo arrancó el comando que corre, o null
let runTimer = 0;

/* El «run» aparece recién pasado el primer segundo: un cd o un ls no tienen
   por qué hacer parpadear un «run 0s» en la barra. */
const RUN_SHOW = 1000;

const html = () => `
  <div class="pr-term">
    <header class="pr-term__head">
      <div class="pr-term__tab">
        <svg class="pr-term__tri" viewBox="0 0 8 10" aria-hidden="true"><path d="M1.6 1.4 6.6 5l-5 3.6z"/></svg>
        <span class="pr-term__num op-num">01</span>
        <span class="pr-term__name">PowerShell 7</span>
        <span class="pr-term__where"><span class="pr-term__dash"></span><span class="pr-term__short op-swap--truncate"></span></span>
      </div>
    </header>
    <div class="pr-term__body"></div>
    <footer class="pr-term__foot">
      <span class="pr-term__stat"><b>cpu</b><span class="pr-term__gauge op-num" data-k="cpu">0%</span></span>
      <span class="pr-term__stat"><b>mem</b><span class="pr-term__gauge op-num" data-k="mem">0%</span></span>
      <span class="pr-term__stat pr-term__branch">${Icons.svg('branch')}<span class="pr-term__val op-swap--truncate"></span></span>
      <span class="pr-term__stat pr-term__cwd">${Icons.svg('folder')}<span class="pr-term__val op-swap--truncate"></span></span>
      <span class="pr-term__stat pr-term__run"><b>run</b><span class="pr-term__val op-num"></span></span>
      <span class="pr-term__end"><span class="pr-term__live"></span><span class="pr-term__clock op-num"></span></span>
    </footer>
  </div>`;

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
     vez, y con la de reserva medida quedaban columnas corridas. */
  await Promise.all([document.fonts.load(`13px 'Roboto Mono'`), document.fonts.load(`500 13px 'Roboto Mono'`)]).catch(() => {});

  xterm = new Terminal({
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
  fit = new FitAddon();
  xterm.loadAddon(fit);
  const uni = new Unicode11Addon();
  xterm.loadAddon(uni);
  xterm.unicode.activeVersion = '11';
  // Un link en la salida (un npm start que dice http://localhost:5173) se abre en una pestaña.
  xterm.loadAddon(new WebLinksAddon((e, uri) => {
    e.preventDefault();
    api.tabs.create(uri, { active: !e.ctrlKey });
  }));

  screen = document.createElement('div');
  screen.className = 'pr-term__screen';
  xterm.open(screen);

  xterm.onData((d) => {
    if (!dead) return api.term.write(d);
    if (d === '\r') restart();          // con la shell terminada, Enter abre otra
    return null;
  });
  xterm.onResize(({ cols, rows }) => { if (!dead) api.term.resize(cols, rows); });
  xterm.onSelectionChange(() => screen.classList.toggle('has-selection', xterm.hasSelection()));

  // OSC 7: el prompt avisa la carpeta (src/term-init.ps1).
  xterm.parser.registerOscHandler(7, (data) => {
    const m = /^file:\/\/[^/]*\/?(.*)$/.exec(data);
    if (m) {
      let p = m[1];
      try { p = decodeURIComponent(p); } catch { /* tal cual */ }
      setCwd(p.replace(/\//g, '\\'));
    }
    return true;
  });

  // OSC 133: C arranca un comando, D vuelve el prompt (src/term-init.ps1).
  xterm.parser.registerOscHandler(133, (data) => {
    if (data[0] === 'C') setRun(true);
    else if (data[0] === 'D') setRun(false);
    return true;
  });

  xterm.attachCustomKeyEventHandler(onKey);

  const ta = xterm.textarea;
  ta.addEventListener('focus', () => { api.term.focused(true); page?.classList.add('is-focus'); });
  ta.addEventListener('blur', () => { api.term.focused(false); page?.classList.remove('is-focus'); });

  // Click derecho: el menú de la terminal, no el de los campos de texto.
  screen.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    contextMenu(e.clientX, e.clientY);
  });

  api.term.onData((m) => {
    if (m.session < session) return;
    session = m.session;
    xterm.write(m.data);
  });
  api.term.onExit((m) => {
    if (m.session !== session) return;
    dead = true;
    setRun(false);
    page?.classList.add('is-dead');
    xterm.write(`\r\n\x1b[38;2;150;150;156mLa sesión terminó${m.code ? ` (código ${m.code})` : ''}. Enter abre otra.\x1b[0m\r\n`);
  });
}

/* ── Teclado ──────────────────────────────────────────────────────────────── */

function onKey(e) {
  if (e.type !== 'keydown') return true;
  const k = e.key.toLowerCase();
  const ctrl = e.ctrlKey && !e.altKey;
  // Copiar: con algo marcado, Ctrl+C copia (sin nada, es el Ctrl+C de siempre: cortar lo que corre).
  if (ctrl && k === 'c' && (e.shiftKey || xterm.hasSelection())) {
    e.preventDefault();
    copy();
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

async function copy() {
  const text = xterm.getSelection();
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    xterm.clearSelection();
  } catch (err) {
    say(`No se pudo copiar: ${err.message}`, { icon: 'alert', tone: 'error' });
  }
}

async function paste() {
  try {
    const text = await api.clip.read();
    if (text) xterm.paste(text);
  } catch (err) {
    say(`No se pudo pegar: ${err.message}`, { icon: 'alert', tone: 'error' });
  }
  xterm.focus();
}

function contextMenu(x, y) {
  const has = xterm.hasSelection();
  menu(pointAnchor(x, y), [
    { label: 'Copiar', icon: 'copy', key: 'Ctrl+C', disabled: !has, onSelect: () => copy() },
    { label: 'Pegar', icon: 'clipboard', key: 'Ctrl+V', onSelect: () => paste() },
    { label: 'Seleccionar todo', onSelect: () => xterm.selectAll() },
    { sep: true },
    { label: 'Limpiar', key: 'Ctrl+L', onSelect: () => { xterm.clear(); xterm.focus(); } },
    { label: 'Reiniciar la shell', icon: 'reload', onSelect: () => restart() },
  ], { align: 'start' });
}

/* ── Tamaño de la letra ───────────────────────────────────────────────────── */

function fontSize() {
  const n = Number(S.settings?.termFontSize);
  return Number.isFinite(n) ? Math.max(SIZE.min, Math.min(SIZE.max, n)) : SIZE.def;
}

function zoom(dir) {
  const next = dir === 0 ? SIZE.def : Math.max(SIZE.min, Math.min(SIZE.max, fontSize() + dir));
  if (next === xterm.options.fontSize) return;
  xterm.options.fontSize = next;
  refit();
  api.settings.save({ termFontSize: next }).catch(() => {});
  say(`Letra de la terminal: ${next} px`, { icon: 'terminal' });
}

/* ── La shell ─────────────────────────────────────────────────────────────── */

/* Las filas son enteras: lo que no llega a una fila sobra (de 0 a casi una
   fila entera, según el alto de la ventana). Pegado abajo hacía el hueco de
   abajo más alto que el de arriba; repartido mitad y mitad, los dos quedan
   iguales. Va como padding de .xterm, que fit descuenta: no cambia las filas. */
function refit() {
  if (!xterm || !screen?.isConnected || !screen.clientWidth || !screen.clientHeight) return;
  xterm.element.style.paddingTop = '';
  try { fit.fit(); } catch { /* sin medidas todavía */ }
  const rows = xterm.element.querySelector('.xterm-screen');
  const spare = rows ? screen.clientHeight - rows.offsetHeight : 0;
  if (spare > 1) xterm.element.style.paddingTop = `${Math.floor(spare / 2)}px`;
}

async function open() {
  refit();
  const fresh = !opened;
  opened = true;
  try {
    const r = await api.term.open(xterm.cols, xterm.rows, fresh);
    if (r.started) {
      xterm.reset();
      setCwd('');
      setRun(false);
    } else if (r.backlog) {
      xterm.write(r.backlog);
    }
    session = r.session;
    dead = false;
    page?.classList.remove('is-dead');
  } catch (err) {
    dead = true;
    page?.classList.add('is-dead');
    xterm.write(`\x1b[38;2;212;103;107m${String(err.message || err)}\x1b[0m\r\n`);
  }
}

async function restart() {
  if (!xterm) return;
  try {
    xterm.reset();
    setCwd('');
    setRun(false);
    const r = await api.term.restart(xterm.cols, xterm.rows);
    session = r.session;
    dead = false;
    page?.classList.remove('is-dead');
  } catch (err) {
    xterm.write(`\x1b[38;2;212;103;107m${String(err.message || err)}\x1b[0m\r\n`);
  }
  xterm.focus();
}

/* ── Las barras ───────────────────────────────────────────────────────────── */

function setCwd(p) {
  if (p === cwd) return;
  cwd = p;
  paintPlace();
  if (!p) { setBranch(null); return; }
  api.term.branch(p).then((b) => { if (p === cwd) setBranch(b); }).catch(() => setBranch(null));
}

function setBranch(b) {
  if (b === branch) return;
  branch = b;
  paintPlace();
}

/** Relevo, no salto: la ruta y el branch cambian en su lugar. */
function paintPlace() {
  if (!page) return;
  const where = page.querySelector('.pr-term__where');
  where.classList.toggle('is-on', !!cwd);
  if (cwd) swapText(page.querySelector('.pr-term__short'), tail(cwd));
  const cwdEl = page.querySelector('.pr-term__cwd');
  cwdEl.classList.toggle('is-on', !!cwd);
  if (cwd) {
    swapText(cwdEl.querySelector('.pr-term__val'), tilde(cwd));
    cwdEl.dataset.tip = cwd;
  }
  const br = page.querySelector('.pr-term__branch');
  br.classList.toggle('is-on', !!branch);
  if (branch) swapText(br.querySelector('.pr-term__val'), branch);
}

/** 6s · 1m 14s · 1h 03m: segundos enteros, que es lo que corre. */
function fmtRun(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

/** Lo que lleva el comando que corre. Al terminar se esfuma con su último
    número, no se borra antes. */
function paintRun() {
  const el = page?.querySelector('.pr-term__run');
  if (!el) return;
  const ms = runSince == null ? 0 : Date.now() - runSince;
  const on = runSince != null && ms >= RUN_SHOW;
  if (on) {
    const val = el.querySelector('.pr-term__val');
    const text = fmtRun(ms);
    if (val.textContent !== text) val.textContent = text;
  }
  el.classList.toggle('is-on', on);
}

function setRun(running) {
  if (running === (runSince != null)) return;
  runSince = running ? Date.now() : null;
  clearInterval(runTimer);
  runTimer = running ? setInterval(paintRun, 250) : 0;
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

/**
 * Monta la terminal en la página recién armada (pages.js). Devuelve la
 * limpieza, que la desmonta sin cerrar la shell: la shell se va cuando se
 * cierra la pestaña (lo decide src/term.cjs).
 */
export function attach(el) {
  page = el;
  const body = el.querySelector('.pr-term__body');
  let gone = false;
  const ro = new ResizeObserver(() => requestAnimationFrame(refit));
  const timers = [setInterval(tickStats, 2000), setInterval(tickClock, 1000)];
  tickClock();
  tickStats();

  booting = booting || boot();
  booting.then(async () => {
    if (gone) return;
    body.appendChild(screen);
    ro.observe(body);
    paintPlace();
    paintRun();
    /* Siempre se pide: si la shell corre, se engancha (y toma el tamaño
       nuevo); si se cerró con su pestaña, abre otra. */
    await open();
    if (gone) return;
    if (activeTab()?.internal === 'terminal') xterm.focus();
  }).catch((err) => {
    console.error('[terminal]', err);
    body.innerHTML = '<div class="pr-term__fail"></div>';
    body.firstChild.textContent = `La terminal no pudo arrancar: ${err?.message || err}`;
  });

  return () => {
    gone = true;
    ro.disconnect();
    timers.forEach(clearInterval);
    if (page === el) page = null;
    if (screen?.parentElement === body) screen.remove();
  };
}

/** Le da el teclado a la terminal, si está a la vista. */
export function focus() {
  if (!xterm || !visible()) return;
  requestAnimationFrame(() => xterm.focus());
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
on('settings', () => {
  if (xterm && xterm.options.fontSize !== fontSize()) { xterm.options.fontSize = fontSize(); refit(); }
});
