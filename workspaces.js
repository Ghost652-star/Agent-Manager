/**
 * 工作区注册表 —— data/workspaces.json
 *
 * 三类工作区（对应 SPEC.md S1）：
 *   default  项目主目录本身（git 的主工作树），不可删、不可重命名
 *   managed  工具创建的 git worktree，可重命名、可归档
 *   external 用户已有 worktree 的挂载，工具只引用、绝不改动
 *
 * 注册表与 git 真实状态（`git worktree list`）对账：
 *   managed 目录丢失 → 标记 missing，不自动删记录（用户可能只是移了磁盘）
 */
const path = require('path');
const fs = require('fs');
const config = require('./config');
const worktree = require('./worktree');

const REG_VERSION = 1;
const SCRATCH_DIR_NAME = '.agent-manager';

function registryPath() {
  return path.join(config.configDir(), 'workspaces.json');
}

function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(registryPath(), 'utf-8'));
    if (raw && raw.version === REG_VERSION && raw.projects) return raw;
  } catch {
    // 文件不存在或损坏 → 从零开始
  }
  return { version: REG_VERSION, projects: {} };
}

function save(reg) {
  const dir = config.configDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const target = registryPath();
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(reg, null, 2));
  fs.renameSync(tmp, target);
}

/** 项目键：统一用正斜杠的绝对路径，避免 Windows 下 \ / 混用导致重复条目 */
function projectKey(projectPath) {
  return path.resolve(projectPath).replace(/\\/g, '/');
}

function newId() {
  return `ws-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function normPath(p) {
  return path.resolve(p).replace(/\\/g, '/');
}

/**
 * Default 工作区：项目主目录本身。惰性创建，永不删除、永不重命名。
 */
function ensureDefault(reg, projectPath) {
  const key = projectKey(projectPath);
  const list = reg.projects[key] || (reg.projects[key] = []);
  if (list.some(w => w.kind === 'default')) return list;

  list.push({
    id: newId(),
    kind: 'default',
    name: '项目目录',
    worktreePath: normPath(projectPath),
    branch: '',            // list() 时从 git 补
    baseBranch: null,
    createdAt: new Date().toISOString(),
    renamed: true          // 用户资产，自动命名永不覆盖
  });
  save(reg);
  return list;
}

/**
 * 与 git 真实状态对账：managed 目录消失 → status: 'missing'。
 * external / default 即使目录消失也只读引用，不改 status（用户自己负责）。
 */
/** 目录里除了 .git 和 scratch 什么都没有（空壳工作区的判定条件之一） */
function isEmptyWorktreeDir(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .every(e => e.name === '.git' || e.name === SCRATCH_DIR_NAME);
  } catch {
    return false;
  }
}

async function reconcile(records, projectPath) {
  const gitTrees = await worktree.listWorktrees(projectPath);
  const byPath = new Map(gitTrees.map(t => [normPath(t.worktree).toLowerCase(), t]));

  let dirty = false;
  const survivors = [];

  for (const r of records) {
    const np = normPath(r.worktreePath).toLowerCase();
    const tree = byPath.get(np);
    const onDisk = Boolean(tree) || fs.existsSync(r.worktreePath);

    // 空壳工作区：git 记录里有分支名，但分支 ref 实际不存在（通常是早期失败留下的）
    if (r.kind === 'managed' && tree && tree.branch && !(await worktree.branchExists(projectPath, tree.branch))) {
      if (fs.existsSync(r.worktreePath) && isEmptyWorktreeDir(r.worktreePath)) {
        try {
          await worktree.removeWorktree(projectPath, r.worktreePath, true);
          dirty = true;
          continue; // 连同注册表记录一起丢弃
        } catch {
          // 删不掉就留在列表里，交给用户手动处理
        }
      }
      if (r.status !== 'broken') { r.status = 'broken'; dirty = true; }
      survivors.push(r);
      continue;
    }

    if (r.kind === 'managed') {
      const missing = !onDisk;
      if (missing && r.status !== 'missing') { r.status = 'missing'; dirty = true; }
      if (!missing && r.status === 'missing') { delete r.status; dirty = true; }
    }

    // 已有状态恢复后，分支名以 git 为准（porcelain 会带 refs/heads 前缀，listWorktrees 已剥掉）
    if (tree) r.branch = tree.branch || r.branch;

    survivors.push(r);
  }

  if (survivors.length !== records.length) {
    records.length = 0;
    records.push(...survivors);
    dirty = true;
  }

  return dirty;
}

/**
 * 迁移（T5.1）：扫描 git worktree list，把工具目录自动登记为 managed。
 * 只登记 worktreeRootFor(projectPath) 下的目录，不碰外部 worktree。
 */
async function migrateExisting(projectPath, cfg = {}) {
  const reg = load();
  const key = projectKey(projectPath);
  const records = ensureDefault(reg, projectPath);
  const root = worktree.worktreeRootFor(projectPath, cfg);
  const rootNorm = normPath(root).toLowerCase();

  const gitTrees = await worktree.listWorktrees(projectPath);
  let dirty = false;
  // 迁移时把 base 分支记下来，否则后续 diff/合并会因为 baseBranch 为空直接判成"没有改动"
  let currentBase = '';
  try {
    currentBase = await worktree.currentBranch(projectPath);
  } catch {
    currentBase = '';
  }

  for (const t of gitTrees) {
    const np = normPath(t.worktree);
    // 只迁移工具目录下的 worktree（root 开头），且不在注册表里
    if (!np.toLowerCase().startsWith(rootNorm)) continue;
    if (records.some(r => normPath(r.worktreePath).toLowerCase() === np.toLowerCase())) continue;

    records.push({
      id: newId(),
      kind: 'managed',
      name: path.basename(t.worktree),
      worktreePath: np,
      branch: (t.branch || '').replace(/^refs\/heads\//, ''),
      baseBranch: currentBase || null,
      baseRef: currentBase || 'HEAD',
      createdAt: new Date().toISOString(),
      renamed: false
    });
    dirty = true;
  }

  if (dirty) {
    reg.projects[key] = records;
    save(reg);
  }
  return records.filter(r => r.kind === 'managed').length;
}

/**
 * 列出某项目的全部工作区。先迁移既有 worktree，再同步补 Default，最后对账。
 */
async function list(projectPath) {
  if (!projectPath) return [];
  await migrateExisting(projectPath);
  const reg = load();
  const key = projectKey(projectPath);
  const records = ensureDefault(reg, projectPath);
  const dirty = await reconcile(records, projectPath);
  if (dirty) { reg.projects[key] = records; save(reg); }
  return records;
}

async function byId(projectPath, id) {
  const all = await list(projectPath);
  return all.find(w => w.id === id) || null;
}

/** 复用工作区启动时刷新"上次使用时间"，供启动弹层排序/展示 */
function touch(projectPath, id) {
  const reg = load();
  const records = reg.projects[projectKey(projectPath)] || [];
  const rec = records.find(w => w.id === id);
  if (!rec) return false;
  rec.lastUsedAt = new Date().toISOString();
  save(reg);
  return true;
}

function byIdSync(reg, projectPath, id) {
  const list = (reg.projects[projectKey(projectPath)] || []);
  return list.find(w => w.id === id) || null;
}

/** 在注册表里找被占用的分支名 / 目录（用于查重） */
function registryOccupied(records, { branch, worktreePath }) {
  const np = worktreePath ? normPath(worktreePath).toLowerCase() : null;
  return records.some(r => {
    if (branch && r.branch === branch) return true;
    if (np && normPath(r.worktreePath).toLowerCase() === np && r.status !== 'missing') return true;
    return false;
  });
}

/**
 * 创建 managed 工作区。
 *   - 分支名对 refs + 磁盘目录 + 注册表三方查重（SPEC S2）
 *   - `git worktree add --no-track`，上游由用户首次 push 自己定
 *   - 失败不留半成品目录
 */
async function createManaged(projectPath, agentCommand, cfg = {}, name) {
  const reg = load();
  const key = projectKey(projectPath);
  const records = ensureDefault(reg, projectPath);

  // 非 git 目录自动 init；已是 git 仓库但没有任何提交时补一次初始提交。
  // 两种情况都必须保证仓库里至少有一个 commit，否则 worktree add --no-track
  // 会和 git 推断的 --orphan 冲突（options '--orphan' and '--track' cannot be used together）。
  if (!(await worktree.gitExists(projectPath))) {
    await worktree.initGit(projectPath);
  } else {
    await worktree.ensureInitialCommit(projectPath);
  }

  const safe = worktree.sanitize(agentCommand);
  const root = worktree.worktreeRootFor(projectPath, cfg);
  if (!fs.existsSync(root)) fs.mkdirSync(root, { recursive: true });

  // 三重查重：git refs + git worktree list + 磁盘目录 + 注册表占用
  const gitTrees = await worktree.listWorktrees(projectPath);
  const taken = new Set(gitTrees.map(w => normPath(w.worktree).toLowerCase()));

  let index = 1;
  let wtPath = '';
  let branch = '';
  for (;;) {
    const suffix = index === 1 ? '' : `-${index}`;
    wtPath = path.join(root, `${safe}${suffix}`);
    branch = `agent/${safe}${suffix}`;
    const pathFree = !taken.has(normPath(wtPath).toLowerCase()) && !fs.existsSync(wtPath);
    const branchFree = !(await worktree.branchExists(projectPath, branch));
    const registryFree = !registryOccupied(records, { branch, worktreePath: wtPath });
    if (pathFree && branchFree && registryFree) break;
    index += 1;
    if (index > 999) throw new Error('可用 worktree 槽位已用尽（超过 999 个）');
  }

  // baseRef：默认当前 HEAD（创建后再补 baseBranch 为当前分支名）
  const baseBranch = await worktree.currentBranch(projectPath);

  try {
    await worktree.addWorktree(projectPath, wtPath, branch, { noTrack: true });
  } catch (err) {
    // 失败不留半成品：目录若已出现就清掉，分支若已建就删掉
    try { if (fs.existsSync(wtPath)) await worktree.removeWorktree(projectPath, wtPath, true); } catch { /* 忽略 */ }
    throw new Error(`创建 worktree 失败：${err.message}`);
  }

  const record = {
    id: newId(),
    kind: 'managed',
    // 默认用目录名（claude-2 / claude-3）而不是 agent 命令，否则多开时列表里全是同名的 claude
    name: name && name.trim() ? name.trim() : path.basename(wtPath),
    worktreePath: normPath(wtPath),
    branch,
    baseBranch: baseBranch || null,
    baseRef: baseBranch || 'HEAD',
    agentCommand,
    createdAt: new Date().toISOString(),
    lastUsedAt: new Date().toISOString(),
    renamed: Boolean(name && name.trim())
  };

  records.push(record);
  reg.projects[key] = records;
  save(reg);

  // 播种 scratch 目录（SPEC S4）：自忽略 .gitignore，零 git 占用
  seedScratch(wtPath);

  return record;
}

/**
 * scratch 目录：放不进 git 的临时文档，但 spec 工具可以扫到。
 * `.gitignore` 内容为 `*`，连同自己一起忽略。
 */
function seedScratch(wtPath) {
  try {
    const dir = path.join(wtPath, SCRATCH_DIR_NAME);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const gi = path.join(dir, '.gitignore');
    if (!fs.existsSync(gi)) fs.writeFileSync(gi, '*\n');
  } catch {
    // scratch 播种失败不阻塞创建
  }
}

/**
 * 挂载用户已有的 worktree 为 external。
 *   - 校验路径确实是本仓库的 worktree（在 `git worktree list` 里）
 *   - 工具只登记，绝不创建/移动/重命名/删除
 */
async function attachExternal(projectPath, wtPath) {
  if (!wtPath) throw new Error('缺少 worktree 路径');
  const target = normPath(wtPath);

  const gitTrees = await worktree.listWorktrees(projectPath);
  const hit = gitTrees.find(t => normPath(t.worktree).toLowerCase() === target.toLowerCase());
  if (!hit) {
    throw new Error('该目录不是本项目的 git worktree，无法挂载');
  }

  const reg = load();
  const key = projectKey(projectPath);
  const records = ensureDefault(reg, projectPath);

  if (records.some(r => normPath(r.worktreePath).toLowerCase() === target.toLowerCase())) {
    throw new Error('该 worktree 已经在工作区列表里');
  }

  const record = {
    id: newId(),
    kind: 'external',
    name: path.basename(target),
    worktreePath: target,
    branch: hit.branch || '',
    baseBranch: null,
    createdAt: new Date().toISOString(),
    renamed: true          // 用户资产，自动命名永不覆盖
  };

  records.push(record);
  reg.projects[key] = records;
  save(reg);
  return record;
}

/**
 * 重命名（仅改显示名）。
 *   - default / external 是用户资产，拒绝重命名
 *   - managed 可改显示名，标记 renamed=true 后自动命名不再覆盖
 */
async function renameWorkspace(projectPath, id, name) {
  const reg = load();
  const key = projectKey(projectPath);
  const records = reg.projects[key] || [];
  const rec = byIdSync(reg, projectPath, id);
  if (!rec) throw new Error('工作区不存在');
  if (rec.kind !== 'managed') throw new Error('该工作区由用户拥有，不能重命名');
  const trimmed = String(name || '').trim();
  if (!trimmed) throw new Error('名称不能为空');

  rec.name = trimmed;
  rec.renamed = true;
  reg.projects[key] = records;
  save(reg);
  return rec;
}

/**
 * 归档（删除目录 + worktree prune）—— 仅 managed。
 *   - external / default 一律拒绝
 *   - 脏工作区拒绝（复用 worktree.cleanup 的安全检查）
 */
async function archive(projectPath, id) {
  const reg = load();
  const key = projectKey(projectPath);
  const records = reg.projects[key] || [];
  const rec = byIdSync(reg, projectPath, id);
  if (!rec) throw new Error('工作区不存在');
  if (rec.kind !== 'managed') {
    throw new Error(rec.kind === 'default'
      ? '项目目录工作区不能归档'
      : '外部挂载的工作区由用户自己管理，工具不会删除它');
  }
  if (rec.status === 'missing') {
    // 目录已经不在了，直接清注册表
    reg.projects[key] = records.filter(r => r.id !== id);
    save(reg);
    return { removed: true, alreadyMissing: true };
  }

  // 复用 worktree.cleanup 的安全检查（脏工作区会抛错）
  await worktree.cleanup(projectPath, rec.worktreePath);

  reg.projects[key] = records.filter(r => r.id !== id);
  save(reg);
  return { removed: true };
}

/**
 * 由工作区记录解析 agent 会话应使用的 cwd。
 * 恢复历史会话时用得上（M2）。
 */
function resolveCwd(record) {
  return record ? record.worktreePath : null;
}

module.exports = {
  SCRATCH_DIR_NAME,
  list,
  byId,
  touch,
  createManaged,
  attachExternal,
  renameWorkspace,
  archive,
  migrateExisting,
  resolveCwd,
  registryPath
};
