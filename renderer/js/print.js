/* ═══════════════════════════════════════════════════════════════════════════
   PRISM — la pantalla de impresión
   Como la de Chrome: a la izquierda las opciones, a la derecha las hojas de
   verdad. Se abre con Ctrl+P, el menú, el clic derecho o el window.print()
   de un sitio (src/print-preload.cjs). El proceso principal está en
   src/print.cjs.

   La vista previa es el PDF de la página hecho con las mismas opciones que
   van a la impresora, dibujado acá con pdf.js. Solo lo que cambia el armado
   de las hojas (papel, orientación, márgenes, escala, fondos) lo rehace;
   elegir páginas muestra u oculta las que ya están, y blanco y negro las tiñe.

   Rehacerlo no parpadea: las hojas viejas se quedan hasta que las nuevas
   están dibujadas, y recién ahí se relevan en el mismo lugar.
   ═══════════════════════════════════════════════════════════════════════════ */

import { api, S } from './state.js';
import { Icons } from './icons.js';
import { Menu, Modal } from './overlays.js';
import { modal } from './layers.js';
import { bindSwitcher, bindStepper, scrollFade, exit } from './motion.js';

const PAPERS = [['A4', 'A4'], ['Letter', 'Carta'], ['Legal', 'Oficio']];
/** Cuánto se espera, después del último cambio, para rehacer la vista previa. */
const REDO_MS = 220;
/** Si armarla tarda más que esto, aparece la barrita de "armando". */
const BUSY_MS = 160;
/** Dos pedidos de un sitio seguidos (print() en un bucle) no reabren la pantalla. */
const PAGE_COOLDOWN = 1500;

/* ── pdf.js ───────────────────────────────────────────────────────────────── */

let pdfjs = null;
async function lib() {
  if (!pdfjs) {
    pdfjs = await import('../vendor/pdfjs/pdf.min.mjs');
    pdfjs.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdfjs/pdf.worker.min.mjs', import.meta.url).href;
  }
  return pdfjs;
}

/* ── Páginas elegidas ─────────────────────────────────────────────────────── */

/** "1-3, 5" → [[1,3],[5,5]], contra las páginas que hay. Ordenado y sin repetir. */
export function parseRanges(text, count) {
  const parts = String(text || '').split(/[,;\s]+/).filter(Boolean);
  if (!parts.length) return { error: 'Escribí qué páginas.' };
  const out = [];
  for (const p of parts) {
    const m = /^(\d+)(?:-(\d*))?$/.exec(p);
    if (!m) return { error: `«${p}» no es una página.` };
    const a = Number(m[1]);
    const b = m[2] === undefined ? a : m[2] === '' ? count : Number(m[2]);
    if (a < 1 || b < a) return { error: `«${p}» no es un rango.` };
    if (count && a > count) return { error: count === 1 ? 'Hay una sola página.' : `Hay ${count} páginas.` };
    out.push([a, Math.min(b, count || b)]);
  }
  out.sort((x, y) => x[0] - y[0]);
  const merged = [];
  for (const r of out) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1] + 1) last[1] = Math.max(last[1], r[1]);
    else merged.push([...r]);
  }
  return { ranges: merged };
}

const inRanges = (n, ranges) => ranges.some(([a, b]) => n >= a && n <= b);

/** Suelta un documento de pdf.js y su worker (en la 6, desde su tarea de carga). */
const drop = (d) => { d?.loadingTask?.destroy().catch(() => {}); };

/* ── Abrir ────────────────────────────────────────────────────────────────── */

let opened = false;
let closedAt = 0;

/** fromPage: lo pidió el window.print() de un sitio, no la persona. */
export async function openPrint({ fromPage = false } = {}) {
  if (opened || (fromPage && Date.now() - closedAt < PAGE_COOLDOWN)) return;
  const t = S.tabs.find((x) => x.id === S.activeId);
  if (!t || t.internal) return;
  opened = true;
  try {
    await show(t);
  } catch (err) {
    console.error('[print]', err);
  } finally {
    opened = false;
    closedAt = Date.now();
  }
}

async function show(t) {
  const o = {
    dest: null, pages: 'all', rangeText: '', copies: 1, landscape: false, color: true,
    paper: 'A4', margins: 'default', scale: 100, background: false, duplex: false,
  };
  let list = [];
  let count = 0;          // páginas del documento, cuando se sepa
  let closed = false;

  const seg = (id, opts, val) => `<div class="op-segmented" id="${id}">${opts.map(([v, l]) => `<button class="op-segmented__opt${v === val ? ' is-active' : ''}" data-value="${v}">${l}</button>`).join('')}</div>`;
  const stepper = (id, { min, max, step, value }) => `<div class="op-stepper"><input class="op-input" type="number" id="${id}" min="${min}" max="${max}" step="${step}" value="${value}">
    <div class="op-stepper__btns"><button class="op-stepper__btn" data-step="up" tabindex="-1" aria-label="Más">${Icons.svg('chevronUp')}</button><button class="op-stepper__btn" data-step="down" tabindex="-1" aria-label="Menos">${Icons.svg('chevronDown')}</button></div></div>`;
  const field = (label, ctl) => `<div class="pr-print__field"><div class="pr-print__label">${label}</div>${ctl}</div>`;
  // Lo que es solo de una impresora se pliega al elegir "Guardar como PDF".
  const onlyPrinter = (html) => `<div class="op-reveal is-open pr-print__only"><div>${html}</div></div>`;

  const body = document.createElement('div');
  body.className = 'pr-print';
  body.innerHTML = `
    <div class="pr-print__opts op-scroll">
      ${field('Destino', `<button class="op-select" id="pp-dest"><span class="op-select__value" data-placeholder="Buscando impresoras…"></span>${Icons.svg('chevronDown')}</button>`)}
      ${field('Páginas', `${seg('pp-pages', [['all', 'Todas'], ['custom', 'Elegir']], 'all')}
        <div class="op-reveal" id="pp-range-wrap"><div><div class="pr-print__range">
          <input class="op-input op-input--mono" id="pp-range" spellcheck="false" autocomplete="off" placeholder="Ej.: 1-3, 5">
          <div class="op-field__hint" id="pp-range-hint">&nbsp;</div></div></div></div>`)}
      ${onlyPrinter(field('Copias', stepper('pp-copies', { min: 1, max: 99, step: 1, value: 1 })))}
      ${field('Orientación', seg('pp-orient', [['portrait', 'Vertical'], ['landscape', 'Horizontal']], 'portrait'))}
      ${onlyPrinter(field('Color', seg('pp-color', [['color', 'Color'], ['gray', 'Blanco y negro']], 'color')))}
      <div class="pr-print__sep"></div>
      ${field('Papel', `<button class="op-select" id="pp-paper"><span class="op-select__value"></span>${Icons.svg('chevronDown')}</button>`)}
      ${field('Márgenes', seg('pp-margins', [['default', 'Normales'], ['none', 'Ninguno']], 'default'))}
      ${field('Escala', `<div class="pr-print__scale">${stepper('pp-scale', { min: 10, max: 200, step: 10, value: 100 })}<span>%</span></div>`)}
      <div class="pr-print__line"><span>Gráficos de fondo</span><button class="op-switch" id="pp-bg" aria-label="Gráficos de fondo"></button></div>
      ${onlyPrinter(`<div class="pr-print__line"><span>Doble faz</span><button class="op-switch" id="pp-duplex" aria-label="Doble faz"></button></div>
        <button class="pr-print__link" id="pp-system">Más opciones de la impresora ${Icons.svg('external')}</button>`)}
    </div>
    <div class="pr-print__preview">
      <div class="pr-print__stage op-scroll op-scroll--line-top op-scroll--line-bottom" id="pp-stage"></div>
      <div class="pr-print__busy op-meter op-meter--indeterminate"><div class="op-meter__fill"></div></div>
      <div class="pr-print__note" id="pp-note"></div>
    </div>`;

  const $ = (s) => body.querySelector(s);
  const stage = $('#pp-stage');
  const note = $('#pp-note');
  let primary = null;
  let summary = null;

  /* ── Destino ───────────────────────────────────────────────────────────── */

  const destLabel = () => (o.dest === 'pdf' ? 'Guardar como PDF' : list.find((p) => p.name === o.dest)?.label || '');
  function setDest(d) {
    o.dest = d;
    $('#pp-dest .op-select__value').textContent = destLabel();
    const pdf = d === 'pdf';
    body.classList.toggle('is-pdf', pdf);
    body.querySelectorAll('.pr-print__only').forEach((el) => el.classList.toggle('is-open', !pdf));
    body.classList.toggle('is-gray', !pdf && !o.color);
    sync();
  }
  api.page.printers().then(({ list: l, default: dflt }) => {
    if (closed) return;
    list = l;
    const saved = S.settings?.printDest;
    setDest(saved === 'pdf' || list.some((p) => p.name === saved) ? saved : dflt || list[0]?.name || 'pdf');
  }).catch(() => { if (!closed) setDest('pdf'); });

  $('#pp-dest').addEventListener('click', (e) => {
    const b = e.currentTarget;
    b.classList.add('is-open');
    Menu.show(b, [
      { label: 'Guardar como PDF', icon: 'pdf', selected: o.dest === 'pdf', onSelect: () => setDest('pdf') },
      ...(list.length ? [{ sep: true }] : []),
      ...list.map((p) => ({ label: p.label, icon: 'printer', selected: o.dest === p.name, onSelect: () => setDest(p.name) })),
    ], { onClose: () => b.classList.remove('is-open') });
  });

  $('#pp-paper .op-select__value').textContent = PAPERS.find(([v]) => v === o.paper)[1];
  $('#pp-paper').addEventListener('click', (e) => {
    const b = e.currentTarget;
    b.classList.add('is-open');
    Menu.show(b, PAPERS.map(([v, l]) => ({
      label: l, selected: o.paper === v,
      onSelect: () => { o.paper = v; b.querySelector('.op-select__value').textContent = l; redo(); },
    })), { onClose: () => b.classList.remove('is-open') });
  });

  /* ── El resto de las opciones ──────────────────────────────────────────── */

  bindSwitcher($('#pp-pages'), (v) => {
    o.pages = v;
    $('#pp-range-wrap').classList.toggle('is-open', v === 'custom');
    if (v === 'custom') setTimeout(() => $('#pp-range').focus(), 60);
    sync();
  });
  $('#pp-range').addEventListener('input', (e) => { o.rangeText = e.target.value; sync(); });
  bindStepper($('#pp-copies').parentElement, (v) => { o.copies = v; sync(); });
  $('#pp-copies').addEventListener('change', (e) => { o.copies = Math.min(99, Math.max(1, Math.round(Number(e.target.value)) || 1)); e.target.value = o.copies; sync(); });
  bindSwitcher($('#pp-orient'), (v) => { o.landscape = v === 'landscape'; redo(); });
  bindSwitcher($('#pp-color'), (v) => { o.color = v === 'color'; body.classList.toggle('is-gray', !o.color); });
  bindSwitcher($('#pp-margins'), (v) => { o.margins = v; redo(); });
  const scaleIn = $('#pp-scale');
  const setScale = (v) => {
    const n = Math.min(200, Math.max(10, Math.round(Number(v)) || 100));
    scaleIn.value = n;
    if (n !== o.scale) { o.scale = n; redo(); }
  };
  bindStepper(scaleIn.parentElement, setScale);
  scaleIn.addEventListener('change', () => setScale(scaleIn.value));
  for (const [id, key, layout] of [['#pp-bg', 'background', true], ['#pp-duplex', 'duplex', false]]) {
    $(id).addEventListener('click', (e) => {
      o[key] = e.currentTarget.classList.toggle('is-on');
      if (layout) redo(); else sync();
    });
  }
  $('#pp-system').addEventListener('click', () => Modal.close('system'));

  /* ── Lo que se ve según lo elegido ─────────────────────────────────────── */

  let ranges = [];
  /* Lo que se muestra: mientras se escribe un rango ("2-" camino a "2-5"),
     las hojas se quedan con la última elección que valía en vez de vaciarse. */
  let shown = null;
  function sync() {
    const custom = o.pages === 'custom';
    const r = custom && count ? parseRanges(o.rangeText, count) : { ranges: [] };
    const hint = $('#pp-range-hint');
    const bad = custom && !!r.error && (o.rangeText.trim() !== '' || !count);
    hint.textContent = custom && r.error && o.rangeText.trim() ? r.error : count ? `De 1 a ${count}` : ' ';
    hint.classList.toggle('op-field__hint--error', bad && o.rangeText.trim() !== '');
    $('#pp-range').classList.toggle('is-invalid', bad && o.rangeText.trim() !== '');
    ranges = custom ? r.ranges || [] : [];
    if (!custom) shown = null;
    else if (r.ranges && count) shown = r.ranges;

    stage.querySelectorAll('.pr-print__sheets:not([data-state="closing"]) .pr-sheet').forEach((s) => {
      s.classList.toggle('is-out', !!shown && !inRanges(Number(s.dataset.n), shown));
    });

    const pages = custom ? ranges.reduce((n, [a, b]) => n + b - a + 1, 0) : count;
    const pdf = o.dest === 'pdf';
    const sheets = pdf ? pages : Math.ceil(pages / (o.duplex ? 2 : 1)) * o.copies;
    if (summary) summary.textContent = !count || (custom && r.error) ? '' : pdf ? `${pages} ${pages === 1 ? 'página' : 'páginas'}` : `${sheets} ${sheets === 1 ? 'hoja' : 'hojas'} de papel`;
    if (primary) {
      primary.textContent = pdf ? 'Guardar' : 'Imprimir';
      primary.disabled = !o.dest || (custom && (!count || !!r.error));
    }
  }

  /* ── La vista previa ───────────────────────────────────────────────────── */

  let seq = 0;
  let redoTimer = null;
  let busyTimer = null;
  let doc = null;
  let io = null;

  function redo() {
    clearTimeout(redoTimer);
    redoTimer = setTimeout(build, REDO_MS);
  }

  const layout = () => ({ landscape: o.landscape, paper: o.paper, margins: o.margins, scale: o.scale, background: o.background });

  async function build() {
    const my = ++seq;
    clearTimeout(busyTimer);
    busyTimer = setTimeout(() => body.classList.add('is-busy'), BUSY_MS);
    let next = null;
    try {
      const [{ getDocument }, data] = await Promise.all([lib(), api.page.printPreview(t.id, layout())]);
      if (my !== seq || closed) return;
      next = await getDocument({ data, isEvalSupported: false, useWasm: false }).promise;
      if (my !== seq || closed) { drop(next); return; }
      await swap(next);
      drop(doc);
      doc = next;
      count = next.numPages;
      note.textContent = '';
      body.classList.remove('has-note');
    } catch (err) {
      drop(next);
      if (my !== seq || closed) return;
      console.error('[print] vista previa', err);
      note.textContent = 'No se pudo armar la vista previa. Igual se puede imprimir.';
      body.classList.add('has-note');
    } finally {
      if (my === seq) { clearTimeout(busyTimer); body.classList.remove('is-busy'); }
    }
    sync();
  }

  /** Las hojas nuevas se dibujan (las que se ven) y recién ahí relevan a las viejas. */
  async function swap(next) {
    const box = document.createElement('div');
    box.className = 'pr-print__sheets';
    const first = await next.getPage(1);
    const vp = first.getViewport({ scale: 1 });
    box.style.setProperty('--ar', `${vp.width} / ${vp.height}`);
    box.classList.toggle('is-wide', vp.width > vp.height);
    for (let n = 1; n <= next.numPages; n++) {
      box.insertAdjacentHTML('beforeend', `<div class="pr-sheet" data-n="${n}"><div class="pr-sheet__in"><div class="pr-sheet__body">
        <div class="pr-sheet__paper"><canvas></canvas></div>
        <div class="pr-sheet__num op-num">${n}</div></div></div></div>`);
    }
    const old = stage.querySelector('.pr-print__sheets:not([data-state="closing"])');
    box.querySelectorAll('.pr-sheet').forEach((s) => s.classList.toggle('is-out', !!shown && !inRanges(Number(s.dataset.n), shown)));
    if (old) box.classList.add('is-after');
    box.style.visibility = 'hidden';
    stage.appendChild(box);

    // Las primeras hojas, antes de mostrarlas: nunca se ve una hoja en blanco.
    const papers = [...box.querySelectorAll('.pr-sheet:not(.is-out)')].slice(0, 2);
    await Promise.all(papers.map((s) => draw(next, s)));
    if (closed) return;

    io?.disconnect();
    io = new IntersectionObserver((entries) => {
      for (const e of entries) if (e.isIntersecting) draw(next, e.target);
    }, { root: stage, rootMargin: '600px 0px' });
    box.querySelectorAll('.pr-sheet').forEach((s) => { if (!s.dataset.drawn) io.observe(s); });

    box.style.visibility = '';
    if (old) exit(old, { fallback: 200 });
  }

  async function draw(d, sheet) {
    if (sheet.dataset.drawn) return;
    sheet.dataset.drawn = '1';
    const canvas = sheet.querySelector('canvas');
    const paper = sheet.querySelector('.pr-sheet__paper');
    const page = await d.getPage(Number(sheet.dataset.n));
    const base = page.getViewport({ scale: 1 });
    const cssW = paper.clientWidth || 400;
    const viewport = page.getViewport({ scale: (cssW * Math.max(1, devicePixelRatio)) / base.width });
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);
    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise.catch(() => {});
    sheet.classList.add('is-drawn');
  }

  /* ── El diálogo ────────────────────────────────────────────────────────── */

  // El pie lleva, a la izquierda, cuántas hojas van a salir.
  const mo = new MutationObserver(() => {
    const m = body.closest('.op-modal');
    if (!m) return;
    mo.disconnect();
    m.classList.add('op-modal--print');
    primary = m.querySelector('.op-modal__foot .op-btn--primary');
    const foot = m.querySelector('.op-modal__foot');
    summary = document.createElement('span');
    summary.className = 'pr-print__summary op-meta op-num';
    foot.prepend(summary);
    scrollFade(body.querySelector('.pr-print__opts'));
    scrollFade(stage);
    sync();
  });
  mo.observe(document.getElementById('op-layer'), { childList: true, subtree: true });

  build();
  const v = await modal({
    title: 'Imprimir',
    sub: t.title || '',
    body,
    width: 960,
    actions: [
      { label: 'Cancelar', value: null },
      { label: 'Imprimir', value: 'go', variant: 'primary', autofocus: true },
    ],
  });
  closed = true;
  mo.disconnect();
  clearTimeout(redoTimer);
  clearTimeout(busyTimer);
  io?.disconnect();
  drop(doc);

  const opts = { ...layout(), color: o.color, copies: o.copies, duplex: o.duplex, ranges, device: o.dest === 'pdf' ? '' : o.dest };
  if (v === 'system') { api.page.printSystem(t.id, opts); return; }
  if (v !== 'go' || !o.dest) return;
  if (S.settings?.printDest !== o.dest) api.settings.save({ printDest: o.dest }).catch(() => {});
  if (o.dest === 'pdf') await api.page.printSave(t.id, opts).catch(() => null);
  else await api.page.printRun(t.id, opts).catch(() => null);
}

