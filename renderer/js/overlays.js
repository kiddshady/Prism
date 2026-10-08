/* ═══════════════════════════════════════════════════════════════════════════
   OPAL — overlays
   Tooltip, toast, menú y modal. Todos se portalean a #op-layer, todos entran y
   SALEN animados, y ninguno usa un primitivo del sistema: acá no hay title=
   amarillo ni confirm() de Chromium.
   ═══════════════════════════════════════════════════════════════════════════ */

import { Icons } from './icons.js';
import { exit, scrollFade, collapse } from './motion.js';

const GAP = 8;      // separación entre el overlay y su ancla
const EDGE = 10;    // margen mínimo contra el borde de la ventana

function layer() {
  let el = document.getElementById('op-layer');
  if (!el) {
    el = document.createElement('div');
    el.id = 'op-layer';
    document.body.appendChild(el);
  }
  return el;
}

/** Mantiene un rectángulo dentro de la ventana. */
function clamp(x, y, w, h) {
  return [
    Math.min(Math.max(EDGE, x), window.innerWidth - w - EDGE),
    Math.min(Math.max(EDGE, y), window.innerHeight - h - EDGE),
  ];
}

/* ══ Tooltip ═════════════════════════════════════════════════════════════════
   Declarativo: data-tip="texto" y opcionalmente data-tip-side / data-tip-key.
   Reemplaza al title= nativo, que es amarillo, lento y no se puede estilar. */

const Tooltip = (() => {
  let current = null;
  let anchor = null;
  let timer = null;
  let left = -Infinity;  // cuándo se fue el último por salir de su ancla
  let watch = null;      // vigila que el ancla siga en el DOM mientras se ve
  let byKey = false;     // el que espera llegó con el teclado

  /** `keep`: el que espera para aparecer sigue esperando (ver el scroll). */
  function hide(immediate = false, { keep = false } = {}) {
    if (!keep) clearTimeout(timer);
    clearInterval(watch);
    if (!current) return;
    const el = current;
    current = null;
    anchor = null;
    /* Hasta el "ya" (un click, un scroll) se va con su salida corta: quitado
       de un cuadro al otro, era lo único que desaparecía de golpe. Solo el
       que se va por salir de su ancla calienta la espera del siguiente. */
    if (!immediate) left = performance.now();
    exit(el, { fallback: 160 });
  }

  function show(el) {
    hide(true);
    anchor = el;

    const tip = document.createElement('div');
    tip.className = 'op-tooltip';
    tip.textContent = el.dataset.tip;
    if (el.dataset.tipKey) {
      const k = document.createElement('span');
      k.className = 'op-tooltip__key';
      k.textContent = el.dataset.tipKey;
      tip.appendChild(k);
    }
    layer().appendChild(tip);
    current = tip;
    /* Si el ancla se va del DOM mientras se ve (una lista que se repinta), el
       navegador no manda pointerout, y el tooltip quedaba clavado. El mouse
       puede no moverse más: se mira cada tanto. */
    watch = setInterval(() => { if (!anchor?.isConnected) hide(true); }, 250);

    const a = el.getBoundingClientRect();
    let [x, y, t] = place(tip, a, el.dataset.tipSide || 'top');

    /* La pared: lo que hay debajo de ella es una vista nativa que tapa al DOM
       (la página, en Prism). Un tooltip de más arriba que la cruzaría queda en
       una sola línea con puntos suspensivos, en vez de meterse abajo. */
    const w = wall?.();
    if (w != null && a.bottom <= w && y + t.height > w) {
      tip.classList.add('op-tooltip--line');
      [x, y, t] = place(tip, a, el.dataset.tipSide || 'top');
    }

    tip.style.left = `${Math.round(x)}px`;
    tip.style.top = `${Math.round(y)}px`;
  }

  function place(tip, a, side) {
    /* El tamaño de layout, no el del rectángulo: la entrada ya arrancó y la
       escala lo achica, y quedaba unos 2,5 px descentrado de su ancla. */
    const t = { width: tip.offsetWidth, height: tip.offsetHeight };
    let x, y;
    if (side === 'bottom')      { x = a.left + a.width / 2 - t.width / 2; y = a.bottom + GAP; }
    else if (side === 'left')   { x = a.left - t.width - GAP;             y = a.top + a.height / 2 - t.height / 2; }
    else if (side === 'right')  { x = a.right + GAP;                      y = a.top + a.height / 2 - t.height / 2; }
    else                        { x = a.left + a.width / 2 - t.width / 2; y = a.top - t.height - GAP; }

    // Si arriba no entra, se da vuelta abajo (y viceversa).
    if (side === 'top' && y < EDGE) y = a.bottom + GAP;
    if (side === 'bottom' && y + t.height > window.innerHeight - EDGE) y = a.top - t.height - GAP;

    return [...clamp(x, y, t.width, t.height), t];
  }

  let wall = null;

  /* Un botón de solo ícono con data-tip y sin aria-label es, para un lector de
     pantalla, «botón» a secas: el texto del tooltip pasa a ser su nombre. Lo
     que la app nombró por su cuenta no se toca. */
  const named = new WeakSet();
  function label(root) {
    const els = root.querySelectorAll ? [...root.querySelectorAll('[data-tip]')] : [];
    if (root.matches?.('[data-tip]')) els.push(root);
    for (const el of els) {
      if (el.textContent.trim()) continue;
      if (el.hasAttribute('aria-label') && !named.has(el)) continue;
      el.setAttribute('aria-label', el.dataset.tip);
      named.add(el);
    }
  }

  /** `opts.wall()` → la Y desde la que el DOM queda tapado (o null). */
  function init(root = document, opts = {}) {
    wall = opts.wall || null;
    label(document.body);
    new MutationObserver((muts) => {
      for (const m of muts) {
        if (m.type === 'attributes') label(m.target);
        else m.addedNodes.forEach((n) => { if (n.nodeType === 1) label(n); });
      }
    }).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-tip'] });

    /* Con el teclado también: el que llega con Tab a un botón de ícono tiene
       que poder saber qué hace. Solo con :focus-visible; el foco que deja un
       click no lo muestra. */
    root.addEventListener('focusin', (e) => {
      const el = e.target.closest?.('[data-tip]');
      if (!el || el === anchor || !el.matches(':focus-visible')) return;
      clearTimeout(timer);
      const warm = current || performance.now() - left < 400;
      byKey = true;
      timer = setTimeout(() => { if (el.isConnected && el.matches(':focus')) show(el); }, warm ? 110 : 420);
    });
    root.addEventListener('focusout', (e) => {
      const el = e.target.closest?.('[data-tip]');
      if (el && el === anchor) hide();
      else if (el) clearTimeout(timer);
    });
    // Escape lo descarta sin mover el foco (y sigue de largo: no es suyo).
    root.addEventListener('keydown', (e) => { if (e.key === 'Escape' && current) hide(true); });

    root.addEventListener('pointerover', (e) => {
      // El ancla se fue del DOM: el pointerout no llega nunca.
      if (current && anchor && !anchor.isConnected) hide(true);
      const el = e.target.closest?.('[data-tip]');
      if (!el || el === anchor) return;
      clearTimeout(timer);
      /* Moverse entre botones vecinos no reinicia la espera larga. No alcanza con
         mirar `current`: el pointerout del botón anterior llega ANTES que este
         pointerover y ya lo cerró. Por eso cuenta también el que se acaba de ir.
         La espera corta (110 ms) es lo que dura su salida: el nuevo aparece
         cuando el viejo terminó de irse, sin encimarse. Si el ancla se fue del
         DOM durante la espera, no hay dónde anclarlo: saldría en la esquina. */
      const warm = current || performance.now() - left < 400;
      byKey = false;
      timer = setTimeout(() => { if (el.isConnected) show(el); }, warm ? 110 : 420);
    });
    root.addEventListener('pointerout', (e) => {
      const el = e.target.closest?.('[data-tip]');
      if (el && el === anchor) hide();
      else if (el) clearTimeout(timer);
    });
    // Un tooltip flotando sobre un click o un scroll es basura visual.
    root.addEventListener('pointerdown', () => hide(true));
    /* El scroll se lleva al que se ve (su lugar ya no es ese). Al que espera
       por el teclado no: llegar con Tab a un botón fuera de la vista lo
       acerca con un scroll, y eso cancelaba justo el tooltip que se pedía. */
    window.addEventListener('scroll', () => hide(true, { keep: byKey }), true);
    window.addEventListener('blur', () => hide(true));
  }

  return { init, hide };
})();

/* ══ Toasts ══════════════════════════════════════════════════════════════════ */

const Toast = (() => {
  let host = null;

  /* UNO A LA VEZ: los avisos no se apilan. Uno que llega con otro a la vista:
     · si dice lo MISMO (título, texto y tono), no se dispara: el que está
       vuelve a empezar su cuenta y su barra. Pasaba en Nexus al tocar dos
       veces «Buscar ahora»: dos «Estás al día» encimados;
     · si dice otra cosa, lo RELEVA: el viejo sale y el nuevo entra en su lugar
       cuando el viejo ya va por la mitad de su salida (no se descarta: podría
       ser un error que hay que ver). */
  let actual = null;   // { el, clave, close, renovar }
  const RELEVO = 120;  // ms: el nuevo espera a que el viejo vaya por la mitad

  function ensure() {
    if (host && host.isConnected) return host;
    host = document.createElement('div');
    host.className = 'op-toasts';
    layer().appendChild(host);
    return host;
  }

  /**
   * Toast.show({ title, text, tone: 'default'|'error', duration, icon })
   * duration:0 → se queda hasta que lo cierren.
   * Devuelve { close }. Con uno igual a la vista, devuelve el de ese.
   */
  function show({ title, text = '', tone = 'default', duration = 4200, icon } = {}) {
    const clave = `${tone}
${title}
${text}`;
    let relevo = false;
    if (actual && actual.el.dataset.state !== 'closing') {
      if (actual.clave === clave) { actual.renovar(); return { close: actual.close }; }
      actual.close();
      relevo = true;
    }

    const el = document.createElement('div');
    el.className = `op-toast${tone === 'error' ? ' op-toast--error' : ''}`;
    el.style.setProperty('--life', `${duration}ms`);

    const glyph = icon || (tone === 'error' ? 'alert' : 'info');
    el.innerHTML = `
      ${Icons.svg(glyph, 'op-icon--sm')}
      <div class="op-toast__main">
        <div class="op-toast__title"></div>
        ${text ? '<div class="op-toast__text"></div>' : ''}
      </div>
      <button class="op-iconbtn op-iconbtn--sm" data-close aria-label="Cerrar">${Icons.svg('close')}</button>
      ${duration ? '<span class="op-toast__life"></span>' : ''}`;

    // textContent, no innerHTML: el contenido puede venir de un error real.
    el.querySelector('.op-toast__title').textContent = title;
    if (text) el.querySelector('.op-toast__text').textContent = text;

    let timer = 0;
    /* Sale deslizándose y después se pliega: lo de alrededor acompaña en vez
       de saltar cuando el que se fue sale del DOM. */
    const close = () => {
      if (el.dataset.state === 'closing') return;
      el.dataset.state = 'closing';
      clearTimeout(timer);
      if (actual?.el === el) actual = null;
      if (!el.isConnected) return;          // lo cerraron antes de entrar (relevo)
      let folded = false;
      const fold = () => {
        if (folded) return;
        folded = true;
        el.removeAttribute('data-state');   // collapse() la marca de nuevo
        el.style.opacity = '0';
        el.style.animation = 'none';        // ya terminó de salir: que no vuelva a entrar
        collapse(el, { duration: 180 });
      };
      el.addEventListener('animationend', (e) => { if (e.target === el) fold(); });
      setTimeout(fold, 260);
    };
    el.querySelector('[data-close]').addEventListener('click', close);

    /* Hover pausa la cuenta: si te acercás a leerlo, no se te escapa. Lo que
       queda se lleva a mano, descontando lo que corrió. Antes se leía de la
       escala de la barra y la cuenta estaba al revés: tocado apenas aparecía,
       se cerraba enseguida con la barra casi llena; tocado al final, se
       quedaba casi toda la duración con la barra ya vacía. */
    let left = duration;
    let since = 0;
    let encima = false;
    const life = el.querySelector('.op-toast__life');
    const correr = (ms) => { since = performance.now(); timer = setTimeout(close, ms); };
    if (duration) {
      el.addEventListener('pointerenter', () => {
        encima = true;
        clearTimeout(timer);
        left -= performance.now() - since;
        if (life) life.style.animationPlayState = 'paused';
      });
      el.addEventListener('pointerleave', () => {
        encima = false;
        if (life) life.style.animationPlayState = 'running';
        // Un respiro mínimo para soltarlo, aunque ya casi no le quedara.
        correr(Math.max(900, left));
      });
    }

    /* El mismo aviso otra vez: la cuenta vuelve a empezar y la barra se
       rellena (eso es lo que se ve: el pedido llegó). */
    const renovar = () => {
      if (!duration) return;
      clearTimeout(timer);
      left = duration;
      if (life) {
        life.style.animation = 'none';
        void life.offsetWidth;
        life.style.animation = '';
        if (encima) life.style.animationPlayState = 'paused';
      }
      if (!encima) correr(left);
    };

    actual = { el, clave, close, renovar };
    const montar = () => {
      if (el.dataset.state === 'closing') return;
      ensure().appendChild(el);
      if (duration) correr(left);
    };
    if (relevo) setTimeout(montar, RELEVO);
    else montar();

    return { close };
  }

  return { show, error: (title, text) => show({ title, text, tone: 'error', duration: 7000 }) };
})();

/* ══ Menú ════════════════════════════════════════════════════════════════════
   items: { label, icon, key, danger, selected, onSelect } | { sep:true } | { groupLabel } */

const Menu = (() => {
  let open = null;

  function close(immediate = false) {
    if (!open) return;
    const { el, anchor, onClose } = open;
    open = null;
    anchor?.classList.remove('is-open');
    onClose?.();
    // También cuando lo reemplaza otro overlay: se va con su salida, no de golpe.
    exit(el, { fallback: 200 });
    document.removeEventListener('keydown', onKey, true);
  }

  function move(dir) {
    if (!open) return;
    const items = [...open.el.querySelectorAll('.op-menuitem:not(:disabled)')];
    if (!items.length) return;
    const i = items.findIndex((it) => it.classList.contains('is-active'));
    const next = items[(i + dir + items.length) % items.length] || items[0];
    items.forEach((it) => it.classList.remove('is-active'));
    next.classList.add('is-active');
    next.scrollIntoView({ block: 'nearest' });
  }

  function onKey(e) {
    if (!open) return;
    /* Las teclas que usa el menú no siguen de largo: con el menú de un campo
       (menus.js) el foco sigue en el campo, y Enter también lo haría ir. */
    if (e.key === 'Escape')          { e.stopPropagation(); close(); }
    else if (e.key === 'ArrowDown')  { e.preventDefault(); e.stopPropagation(); move(1); }
    else if (e.key === 'ArrowUp')    { e.preventDefault(); e.stopPropagation(); move(-1); }
    else if (e.key === 'Enter')      { e.preventDefault(); e.stopPropagation(); open.el.querySelector('.op-menuitem.is-active')?.click(); }
  }

  function show(anchorEl, items, { align = 'start', onClose } = {}) {
    /* Volver a pedir el menú del MISMO ancla es cerrarlo.
       Sin esto el toggle no funciona y parece que el menú "rebota": el
       manejador de click-afuera deja pasar al ancla a propósito (si no, cerrar
       y reabrir competirían), así que el click llega al handler del botón, que
       llama a show() otra vez → cierra y reabre dentro del mismo gesto. */
    if (open && open.anchor === anchorEl) {
      close();
      return null;
    }
    close(true);

    const el = document.createElement('div');
    el.className = 'op-menu op-scroll';
    el.setAttribute('role', 'menu');

    items.forEach((it) => {
      if (it.sep) {
        el.insertAdjacentHTML('beforeend', '<div class="op-menu__sep"></div>');
        return;
      }
      if (it.groupLabel) {
        const l = document.createElement('div');
        l.className = 'op-menu__label';
        l.textContent = it.groupLabel;
        el.appendChild(l);
        return;
      }
      const b = document.createElement('button');
      b.className = `op-menuitem${it.danger ? ' op-menuitem--danger' : ''}${it.selected ? ' is-selected' : ''}`;
      b.setAttribute('role', 'menuitem');
      if (it.disabled) b.disabled = true;
      b.innerHTML = `
        ${it.icon ? Icons.svg(it.icon) : '<span style="width:14px"></span>'}
        <span class="op-truncate"></span>
        ${it.key ? `<span class="op-menuitem__key">${it.key}</span>` : ''}
        ${it.selected ? Icons.svg('check', 'op-icon--sm') : ''}`;
      b.querySelector('span.op-truncate').textContent = it.label;
      // Un menú no se lleva el foco (como uno nativo): el campo del click
      // derecho conserva su selección, y cortar o pegar caen sobre ella.
      b.addEventListener('mousedown', (e) => e.preventDefault());
      b.addEventListener('click', () => { close(); it.onSelect?.(it); });
      el.appendChild(b);
      // Un ítem vivo (un porcentaje que avanza mientras el menú está abierto).
      it.mount?.(b);
    });

    layer().appendChild(el);
    scrollFade(el);
    anchorEl.classList.add('is-open');

    const a = anchorEl.getBoundingClientRect();
    /* El tamaño de layout, no el del rectángulo: la entrada ya arrancó y la
       escala lo achica, y el menú se ubicaba como si fuera más chico (quedaba
       pegado al borde de la ventana). */
    const m = { width: el.offsetWidth, height: el.offsetHeight };
    /* Abre abajo del ancla; si abajo no entra y arriba hay más lugar, arriba
       (y la animación nace de ese lado). El alto es el lugar que hay de ese
       lado, no un tope fijo: con un 60 % de la ventana, el menú principal
       escondía "Salir de Prism" en la ventana de fábrica, y nada avisaba que
       había más. Si igual no entra, se desplaza, con la barrita a la vista
       mientras quede algo escondido (overlays.css). */
    const below = window.innerHeight - (a.bottom + 6) - EDGE;
    const above = a.top - 6 - EDGE;
    const flipUp = m.height > below && above > below;
    const room = Math.max(80, flipUp ? above : below);
    const h = Math.min(m.height, room);
    if (m.height > room) el.style.maxHeight = `${Math.floor(room)}px`;
    // Desplazándose aparece la barrita, que lo ensancha: el ancho se mide después.
    const w = m.height > room ? el.offsetWidth : m.width;
    let x = align === 'end' ? a.right - w : a.left;
    let y = flipUp ? a.top - h - 6 : a.bottom + 6;
    el.style.setProperty('--origin', `${flipUp ? 'bottom' : 'top'} ${align === 'end' ? 'right' : 'left'}`);

    [x, y] = clamp(x, y, w, h);
    el.style.left = `${Math.round(x)}px`;
    el.style.top = `${Math.round(y)}px`;
    el.style.minWidth = `${Math.max(w, a.width)}px`;

    open = { el, anchor: anchorEl, onClose };
    document.addEventListener('keydown', onKey, true);
    /* Cierre por click afuera. El setTimeout evita que el mismo gesto que abrió
       el menú lo cierre. Se consulta `open.anchor` y no la variable capturada:
       si se abrió otro menú mientras este escuchador seguía armado, mirar el
       ancla vieja cerraría el menú nuevo apenas tocás su propio botón. */
    setTimeout(() => {
      document.addEventListener('pointerdown', function once(ev) {
        if (!open) return;                       // ya se cerró por otra vía
        if (open.el.contains(ev.target) || open.anchor.contains(ev.target)) {
          document.addEventListener('pointerdown', once, { once: true });
          return;
        }
        close();
      }, { once: true });
    }, 0);

    return { close };
  }

  return { show, close, get isOpen() { return !!open; } };
})();

/* ══ Modal ═══════════════════════════════════════════════════════════════════ */

/** Los campos de una línea: los que se confirman con Enter. */
const TEXT_FIELDS = ['text', 'search', 'url', 'email', 'tel', 'password', 'number']
  .map((t) => `input[type="${t}"]:not([disabled])`).join(', ') + ', input:not([type]):not([disabled])';

const Modal = (() => {
  let open = null;
  /* Los que pidieron turno con otro abierto. El nuevo pisaba al de abajo, que
     quedaba con su velo tapando todo y sin forma de cerrarse (sus botones y
     Escape llamaban a un close() que ya no lo conocía), y su promesa no se
     resolvía nunca. Ahora espera: al cerrarse el actual, hereda su velo. */
  const waiting = [];

  function close(result) {
    if (!open) return;
    const { scrim, anim, req, restore } = open;
    open = null;
    document.removeEventListener('keydown', onKey, true);
    const next = waiting.shift();
    // Con alguien esperando, la salida va pareja: el que entra asoma mientras se va.
    if (next) anim.classList.add('is-relayed');
    exit(anim, { fallback: 300 });
    if (next) mount(next, { scrim, restore });
    else { exit(scrim, { fallback: 300 }); restore?.focus?.(); }
    req.resolve(result);
  }

  function onKey(e) {
    if (!open) return;
    if (e.key === 'Escape') {
      /* Si hay un menú abierto encima, el Escape es suyo. Los dos escuchan en
         `document` y en captura, así que gana el que se registró primero — y
         ese es el modal, que abrió antes. Sin esta guarda, desplegar un select
         adentro del diálogo y arrepentirse cerraba el diálogo entero y se
         llevaba todo lo tipeado. El que ya está saliendo no cuenta: sigue en
         el DOM hasta que termine su animación. */
      if (document.querySelector('.op-menu:not([data-state="closing"])')) return;
      e.preventDefault(); e.stopPropagation(); close(null);
    }
    /* Enter en un campo de una línea confirma, como en un formulario: no hay
       <form>, y había que ir con el mouse hasta el botón. Solo la acción
       primaria, nunca la destructiva; no en un textarea (Enter es un renglón
       nuevo), no con un menú abierto encima (el Enter es suyo), no mientras
       se arma, y no a mitad de una composición del teclado. */
    if (e.key === 'Enter' && !e.isComposing && open.primary && e.target.matches?.(TEXT_FIELDS)
        && open.anim.contains(e.target) && !open.anim.classList.contains('is-arming')
        && !document.querySelector('.op-menu:not([data-state="closing"])')) {
      e.preventDefault(); e.stopPropagation(); open.primary.click();
      return;
    }
    if (e.key !== 'Tab') return;
    // Trampa de foco: el tabulador no se escapa del modal.
    const f = [...open.anim.querySelectorAll('button,input,textarea,select,[tabindex]:not([tabindex="-1"])')]
      .filter((el) => !el.disabled && el.offsetParent !== null);
    if (!f.length) return;
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }

  /**
   * Modal.show({ title, sub, body, actions, width, dismissible, signal, arm })
   * actions: [{ label, value, variant, autofocus, guard }]  → resuelve con `value`.
   * `guard` (puede ser asíncrona): si no devuelve true, el diálogo se queda
   * abierto con lo tipeado. Es para validar un formulario o guardar antes de
   * cerrar; mientras corre, el botón no toma otro click.
   * body puede ser string HTML o un Node.
   * Con otro abierto, espera su turno. `signal` (de un AbortController) lo
   * retira: si todavía espera, sale de la fila sin verse; si ya se ve, se
   * cierra con null. Cierra ESE modal, no el que esté a la vista.
   * `arm` (ms): para lo que se abre solo, sin que la persona lo pida (un
   * sitio que pide un permiso). Durante ese rato sus botones no toman
   * clicks, y el foco arranca en el diálogo, no en un botón: un segundo
   * click o un Enter que venía para otra cosa no contesta por la persona.
   */
  function show(opts = {}) {
    return new Promise((resolve) => {
      const req = { opts, resolve };
      const { signal } = opts;
      if (signal?.aborted) { resolve(null); return; }
      signal?.addEventListener('abort', () => {
        const i = waiting.indexOf(req);
        if (i >= 0) { waiting.splice(i, 1); resolve(null); }
        else if (open?.req === req) close(null);
      }, { once: true });
      if (open) waiting.push(req);
      else mount(req);
    });
  }

  /** Lo arma y lo muestra. `inherited`: el velo y el foco del que se acaba de ir. */
  function mount(req, inherited = null) {
    const { title, sub = '', body = '', actions = [], width, dismissible = true, arm = 0 } = req.opts;
    let scrim = inherited?.scrim;
    if (!scrim) {
      scrim = document.createElement('div');
      scrim.className = 'op-scrim';
      // Un solo oyente por velo, aunque pase de un modal al siguiente.
      scrim.addEventListener('click', () => { if (open?.dismissible) close(null); });
    }

    const anim = document.createElement('div');
    anim.className = `op-modal__anim${inherited ? ' is-after' : ''}`;
    // Lo de un modal que ya se está yendo no cierra al que vino después.
    const mine = (fn) => () => { if (open?.anim === anim) fn(); };

    const modal = document.createElement('div');
    modal.className = 'op-modal';
    if (width) modal.style.width = `min(${width}px, calc(100vw - 96px))`;
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');

    modal.innerHTML = `
      <div class="op-modal__head">
        <div class="op-grow">
          <div class="op-modal__title"></div>
          ${sub ? '<div class="op-modal__sub"></div>' : ''}
        </div>
        ${dismissible ? `<button class="op-iconbtn" data-dismiss data-tip="Cerrar" data-tip-key="Esc">${Icons.svg('close')}</button>` : ''}
      </div>
      <div class="op-modal__body op-scroll"></div>
      ${actions.length ? '<div class="op-modal__foot"></div>' : ''}`;

    modal.querySelector('.op-modal__title').textContent = title;
    if (sub) modal.querySelector('.op-modal__sub').textContent = sub;

    const bodyEl = modal.querySelector('.op-modal__body');
    if (body instanceof Node) bodyEl.appendChild(body);
    else bodyEl.innerHTML = body;

    const foot = modal.querySelector('.op-modal__foot');
    let primary = null;
    let auto = null;
    actions.forEach((a) => {
      const b = document.createElement('button');
      b.className = `op-btn op-flashable op-btn--${a.variant || 'ghost'}`;
      b.textContent = a.label;
      b.addEventListener('click', mine(async () => {
        if (a.guard) {
          if (b.disabled) return;
          b.disabled = true;
          const pasa = await Promise.resolve().then(() => a.guard(b)).catch(() => false);
          b.disabled = false;
          if (pasa !== true || open?.anim !== anim) return;
        }
        close(a.value);
      }));
      foot.appendChild(b);
      if (a.variant === 'primary' && !primary) primary = b;
      if (a.autofocus && !auto) auto = b;
    });

    modal.querySelector('[data-dismiss]')?.addEventListener('click', mine(() => close(null)));

    anim.appendChild(modal);
    if (inherited) layer().append(anim);
    else layer().append(scrim, anim);
    Icons.mount(modal);
    scrollFade(bodyEl);

    // El foco vuelve a donde estaba antes del PRIMERO de la fila.
    const restore = inherited ? inherited.restore : document.activeElement;
    open = { scrim, anim, req, dismissible, restore, primary };
    document.addEventListener('keydown', onKey, true);
    if (arm) {
      anim.classList.add('is-arming');
      setTimeout(() => anim.classList.remove('is-arming'), arm);
      modal.tabIndex = -1;
      setTimeout(() => modal.focus(), 60);
    } else {
      /* El foco: al botón con autofocus si alguno lo pide. Es una decisión de
         quien arma el diálogo: en uno de opciones (imprimir) Enter va al
         botón, y las flechas no pueden cambiar las copias. Si nadie lo pide,
         adonde se va a escribir: el primer campo visible del cuerpo (con el
         foco en «Guardar», había que ir con el mouse hasta el nombre). Sin
         campos, el primero del pie; antes caía en la X de cerrar. */
      const field = [...bodyEl.querySelectorAll(`${TEXT_FIELDS}, textarea:not([disabled]), select:not([disabled])`)]
        .find((f) => f.checkVisibility({ visibilityProperty: true }));
      setTimeout(() => (auto || field || foot?.querySelector('button') || anim.querySelector('button'))?.focus(), 60);
    }
  }

  /** Confirmación destructiva: el rojo aparece acá porque algo se va a romper. */
  function confirm({ title, sub, confirmLabel = 'Confirmar', danger = false } = {}) {
    return show({
      title,
      sub,
      actions: [
        { label: 'Cancelar', value: false },
        { label: confirmLabel, value: true, variant: danger ? 'danger-solid' : 'primary', autofocus: true },
      ],
    }).then((v) => v === true);
  }

  return { show, confirm, close };
})();

export { Tooltip, Toast, Menu, Modal };
