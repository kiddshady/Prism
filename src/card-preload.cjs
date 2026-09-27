'use strict';

/* PRISM — preload de la tarjeta de la esquina (card.cjs). Lo único que puede
   hacer: recibir qué mostrar, avisar su alto y decir qué botón se tocó. */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('card', {
  onShow: (cb) => ipcRenderer.on('card:show', (_e, d) => cb(d)),
  onHide: (cb) => ipcRenderer.on('card:hide', () => cb()),
  act: (id) => ipcRenderer.send('card:act', String(id)),
  size: (h) => ipcRenderer.send('card:size', Number(h)),
  gone: () => ipcRenderer.send('card:gone'),
});
