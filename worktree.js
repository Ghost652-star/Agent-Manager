const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');

function run(cwd, cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd, encoding: 'utf-8', windowsHide: true }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else resolve(stdout.trim());
    });
  });
}

async function gitExists(projectPath) {
  try {
    await run(projectPath, 'git', ['rev-parse', '--git-dir']);
    return true;
  } catch {
    return false;
  }
}

async function initGit(projectPath) {
  await run(projectPath, 'git', ['init']);
  try {
    await run(projectPath, 'git', ['checkout', '-b', 'main']);
  } catch {
    // 可能已经存在 main 分支
  }
}

function sanitize(name) {
  return name.replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase();
}

function worktreeRootFor(projectPath, cfg = {}) {
  const projectName = path.basename(projectPath);
  if (cfg.worktreeRoot) {
    return path.join(cfg.worktreeRoot, projectName);
  }
  const parsed = path.parse(projectPath);
  return path.join(parsed.root, 'agent-worktrees', projectName);
}

async function branchExists(projectPath, branch) {
  try {
    // show-ref --verify 精确匹配，避免 branch --list 的子串误判
    await run(projectPath, 'git', ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]);
    return true;
  } catch {
    return false;
  }
}

async function listWorktrees(projectPath) {
  try {
    const out = await run(projectPath, 'git', ['worktree', 'list', '--porcelain']);
    const lines = out.split(/\r?\n/);
    const result = [];
    let current = {};
    for (const line of lines) {
      if (line.startsWith('worktree ')) {
        if (current.worktree) result.push(current);
        current = { worktree: line.slice(9).trim() };
      } else if (line.startsWith('branch ')) {
        current.branch = line.slice(7).trim();
      } else if (line.startsWith('bare')) {
        current.bare = true;
      }
    }
    if (current.worktree) result.push(current);
    return result;
  } catch {
    return [];
  }
}

async function ensure(projectPath, agentCommand, cfg = {}) {
  if (!(await gitExists(projectPath))) {
    await initGit(projectPath);
  }

  const safe = sanitize(agentCommand);
  const root = worktreeRootFor(projectPath, cfg);

  if (!fs.existsSync(root)) {
    fs.mkdirSync(root, { recursive: true });
  }

  // 同一个 agent 允许开多个会话：依次寻找 claude、claude-2、claude-3… 的空槽位
  const registered = await listWorktrees(projectPath);
  const taken = new Set(registered.map(w => path.resolve(w.worktree).toLowerCase()));

  let index = 1;
  let wtPath = '';
  let branch = '';
  for (;;) {
    const suffix = index === 1 ? '' : `-${index}`;
    wtPath = path.join(root, `${safe}${suffix}`);
    branch = `agent/${safe}${suffix}`;
    const pathFree = !taken.has(path.resolve(wtPath).toLowerCase()) && !fs.existsSync(wtPath);
    if (pathFree && !(await branchExists(projectPath, branch))) break;
    index += 1;
    if (index > 999) throw new Error('可用 worktree 槽位已用尽（超过 999 个）');
  }

  try {
    await run(projectPath, 'git', ['worktree', 'add', wtPath, '-b', branch]);
  } catch (err) {
    throw new Error(`创建 worktree 失败：${err.message}`);
  }

  return wtPath;
}

async function cleanup(projectPath, wtPath) {
  if (!wtPath) throw new Error('缺少 worktree 路径');
  if (!fs.existsSync(wtPath)) throw new Error('工作树目录不存在，可能已被清理');

  // 先查脏状态：有未提交改动就拒绝，绝不替用户做销毁决定
  let dirty = '';
  try {
    dirty = (await run(wtPath, 'git', ['status', '--porcelain'])).trim();
  } catch (err) {
    throw new Error(`无法读取工作树状态：${err.message}`);
  }
  if (dirty) {
    const count = dirty.split(/\r?\n/).filter(Boolean).length;
    throw new Error(`工作树还有 ${count} 个未提交改动，已取消清理。请先提交或手动处理。`);
  }

  // 不加 --force，失败时也不 rm -rf：宁可留下目录，也不能误删成果
  await run(projectPath, 'git', ['worktree', 'remove', wtPath]);
  await run(projectPath, 'git', ['worktree', 'prune']);
}

module.exports = { ensure, cleanup, worktreeRootFor };
