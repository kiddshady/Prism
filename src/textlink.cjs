'use strict';

/* ═══════════════════════════════════════════════════════════════════════════
   PRISM — el enlace a un texto (la lógica, sin Electron)
   «Copiar enlace al texto»: la dirección de la página más un fragmento
   `#:~:text=…` que hace que quien la abra caiga en ese párrafo, resaltado.
   Lo entiende Chromium (y Prism, que lo es): no hay nada que resolver del
   lado de quien abre.

   ── Qué se escribe en el fragmento ─────────────────────────────────────────
   text=[antes-,]inicio[,fin][,-después]
   · Un texto corto, en un solo bloque, va entero en `inicio`.
   · Uno largo, o que cruza de un párrafo a otro, no puede ir entero: `inicio`
     tiene que caber en un bloque. Va con sus primeras palabras y `fin` con las
     últimas, y Chromium resalta todo lo del medio.
   · Si lo mismo aparece más arriba en la página, el enlace caería en la
     primera vez: se suma lo que hay justo antes (y justo después) para decir
     cuál es.

   Las coincidencias son por palabra entera: por eso lo que se seleccionó a
   mitad de una palabra se estira hasta sus bordes (collect, del lado de la
   página). Y todo se compara sin mayúsculas, como lo hace Chromium.
   ═══════════════════════════════════════════════════════════════════════════ */

/** Cuánto puede medir un texto para ir entero en el enlace. */
const WHOLE_MAX = 300;
/** Cuántas palabras llevan el inicio y el fin de uno largo, y el contexto. */
const EDGE_WORDS = 5;
const CONTEXT_WORDS = 3;

const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const words = (s) => norm(s).split(' ').filter(Boolean);
const low = (s) => s.toLocaleLowerCase();

/** Cuántas veces aparece (hasta 2: alcanza para saber si es la única). */
function times(hay, needle) {
  if (!needle) return 0;
  let n = 0;
  for (let i = hay.indexOf(needle); i >= 0 && n < 2; i = hay.indexOf(needle, i + 1)) n++;
  return n;
}

/**
 * Los términos del fragmento para un texto elegido.
 * sel: { text, before, after, page }: el texto (con un salto de línea donde
 * cambia de bloque), lo que hay antes y después en su bloque, y el texto de
 * la página (para saber si se repite). Devuelve null si no hay nada que enlazar.
 */
function terms(sel = {}) {
  const lines = String(sel.text ?? '').split(/\n+/).map(norm).filter(Boolean);
  if (!lines.length) return null;
  const whole = lines.join(' ');
  const page = low(norm(sel.page));
  let start = whole;
  let end = '';
  if (lines.length > 1 || whole.length > WHOLE_MAX) {
    const first = words(lines[0]);
    const last = words(lines[lines.length - 1]);
    // En un solo bloque largo, el inicio y el fin no se pisan.
    const cap = lines.length > 1 ? EDGE_WORDS : Math.min(EDGE_WORDS, Math.floor(first.length / 2));
    start = first.slice(0, Math.max(1, cap)).join(' ');
    /* El fin es la primera vez que aparece DESPUÉS del inicio: si esas
       palabras ya están antes, adentro de lo elegido, el resaltado se
       cortaría ahí. Se le suman palabras hasta que sea el último. */
    const body = low(whole);
    const most = lines.length > 1 ? last.length : last.length - Math.max(1, cap);
    let n = Math.min(Math.max(1, cap), Math.max(1, most));
    end = last.slice(-n).join(' ');
    while (n < most && body.indexOf(low(end), start.length) !== body.length - end.length) end = last.slice(-(++n)).join(' ');
  }
  // Sin el texto de la página no se sabe si se repite: no se inventa contexto.
  const repeated = !!page && times(page, low(start)) > 1;
  const prefix = repeated ? words(sel.before).slice(-CONTEXT_WORDS).join(' ') : '';
  const suffix = repeated && !end ? words(sel.after).slice(0, CONTEXT_WORDS).join(' ') : '';
  return { prefix, start, end, suffix };
}

/* El guion separa el contexto y la coma los términos: adentro de un término
   van escapados (la coma y el & ya los escapa encodeURIComponent). */
const enc = (s) => encodeURIComponent(s).replace(/-/g, '%2D');

/** `text=…` para unos términos. */
function directive(t) {
  return `text=${t.prefix ? `${enc(t.prefix)}-,` : ''}${enc(t.start)}${t.end ? `,${enc(t.end)}` : ''}${t.suffix ? `,-${enc(t.suffix)}` : ''}`;
}

/** La dirección con el fragmento. Conserva el ancla que tuviera (#seccion) y
    reemplaza un enlace a texto anterior. null si la página no es enlazable. */
function linkFor(url, t) {
  if (!t?.start) return null;
  let u;
  try { u = new URL(String(url)); } catch { return null; }
  if (!/^(https?|file):$/.test(u.protocol)) return null;
  const anchor = u.hash.replace(/^#/, '').split(':~:')[0];
  u.hash = '';
  return `${u.href}#${anchor}:~:${directive(t)}`;
}

/* ── Del lado de la página ───────────────────────────────────────────────────
   Corre adentro de la página, en un mundo aislado (el código de la página no
   lo ve ni lo puede torcer): por eso es una función suelta, que no usa nada
   de afuera. Devuelve lo que necesita terms(), o null si no hay selección. */
/* eslint-disable no-undef */
function collect() {
  const sel = getSelection();
  if (!sel || !sel.rangeCount || sel.isCollapsed) return null;
  const r = sel.getRangeAt(0).cloneRange();
  const W = /[\p{L}\p{N}_]/u;
  // Las coincidencias son por palabra entera: se estira hasta los bordes.
  if (r.startContainer.nodeType === 3) {
    const d = r.startContainer.data;
    let i = r.startOffset;
    while (i > 0 && i < d.length && W.test(d[i]) && W.test(d[i - 1])) i--;
    r.setStart(r.startContainer, i);
  }
  if (r.endContainer.nodeType === 3) {
    const d = r.endContainer.data;
    let i = r.endOffset;
    while (i > 0 && i < d.length && W.test(d[i]) && W.test(d[i - 1])) i++;
    r.setEnd(r.endContainer, i);
  }
  const blockOf = (n) => {
    let e = n.nodeType === 1 ? n : n.parentElement;
    while (e && e !== document.body && getComputedStyle(e).display.startsWith('inline')) e = e.parentElement;
    return e || document.body;
  };
  const root = r.commonAncestorContainer.nodeType === 1 ? r.commonAncestorContainer : r.commonAncestorContainer.parentNode;
  const tw = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  let text = '';
  let last = null;
  for (let n = tw.nextNode(); n; n = tw.nextNode()) {
    if (!r.intersectsNode(n)) continue;
    if (n.nodeType === 1) { if (n.tagName === 'BR') text += '\n'; continue; }
    const pe = n.parentElement;
    // Lo que no se ve no se puede enlazar (Chromium no lo busca).
    if (!pe || !pe.checkVisibility({ visibilityProperty: true }) || /^(SCRIPT|STYLE|NOSCRIPT)$/.test(pe.tagName)) continue;
    const from = n === r.startContainer ? r.startOffset : 0;
    const to = n === r.endContainer ? r.endOffset : n.data.length;
    const b = blockOf(n);
    if (last && b !== last) text += '\n';
    text += n.data.slice(from, to);
    last = b;
  }
  const pre = document.createRange();
  pre.selectNodeContents(blockOf(r.startContainer));
  pre.setEnd(r.startContainer, r.startOffset);
  const post = document.createRange();
  post.selectNodeContents(blockOf(r.endContainer));
  post.setStart(r.endContainer, r.endOffset);
  return {
    text: text.slice(0, 20000),
    before: pre.toString().slice(-200),
    after: post.toString().slice(0, 200),
    page: (document.body ? document.body.innerText : '').slice(0, 400000),
  };
}
/* eslint-enable no-undef */

/** Lo que llegó de la página, saneado (viene de un proceso que no es de confianza). */
function clean(m) {
  if (!m || typeof m !== 'object' || typeof m.text !== 'string') return null;
  const s = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
  return { text: s(m.text, 20000), before: s(m.before, 200), after: s(m.after, 200), page: s(m.page, 400000) };
}

module.exports = { terms, directive, linkFor, collect, clean, WHOLE_MAX };
