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
  openConsole: (id) => ipcRenderer.invoke('open:console', id),
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
