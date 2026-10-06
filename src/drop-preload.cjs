'use strict';

/* ═══════════════════════════════════════════════════════════════════════════
   PRISM — preload de las páginas: archivos soltados
   Un PDF arrastrado desde el Explorador y soltado sobre una página se abre en
   su pestaña, como en Chrome, pero sin reemplazar la página de abajo.

   Solo si la página no lo usó. Un sitio que recibe adjuntos (Drive, WhatsApp,
   el campus) cancela el drop porque lo toma él, y ahí Prism no hace nada. Lo
   mismo un <input type="file"> de un formulario, que se queda con el archivo
   sin cancelarlo. Si el sitio lo tomó o no se sabe cuando el evento terminó
   de pasar por todos (también los listeners que la página puso después que
   este), así que la decisión espera a la tarea siguiente.

   Las rutas salen de webUtils (las páginas no las ven) y el proceso principal
   vuelve a filtrar qué se abre (default-browser.cjs, fileTargets).
   ═══════════════════════════════════════════════════════════════════════════ */

const { ipcRenderer, webUtils } = require('electron');

const withFiles = (e) => e.isTrusted && !!e.dataTransfer && [...e.dataTransfer.types].includes('Files');

// Sin aceptar el dragover no llega el drop. Si la página ya lo aceptó (o lo rechazó), es suyo.
window.addEventListener('dragover', (e) => {
  if (!withFiles(e) || e.defaultPrevented) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
});

window.addEventListener('drop', (e) => {
  if (!withFiles(e)) return;
  if (e.target instanceof Element && e.target.closest('input[type="file"]')) return;
  // Los archivos se leen durante el evento: después el dataTransfer queda vacío.
  const paths = [...e.dataTransfer.files]
    .map((f) => { try { return webUtils.getPathForFile(f); } catch { return ''; } })
    .filter(Boolean);
  if (!paths.length) return;
  setTimeout(() => { if (!e.defaultPrevented) ipcRenderer.send('page:drop-files', paths); }, 0);
});
