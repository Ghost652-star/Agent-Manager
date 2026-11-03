const { app, BrowserWindow, ipcMain, dialog, Notification, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const { execFile } = require('child_process');
const pty = require('node-pty');
const chokidar = require('chokidar');
const worktree = require('./worktree');
const workspaces = require('./workspaces');
const sessionsStore = require('./sessions');
const git = require('./git');
const agents = require('./agents');
const config = require('./config');

const sessions = new Map();
let mainWindow;

// Windows 上杀掉 PowerShell 本身不会带走它启动的 agent 子进程，
// 用 taskkill /T 结束整棵进程树，避免后台残留 node/claude 进程。
function killSessionProcess(session) {
  if (!session || !session.pty) return;
  const term = session.pty;
  if (process.platform === 'win32' && term.pid) {
    execFile('taskkill', ['/PID', String(term.pid), '/T', '/F'], { windowsHide: true }, () => {
      try { term.kill(); } catch { /* 已退出 */ }
    });
    return;
  }
  try { term.kill(); } catch { /* 已退出 */ }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0a0a0a',
    titleBarStyle: 'default',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // preload 只用到 contextBridge / ipcRenderer，开沙箱不会有副作用
      sandbox: true
    }
  });

  // 禁止页面被导航走（例如点开 README 里的外链）；外链交给系统浏览器
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url === mainWindow.webContents.getURL()) return;
    event.preventDefault();
    if (/^https?:/i.test(url)) shell.openExternal(url);
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));

  mainWindow.on('closed', () => {
    sessions.forEach(s => killSessionProcess(s));
    sessions.clear();
    if (fsWatcher) {
      try { fsWatcher.close(); } catch { /* 忽略 */ }
      fsWatcher = null;
    }
    mainWindow = null;
  });
}

// 单实例：第二个实例直接唤起已有窗口，避免两个进程同时写 config、抢 worktree
const gotSingleInstanceLock = app.requestSingleInstanceLock();

if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  app.whenReady().then(() => {
    // 启动时：清理 30 天前的旧会话；把残留的 running 状态改为 exited（进程已随重启消失）
    try {
      sessionsStore.prune();
      for (const s of sessionsStore.list()) {
        if (s.status === 'running') sessionsStore.setStatus(s.id, 'exited');
      }
    } catch { /* 持久化清理失败不影响启动 */ }
    createWindow();
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

ipcMain.handle('app:select-project', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title: '选择项目目录'
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

ipcMain.handle('app:select-directory', async (e, { title = '选择目录' } = {}) => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

ipcMain.handle('config:get', () => config.read());
ipcMain.handle('config:set', (e, cfg) => config.write(cfg));

// 只允许用系统浏览器打开 http/https/mailto，其他协议一律拒绝
ipcMain.handle('app:open-external', async (e, { url }) => {
  try {
    const parsed = new URL(String(url));
    if (!['http:', 'https:', 'mailto:'].includes(parsed.protocol)) {
      return { success: false, error: '不支持的链接协议' };
    }
    await shell.openExternal(parsed.href);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// ---------- 文件面板（只读浏览） ----------

// 防路径穿越：target 必须位于 root 内部（或就是 root）
function isInside(root, target) {
  if (root === target) return true;
  const rel = path.relative(root, target);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

// 隐藏噪音目录，避免树过大
const IGNORED_DIRS = new Set(['.git', 'node_modules']);

ipcMain.handle('fs:readdir', async (e, { root, relPath = '' }) => {
  if (!root) return { success: false, error: '未选择项目' };
  const base = path.resolve(root);
  const target = path.resolve(base, relPath);
  if (!isInside(base, target)) return { success: false, error: '路径越界' };
  try {
    const dirents = await fsp.readdir(target, { withFileTypes: true });
    const entries = [];
    for (const d of dirents) {
      if (d.isDirectory() && IGNORED_DIRS.has(d.name)) continue;
      entries.push({ name: d.name, isDir: d.isDirectory() });
    }
    entries.sort((a, b) => (b.isDir - a.isDir) || a.name.localeCompare(b.name, 'zh-CN'));
    return { success: true, entries };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

const MAX_PREVIEW_SIZE = 2 * 1024 * 1024; // 2MB
const MAX_PREVIEW_LINES = 5000;

// ---------- Git 状态（只读查询，不提供任何写操作） ----------

ipcMain.handle('git:status', async (e, { projectPath, wtPath }) => {
  try {
    const info = await git.worktreeStatus(projectPath, wtPath);
    return { success: true, ...info };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('git:diff', async (e, { wtPath, relPath }) => {
  try {
    return { success: true, diff: await git.diffFile(wtPath, relPath) };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// ---------- 文件树自动刷新（chokidar，仅监视当前浏览根目录） ----------

let fsWatcher = null;
let fsWatchNotifyTimer = null;

// 这些目录/文件的变化不触发刷新：体积大、刷新无意义，且会造成事件风暴
const WATCH_IGNORED_DIRS = new Set([
  '.git', 'node_modules', 'target', 'dist', 'build', 'out',
  '.idea', '.vscode', '.gradle', '.mvn', 'coverage'
]);

ipcMain.handle('fs:watch', (e, { root }) => {
  if (fsWatcher) {
    try { fsWatcher.close(); } catch { /* 忽略 */ }
    fsWatcher = null;
  }
  if (!root || !fs.existsSync(root)) return { success: false, error: '目录不存在' };
  const base = path.resolve(root);

  const shouldIgnore = p => {
    const rel = path.relative(base, p);
    if (!rel) return false; // 根目录本身不能忽略
    if (rel.split(path.sep).some(seg => WATCH_IGNORED_DIRS.has(seg))) return true;
    return /\.(class|jar|war|ear|log|tmp)$/i.test(p);
  };

  try {
    fsWatcher = chokidar.watch(base, {
      ignoreInitial: true,
      ignored: shouldIgnore,
      awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 }
    });

    const notify = () => {
      if (fsWatchNotifyTimer) return; // 事件风暴时节流，600ms 最多通知一次
      fsWatchNotifyTimer = setTimeout(() => {
        fsWatchNotifyTimer = null;
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('fs:changed', { root: base });
        }
      }, 600);
    };

    fsWatcher.on('add', notify).on('change', notify).on('unlink', notify)
      .on('addDir', notify).on('unlinkDir', notify);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('fs:readfile', async (e, { root, relPath }) => {
  if (!root) return { success: false, error: '未选择项目' };
  const base = path.resolve(root);
  const target = path.resolve(base, relPath);
  if (!isInside(base, target)) return { success: false, error: '路径越界' };
  try {
    const stat = await fsp.stat(target);
    if (stat.isDirectory()) return { success: false, error: '这是一个目录' };
    if (stat.size > MAX_PREVIEW_SIZE) {
      return { success: false, error: `文件过大（${(stat.size / 1024 / 1024).toFixed(1)}MB），不支持预览` };
    }
    const buf = await fsp.readFile(target);
    if (buf.includes(0)) {
      const ext = path.extname(target).toLowerCase();
      if (ext === '.class') return { success: false, error: 'Java 编译后的字节码文件（.class），请查看对应的 .java 源文件。' };
      if (['.jar', '.war', '.ear'].includes(ext)) return { success: false, error: 'Java 归档压缩包，二进制文件，不支持预览。' };
      return { success: false, error: '二进制文件，不支持预览' };
    }
    const content = buf.toString('utf-8');
    return { success: true, content, truncated: false, maxLines: MAX_PREVIEW_LINES };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('agent:detect', async () => agents.detect());

// ---------- 会话持久化（重启恢复） ----------

ipcMain.handle('session:list', async (e, { projectPath }) => {
  try {
    return { success: true, sessions: sessionsStore.list(projectPath) };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('session:forget', async (e, { sessionId }) => {
  try {
    return { success: true, removed: sessionsStore.forget(sessionId) };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// 恢复前体检：工作区是否还在、agent 是否可用
ipcMain.handle('session:check', async (e, { projectPath, sessionId }) => {
  const rec = sessionsStore.byId(sessionId);
  if (!rec) return { success: false, error: '会话记录不存在' };

  const ws = rec.workspaceId ? await workspaces.byId(projectPath, rec.workspaceId) : null;
  const missing = !ws || ws.status === 'missing';
  const agentList = await agents.detect();
  const agentOk = agentList.some(a => a.command === rec.agentCommand);

  return {
    success: true,
    session: rec,
    workspace: ws,
    workspaceMissing: missing,
    agentOk
  };
});

// ---------- 工作区（三类：default / managed / external） ----------

ipcMain.handle('workspace:list', async (e, { projectPath }) => {
  try {
    return { success: true, workspaces: await workspaces.list(projectPath) };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('workspace:create', async (e, { projectPath, agentCommand, name }) => {
  try {
    const cfg = config.read();
    return { success: true, workspace: await workspaces.createManaged(projectPath, agentCommand, cfg, name) };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('workspace:attach', async (e, { projectPath, path: wtPath }) => {
  try {
    return { success: true, workspace: await workspaces.attachExternal(projectPath, wtPath) };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('workspace:rename', async (e, { projectPath, id, name }) => {
  try {
    return { success: true, workspace: await workspaces.renameWorkspace(projectPath, id, name) };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('workspace:archive', async (e, { projectPath, id }) => {
  try {
    return { success: true, result: await workspaces.archive(projectPath, id) };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// ---------- 审查闭环（M4） ----------

// 查看 worktree 相对 base 的 diff 统计
ipcMain.handle('review:diffstat', async (e, { projectPath, workspaceId }) => {
  try {
    const ws = await workspaces.byId(projectPath, workspaceId);
    if (!ws) throw new Error('工作区不存在');
    const stats = await worktree.diffStats(projectPath, ws.worktreePath, ws.baseBranch || 'HEAD');
    return { success: true, ...stats };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// 合并回 base 分支
ipcMain.handle('review:merge', async (e, { projectPath, workspaceId }) => {
  try {
    const ws = await workspaces.byId(projectPath, workspaceId);
    if (!ws) throw new Error('工作区不存在');
    const result = await worktree.mergeToBase(projectPath, ws.worktreePath, ws.branch, ws.baseBranch);
    return { success: true, ...result };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// 丢弃全部未提交改动（二次确认由前端处理）
ipcMain.handle('review:discard', async (e, { projectPath, workspaceId, confirm }) => {
  try {
    const ws = await workspaces.byId(projectPath, workspaceId);
    if (!ws) throw new Error('工作区不存在');
    const count = await worktree.countDirty(ws.worktreePath);
    if (count === 0) return { success: true, discarded: 0 };
    if (!confirm) return { success: false, error: '需要确认', dirtyCount: count };
    await worktree.discardAllChanges(ws.worktreePath);
    return { success: true, discarded: count };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// ---------- 任务完成通知（空闲检测） ----------
// 原理：终端持续无输出 + 软件窗口不在前台 → 弹系统通知。
// 不做关键词匹配（各家 agent 提示语不同且常变，误报率高），只用两个稳定信号。
// 每段空闲只提醒一次：只有产生新输出后才重新武装，避免人不在时每 5 分钟骚扰。

const IDLE_NOTIFY_MS = 60 * 1000; // 终端空闲 60 秒视为"可能完成"

setInterval(() => {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.isFocused()) return;
  const now = Date.now();
  for (const [sessionId, s] of sessions) {
    if (s.exited || !s.lastDataAt || s.idleNotified) continue;
    const idleFor = now - s.lastDataAt;
    if (idleFor >= IDLE_NOTIFY_MS) {
      try {
        const n = new Notification({
          title: `${s.agentCommand} 可能已经完成 / 等你输入`,
          body: `空闲了 ${Math.round(idleFor / 1000)} 秒。工作树：${s.worktreePath}`,
          silent: false
        });
        n.on('click', () => {
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.show();
            mainWindow.focus();
            mainWindow.webContents.send('session:activate', { sessionId });
          }
        });
        n.show();
      } catch {
        // 系统不支持通知时静默跳过
      }
      s.idleNotified = true;
    }
  }
}, 5000);

ipcMain.handle('agent:launch', async (e, { projectPath, agentCommand, sessionId, workspaceId }) => {
  try {
    // 命令来自检测列表，仍做一次白名单校验，避免被拼接成任意命令
    if (!/^[A-Za-z0-9._-]+$/.test(String(agentCommand))) {
      throw new Error('非法的 agent 命令');
    }

    const cfg = config.read();

    // 优先复用指定工作区（M2 会话恢复），否则新建 managed 工作区
    let ws;
    if (workspaceId) {
      ws = await workspaces.byId(projectPath, workspaceId);
      if (!ws) throw new Error('指定的工作区不存在');
      if (ws.status === 'missing') throw new Error('工作区目录已丢失，无法启动');
    } else {
      ws = await workspaces.createManaged(projectPath, agentCommand, cfg);
    }
    const wtPath = ws.worktreePath;

    // Windows 用 -NoExit -Command 直接把 agent 作为 shell 的初始命令执行，
    // 不再依赖"等 600ms 再敲命令"的时序，慢机器也不会丢命令。
    const shellPath = process.platform === 'win32' ? 'powershell.exe' : 'bash';
    const shellArgs = process.platform === 'win32'
      ? ['-NoLogo', '-NoExit', '-Command', agentCommand]
      : ['-c', agentCommand];

    const p = pty.spawn(shellPath, shellArgs, {
      name: 'xterm-256color',
      cwd: wtPath,
      env: process.env
    });

    sessions.set(sessionId, {
      pty: p,
      worktreePath: wtPath,
      workspaceId: ws.id,
      agentCommand,
      projectPath,
      lastDataAt: Date.now(),
      idleNotified: false,
      exited: false
    });

    // 持久化会话记录（重启后可恢复）
    sessionsStore.record({
      sessionId,
      agentCommand,
      agentLabel: agentCommand,
      projectPath,
      workspaceId: ws.id,
      worktreePath: wtPath
    });

    p.onData(data => {
      const s = sessions.get(sessionId);
      if (s) {
        s.lastDataAt = Date.now();
        s.idleNotified = false; // 有新输出 → 下一段空闲可以再次提醒
      }
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('pty:data', { sessionId, data });
      }
    });

    p.onExit(({ exitCode, signal }) => {
      const s = sessions.get(sessionId);
      if (s) s.exited = true;
      sessionsStore.setStatus(sessionId, 'exited');
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('pty:exit', { sessionId, exitCode, signal });
      }
      sessions.delete(sessionId);
    });

    return { success: true, worktreePath: wtPath, workspaceId: ws.id, workspaceName: ws.name };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.on('pty:input', (e, { sessionId, data }) => {
  const s = sessions.get(sessionId);
  if (s) s.pty.write(data);
});

ipcMain.on('pty:resize', (e, { sessionId, cols, rows }) => {
  const s = sessions.get(sessionId);
  if (s) s.pty.resize(cols, rows);
});

ipcMain.on('pty:kill', (e, { sessionId }) => {
  const s = sessions.get(sessionId);
  if (!s) return;
  const finish = () => {
    killSessionProcess(s);
    sessions.delete(sessionId);
  };
  if (s.exited) return finish();
  // 先发 Ctrl+C 让 agent 有机会收尾，400ms 后再强杀
  try { s.pty.write('\x03'); } catch { /* 忽略 */ }
  setTimeout(finish, 400);
});

ipcMain.handle('worktree:cleanup', async (e, { projectPath, wtPath }) => {
  try {
    await worktree.cleanup(projectPath, wtPath);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});
