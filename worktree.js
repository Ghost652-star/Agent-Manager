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
    const out = await run(projectPath, 'git', ['branch', '--list', branch]);
    return out.includes(branch);
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
  const wtPath = path.join(root, safe);

  // 如果路径已存在且已注册，直接复用
  const existing = (await listWorktrees(projectPath)).find(w => w.worktree === wtPath);
  if (existing && fs.existsSync(wtPath)) {
    return wtPath;
  }

  if (!fs.existsSync(root)) {
    fs.mkdirSync(root, { recursive: true });
  }

  let branch = `agent/${safe}`;
  let i = 1;
  while (await branchExists(projectPath, branch)) {
    branch = `agent/${safe}-${i}`;
    i++;
  }

  try {
    await run(projectPath, 'git', ['worktree', 'add', wtPath, '-b', branch]);
  } catch (err) {
    // 可能路径残留但未被 git 识别，尝试清理后重建
    if (fs.existsSync(wtPath)) {
      fs.rmSync(wtPath, { recursive: true, force: true });
    }
    await run(projectPath, 'git', ['worktree', 'prune']);
    await run(projectPath, 'git', ['worktree', 'add', wtPath, '-b', branch]);
  }

  return wtPath;
}

async function cleanup(projectPath, agentCommand, cfg = {}) {
  const safe = sanitize(agentCommand);
  const root = worktreeRootFor(projectPath, cfg);
  const wtPath = path.join(root, safe);

  try {
    await run(projectPath, 'git', ['worktree', 'remove', wtPath]);
  } catch (err) {
    // 如果 git 不认为它是 worktree，仅删除目录
    if (fs.existsSync(wtPath)) {
      fs.rmSync(wtPath, { recursive: true, force: true });
    }
  }
  await run(projectPath, 'git', ['worktree', 'prune']);
}

module.exports = { ensure, cleanup, worktreeRootFor };
