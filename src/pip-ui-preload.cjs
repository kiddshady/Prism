'use strict';

/* PRISM — preload de los controles de la ventanita (pip.cjs). Lo único que
   pueden hacer: recibir el estado del video, pedir una acción y arrastrar. */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pip', {
  onState: (cb) => ipcRenderer.on('pipui:state', (_e, s) => cb(s)),
  act: (op, arg = 0) => ipcRenderer.send('pipui:act', String(op), Number(arg) || 0),
  drag: (phase) => ipcRenderer.send('pipui:drag', String(phase)),
});
