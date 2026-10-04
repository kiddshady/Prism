'use strict';

/* ═══════════════════════════════════════════════════════════════════════════
   PRISM — descargas
   Cada descarga es un registro que el renderer dibuja (panel y página) y un
   DownloadItem de Chromium mientras está viva. Las terminadas se guardan en
   disco para que la lista sobreviva a un reinicio. Las vivas, mientras bajan,
   no; si la app se cierra a mitad, Chromium las corta, y se guardan como
   cortadas (`atQuit`): la fila queda para reintentar.
   ═══════════════════════════════════════════════════════════════════════════ */

const fs = require('fs');
const path = require('path');
const { app, shell } = require('electron');

const KEEP = 200;
/** Lo más largo que puede ser un nombre (con la extensión). */
const NAME_MAX = 180;

/* Los nombres que tomaron las descargas en curso, de TODAS las ventanas: una
   en la normal y otra en incógnito del mismo archivo también se pisarían. */
const reservedAll = new Set();

/* "archivo.pdf" ya existe → "archivo (1).pdf". Los nombres reservados por
   descargas en curso cuentan como ocupados: dos descargas simultáneas del mismo
   archivo se pisarían, porque ninguna llegó todavía al disco.
   Un nombre largo se recorta en la base, nunca en la extensión: el título
   entero de un apunte como nombre perdía el ".pdf" y Windows no sabía con qué
   abrirlo. Y el recorte no termina en espacio ni en punto, que Windows saca
   callado (el archivo quedaría con otro nombre que el anotado). */
function uniquePath(dir, filename, reserved = new Set()) {
  const clean = String(filename || 'descarga').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim() || 'descarga';
  let ext = path.extname(clean);
  if (ext.length > 16 || ext === '.') ext = '';
  const base = clean.slice(0, clean.length - ext.length).slice(0, NAME_MAX - ext.length).replace(/[ .]+$/, '') || 'descarga';
  for (let i = 0; i < 10000; i++) {
    const name = `${base}${i ? ` (${i})` : ''}${ext}`;
    const p = path.join(dir, name);
    if (!reserved.has(p.toLowerCase()) && !fs.existsSync(p)) return p;
  }
  return path.join(dir, `${base}-${Date.now()}${ext}`);
}

function createDownloads(ctx, { doc }) {
  let list = [];                 // más nueva primero
  const live = new Map();        // id → DownloadItem
  const reserved = reservedAll;
  let seq = 0;
  /** Prism se está cerrando: lo que baja se corta, y se anota así. */
  let closing = false;

  const pub = (d) => ({ ...d });
  let emitTimer = null;
  function emit(now = false) {
    const go = () => { emitTimer = null; ctx.send('downloads:state', list.map(pub)); };
    if (now) { clearTimeout(emitTimer); go(); return; }
    if (!emitTimer) emitTimer = setTimeout(go, 150);
  }

  /* Lo que va al disco. Las que bajan no (su estado cambia a cada rato),
     salvo al cerrar: ahí quedan como cortadas, con su dirección para
     reintentar. Sin eso, la descarga desaparecía como si nunca hubiera
     existido. */
  const cut = (d) => ({ ...d, state: 'interrupted', speed: 0, paused: false, endedAt: Date.now(), atQuit: true });
  const persisted = () => ({
    list: list.filter((d) => closing || d.state !== 'progressing').map((d) => (d.state === 'progressing' ? cut(d) : d)).slice(0, KEEP),
    seq,
  });

  let saveTimer = null;
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      doc.write(persisted()).catch((err) => console.error('[downloads]', err.message));
    }, 600);
  }

  /** Prism se cierra: lo que bajaba se guarda como cortado, ya. */
  function flush() {
    closing = true;
    clearTimeout(saveTimer);
    return doc.write(persisted()).catch((err) => console.error('[downloads]', err.message));
  }
  /** Igual, sin soltar el hilo: Windows se está apagando (ver store.cjs). */
  function flushSync() {
    closing = true;
    clearTimeout(saveTimer);
    try { doc.writeSync?.(persisted()); } catch (err) { console.error('[downloads]', err.message); }
  }

  async function load() {
    const data = await doc.read().catch(() => null);
    list = Array.isArray(data?.list) ? data.list : [];
    seq = Number(data?.seq) || list.reduce((m, d) => Math.max(m, Number(d.id) || 0), 0);
    // Si el archivo ya no está, se marca: la fila queda, pero "Abrir" no.
    for (const d of list) if (d.state === 'completed') d.missing = !fs.existsSync(d.path || '');
  }

  function dir() {
    const d = ctx.settings.downloadDir;
    return d && fs.existsSync(d) ? d : app.getPath('downloads');
  }

  function attach(session) {
    session.on('will-download', (_e, item, wc) => {
      const id = ++seq;
      const d = {
        id,
        filename: item.getFilename(),
        url: item.getURL(),
        mime: item.getMimeType(),
        path: '',
        total: item.getTotalBytes(),
        received: 0,
        speed: 0,
        state: 'progressing',
        paused: false,
        startedAt: Date.now(),
        endedAt: null,
      };

      if (!ctx.settings.askDownload) {
        const p = uniquePath(dir(), d.filename, reserved);
        reserved.add(p.toLowerCase());
        item.setSavePath(p);
        d.path = p;
        d.filename = path.basename(p);
      }
      // Con askDownload, Chromium abre el diálogo de guardar del sistema.

      list.unshift(d);
      live.set(id, item);

      let lastBytes = 0;
      let lastT = Date.now();
      item.on('updated', (_ev, state) => {
        const now = Date.now();
        const got = item.getReceivedBytes();
        const dt = now - lastT;
        if (dt >= 400) {
          // Promedio móvil: la velocidad instantánea salta demasiado para leerse.
          const inst = ((got - lastBytes) / dt) * 1000;
          d.speed = d.speed ? d.speed * 0.6 + inst * 0.4 : inst;
          lastBytes = got;
          lastT = now;
        }
        d.received = got;
        d.total = item.getTotalBytes();
        d.paused = item.isPaused();
        d.state = state === 'interrupted' ? 'interrupted' : 'progressing';
        if (!d.path) { d.path = item.getSavePath(); d.filename = path.basename(d.path) || d.filename; }
        emit();
      });

      item.once('done', (_ev, state) => {
        live.delete(id);
        reserved.delete((d.path || '').toLowerCase());
        d.path = item.getSavePath() || d.path;
        d.filename = path.basename(d.path) || d.filename;
        d.received = item.getReceivedBytes();
        d.state = state;               // completed · cancelled · interrupted
        // La cortó la salida de Prism, no la persona: queda para reintentar.
        if (closing && state !== 'completed') Object.assign(d, { state: 'interrupted', atQuit: true });
        d.speed = 0;
        d.endedAt = Date.now();
        emit(true);
        save();
        if (closing) return;
        if (state === 'completed') ctx.send('status:msg', { text: `Descarga completa · ${d.filename}`, icon: 'download' });
        else if (state === 'interrupted') ctx.send('status:msg', { text: `Se cortó la descarga · ${d.filename}`, icon: 'alert', tone: 'error' });
      });

      // Una pestaña que se abrió SOLO para bajar un archivo no tiene nada que
      // mostrar: se cierra, como en Chrome.
      ctx.tabs?.closeIfDownloadOnly(wc?.id);
      emit(true);
      ctx.send('downloads:started', { id });
    });
  }

  const find = (id) => list.find((d) => d.id === Number(id));

  const actions = {
    open(id) {
      const d = find(id);
      if (d?.state === 'completed' && d.path) return shell.openPath(d.path).then((err) => { if (err) throw new Error(err); return true; });
      return false;
    },
    show(id) {
      const d = find(id);
      if (d?.path && fs.existsSync(d.path)) { shell.showItemInFolder(d.path); return true; }
      shell.openPath(dir());
      return false;
    },
    cancel(id) { live.get(Number(id))?.cancel(); return true; },
    pause(id) { live.get(Number(id))?.pause(); emit(true); return true; },
    resume(id) {
      const item = live.get(Number(id));
      if (item?.canResume()) item.resume();
      emit(true);
      return true;
    },
    retry(id) {
      const d = find(id);
      if (!d) return false;
      list = list.filter((x) => x !== d);
      ctx.web.downloadURL(d.url);
      emit(true);
      // La fila vieja se va también del disco: si no, volvía al reiniciar.
      save();
      return true;
    },
    remove(id) {
      const d = find(id);
      if (!d || d.state === 'progressing') return false;
      list = list.filter((x) => x !== d);
      emit(true);
      save();
      return true;
    },
    clear() {
      list = list.filter((d) => d.state === 'progressing');
      emit(true);
      save();
      return true;
    },
    openFolder() { shell.openPath(dir()); return true; },
  };

  return {
    load,
    attach,
    flush,
    flushSync,
    list: () => list.map(pub),
    get activeCount() { return list.filter((d) => d.state === 'progressing').length; },
    /** Las que bajan, para preguntar antes de salir: { filename, pct }. */
    active: () => list.filter((d) => d.state === 'progressing').map((d) => ({ filename: d.filename, pct: d.total ? Math.round((d.received / d.total) * 100) : null })),
    dir,
    ...actions,
  };
}

module.exports = { createDownloads, uniquePath };
