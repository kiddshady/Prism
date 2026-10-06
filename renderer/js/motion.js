/* ═══════════════════════════════════════════════════════════════════════════
   OPAL — motion (runtime)
   La mitad JS del sistema de movimiento. Su trabajo más importante es el que
   más se olvida: que lo que se va del DOM TERMINE su animación de salida antes
   de irse. Sin esto los overlays parpadean al cerrarse y la app se siente rota.
   ═══════════════════════════════════════════════════════════════════════════ */

/** Dos frames: garantiza que el navegador ya aplicó los estilos iniciales. */
export function raf2(fn) {
  requestAnimationFrame(() => requestAnimationFrame(fn));
}

/**
 * Saca un elemento del DOM DESPUÉS de su animación de salida.
 * Marca data-state="closing" (el CSS engancha ahí) y espera al animationend,
 * con un timeout de red por si el elemento no tiene animación declarada.
 */
export function exit(el, { fallback = 400, onDone } = {}) {
  if (!el || el.dataset.state === 'closing') return Promise.resolve();
  el.dataset.state = 'closing';

  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      el.removeEventListener('animationend', onAnim);
      el.remove();
      onDone?.();
      resolve();
    };
    // Solo nos importa la animación del propio elemento, no la de sus hijos.
    const onAnim = (e) => { if (e.target === el) finish(); };
    el.addEventListener('animationend', onAnim);
    const timer = setTimeout(finish, fallback);
  });
}

/** Escalona los hijos de un contenedor seteando --i (el CSS lo usa de delay). */
export function stagger(container, selector = ':scope > *', step = 1) {
  container.querySelectorAll(selector).forEach((el, i) => {
    el.style.setProperty('--i', String(i * step));
  });
}

/* ── Click-flash ────────────────────────────────────────────────────────────
   Un velo de luz que nace con el press y decae. No viaja como un ripple de
   Material: solo confirma que el click llegó, y se limpia solo. */
export function initClickFlash(root = document) {
  root.addEventListener('pointerdown', (e) => {
    const target = e.target.closest?.('.op-flashable');
    if (!target || target.disabled) return;
    const flash = document.createElement('span');
    flash.className = 'op-flash';
    target.appendChild(flash);
    flash.addEventListener('animationend', () => flash.remove(), { once: true });
  });
}

/* ── Esfumado del scroll ────────────────────────────────────────────────────
   Apaga el fade del lado donde no hay nada recortado: pegado arriba no se
   esfuma arriba. Sin esto el primer item vive a media luz sin razón. */
export function scrollFade(el) {
  if (!el || el.__vcFade) return;
  el.__vcFade = true;

  const update = () => {
    const slack = el.scrollHeight - el.clientHeight;
    if (slack <= 1) {                       // no hay nada que recortar
      el.classList.add('is-top', 'is-bottom');
      return;
    }
    el.classList.toggle('is-top', el.scrollTop <= 1);
    el.classList.toggle('is-bottom', el.scrollTop >= slack - 1);
  };

  el.addEventListener('scroll', update, { passive: true });
  new ResizeObserver(update).observe(el);
  // El contenido puede cambiar de alto sin que cambie el del contenedor.
  new MutationObserver(update).observe(el, { childList: true, subtree: true });
  update();
}

/** Aplica scrollFade a todo .op-scroll que todavía no lo tenga. */
export function initScrollFades(root = document) {
  root.querySelectorAll('.op-scroll').forEach(scrollFade);
}

/* ── Indicadores que viajan ─────────────────────────────────────────────────
   La cápsula del segmentado y el subrayado de los tabs se DESLIZAN entre
   opciones. Que viajen en vez de saltar es lo que los hace sentir físicos. */

export function syncSegmented(seg) {
  const opts = [...seg.querySelectorAll('.op-segmented__opt')];
  if (!opts.length) return;
  const active = Math.max(0, opts.findIndex((o) => o.classList.contains('is-active')));
  const w = (seg.clientWidth - 4) / opts.length;
  seg.style.setProperty('--seg-w', `${w}px`);
  seg.style.setProperty('--seg', String(active));
}

export function syncTabs(tabs) {
  const active = tabs.querySelector('.op-tab.is-active');
  if (!active) return;
  tabs.style.setProperty('--tab-x', `${active.offsetLeft}px`);
  tabs.style.setProperty('--tab-w', `${active.offsetWidth}px`);
}

/**
 * Cablea un grupo (segmentado o tabs) para que se comporte solo.
 * onChange recibe el value del botón elegido.
 */
export function bindSwitcher(root, onChange) {
  const isSeg = root.classList.contains('op-segmented');
  const optSel = isSeg ? '.op-segmented__opt' : '.op-tab';
  const sync = () => (isSeg ? syncSegmented(root) : syncTabs(root));

  root.addEventListener('click', (e) => {
    const opt = e.target.closest(optSel);
    if (!opt || opt.classList.contains('is-active')) return;
    root.querySelectorAll(optSel).forEach((o) => o.classList.remove('is-active'));
    opt.classList.add('is-active');
    sync();
    onChange?.(opt.dataset.value, opt);
  });

  new ResizeObserver(sync).observe(root);
  /* El indicador NACE en su lugar: sin esto viaja desde la izquierda cada vez
     que se repinta el grupo (en Ajustes, cualquier ajuste cambiado repinta la
     página y los segmentados se animaban solos). Solo viaja al elegir. */
  root.dataset.placing = '';
  sync();
  raf2(() => {
    sync();   // las fuentes pueden cambiar el ancho después del primer layout
    getComputedStyle(root, isSeg ? '::before' : '::after').transform;   // asienta el lugar sin transición
    delete root.dataset.placing;
  });
  return sync;
}

/* ── Campo numérico ─────────────────────────────────────────────────────────
   El spinner de `<input type=number>` es de Chromium y está tapado en el CSS.
   Esto le devuelve las flechas, ya dibujadas por nosotros.

   El input NO se reemplaza: sigue siendo el dueño del valor, del foco y del
   teclado. Por eso cada paso despacha `input` Y `change` con bubbles — quien
   escuchaba al campo antes de tener flechas sigue funcionando sin tocar nada.

   Mantener apretado repite, y acelera: un campo de copias que llega a 50 de a
   un click por vez no lo usa nadie. */

const ESPERA = 380;    // antes de empezar a repetir: distingue click de aguante
const PASO_LENTO = 110;
const PASO_RAPIDO = 45;
const ACELERA_A = 1200;   // ms aguantando antes de pasar a rápido

/**
 * Cablea un `.op-stepper` (input + dos flechas).
 * onChange recibe el valor numérico ya acotado a min/max.
 */
export function bindStepper(root, onChange) {
  const input = root?.querySelector('input[type="number"]');
  if (!input) return () => {};

  const num = (attr, fallback) => {
    const v = parseFloat(input.getAttribute(attr));
    return Number.isFinite(v) ? v : fallback;
  };

  const leer = () => {
    const v = parseFloat(input.value);
    return Number.isFinite(v) ? v : num('min', 0);
  };

  /** Los topes se releen en cada paso: el max suele depender de otra cosa. */
  const acotar = (v) => Math.min(num('max', Infinity), Math.max(num('min', -Infinity), v));

  const sync = () => {
    const v = leer();
    const arriba = root.querySelector('[data-step="up"]');
    const abajo = root.querySelector('[data-step="down"]');
    if (arriba) arriba.disabled = v >= num('max', Infinity);
    if (abajo) abajo.disabled = v <= num('min', -Infinity);
  };

  function mover(dir) {
    const antes = leer();
    const v = acotar(antes + dir * num('step', 1));
    if (v === antes) { sync(); return false; }
    input.value = String(v);
    sync();
    // bubbles: los listeners suelen estar en el contenedor, no en el input.
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    onChange?.(v, input);
    return true;
  }

  let timer = null;
  const frenar = () => { clearTimeout(timer); timer = null; };

  function arrancar(dir, desde) {
    const transcurrido = Date.now() - desde;
    if (!mover(dir)) { frenar(); return; }
    timer = setTimeout(() => arrancar(dir, desde), transcurrido > ACELERA_A ? PASO_RAPIDO : PASO_LENTO);
  }

  root.addEventListener('pointerdown', (e) => {
    const btn = e.target.closest('[data-step]');
    if (!btn || btn.disabled) return;
    e.preventDefault();                 // que el campo no pierda el foco
    const dir = btn.dataset.step === 'up' ? 1 : -1;
    mover(dir);
    const desde = Date.now();
    timer = setTimeout(() => arrancar(dir, desde), ESPERA);
    /* La captura del puntero es lo que hace que soltar CUENTE aunque el dedo se
       haya ido del botón. Sin esto, arrastrar afuera deja el contador corriendo
       para siempre. */
    btn.setPointerCapture?.(e.pointerId);
  });

  for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) {
    root.addEventListener(ev, frenar);
  }

  input.addEventListener('input', sync);
  sync();
  return sync;
}

/* ── Revelado de alto (grid 0fr → 1fr) ───────────────────────────────────── */
export function toggleReveal(el, open) {
  const next = open ?? !el.classList.contains('is-open');
  el.classList.toggle('is-open', next);
  return next;
}

/* ── Números que cuentan ────────────────────────────────────────────────────
   Un contador que salta de 0 a 1284 no se lee; uno que corre, sí. */
export function countTo(el, to, { from = 0, duration = 700, format = (n) => n } = {}) {
  const start = performance.now();
  const ease = (t) => 1 - Math.pow(1 - t, 3);
  const tick = (now) => {
    const t = Math.min(1, (now - start) / duration);
    el.textContent = format(Math.round(from + (to - from) * ease(t)));
    if (t < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

/** Marca un valor que acaba de cambiar: destella y vuelve. */
export function tick(el) {
  el.classList.remove('op-ticked');
  void el.offsetWidth;          // reinicia la animación
  el.classList.add('op-ticked');
}

/* ── Lo que se anima desde JS ───────────────────────────────────────────────
   Los mismos tokens que tokens.css, para las animaciones de la Web Animations
   API (las listas y los tamaños, que no se pueden escribir en una hoja). */
let outMs = null;
const T = {
  in: 280, move: 280, size: 280, after: 80, step: 14,
  /* Las salidas son la misma perilla que en el CSS (--op-t-out): la fila que
     se va de una lista, el relevo chico, la pestaña que se cierra. Se lee la
     primera vez que hace falta, con las hojas ya cargadas. */
  get out() {
    if (outMs == null) {
      const v = getComputedStyle(document.documentElement).getPropertyValue('--op-t-out').trim();
      const n = parseFloat(v);
      outMs = Number.isFinite(n) ? (/ms$/.test(v) ? n : /s$/.test(v) ? n * 1000 : n) : 150;
    }
    return outMs;
  },
};
const EASE = 'cubic-bezier(.16, 1, .3, 1)';        // --op-ease
const EASE_BOTH = 'cubic-bezier(.65, 0, .35, 1)';  // --op-ease-both

/** Una animación hecha desde JS que, si la ventana no pinta, igual termina. */
function settled(anim, ms, fn) {
  let done = false;
  const go = () => { if (!done) { done = true; fn(); } };
  anim.finished.then(go, () => {});
  setTimeout(go, ms);
}

/* ── Números que corren ─────────────────────────────────────────────────────
   Como countTo(), pero arranca de lo que se ve AHORA: cada dato nuevo retoma
   la carrera desde donde iba en vez de volver a cero o saltar. Es lo que pide
   un porcentaje que llega de a pedazos (una descarga, una actualización).
   `to` es un número o un objeto de números; `paint` recibe el valor (o el
   objeto) de cada cuadro y escribe. La primera vez escribe sin correr. */
export function roll(el, to, paint, { duration = 420, from: start0 } = {}) {
  if (!el) return;
  const obj = typeof to === 'object' && to !== null;
  if (!el.__roll && Number.isFinite(start0)) el.__roll = { cur: start0, to: start0, raf: 0 };   // lo que ya dice el texto
  const st = el.__roll;
  if (!st) { el.__roll = { cur: to, to, raf: 0 }; paint(to); return; }
  if (JSON.stringify(st.to) === JSON.stringify(to)) return;
  cancelAnimationFrame(st.raf);
  st.to = to;
  const from = st.cur;
  const start = performance.now();
  const ease = (t) => 1 - Math.pow(1 - t, 3);
  const lerp = (a, b, k) => (Number.isFinite(a) ? a + (b - a) * k : b);
  const frame = (now) => {
    if (!el.isConnected) return;
    const k = ease(Math.min(1, (now - start) / duration));
    st.cur = obj
      ? Object.fromEntries(Object.keys(to).map((key) => [key, lerp(from?.[key], to[key], k)]))
      : lerp(from, to, k);
    paint(st.cur);
    if (k < 1) st.raf = requestAnimationFrame(frame);
  };
  st.raf = requestAnimationFrame(frame);
}

/* ── Tamaño que viaja ───────────────────────────────────────────────────────
   Un elemento que cambió de tamaño va del que tenía (`from`, medido antes del
   cambio) al de ahora, en vez de saltar. Se anima el tamaño y no un transform
   porque lo que está al lado tiene que acompañarlo; es breve y en cosas
   chicas. `ignore` son hijos que se están yendo: no cuentan para el destino.
   Para medir sin ellos se sacan del flujo un instante, sin esconderlos:
   apagar y prender `display` les reinicia las animaciones de CSS, y las filas
   que se iban de una lista (limpiar las descargas) volvían a correr su
   entrada: bajaban 8 px y subían mientras se esfumaban. */
export function glideSize(el, from, { ignore = [], width = true, height = true } = {}) {
  if (!el || !from) return;
  const pos = ignore.map((o) => o.style.position);
  ignore.forEach((o) => { o.style.position = 'absolute'; });
  const to = { w: el.offsetWidth, h: el.offsetHeight };
  ignore.forEach((o, i) => { o.style.position = pos[i]; });
  const dw = width && Math.abs(to.w - from.w) >= 1;
  const dh = height && Math.abs(to.h - from.h) >= 1;
  if (!dw && !dh) return;
  el.__glide?.cancel();
  const a = {}; const b = {};
  if (dw) { a.width = `${from.w}px`; b.width = `${to.w}px`; }
  if (dh) { a.height = `${from.h}px`; b.height = `${to.h}px`; }
  /* Si se ACHICA con algo yéndose adentro, primero se va lo de adentro y
     recién después se pliega la caja. Al revés, la caja cortaba lo que todavía
     se veía casi entero (ocultar una contraseña larga: el segundo renglón
     salía partido al medio a los 30 ms), y eso se lee como un deslizamiento.
     Para crecer no hace falta esperar: primero se abre, después entra. */
  const shrinks = ignore.length > 0 && ((dw && to.w < from.w) || (dh && to.h < from.h));
  // Mientras viaja, lo que todavía no entra no se desborda de la caja.
  el.__glide = el.animate([{ ...a, overflow: 'hidden' }, { ...b, overflow: 'hidden' }], shrinks
    ? { duration: T.size - 40, delay: T.out - 50, easing: EASE_BOTH, fill: 'backwards' }
    : { duration: T.size, easing: EASE });
}

/* ── Relevo de contenido ────────────────────────────────────────────────────
   Un valor que cambia EN SU LUGAR (un texto, un ícono, un número que no
   corre, lo tapado y lo visible de una contraseña): el viejo se va y el nuevo
   entra en la misma celda, esperando a que el viejo casi no se vea. Es el
   relevo de las páginas, en chico.
     dir   1 sube, -1 baja: un contador que avanza o retrocede.
     size  la caja va de su tamaño al nuevo en vez de saltar cuando el viejo
           termina de irse (un botón que cambia de rótulo).
   La primera vez adopta lo que el elemento ya tenía, sin animarlo. */
export function swap(el, html, { dir = 0, size = false } = {}) {
  if (!el) return null;
  let items = [...el.children].filter((c) => c.classList.contains('op-swap__item'));
  if (!items.length) {
    const first = document.createElement('span');
    first.className = 'op-swap__item is-settled';
    first.append(...el.childNodes);
    el.appendChild(first);
    el.__swap = first.innerHTML;
    items = [first];
  }
  el.classList.add('op-swap');
  if (html === el.__swap) return null;
  el.__swap = html;
  const live = items.filter((c) => c.dataset.state !== 'closing');
  const from = size ? { w: el.offsetWidth, h: el.offsetHeight } : null;
  const d = dir > 0 ? 'up' : dir < 0 ? 'down' : '';
  const next = document.createElement('span');
  next.className = 'op-swap__item';
  next.innerHTML = html;
  if (d) next.dataset.dir = d;
  live.forEach((o) => {
    if (d) o.dataset.dir = d; else delete o.dataset.dir;
    exit(o, { fallback: 220 });
  });
  // Si no había nada a la vista (un vacío), lo nuevo entra sin esperar.
  if (live.some((o) => o.textContent.trim() || o.querySelector('svg, img, [class]'))) next.classList.add('is-after');
  el.appendChild(next);
  setTimeout(() => next.classList.add('is-settled'), 420);
  if (from) glideSize(el, from, { ignore: live });
  return next;
}

/** El texto de un elemento, con relevo si cambió. */
export const swapText = (el, text, opts) => swap(el, esc(text), opts);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ── Listas que se ponen al día ─────────────────────────────────────────────
   Rehacer una lista con innerHTML la hace parpadear: lo que estaba se va de
   un cuadro al otro y lo nuevo aparece todo junto, aunque sea casi lo mismo
   (buscar, una descarga que avanza, filtrar). reconcile() la pone al día
   fila por fila, por clave:
   · las que siguen son el MISMO nodo, y viajan a su lugar nuevo (FLIP);
   · las que ya no están salen desde donde estaban, fuera del flujo;
   · las nuevas entran, y si había algo yéndose, esperan a que casi no se vea.

   items: [{ key, html, ...lo que quieras }]. Opciones:
     update(el, item)   pone al día una fila que sigue y cuyo html cambió
                        (sin esto se le copian los atributos, y si cambió el
                        contenido se releva con un parpadeo corto)
     created(el, item)  después de crear una fila o reemplazar su contenido
                        (cablear íconos, favicons)
     height             la caja va de su alto al nuevo (un desplegable)
     enter              false: las nuevas aparecen sin animar (no hay nada
                        que contar: la primera pintada de algo que ya entra) */
export function reconcile(box, items, { update, created, height = false, enter = true } = {}) {
  const was = new Map();
  const leaving = [];
  for (const el of box.children) {
    if (el.dataset.state === 'closing') continue;
    if (el.dataset.key != null && !was.has(el.dataset.key)) was.set(el.dataset.key, el);
    else leaving.push(el);    // lo que no tiene clave (un innerHTML de antes) también se va
  }
  const keep = new Set(items.map((it) => it.key));
  for (const [k, el] of was) if (!keep.has(k)) leaving.push(el);

  // Dónde estaba cada cosa: todas las lecturas antes de cualquier escritura.
  const box0 = box.getBoundingClientRect();
  const h0 = height ? box.offsetHeight : 0;
  const first = new Map();
  for (const el of box.children) if (el.dataset.state !== 'closing') first.set(el, el.getBoundingClientRect());
  for (const el of was.values()) { el.__move?.cancel(); el.__move = null; }

  /* El scroll, también antes: cada fila que sale del flujo achica el
     contenido, y leído adentro del bucle ya venía recortado. En una lista
     scrolleada (limpiar las descargas con 200 px bajados) las que se iban
     caían amontonadas unas sobre otras, más abajo de donde estaban.
     Si no sigue ninguna (la lista entera cambia por otra, o por el vacío),
     el scroll vuelve arriba ya, y las que se van quedan donde se veían: lo
     nuevo nace arriba, y con el scroll bajado entraba fuera de la vista y
     aparecía de golpe, casi entero, cuando las viejas se terminaban de ir. */
  const replaced = leaving.length > 0 && ![...was.keys()].some((k) => keep.has(k));
  const sx = replaced ? 0 : box.scrollLeft; const sy = replaced ? 0 : box.scrollTop;
  if (leaving.length && getComputedStyle(box).position === 'static') box.style.position = 'relative';
  for (const el of leaving) {
    const r = first.get(el);
    Object.assign(el.style, {
      position: 'absolute', margin: '0', boxSizing: 'border-box', pointerEvents: 'none', zIndex: '0',
      top: `${r.top - box0.top - box.clientTop + sy}px`,
      left: `${r.left - box0.left - box.clientLeft + sx}px`,
      width: `${r.width}px`, height: `${r.height}px`,
    });
    el.dataset.state = 'closing';
    const op = Number(getComputedStyle(el).opacity) || 0;
    const anim = el.animate([{ opacity: op }, { opacity: 0 }], { duration: T.out, easing: EASE_BOTH, fill: 'forwards' });
    settled(anim, T.out + 200, () => el.remove());
  }
  if (replaced) { box.scrollTop = 0; box.scrollLeft = 0; }

  const fresh = [];
  let prev = null;
  for (const it of items) {
    let el = was.get(it.key);
    if (!el) {
      el = make(it);
      fresh.push(el);
    } else if (el.__html !== it.html) {
      if (update) update(el, it); else morph(el, it, created);
      el.__html = it.html;
    }
    // A su lugar, salteando lo que se está yendo (no cuenta para el orden).
    let want = prev ? prev.nextElementSibling : box.firstElementChild;
    while (want && want !== el && want.dataset.state === 'closing') want = want.nextElementSibling;
    if (want !== el) {
      box.insertBefore(el, want);
      if (!fresh.includes(el)) quiet(el);   // moverlo le reinicia las animaciones de CSS
    }
    prev = el;
  }
  for (const el of fresh) { quiet(el); created?.(el, el.__item); }

  // Las que siguen viajan de donde estaban a donde quedaron.
  const vh = window.innerHeight;
  for (const el of was.values()) {
    if (!keep.has(el.dataset.key)) continue;
    const a = first.get(el);
    const b = el.getBoundingClientRect();
    const dx = a.left - b.left;
    const dy = a.top - b.top;
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue;
    if ((a.bottom < 0 && b.bottom < 0) || (a.top > vh && b.top > vh)) continue;   // afuera: nadie lo ve
    el.__move = el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], { duration: T.move, easing: EASE });
  }

  if (enter) {
    const wait = leaving.length ? T.after : 0;
    fresh.forEach((el, i) => {
      el.animate([{ opacity: 0, transform: 'translateY(4px)' }, { opacity: 1, transform: 'none' }],
        { duration: T.in, easing: EASE, delay: wait + Math.min(i, 16) * T.step, fill: 'backwards' });
    });
  }

  if (height) glideSize(box, { w: box.offsetWidth, h: h0 }, { width: false, ignore: leaving });
  return { fresh, leaving };
}

function make(it) {
  const t = document.createElement('template');
  t.innerHTML = it.html.trim();
  const el = t.content.firstElementChild;
  el.dataset.key = it.key;
  el.__html = it.html;
  el.__inner = el.innerHTML;
  el.__item = it;
  return el;
}

/* Sin la entrada propia de la fila (la que tiene en su CSS para cuando la
   lista se pinta entera): de entrar se encarga reconcile(). Cancelada por la
   API, una animación de CSS no vuelve hasta que cambie su nombre, así que la
   salida de [data-state=closing] (exit()) sigue funcionando. */
function quiet(el) {
  for (const a of el.getAnimations()) if (a instanceof CSSAnimation && a.effect?.getTiming().iterations !== Infinity) a.cancel();
}

/* Una fila que sigue pero cambió: los atributos se copian (las clases nuevas
   corren con sus transiciones de color), y el contenido, si cambió, se releva
   con un parpadeo corto en vez de cambiar de un cuadro al otro. */
function morph(el, it, created) {
  const t = document.createElement('template');
  t.innerHTML = it.html.trim();
  const nu = t.content.firstElementChild;
  for (const { name } of [...el.attributes]) if (name !== 'data-key' && name !== 'data-state' && !nu.hasAttribute(name)) el.removeAttribute(name);
  for (const { name, value } of [...nu.attributes]) if (el.getAttribute(name) !== value) el.setAttribute(name, value);
  el.__item = it;
  if (nu.innerHTML === el.__inner) return;
  el.__inner = nu.innerHTML;
  el.__next = nu;
  if (el.__blink) return;               // ya hay uno en curso: usa lo último que llegue
  el.__blink = el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 90, easing: EASE_BOTH, fill: 'forwards' });
  settled(el.__blink, 200, () => {
    const latest = el.__next;
    el.__next = null;
    el.replaceChildren(...latest.childNodes);
    created?.(el, el.__item);
    el.__blink.cancel();
    el.__blink = null;
    el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: T.in - 100, easing: EASE });
  });
}

/* ── Plegar y desplegar ─────────────────────────────────────────────────────
   Una fila que se va de una columna se esfuma Y se pliega: así las de abajo
   suben acompañándola en vez de saltar cuando sale del DOM. expand() es lo
   mismo al revés, para una que llega. */
export function collapse(el, { duration = 200 } = {}) {
  if (!el || el.dataset.state === 'closing' || !el.isConnected) { el?.remove(); return Promise.resolve(); }
  el.dataset.state = 'closing';
  const cs = getComputedStyle(el);
  el.style.overflow = 'hidden';
  el.style.pointerEvents = 'none';
  const anim = el.animate([
    { opacity: cs.opacity, height: `${el.offsetHeight}px`, paddingTop: cs.paddingTop, paddingBottom: cs.paddingBottom, marginTop: cs.marginTop, marginBottom: cs.marginBottom },
    { opacity: 0, height: '0px', paddingTop: '0px', paddingBottom: '0px', marginTop: '0px', marginBottom: '0px' },
  ], { duration, easing: EASE_BOTH, fill: 'forwards' });
  return new Promise((resolve) => settled(anim, duration + 200, () => { el.remove(); resolve(); }));
}

export function expand(el, { duration = T.in } = {}) {
  if (!el?.isConnected) return;
  const cs = getComputedStyle(el);
  el.animate([
    { opacity: 0, height: '0px', paddingTop: '0px', paddingBottom: '0px', overflow: 'hidden' },
    { opacity: 1, height: `${el.offsetHeight}px`, paddingTop: cs.paddingTop, paddingBottom: cs.paddingBottom, overflow: 'hidden' },
  ], { duration, easing: EASE });
}

/** Un nodo que reemplaza a otro en una fila (un ícono): el viejo se apaga, el nuevo se enciende. */
export function replaceSoft(old, node, { out = 90 } = {}) {
  if (!old?.isConnected || !old.getClientRects().length) {
    old?.replaceWith(node);
    node.animate?.([{ opacity: 0 }, { opacity: 1 }], { duration: T.in - 100, easing: EASE });
    return;
  }
  const a = old.animate([{ opacity: 1 }, { opacity: 0 }], { duration: out, easing: EASE_BOTH, fill: 'forwards' });
  settled(a, out + 150, () => {
    if (!old.isConnected) return;
    old.replaceWith(node);
    node.animate?.([{ opacity: 0 }, { opacity: 1 }], { duration: T.in - 100, easing: EASE });
  });
}

/* ── Fundido ────────────────────────────────────────────────────────────────
   Para una superficie entera que cambia por otra (un panel): lo nuevo ya está
   quieto debajo y lo viejo, opaco y ENCIMA, se esfuma. Así la pantalla está
   tapada todo el tiempo: el relevo con espera destapaba el fondo en el medio.
   El calco lleva la clase op-dissolving (su CSS le pone el fondo opaco y lo
   sube); el contenedor tiene que apilarlos en la misma celda. */
export function dissolve(old, { fallback = 260 } = {}) {
  if (!old || old.dataset.state === 'closing') return Promise.resolve();
  old.inert = true;
  old.removeAttribute('id');
  for (const el of old.querySelectorAll('[id]')) el.removeAttribute('id');
  old.classList.add('op-dissolving');
  // Lo que tenía entrada propia la da por terminada: no vuelve a entrar adentro del calco.
  for (const a of old.getAnimations({ subtree: true })) {
    if (a.effect?.getTiming().iterations !== Infinity) a.finish();
  }
  return exit(old, { fallback });
}
