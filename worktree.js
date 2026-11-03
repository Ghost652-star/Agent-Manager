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
        // porcelain 输出的是完整 ref（refs/heads/main），剥掉前缀只留分支名
        current.branch = line.slice(7).trim().replace(/^refs\/heads\//, '');
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

async function currentBranch(projectPath) {
  try {
    return (await run(projectPath, 'git', ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
  } catch {
    return '';
  }
}

/**
 * 创建 worktree + 分支。
 *   noTrack: true → `--no-track`，新分支不设上游，
 *   防止 git 的 autoSetupMerge 把上游指向 base 分支，
 *   导致工作区里 `git push` 误推到 base。（SPEC S2）
 */
async function addWorktree(projectPath, wtPath, branch, opts = {}) {
  const args = ['worktree', 'add', '-b', branch];
  if (opts.noTrack) args.push('--no-track');
  args.push(wtPath);
  if (opts.baseRef) args.push(opts.baseRef);
  try {
    await run(projectPath, 'git', args);
  } catch (err) {
    throw new Error(`git worktree add 失败：${err.message}`);
  }
}

/**
 * 移除 worktree。force=true 时允许删除脏工作树（仅限创建失败时的半成品清理）。
 */
async function removeWorktree(projectPath, wtPath, force = false) {
  const args = ['worktree', 'remove'];
  if (force) args.push('--force');
  args.push(wtPath);
  await run(projectPath, 'git', args);
  await run(projectPath, 'git', ['worktree', 'prune']);
}

/**
 * 查看 worktree 相对 base 分支的 diff 统计（审查闭环用）。
 * 返回 { files, insertions, deletions, diff }。
 */
async function diffStats(projectPath, wtPath, baseBranch) {
  if (!baseBranch) return { files: 0, insertions: 0, deletions: 0, diff: '' };
  try {
    const out = await run(wtPath, 'git', ['diff', '--stat', `${baseBranch}...HEAD`]);
    const numstat = await run(wtPath, 'git', ['diff', '--numstat', `${baseBranch}...HEAD`]);
    let files = 0, insertions = 0, deletions = 0;
    for (const line of numstat.split(/\r?\n/)) {
      const parts = line.trim().split(/\s+/);
      if (parts.length >= 3) {
        files += 1;
        insertions += parseInt(parts[0], 10) || 0;
        deletions += parseInt(parts[1], 10) || 0;
      }
    }
    return { files, insertions, deletions, diff: out };
  } catch (err) {
    return { files: 0, insertions: 0, deletions: 0, diff: '', error: err.message };
  }
}

/**
 * 把 worktree 分支合并回 base 分支。
 *   - 在 base 分支上执行 merge，不切到 worktree
 *   - 冲突时自动 abort，抛出可读错误
 *   - 成功后返回合并摘要
 */
async function mergeToBase(projectPath, wtPath, branch, baseBranch) {
  if (!branch || !baseBranch) throw new Error('缺少分支信息');
  // 先确认 worktree 干净
  const status = (await run(wtPath, 'git', ['status', '--porcelain'])).trim();
  if (status) {
    const count = status.split(/\r?\n/).filter(Boolean).length;
    throw new Error(`工作树有 ${count} 个未提交改动，请先提交或暂存后再合并`);
  }

  // 检查是否有可合并的提交
  const ahead = await run(wtPath, 'git', ['rev-list', '--count', `${baseBranch}..${branch}`]).catch(() => '0');
  if (parseInt(ahead, 10) === 0) {
    throw new Error('没有新提交可合并（分支与 base 一致）');
  }

  // 在 base 分支上合并
  const baseWt = projectPath; // base 分支在项目主目录
  try {
    const out = await run(baseWt, 'git', ['merge', '--no-ff', branch, '-m', `merge ${branch} into ${baseBranch}`]);
    return { success: true, summary: out };
  } catch (err) {
    // 冲突时中止合并，恢复原状
    try { await run(baseWt, 'git', ['merge', '--abort']); } catch { /* 忽略 */ }
    throw new Error(`合并冲突，已中止合并（${err.message}）`);
  }
}

/**
 * 丢弃 worktree 的全部未提交改动（需调用方二次确认）。
 */
async function discardAllChanges(wtPath) {
  await run(wtPath, 'git', ['reset', '--hard', 'HEAD']);
  await run(wtPath, 'git', ['clean', '-fd']);
}

/**
 * 统计未提交改动的文件数（用于"丢弃"确认提示）。
 */
async function countDirty(wtPath) {
  try {
    const out = (await run(wtPath, 'git', ['status', '--porcelain'])).trim();
    return out ? out.split(/\r?\n/).filter(Boolean).length : 0;
  } catch {
    return 0;
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

  await addWorktree(projectPath, wtPath, branch, { noTrack: true });
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

module.exports = {
  ensure,
  cleanup,
  worktreeRootFor,
  listWorktrees,
  branchExists,
  currentBranch,
  addWorktree,
  removeWorktree,
  sanitize,
  diffStats,
  mergeToBase,
  discardAllChanges,
  countDirty
};
