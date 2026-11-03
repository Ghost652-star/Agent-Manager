const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  selectProject: () => ipcRenderer.invoke('app:select-project'),
  selectDirectory: opts => ipcRenderer.invoke('app:select-directory', opts),
  openExternal: url => ipcRenderer.invoke('app:open-external', { url }),
  getConfig: () => ipcRenderer.invoke('config:get'),
  setConfig: cfg => ipcRenderer.invoke('config:set', cfg),
  detectAgents: () => ipcRenderer.invoke('agent:detect'),
  launchAgent: params => ipcRenderer.invoke('agent:launch', params),
  cleanupWorktree: params => ipcRenderer.invoke('worktree:cleanup', params),

  // 会话持久化（重启恢复）
  listSessions: params => ipcRenderer.invoke('session:list', params),
  forgetSession: params => ipcRenderer.invoke('session:forget', params),
  checkSession: params => ipcRenderer.invoke('session:check', params),

  // 工作区（default / managed / external）
  listWorkspaces: params => ipcRenderer.invoke('workspace:list', params),
  listAllWorkspaces: params => ipcRenderer.invoke('workspace:list-all', params),
  createWorkspace: params => ipcRenderer.invoke('workspace:create', params),
  attachWorkspace: params => ipcRenderer.invoke('workspace:attach', params),
  renameWorkspace: params => ipcRenderer.invoke('workspace:rename', params),
  archiveWorkspace: params => ipcRenderer.invoke('workspace:archive', params),

  // 审查闭环
  reviewDiffstat: params => ipcRenderer.invoke('review:diffstat', params),
  reviewMerge: params => ipcRenderer.invoke('review:merge', params),
  reviewDiscard: params => ipcRenderer.invoke('review:discard', params),
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
