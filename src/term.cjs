'use strict';

/* ═══════════════════════════════════════════════════════════════════════════
   PRISM — la terminal
   Una sola shell: PowerShell 7 en una pty (node-pty sobre ConPTY), dibujada
   por xterm.js en la pestaña prism://terminal de la ventana normal. Vive acá,
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

function createTerm(ctx) {
  let pty = null;        // node-pty, cargado recién cuando se abre la primera shell
  let proc = null;
  let session = 0;
  let backlog = '';
  let pending = '';
  let flushTimer = null;
  let lastCpu = cpuSample();
  let alive = false;

  const mine = (w) => {
    if (w.private) throw new Error('La terminal vive en la ventana normal.');
  };

  function flush() {
    flushTimer = null;
    if (!pending) return;
    const chunk = pending;
    pending = '';
    ctx.send('term:data', { session, data: chunk });
  }

  function onData(data) {
    backlog += data;
    if (backlog.length > BACKLOG_MAX) {
      // Se corta en un salto de línea: cortando en cualquier lado podía quedar
      // media secuencia de escape al principio, y el repaso la dibujaba.
      const from = backlog.length - BACKLOG_MAX * 0.75;
      const nl = backlog.indexOf('\n', from);
      backlog = backlog.slice(nl < 0 ? from : nl + 1);
    }
    pending += data;
    if (!flushTimer) flushTimer = setTimeout(flush, FLUSH_MS);
  }

  function spawn(cols, rows) {
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
    session += 1;
    backlog = '';
    pending = '';
    const mySession = session;
    proc = pty.spawn(exe, ['-NoLogo', '-NoExit', '-ExecutionPolicy', 'Bypass', '-Command', '. $env:PRISM_TERM_INIT'], {
      name: 'xterm-256color',
      cols: Math.max(20, cols | 0),
      rows: Math.max(5, rows | 0),
      cwd: os.homedir(),
      env,
      useConpty: true,
      useConptyDll: true,
    });
    alive = true;
    proc.onData(onData);
    proc.onExit(({ exitCode }) => {
      if (mySession !== session) return;
      flush();
      alive = false;
      proc = null;
      ctx.send('term:exit', { session: mySession, code: exitCode });
    });
  }

  function kill() {
    if (!proc) return;
    const p = proc;
    proc = null;
    alive = false;
    session += 1;      // lo que todavía escriba la que se va, ya no es de nadie
    clearTimeout(flushTimer);
    flushTimer = null;
    pending = '';
    backlog = '';
    try { p.kill(); } catch { /* ya se había ido */ }
  }

  return {
    /** Abre la shell (o se engancha a la que ya corre). `fresh`: la interfaz
        no tiene nada dibujado, así que vuelve lo último que se escribió. */
    open(w, { cols = 80, rows = 24, fresh = false } = {}) {
      mine(w);
      if (!alive) {
        spawn(cols, rows);
        return { session, started: true, backlog: '' };
      }
      try { proc.resize(Math.max(20, cols | 0), Math.max(5, rows | 0)); } catch { /* se estaba yendo */ }
      return { session, started: false, backlog: fresh ? backlog : '' };
    },
    restart(w, size = {}) {
      mine(w);
      kill();
      return this.open(w, size);
    },
    write(w, data) {
      if (w.private || !proc) return;
      proc.write(String(data));
    },
    resize(w, cols, rows) {
      if (w.private || !proc) return;
      const c = Math.max(20, Math.min(1000, cols | 0));
      const r = Math.max(5, Math.min(500, rows | 0));
      try { proc.resize(c, r); } catch { /* se estaba yendo */ }
    },
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
    /** Sin la pestaña de la terminal, la shell se cierra (la pestaña cerrada,
        o navegada a otra página). Lo llama tabs.cjs con cada cambio. */
    sync(w, tabs) {
      if (w.private || !proc) return;
      if (!tabs.some((t) => t.internal === 'terminal')) kill();
    },
    get alive() { return alive; },
  };
}

module.exports = { createTerm, findPwsh, readBranch };
