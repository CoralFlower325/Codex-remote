const { contextBridge, ipcRenderer } = require('electron');
const invoke = (name, ...args) => ipcRenderer.invoke(`manager:${name}`, ...args);
contextBridge.exposeInMainWorld('manager', {
  get: () => invoke('get'),
  refresh: () => invoke('refresh'),
  dismiss: () => invoke('dismiss'),
  choose: () => invoke('choose'),
  detect: () => invoke('detect'),
  select: (directory) => invoke('select', directory),
  action: (action) => invoke('action', action),
  open: () => invoke('open'),
  check: () => invoke('check'),
  update: () => invoke('update'),
  managerCheck: () => invoke('managerCheck'),
  managerDownload: () => invoke('managerDownload'),
  managerInstall: () => invoke('managerInstall'),
  managerCancel: () => invoke('managerCancel'),
  managerInstaller: () => invoke('managerInstaller'),
  managerBackups: () => invoke('managerBackups'),
  recover: () => invoke('recover'),
  diagnose: () => invoke('diagnose'),
  repair: (target) => invoke('repair', target),
  logs: (kind) => invoke('logs', kind),
  security: (request) => invoke('security', request),
  folder: () => invoke('folder'),
  login: (value) => invoke('login', value),
  quit: () => invoke('quit'),
  subscribe: (listener) => {
    const handler = (_event, state) => listener(state);
    ipcRenderer.on('manager:state', handler);
    return () => ipcRenderer.removeListener('manager:state', handler);
  }
});
