'use strict';

/* ═══════════════════════════════════════════════════════════════════════════
   PRISM — la terminal
   PowerShell 7 en una pty (node-pty sobre ConPTY), dibujada por xterm.js en
   la pestaña prism://terminal de la ventana normal. Una shell por mitad: la
   pestaña se puede dividir en dos («a» y «b»), cada una con la suya. Vive acá,
   en el proceso principal, y no en la pestaña: si la interfaz se recarga (se
   cayó y recover.cjs la levanta) la shell sigue, y al volver se le repasa lo
   último que escribió.

   Carga el $PROFILE de siempre (core-profile, el prompt de NTX) y después
   src/term-init.ps1, que la pinta en la escala de Prism y avisa la carpeta.

   · ConPTY propio de node-pty (useConptyDll): con el de Windows, cerrar la
     shell hace un child_process.fork(), y con el fusible runAsNode apagado
     ese fork levantaba OTRO Prism (el ejecutable de Electron sin modo Node).
   · La salida viaja por tandas: un `dir` grande son miles de pedazos, y un
     mensaje IPC por pedazo traba la interfaz.
   ═══════════════════════════════════════════════════════════════════════════ */

const fs = require('fs');
const os = require('os');
const path = require('path');

/** Lo último que escribió la shell, para repasarlo si la interfaz vuelve de cero. */
const BACKLOG_MAX = 512 * 1024;
const FLUSH_MS = 6;

/** pwsh 7: donde lo deja el instalador, y si no, el primero del PATH. */
function findPwsh() {
  const env = process.env;
  const fixed = [env.ProgramW6432, env.ProgramFiles, env['ProgramFiles(x86)']]
    .filter(Boolean)
    .map((root) => path.join(root, 'PowerShell', '7', 'pwsh.exe'));
  const onPath = String(env.PATH || env.Path || '').split(path.delimiter)
    .filter(Boolean)
    .map((dir) => path.join(dir, 'pwsh.exe'));
  return [...fixed, ...onPath].find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } }) || null;
}

/* El script de arranque, afuera del asar: pwsh no puede leer adentro de él
   (por eso va en asarUnpack, en package.json). */
const INIT = path.join(__dirname, 'term-init.ps1').replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);

/* ── El branch, sin correr git ──────────────────────────────────────────────
   Se sube desde la carpeta buscando .git (carpeta, o archivo con `gitdir:` en
   un worktree) y se lee HEAD. Llega con cada prompt: va con caché corta. */
const branchCache = new Map();
const BRANCH_TTL = 2000;

function readBranch(dir) {
  let cur = path.resolve(dir);
  for (;;) {
    const dotgit = path.join(cur, '.git');
    let st = null;
    try { st = fs.statSync(dotgit); } catch { /* sigue subiendo */ }
    if (st) {
      let gitdir = dotgit;
      if (st.isFile()) {
        const m = /^gitdir:\s*(.+)\s*$/m.exec(fs.readFileSync(dotgit, 'utf8'));
        if (!m) return null;
        gitdir = path.resolve(cur, m[1].trim());
      }
      const head = fs.readFileSync(path.join(gitdir, 'HEAD'), 'utf8').trim();
      const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
      return ref ? ref[1] : head.slice(0, 7);
    }
    const up = path.dirname(cur);
    if (up === cur) return null;
    cur = up;
  }
}

function branchFor(dir) {
  const key = String(dir || '');
  if (!key) return null;
  const hit = branchCache.get(key);
  if (hit && Date.now() - hit.at < BRANCH_TTL) return hit.branch;
  let branch = null;
  try { branch = readBranch(key); } catch { branch = null; }
  branchCache.set(key, { branch, at: Date.now() });
  if (branchCache.size > 64) branchCache.delete(branchCache.keys().next().value);
  return branch;
}

/* ── CPU y memoria del sistema ──────────────────────────────────────────────
   os.cpus() cuenta desde el booteo: lo que dice algo es la diferencia contra
   la lectura anterior. */
function cpuSample() {
  let idle = 0;
  let total = 0;
  for (const c of os.cpus()) {
    for (const v of Object.values(c.times)) total += v;
    idle += c.times.idle;
  }
  return { idle, total };
}

/** Las mitades: la terminal se divide en dos y no más. */
const PANES = ['a', 'b'];
const paneOf = (id) => (PANES.includes(id) ? id : 'a');

function createTerm(ctx) {
  let pty = null;        // node-pty, cargado recién cuando se abre la primera shell
  let seq = 0;           // las sesiones se numeran para toda la ventana
  let lastCpu = cpuSample();
  /** Una shell por mitad: { proc, session, backlog, pending, flushTimer }. */
  const shells = new Map();

  const mine = (w) => {
    if (w.private) throw new Error('La terminal vive en la ventana normal.');
  };

  function flush(pane, sh) {
    sh.flushTimer = null;
    if (!sh.pending) return;
    const chunk = sh.pending;
    sh.pending = '';
    ctx.send('term:data', { pane, session: sh.session, data: chunk });
  }

  function onData(pane, sh, data) {
    sh.backlog += data;
    if (sh.backlog.length > BACKLOG_MAX) {
      // Se corta en un salto de línea: cortando en cualquier lado podía quedar
      // media secuencia de escape al principio, y el repaso la dibujaba.
      const from = sh.backlog.length - BACKLOG_MAX * 0.75;
      const nl = sh.backlog.indexOf('\n', from);
      sh.backlog = sh.backlog.slice(nl < 0 ? from : nl + 1);
    }
    sh.pending += data;
    if (!sh.flushTimer) sh.flushTimer = setTimeout(() => flush(pane, sh), FLUSH_MS);
  }

  function spawn(pane, cols, rows) {
    const exe = findPwsh();
    if (!exe) throw new Error('No encontré PowerShell 7 (pwsh.exe). Se instala con: winget install Microsoft.PowerShell');
    pty = pty || require('node-pty');
    const env = {};
    for (const [k, v] of Object.entries(process.env)) {
      /* NO_COLOR fuera: si Prism lo heredó (lo lanzó una consola que lo tenía),
         pwsh pasaba a texto plano y los errores dejaban de verse en rojo. */
      if (!k.startsWith('ELECTRON_') && k !== 'NODE_OPTIONS' && k !== 'NO_COLOR') env[k] = v;
    }
    Object.assign(env, {
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      PRISM_TERM: '1',
      PRISM_TERM_INIT: INIT,
      NTX_ACCENT: '#f0f3f7',   // la esquina del prompt de NTX, en la luz de Prism
    });
    seq += 1;
    const sh = { proc: null, session: seq, backlog: '', pending: '', flushTimer: null };
    sh.proc = pty.spawn(exe, ['-NoLogo', '-NoExit', '-ExecutionPolicy', 'Bypass', '-Command', '. $env:PRISM_TERM_INIT'], {
      name: 'xterm-256color',
      cols: Math.max(20, cols | 0),
      rows: Math.max(5, rows | 0),
      cwd: os.homedir(),
      env,
      useConpty: true,
      useConptyDll: true,
    });
    shells.set(pane, sh);
    // Lo que todavía escriba una shell que ya se fue (o que reemplazaron) no es de nadie.
    const current = () => shells.get(pane) === sh;
    sh.proc.onData((data) => { if (current()) onData(pane, sh, data); });
    sh.proc.onExit(({ exitCode }) => {
      if (!current()) return;
      clearTimeout(sh.flushTimer);
      flush(pane, sh);
      shells.delete(pane);
      ctx.send('term:exit', { pane, session: sh.session, code: exitCode });
    });
    return sh;
  }

  function killPane(pane) {
    const sh = shells.get(pane);
    if (!sh) return;
    shells.delete(pane);
    clearTimeout(sh.flushTimer);
    try { sh.proc.kill(); } catch { /* ya se había ido */ }
  }

  const kill = () => [...shells.keys()].forEach(killPane);

  return {
    /** Abre la shell de una mitad (o se engancha a la que ya corre). `fresh`:
        la interfaz no tiene nada dibujado, así que vuelve lo último que se escribió. */
    open(w, { pane, cols = 80, rows = 24, fresh = false } = {}) {
      mine(w);
      const id = paneOf(pane);
      const sh = shells.get(id);
      if (!sh) {
        const born = spawn(id, cols, rows);
        return { pane: id, session: born.session, started: true, backlog: '' };
      }
      try { sh.proc.resize(Math.max(20, cols | 0), Math.max(5, rows | 0)); } catch { /* se estaba yendo */ }
      return { pane: id, session: sh.session, started: false, backlog: fresh ? sh.backlog : '' };
    },
    restart(w, size = {}) {
      mine(w);
      killPane(paneOf(size.pane));
      return this.open(w, size);
    },
    write(w, data, pane) {
      const sh = shells.get(paneOf(pane));
      if (w.private || !sh) return;
      sh.proc.write(String(data));
    },
    resize(w, cols, rows, pane) {
      const sh = shells.get(paneOf(pane));
      if (w.private || !sh) return;
      const c = Math.max(20, Math.min(1000, cols | 0));
      const r = Math.max(5, Math.min(500, rows | 0));
      try { sh.proc.resize(c, r); } catch { /* se estaba yendo */ }
    },
    /** Cierra una mitad (su cruz, o la división que se deshace). */
    close(w, pane) {
      if (w.private) return;
      killPane(paneOf(pane));
    },
    /** Las mitades con su shell viva: la interfaz que vuelve de cero se arma con estas. */
    panes: () => PANES.filter((id) => shells.has(id)),
    kill,
    branch: (dir) => branchFor(dir),
    stats() {
      const now = cpuSample();
      const idle = now.idle - lastCpu.idle;
      const total = now.total - lastCpu.total;
      lastCpu = now;
      const cpu = total > 0 ? Math.round((1 - idle / total) * 100) : 0;
      const mem = Math.round(((os.totalmem() - os.freemem()) / os.totalmem()) * 100);
      return { cpu: Math.max(0, Math.min(100, cpu)), mem };
    },
    /** Sin la pestaña de la terminal, las shells se cierran (la pestaña cerrada,
        o navegada a otra página). Lo llama tabs.cjs con cada cambio. */
    sync(w, tabs) {
      if (w.private || !shells.size) return;
      if (!tabs.some((t) => t.internal === 'terminal')) kill();
    },
    get alive() { return shells.size > 0; },
  };
}

module.exports = { createTerm, findPwsh, readBranch };
