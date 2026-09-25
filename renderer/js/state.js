/* ═══════════════════════════════════════════════════════════════════════════
   PRISM — estado del renderer
   Un espejo de lo que manda el proceso principal. El renderer no decide nada
   sobre las pestañas: recibe la foto completa y la dibuja. Cada módulo se
   suscribe a los cambios que le importan.
   ═══════════════════════════════════════════════════════════════════════════ */

export const api = window.prism;

export const S = {
  tabs: [],
  activeId: null,
  canReopen: false,
  fullscreen: false,
  /** El par que se ve: { a, b, ratio, gap } (a a la izquierda), o null. */
  split: null,
  settings: {},
  info: null,
  downloads: [],
  update: { phase: 'idle' },
};

const subs = new Map();   // tipo → Set de funciones

/** Se suscribe a un tipo de cambio: 'tabs' · 'settings' · 'downloads' · 'library'. */
export function on(kind, fn) {
  if (!subs.has(kind)) subs.set(kind, new Set());
  subs.get(kind).add(fn);
  return () => subs.get(kind)?.delete(fn);
}

export function emit(kind, ...args) {
  for (const fn of subs.get(kind) || []) {
    try { fn(...args); } catch (err) { console.error(`[state:${kind}]`, err); }
  }
}

export const activeTab = () => S.tabs.find((t) => t.id === S.activeId) || null;

/** La pestaña activa es una página web con su vista (y no una propia de Prism). */
export const isWebActive = () => {
  const t = activeTab();
  return !!t && !t.internal && !t.error && !t.crashed;
};
