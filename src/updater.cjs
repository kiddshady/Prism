'use strict';

/* ═══════════════════════════════════════════════════════════════════════════
   PRISM — actualizaciones
   La receta de Umbral y Quire, probada de punta a punta: sin servidor propio.
   electron-builder sube un `latest.yml` a cada release de GitHub y
   electron-updater lo lee: la lista de versiones ES la lista de releases de
   kiddshady/Prism.

   Se busca sola al arrancar y cada 6 h (Prism vive en la bandeja y puede
   pasar días sin cerrarse), pero NO se baja sin que digas que sí: el
   instalador pesa ~100 MB. Si la bajaste y nunca tocás "Reiniciar", entra
   igual la próxima vez que salís de Prism.

   No funciona desde el código fuente ni en una portable; ahí se dice, no se
   falla callado. Para probar el cartel desde el código:
     PRISM_UPDATE_TEST=1 npm start   (finge ser la 0.0.1 contra los releases reales)
   ═══════════════════════════════════════════════════════════════════════════ */

const path = require('path');
const { app } = require('electron');

const RELEASES = 'https://github.com/kiddshady/Prism/releases';
const EVERY_MS = 6 * 60 * 60 * 1000;

let autoUpdater = null;
let emit = () => {};

// fase: idle · unsupported · checking · current · available · downloading · ready · error
const EMPTY = {
  phase: 'idle',
  current: '',
  version: null,
  name: null,
  bytes: 0,
  pct: 0,
  reason: '',
  error: '',
  url: RELEASES,
  // Si la búsqueda la pediste vos. Un "estás al día" o un error de red solo
  // se muestran en ese caso: en cada arranque serían puro ruido.
  manual: false,
};

let state = { ...EMPTY };

function set(patch) {
  state = { ...state, ...patch };
  emit(state);
  return state;
}

// El error de electron-updater trae stack y URL adentro: alcanza la primera línea.
function message(err) {
  const text = String(err?.message || err || 'Error desconocido').split('\n')[0].trim();
  if (/ENOTFOUND|ENETUNREACH|EAI_AGAIN|getaddrinfo/i.test(text)) return 'No se pudo llegar a GitHub. ¿Hay internet?';
  if (/ETIMEDOUT|ESOCKETTIMEDOUT/i.test(text)) return 'GitHub no contestó a tiempo.';
  // Recién publicado, el nodo de GitHub que toca puede tardar ~2 min en tenerlo.
  if (/404/.test(text)) return 'La versión nueva todavía no está lista en GitHub. Probá en un rato.';
  return text;
}

function init({ onChange }) {
  emit = onChange || emit;
  state = { ...EMPTY, current: app.getVersion() };

  const devTest = !app.isPackaged && process.env.PRISM_UPDATE_TEST;
  if (!app.isPackaged && !devTest) {
    return set({ phase: 'unsupported', reason: 'Desde el código fuente no hay nada que actualizar: usá git.' });
  }
  if (process.env.PORTABLE_EXECUTABLE_FILE) {
    return set({ phase: 'unsupported', reason: 'La portable no se actualiza sola: bajate la nueva de GitHub.' });
  }

  ({ autoUpdater } = require('electron-updater'));
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = null;
  if (devTest) {
    autoUpdater.updateConfigPath = path.join(__dirname, '..', 'dev-app-update.yml');
    autoUpdater.forceDevUpdateConfig = true;
    autoUpdater.currentVersion = '0.0.1';
    state.current = '0.0.1';
  }

  autoUpdater.on('checking-for-update', () => set({ phase: 'checking', error: '' }));
  autoUpdater.on('update-available', (info) => set({
    phase: 'available',
    version: info?.version || null,
    name: String(info?.releaseName || '').trim() || `Prism ${info?.version || ''}`.trim(),
    bytes: Number(info?.files?.[0]?.size) || 0,
    url: info?.version ? `${RELEASES}/tag/v${info.version}` : RELEASES,
  }));
  autoUpdater.on('update-not-available', () => set({ phase: 'current', version: null }));
  // percent viene 0–100.
  autoUpdater.on('download-progress', (p) => set({
    phase: 'downloading',
    pct: Math.max(0, Math.min(1, Number(p?.percent || 0) / 100)),
  }));
  autoUpdater.on('update-downloaded', (info) => set({ phase: 'ready', version: info?.version || state.version, pct: 1 }));
  autoUpdater.on('error', (err) => set({ phase: 'error', error: message(err) }));

  setTimeout(() => check(), 10000);
  setInterval(() => check(), EVERY_MS);
  return state;
}

async function check({ manual = false } = {}) {
  if (!autoUpdater) return set({ manual });
  // No pisar una búsqueda o descarga en curso, ni tirar una ya bajada.
  if (['checking', 'downloading', 'ready'].includes(state.phase)) return state;
  set({ manual });
  try {
    await autoUpdater.checkForUpdates();
  } catch (err) {
    set({ phase: 'error', error: message(err) });
  }
  return state;
}

async function download() {
  if (!autoUpdater || state.phase !== 'available') return state;
  set({ phase: 'downloading', pct: 0 });
  try {
    await autoUpdater.downloadUpdate();
  } catch (err) {
    set({ phase: 'error', error: message(err) });
  }
  return state;
}

/** Cierra e instala. `beforeQuit` marca que la salida es de verdad (no a la bandeja). */
function install(beforeQuit) {
  if (!autoUpdater || state.phase !== 'ready') return false;
  setImmediate(() => {
    beforeQuit?.();
    autoUpdater.quitAndInstall(true, true);
  });
  return true;
}

module.exports = { init, check, download, install, get: () => state, RELEASES };
