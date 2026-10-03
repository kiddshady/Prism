/* ═══════════════════════════════════════════════════════════════════════════
   PRISM — los menús
   El de cada pestaña, el de la página (click derecho) y el principal. Todos
   son el Menu de Opal con la página congelada debajo (layers.js). Cada acción
   vive acá Y en otro lado a la vista (un botón o un atajo): no hay nada que
   solo se pueda hacer desde un menú.
   ═══════════════════════════════════════════════════════════════════════════ */

import { api, S, activeTab, on } from './state.js';
import { roll, swapText } from './motion.js';
import { menu, pointAnchor } from './layers.js';
import { newTab } from './tabstrip.js';
import { addressField } from './suggest.js';

const ellipsis = (s, n = 28) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

/* ── Pestaña ─────────────────────────────────────────────────────────────── */

export function tabMenu(anchor, id) {
  const t = S.tabs.find((x) => x.id === id);
  if (!t) return;
  const i = S.tabs.indexOf(t);
  // Las fijadas no cuentan: "cerrar las otras" y "las de la derecha" las respetan.
  const right = S.tabs.slice(i + 1).filter((x) => !x.pinned).length;
  const others = S.tabs.filter((x) => x.id !== id && !x.pinned).length;
  menu(anchor, [
    { label: 'Nueva pestaña a la derecha', icon: 'plus', onSelect: () => { S.focusOmniOnNext = true; api.tabs.create('', { index: i + 1 }); } },
    { label: 'Recargar', icon: 'reload', key: 'F5', disabled: !!t.internal, onSelect: () => { api.tabs.activate(id); api.nav.reload(); } },
    { label: 'Duplicar', icon: 'duplicate', onSelect: () => api.tabs.duplicate(id) },
    { label: t.pinned ? 'Desfijar' : 'Fijar', icon: 'pin', onSelect: () => api.tabs.pin(id, !t.pinned) },
    ...splitItems(t),
    { label: t.muted ? 'Activar el sonido' : 'Silenciar la pestaña', icon: t.muted ? 'speaker' : 'speakerOff', onSelect: () => api.tabs.mute(id) },
    { sep: true },
    // Ctrl+W no cierra una fijada: el atajo solo se muestra donde anda.
    { label: 'Cerrar', icon: 'close', key: t.pinned ? undefined : 'Ctrl+W', onSelect: () => api.tabs.close(id) },
    { label: 'Cerrar las otras', disabled: !others, onSelect: () => api.tabs.closeOthers(id) },
    { label: right === 1 ? 'Cerrar la de la derecha' : 'Cerrar las de la derecha', disabled: !right, onSelect: () => api.tabs.closeRight(id) },
    { sep: true },
    { label: 'Reabrir la última cerrada', icon: 'reopen', key: 'Ctrl+Mayús+T', disabled: !S.canReopen, onSelect: () => api.tabs.reopen() },
  ], { align: 'start' });
}

/** Vista dividida desde el menú de una pestaña: armar el par, o manejarlo. */
function splitItems(t) {
  if (t.split) {
    return [
      { label: 'Intercambiar lados', icon: 'swap', onSelect: () => api.tabs.swapSplit(t.id) },
      { label: 'Separar la vista dividida', icon: 'unsplit', onSelect: () => api.tabs.unsplit(t.id) },
    ];
  }
  if (t.pinned) return [];
  const act = activeTab();
  const withActive = act && act.id !== t.id && !act.split && !act.pinned;
  return [
    { label: 'Dividir con una pestaña nueva', icon: 'splitView', onSelect: () => { S.focusOmniOnNext = true; api.tabs.split(t.id); } },
    ...(withActive ? [{ label: 'Dividir con la pestaña actual', onSelect: () => api.tabs.split(act.id, t.id) }] : []),
  ];
}

/* ── Página (click derecho) ──────────────────────────────────────────────── */

export function pageMenu(p) {
  const items = [];
  const act = (action, payload = {}) => () => api.page.context(action, payload);
  const sel = String(p.selectionText || '').trim();

  if (p.misspelledWord) {
    const sug = (p.suggestions || []).slice(0, 4);
    if (sug.length) sug.forEach((w) => items.push({ label: w, icon: 'check', onSelect: act('spell', { word: w }) }));
    else items.push({ label: 'Sin sugerencias', disabled: true });
    items.push({ label: 'Agregar al diccionario', icon: 'book', onSelect: act('spell-add', { word: p.misspelledWord }) });
    items.push({ sep: true });
  }

  if (p.linkURL) {
    items.push(
      { label: 'Abrir en una pestaña nueva', icon: 'external', onSelect: act('link-tab', { url: p.linkURL }) },
      ...(activeTab()?.pinned ? [] : [{ label: 'Abrir el enlace al costado', icon: 'splitView', onSelect: act('link-split', { url: p.linkURL }) }]),
      ...(S.info?.private ? [] : [{ label: 'Abrir el enlace en incógnito', icon: 'ghost', onSelect: act('link-incognito', { url: p.linkURL }) }]),
      { label: 'Copiar la dirección del enlace', icon: 'link', onSelect: act('link-copy', { url: p.linkURL }) },
      { label: 'Guardar el enlace', icon: 'download', onSelect: act('link-save', { url: p.linkURL }) },
      { sep: true },
    );
  }

  if (p.mediaType === 'image' && p.srcURL) {
    items.push(
      { label: 'Abrir la imagen en una pestaña nueva', icon: 'image', onSelect: act('image-tab', { url: p.srcURL }) },
      { label: 'Copiar la imagen', icon: 'copy', onSelect: act('image-copy', { x: p.pageX, y: p.pageY }) },
      { label: 'Copiar la dirección de la imagen', icon: 'link', onSelect: act('image-copy-url', { url: p.srcURL }) },
      { label: 'Guardar la imagen', icon: 'download', onSelect: act('image-save', { url: p.srcURL }) },
      { sep: true },
    );
  }
  if (p.mediaType === 'video') {
    items.push({ label: 'Ver en una ventanita', icon: 'pip', key: 'Ctrl+Mayús+P', onSelect: act('video-pip') });
    if (!p.srcURL || p.srcURL.startsWith('blob:')) items.push({ sep: true });
  }
  if ((p.mediaType === 'video' || p.mediaType === 'audio') && p.srcURL && !p.srcURL.startsWith('blob:')) {
    items.push(
      { label: `Abrir ${p.mediaType === 'video' ? 'el video' : 'el audio'} en una pestaña nueva`, icon: p.mediaType === 'video' ? 'video' : 'music', onSelect: act('image-tab', { url: p.srcURL }) },
      { label: 'Guardar', icon: 'download', onSelect: act('image-save', { url: p.srcURL }) },
      { sep: true },
    );
  }

  if (p.isEditable) {
    const f = p.editFlags || {};
    items.push(
      { label: 'Deshacer', key: 'Ctrl+Z', disabled: !f.canUndo, onSelect: act('undo') },
      { label: 'Rehacer', key: 'Ctrl+Y', disabled: !f.canRedo, onSelect: act('redo') },
      { sep: true },
      { label: 'Cortar', key: 'Ctrl+X', disabled: !f.canCut, onSelect: act('cut') },
      { label: 'Copiar', icon: 'copy', key: 'Ctrl+C', disabled: !f.canCopy, onSelect: act('copy') },
      { label: 'Pegar', key: 'Ctrl+V', disabled: !f.canPaste, onSelect: act('paste') },
      { label: 'Pegar sin formato', key: 'Ctrl+Mayús+V', disabled: !f.canPaste, onSelect: act('paste-plain') },
      { label: 'Seleccionar todo', key: 'Ctrl+A', disabled: !f.canSelectAll, onSelect: act('select-all') },
      { sep: true },
    );
  } else if (sel) {
    const engine = S.info?.engines?.[S.settings.searchEngine] || 'Google';
    items.push(
      { label: 'Copiar', icon: 'copy', key: 'Ctrl+C', onSelect: act('copy') },
      { label: `Buscar «${ellipsis(sel)}» en ${engine}`, icon: 'search', onSelect: act('search', { text: sel }) },
      { sep: true },
    );
  }

  if (!p.linkURL && !p.isEditable && !sel && p.mediaType !== 'image') {
    items.push(
      { label: 'Atrás', icon: 'arrowLeft', key: 'Alt+Izq', disabled: !p.canGoBack, onSelect: act('back') },
      { label: 'Adelante', icon: 'arrowRight', key: 'Alt+Der', disabled: !p.canGoForward, onSelect: act('forward') },
      { label: 'Recargar', icon: 'reload', key: 'F5', onSelect: act('reload') },
      { sep: true },
      { label: 'Imprimir', icon: 'printer', key: 'Ctrl+P', onSelect: act('print') },
      { label: 'Capturar lo visible', icon: 'capture', onSelect: () => api.page.capture('visible') },
      { label: 'Capturar la página entera', icon: 'captureFull', key: 'Ctrl+Mayús+S', onSelect: () => api.page.capture('full') },
      { label: 'Ver el código fuente', icon: 'code', key: 'Ctrl+U', onSelect: act('source') },
      { sep: true },
    );
  }

  items.push({ label: 'Inspeccionar', icon: 'terminal', onSelect: act('inspect', { x: p.pageX, y: p.pageY }) });
  menu(pointAnchor(p.x, p.y), items, { align: 'start' });
}

/* ── Campos de texto (click derecho) ─────────────────────────────────────
   Los del cromo: la omnibox, la barra grande de la pestaña nueva, los
   buscadores del historial y de favoritos, los de un modal. Chromium no trae
   menú propio en Electron, así que sin esto el click derecho no hacía nada.
   El menú no se lleva el foco (overlays.js), así que cada acción cae sobre el
   campo con su selección intacta. */

// Los que no se escriben (number, date, color…) no llevan este menú.
const TEXT_TYPES = new Set(['text', 'search', 'url', 'email', 'tel', 'password']);

/** El campo de texto donde cayó el click, o null. */
export function textFieldOf(target) {
  const el = target?.closest?.('input, textarea');
  if (!el || (el.tagName === 'INPUT' && !TEXT_TYPES.has(el.type))) return null;
  return el;
}

const exec = (cmd, value) => document.execCommand(cmd, false, value);

export async function fieldMenu(field, x, y) {
  const addr = addressField(field);
  addr?.close();
  const ro = field.readOnly || field.disabled;
  const secret = field.type === 'password';
  const hasSel = field.selectionEnd > field.selectionStart;
  const all = !!field.value && field.selectionStart === 0 && field.selectionEnd === field.value.length;
  const canUndo = !ro && document.queryCommandEnabled('undo');
  const clip = await api.clip.read().catch(() => '');

  // "Pegar e ir", como Chrome: dice adónde va lo copiado antes de ir.
  let go = null;
  const pasted = clip.replace(/\s+/g, ' ').trim();
  if (addr) {
    const kind = pasted ? (await api.omni.suggest(pasted.slice(0, 500)).catch(() => null))?.classified?.type : null;
    go = kind === 'url'
      ? { label: `Pegar e ir a ${ellipsis(pasted, 48)}`, icon: 'globe' }
      : { label: pasted ? `Pegar y buscar «${ellipsis(pasted, 36)}»` : 'Pegar e ir', icon: kind ? 'search' : 'arrowRight' };
  }

  menu(pointAnchor(x, y), [
    { label: 'Deshacer', key: 'Ctrl+Z', disabled: !canUndo, onSelect: () => exec('undo') },
    { sep: true },
    { label: 'Cortar', key: 'Ctrl+X', disabled: ro || secret || !hasSel, onSelect: () => exec('cut') },
    { label: 'Copiar', icon: 'copy', key: 'Ctrl+C', disabled: secret || !hasSel, onSelect: () => exec('copy') },
    // Se vuelve a leer al elegir: lo copiado pudo cambiar con el menú abierto.
    { label: 'Pegar', key: 'Ctrl+V', disabled: ro || !clip, onSelect: async () => exec('insertText', await api.clip.read().catch(() => clip)) },
    ...(go ? [{ ...go, disabled: !pasted, onSelect: () => addr.go(pasted) }] : []),
    { label: 'Suprimir', disabled: ro || !hasSel, onSelect: () => exec('delete') },
    { sep: true },
    { label: 'Seleccionar todo', key: 'Ctrl+A', disabled: !field.value || all, onSelect: () => field.select() },
  ], { align: 'start' });
}

/* ── Principal ───────────────────────────────────────────────────────────── */

/** El ítem de actualización, arriba de todo, solo si hay algo que hacer. */
function updateItems() {
  const u = S.update || {};
  if (u.phase === 'available') return [{ label: `Descargar Prism ${u.version}`, icon: 'download', onSelect: () => api.update.download() }, { sep: true }];
  if (u.phase === 'downloading') return [{ label: `Descargando la ${u.version}… ${Math.round((u.pct || 0) * 100)} %`, icon: 'download', disabled: true, mount: liveUpdate }, { sep: true }];
  if (u.phase === 'ready') return [{ label: `Reiniciar para actualizar a la ${u.version}`, icon: 'reload', onSelect: () => api.update.install() }, { sep: true }];
  return [];
}

/* Con el menú abierto la descarga sigue: el porcentaje corre en el ítem, y
   si termina, el rótulo se releva al de "lista". Se suelta solo cuando el
   menú ya no está. */
function liveUpdate(b) {
  const label = b.querySelector('span.op-truncate');
  const text = (u) => (u.phase === 'downloading' ? `Descargando la ${u.version}… ${Math.round((u.pct || 0) * 100)} %` : `La ${u.version} está lista: reabrí el menú`);
  let phase = 'downloading';
  const shown = (S.update?.pct || 0) * 100;   // lo que dice el rótulo al abrir
  const off = on('update', (u) => {
    if (!b.isConnected) { off(); return; }
    if (u.phase === 'downloading' && phase === 'downloading') {
      const v = u.version;
      roll(label, (u.pct || 0) * 100, (p) => { label.textContent = `Descargando la ${v}… ${Math.round(p)} %`; }, { from: shown });
    } else if (u.phase !== phase) {
      phase = u.phase;
      swapText(label, text(u));
    }
  });
}

export function mainMenu(anchor, { openFind } = {}) {
  const t = activeTab();
  const web = !!t && !t.internal && !t.error && !t.crashed;
  const zoom = Math.round((t?.zoom || 1) * 100);
  menu(anchor, [
    ...updateItems(),
    { label: 'Nueva pestaña', icon: 'plus', key: 'Ctrl+T', onSelect: () => newTab() },
    { label: 'Nueva ventana de incógnito', icon: 'ghost', key: 'Ctrl+Mayús+N', onSelect: () => api.win.incognito() },
    { label: 'Reabrir la última cerrada', icon: 'reopen', key: 'Ctrl+Mayús+T', disabled: !S.canReopen, onSelect: () => api.tabs.reopen() },
    { sep: true },
    { label: 'Historial', icon: 'history', key: 'Ctrl+H', onSelect: () => openPage('historial') },
    { label: 'Favoritos', icon: 'star', onSelect: () => openPage('favoritos') },
    { label: S.settings?.bookmarksBar === false ? 'Mostrar la barra de favoritos' : 'Ocultar la barra de favoritos', icon: 'bookmark', key: 'Ctrl+Mayús+B', onSelect: () => api.settings.save({ bookmarksBar: S.settings?.bookmarksBar === false }) },
    { label: 'Descargas', icon: 'download', key: 'Ctrl+J', onSelect: () => openPage('descargas') },
    { sep: true },
    { label: 'Buscar en la página', icon: 'search', key: 'Ctrl+F', disabled: !web, onSelect: () => openFind?.() },
    { label: 'Acercar', icon: 'zoomIn', key: 'Ctrl++', disabled: !web, onSelect: () => api.page.zoom('in') },
    { label: `Alejar${web && zoom !== 100 ? ` · ${zoom} %` : ''}`, icon: 'zoomOut', key: 'Ctrl+-', disabled: !web, onSelect: () => api.page.zoom('out') },
    { label: 'Imprimir', icon: 'printer', key: 'Ctrl+P', disabled: !web, onSelect: () => api.page.print() },
    { label: 'Capturar lo visible', icon: 'capture', disabled: !web, onSelect: () => api.page.capture('visible') },
    { label: 'Capturar la página entera', icon: 'captureFull', key: 'Ctrl+Mayús+S', disabled: !web, onSelect: () => api.page.capture('full') },
    // Con la ventanita abierta, el atajo la trae de vuelta desde cualquier pestaña.
    S.tabs.some((x) => x.pip)
      ? { label: 'Traer el video de vuelta', icon: 'pipBack', key: 'Ctrl+Mayús+P', onSelect: () => api.page.pip() }
      : { label: 'Ver el video en una ventanita', icon: 'pip', key: 'Ctrl+Mayús+P', disabled: !web, onSelect: () => api.page.pip() },
    { sep: true },
    { label: 'Herramientas de desarrollo', icon: 'terminal', key: 'F12', disabled: !web, onSelect: () => api.page.devtools() },
    { label: 'Ver el código fuente', icon: 'code', key: 'Ctrl+U', disabled: !web, onSelect: () => api.page.context('source') },
    { sep: true },
    { label: 'Ajustes', icon: 'settings', onSelect: () => openPage('ajustes') },
    { label: 'Salir de Prism', icon: 'exit', key: 'Ctrl+Mayús+Q', onSelect: () => api.quit() },
  ], { align: 'end' });
}

/** Abre una página propia: la reutiliza si ya está abierta en alguna pestaña. */
export function openPage(name) {
  const t = S.tabs.find((x) => x.internal === name);
  if (t) { api.tabs.activate(t.id); return; }
  const cur = activeTab();
  if (cur?.internal === 'nueva') api.tabs.navigate(cur.id, `prism://${name}`);
  else api.tabs.create(`prism://${name}`, { index: S.tabs.indexOf(cur) + 1 });
}
