const { contextBridge, ipcRenderer } = require('electron');
const invoke = (name, ...args) => ipcRenderer.invoke(`manager:${name}`, ...args);
contextBridge.exposeInMainWorld('manager', {
  get: () => invoke('get'),
  refresh: () => invoke('refresh'),
  choose: () => invoke('choose'),
  action: (action) => invoke('action', action),
  open: () => invoke('open'),
  check: () => invoke('check'),
  update: () => invoke('update'),
  folder: () => invoke('folder'),
  login: (value) => invoke('login', value),
  quit: () => invoke('quit'),
  subscribe: (listener) => {
    const handler = (_event, state) => listener(state);
    ipcRenderer.on('manager:state', handler);
    return () => ipcRenderer.removeListener('manager:state', handler);
  }
});
