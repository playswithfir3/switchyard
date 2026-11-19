const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('sy', {
  platform: process.platform,
  invoke: (name, ...args) => ipcRenderer.invoke(`sy:${name}`, ...args),
  send: (name, ...args) => ipcRenderer.send(`sy:${name}`, ...args),
  on: (name, cb) => {
    const f = (_e, ...args) => cb(...args);
    ipcRenderer.on(`sy:${name}`, f);
    return () => ipcRenderer.removeListener(`sy:${name}`, f);
  },
  pathForFile: (file) => webUtils.getPathForFile(file),
});
