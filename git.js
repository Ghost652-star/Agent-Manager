const { execFile } = require('child_process');

function run(cwd, cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd, encoding: 'utf-8', windowsHide: true, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else resolve(stdout);
    });
  });
}

async function currentBranch(cwd) {
  try {
    return (await run(cwd, 'git', ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
  } catch {
    return null;
  }
}

// 读取 worktree 的完整工作状态（只读，不做任何修改）
async function worktreeStatus(projectPath, wtPath) {
  const projectBranch = await currentBranch(projectPath);
  const wtBranch = await currentBranch(wtPath);

  const st = await run(wtPath, 'git', ['status', '--porcelain']);
  const dirty = st
    .split(/\r?\n/)
    .filter(Boolean)
    .map(line => ({
      status: line.slice(0, 2).trim() || 'M',
      file: line.slice(3).trim()
    }));

  // 领先/落后主分支的提交数
  let ahead = 0;
  let behind = 0;
  if (wtBranch && projectBranch && wtBranch !== 'HEAD') {
    try {
      const counts = await run(wtPath, 'git', ['rev-list', '--left-right', '--count', `${wtBranch}...${projectBranch}`]);
      const parts = counts.trim().split(/\s+/);
      ahead = parseInt(parts[0], 10) || 0;
      behind = parseInt(parts[1], 10) || 0;
    } catch {
      // 分支无共同祖先等情况，忽略
    }
  }

  let lastCommit = '';
  try {
    lastCommit = (await run(wtPath, 'git', ['log', '-1', '--pretty=format:%h %an: %s'])).trim();
  } catch {
    // 可能还没有任何提交
  }

  return { projectBranch, wtBranch, dirty, ahead, behind, lastCommit };
}

// ---------- 只读查询，本模块不提供任何写操作 ----------

// 读取单个文件的 diff（只读）
async function diffFile(wtPath, relPath) {
  const normalized = relPath.replace(/\\/g, '/');
  return (await run(wtPath, 'git', ['diff', '--no-color', '--', normalized])).replace(/\r\n/g, '\n');
}

module.exports = { worktreeStatus, diffFile };
