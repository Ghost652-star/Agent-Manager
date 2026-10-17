const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  selectProject: () => ipcRenderer.invoke('app:select-project'),
  selectDirectory: opts => ipcRenderer.invoke('app:select-directory', opts),
  getConfig: () => ipcRenderer.invoke('config:get'),
  setConfig: cfg => ipcRenderer.invoke('config:set', cfg),
  detectAgents: () => ipcRenderer.invoke('agent:detect'),
  launchAgent: params => ipcRenderer.invoke('agent:launch', params),
  cleanupWorktree: params => ipcRenderer.invoke('worktree:cleanup', params),
  readDir: params => ipcRenderer.invoke('fs:readdir', params),
  readFile: params => ipcRenderer.invoke('fs:readfile', params),
  watchTree: params => ipcRenderer.invoke('fs:watch', params),

  gitStatus: params => ipcRenderer.invoke('git:status', params),
  gitDiff: params => ipcRenderer.invoke('git:diff', params),

  onFsChanged: cb => ipcRenderer.on('fs:changed', (e, data) => cb(data)),
  onSessionActivate: cb => ipcRenderer.on('session:activate', (e, data) => cb(data)),

  onPtyData: cb => ipcRenderer.on('pty:data', (e, data) => cb(data)),
  onPtyExit: cb => ipcRenderer.on('pty:exit', (e, data) => cb(data)),
  removeAllListeners: channel => ipcRenderer.removeAllListeners(channel),

  ptyInput: params => ipcRenderer.send('pty:input', params),
  ptyResize: params => ipcRenderer.send('pty:resize', params),
  ptyKill: params => ipcRenderer.send('pty:kill', params)
});
