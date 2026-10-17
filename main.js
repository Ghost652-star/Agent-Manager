const { app, BrowserWindow, ipcMain, dialog, Notification } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const pty = require('node-pty');
const worktree = require('./worktree');
const git = require('./git');
const agents = require('./agents');
const config = require('./config');

const sessions = new Map();
let mainWindow;

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
      sandbox: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));

  mainWindow.on('closed', () => {
    sessions.forEach(s => s.pty.kill());
    sessions.clear();
    mainWindow = null;
  });
}

app.whenReady().then(createWindow);

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

// ---------- 文件树自动刷新（fs.watch，仅监视当前浏览根目录） ----------

let fsWatcher = null;
let fsWatchNotifyTimer = null;

ipcMain.handle('fs:watch', (e, { root }) => {
  if (fsWatcher) {
    try { fsWatcher.close(); } catch { /* 忽略 */ }
    fsWatcher = null;
  }
  if (!root || !fs.existsSync(root)) return { success: false, error: '目录不存在' };
  const base = path.resolve(root);
  try {
    fsWatcher = fs.watch(base, { recursive: true }, () => {
      if (fsWatchNotifyTimer) return; // 事件风暴时节流，1 秒最多通知一次
      fsWatchNotifyTimer = setTimeout(() => {
        fsWatchNotifyTimer = null;
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('fs:changed', { root: base });
        }
      }, 1000);
    });
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

// ---------- 任务完成通知（空闲检测） ----------
// 原理：终端持续无输出 + 软件窗口不在前台 → 弹系统通知。
// 不做关键词匹配（各家 agent 提示语不同且常变，误报率高），只用两个稳定信号。
// 每个会话 5 分钟最多提醒一次，点通知跳转到对应 tab。

const IDLE_NOTIFY_MS = 60 * 1000;        // 终端空闲 60 秒视为"可能完成"
const NOTIFY_THROTTLE_MS = 5 * 60 * 1000; // 同一会话 5 分钟内不重复提醒

setInterval(() => {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.isFocused()) return;
  const now = Date.now();
  for (const [sessionId, s] of sessions) {
    if (s.exited || !s.lastDataAt) continue;
    const idleFor = now - s.lastDataAt;
    if (idleFor >= IDLE_NOTIFY_MS && now - (s.lastNotifiedAt || 0) >= NOTIFY_THROTTLE_MS) {
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
      s.lastNotifiedAt = now;
    }
  }
}, 5000);

ipcMain.handle('agent:launch', async (e, { projectPath, agentCommand, sessionId }) => {
  try {
    const cfg = config.read();
    const wtPath = await worktree.ensure(projectPath, agentCommand, cfg);
    const shell = process.platform === 'win32' ? 'powershell.exe' : 'bash';
    const p = pty.spawn(shell, [], {
      name: 'xterm-256color',
      cwd: wtPath,
      env: process.env
    });

    sessions.set(sessionId, {
      pty: p,
      worktreePath: wtPath,
      agentCommand,
      projectPath,
      lastDataAt: Date.now(),
      lastNotifiedAt: 0,
      exited: false
    });

    p.onData(data => {
      const s = sessions.get(sessionId);
      if (s) s.lastDataAt = Date.now();
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('pty:data', { sessionId, data });
      }
    });

    p.onExit(({ exitCode, signal }) => {
      const s = sessions.get(sessionId);
      if (s) s.exited = true;
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('pty:exit', { sessionId, exitCode, signal });
      }
      sessions.delete(sessionId);
    });

    // 让 shell 初始化一会儿，再自动输入 agent 命令
    setTimeout(() => {
      p.write(`${agentCommand}\r`);
    }, 600);

    return { success: true, worktreePath: wtPath };
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
  if (s) {
    s.pty.kill();
    sessions.delete(sessionId);
  }
});

ipcMain.handle('worktree:cleanup', async (e, { projectPath, agentCommand }) => {
  try {
    const cfg = config.read();
    await worktree.cleanup(projectPath, agentCommand, cfg);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});
