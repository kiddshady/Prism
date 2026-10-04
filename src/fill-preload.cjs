'use strict';

/* PRISM — preload de la lista de contraseñas y tarjetas (fill.cjs). Lo único
   que puede hacer: recibir qué mostrar, avisar su alto, y decir sobre qué
   fila está el mouse y cuál se eligió. */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('fill', {
  onRender: (cb) => ipcRenderer.on('fill:render', (_e, d) => cb(d)),
  onDir: (cb) => ipcRenderer.on('fill:dir', (_e, up) => cb(!!up)),
  onOn: (cb) => ipcRenderer.on('fill:on', () => cb()),
  onOff: (cb) => ipcRenderer.on('fill:off', () => cb()),
  onActive: (cb) => ipcRenderer.on('fill:active', (_e, i) => cb(Number(i))),
  size: (h) => ipcRenderer.send('fill:size', Number(h)),
  hover: (i) => ipcRenderer.send('fill:hover', Number(i)),
  press: () => ipcRenderer.send('fill:press'),
  pick: (i) => ipcRenderer.send('fill:pick', Number(i)),
});
