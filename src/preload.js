'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('usage', {
  getState: () => ipcRenderer.invoke('state:get'),
  refresh: (id) => ipcRenderer.invoke('refresh', id),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (payload) => ipcRenderer.invoke('settings:save', payload),
  hide: () => ipcRenderer.invoke('window:hide'),
  togglePin: () => ipcRenderer.invoke('window:togglePin'),
  fitHeight: (h) => ipcRenderer.invoke('window:fit', h),
  // Moves the window by script while pinned (the pinned top bar isn't a native drag area).
  dragWindow: (phase) => ipcRenderer.send('window:drag', phase),
  openConsole: (id) => ipcRenderer.invoke('open:console', id),
  updateAct: () => ipcRenderer.invoke('update:act'),
  // Native right-click menu for a card; resolves with the chosen action (or null).
  cardMenu: (opts) => ipcRenderer.invoke('card:menu', opts),
  onState: (cb) => {
    const h = (_e, s) => cb(s);
    ipcRenderer.on('state:update', h);
    return () => ipcRenderer.removeListener('state:update', h);
  },
  onOpenSettings: (cb) => {
    const h = () => cb();
    ipcRenderer.on('ui:open-settings', h);
    return () => ipcRenderer.removeListener('ui:open-settings', h);
  },
});
