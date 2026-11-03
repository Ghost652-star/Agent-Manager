/**
 * 会话持久化 —— data/sessions.json
 *
 * 记录每次 agent 会话的元数据（项目、agent、工作区、标题、状态），
 * 重启后恢复为"已退出"标签，点击可一键用原 agent + 原工作区重启。
 *
 * 不持久化进程本身（PTY 随应用退出而结束）——
 * 恢复的是"上下文"，不是"进程"。
 */
const path = require('path');
const fs = require('fs');
const config = require('./config');

const REG_VERSION = 1;
const PRUNE_DAYS = 30;

function sessionsPath() {
  return path.join(config.configDir(), 'sessions.json');
}

function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(sessionsPath(), 'utf-8'));
    if (raw && raw.version === REG_VERSION && Array.isArray(raw.sessions)) return raw;
  } catch {
    // 文件不存在或损坏 → 从零开始
  }
  return { version: REG_VERSION, sessions: [] };
}

function save(reg) {
  const dir = config.configDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const target = sessionsPath();
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(reg, null, 2));
  fs.renameSync(tmp, target);
}

function newId() {
  return `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 启动会话时登记（状态 running）。
 *   sessionId 可传入（与 renderer 的会话 id 对齐），否则自动生成。
 */
function record({ sessionId, agentCommand, agentLabel, projectPath, workspaceId, worktreePath, title }) {
  const reg = load();
  const id = sessionId || newId();
  const now = Date.now();
  const existing = reg.sessions.find(s => s.id === id);

  if (existing) {
    // 复用（会话恢复场景）：更新状态为 running，保留 createdAt
    existing.status = 'running';
    existing.lastActiveAt = now;
    existing.worktreePath = worktreePath || existing.worktreePath;
    existing.workspaceId = workspaceId || existing.workspaceId;
    if (title) existing.title = title;
  } else {
    reg.sessions.push({
      id,
      agentCommand,
      agentLabel: agentLabel || agentCommand,
      projectPath,
      workspaceId: workspaceId || null,
      worktreePath: worktreePath || null,
      title: title || '',
      createdAt: now,
      lastActiveAt: now,
      status: 'running'
    });
  }
  save(reg);
  return id;
}

/**
 * 会话状态变更。
 *   status: 'running' | 'exited' | 'lost'
 */
function setStatus(sessionId, status) {
  const reg = load();
  const rec = reg.sessions.find(s => s.id === sessionId);
  if (!rec) return;
  rec.status = status;
  rec.lastActiveAt = Date.now();
  save(reg);
}

function setTitle(sessionId, title) {
  const reg = load();
  const rec = reg.sessions.find(s => s.id === sessionId);
  if (!rec) return;
  rec.title = String(title || '').slice(0, 120);
  save(reg);
}

/**
 * 列出会话。可按项目过滤。
 *   - status 'lost' 表示工作区目录已消失，恢复前需要提示
 */
function list(projectPath) {
  const reg = load();
  let sessions = reg.sessions;
  if (projectPath) {
    const key = path.resolve(projectPath).replace(/\\/g, '/');
    sessions = sessions.filter(s => {
      const sp = s.projectPath ? path.resolve(s.projectPath).replace(/\\/g, '/') : '';
      return sp === key;
    });
  }
  return sessions.slice().sort((a, b) => (b.lastActiveAt || 0) - (a.lastActiveAt || 0));
}

function byId(sessionId) {
  const reg = load();
  return reg.sessions.find(s => s.id === sessionId) || null;
}

/**
 * 清理旧记录：30 天未活动且状态为 exited 的记录。
 * 启动时执行一次。
 */
function prune() {
  const reg = load();
  const cutoff = Date.now() - PRUNE_DAYS * 24 * 60 * 60 * 1000;
  const before = reg.sessions.length;
  reg.sessions = reg.sessions.filter(s => {
    if (s.status === 'exited' && (s.lastActiveAt || 0) < cutoff) return false;
    return true;
  });
  const removed = before - reg.sessions.length;
  if (removed > 0) save(reg);
  return removed;
}

/**
 * 删除一条记录（用户主动"忘记"）。
 */
function forget(sessionId) {
  const reg = load();
  const before = reg.sessions.length;
  reg.sessions = reg.sessions.filter(s => s.id !== sessionId);
  if (reg.sessions.length !== before) save(reg);
  return reg.sessions.length !== before;
}

module.exports = {
  record,
  setStatus,
  setTitle,
  list,
  byId,
  prune,
  forget,
  sessionsPath
};
