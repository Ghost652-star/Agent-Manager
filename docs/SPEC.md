---
id: spec-workspace-v2
type: product-spec
status: draft
title: 工作区与会话治理 v2
parent: goal-and-requirements
covers: [workspace-registry, three-kinds, worktree-hardening, session-persistence, scratch-dir, review-loop]
tags: [spec, workspace, session, review]
---

# SPEC — 工作区与会话治理 v2

## 1. 目标（Goal）

让 Agent Manager 的"多 Agent 并行"从**能跑**升级为**可治理**：

> 用户可以放心地同时开多个 Agent 会话，随手知道"谁在哪条分支上干什么、干完了怎么收"，
> 重启软件后一切还在，工具绝不碰用户自己的工作树。

一句话：**把 ThinkRail 验证过的五件事，做进 Agent Manager**——
三类工作区、创建加固、会话持久化、scratch 目录、审查闭环。

## 2. 背景与现状

- v1.0.4 已完成：worktree 会话级隔离（`claude` / `claude-2` 自动编号）、清理安全检查、
  DOMPurify、单实例锁、chokidar 监听、通知去重等（见 `MEMORY.md`）。
- 现存缺口（对照 ThinkRail）：
  1. 工作区只有一种（工具创建的），用户自己的 worktree / 项目主目录没有正式身份；
  2. `git worktree add` 未带 `--no-track`，上游可能指向 base 分支；
     分支名只查 refs、不查目录残留；
  3. 重启后所有会话丢失，只剩 worktree 目录躺在磁盘上；
  4. Agent 的临时文档没地方放（会被 git 扫到或被清理误删）；
  5. 合并闭环缺失：看 diff → 合并 → 清理要手工开终端。

## 3. 成功标准（Definition of Done）

### S1 三类工作区
- [ ] 每个项目有且只有一个 **Default 工作区**（`kind: "default"`），
      cwd = 项目主目录本身；不可删除、不可重命名。
- [ ] 工具创建的工作区为 **Managed**（`kind: "managed"`），
      位于 worktree 根目录下，可重命名、可归档、可清理。
- [ ] 用户已有的 worktree 可 **挂载**为 **External**（`kind: "external"`）：
      工具只引用路径，绝不创建、移动、重命名或删除它。
- [ ] 文件树 / Git 面板 / 终端的根目录选择器里，三类工作区以一致的方式出现并标注类型。

### S2 创建加固
- [ ] 所有 Managed 工作区创建使用 `git worktree add -b <branch> --no-track`；
      上游由用户首次 push 时自己定。
- [ ] 分支名对 `refs/heads/*` **和** worktree 目录双向查重；
      查重时跳过"分支还在但目录已归档"的残留。
- [ ] 创建失败时不留下半成品目录；错误信息带上 git 的 stderr。

### S3 会话持久化与恢复
- [ ] 会话元数据（项目、agent、工作区、标题、创建时间、最后状态）持久化到本地。
- [ ] 重启后，历史会话以"已退出"状态回到标签栏；点击可一键用同一 agent + 同一工作区重启。
- [ ] 不尝试恢复 PTY 进程本身；恢复的是"上下文"，不是"进程"。
- [ ] 恢复失败（工作区被删、agent 未安装）时给出明确提示，不静默丢弃。

### S4 Scratch 目录
- [ ] 每个 Managed 工作区内有约定的 scratch 目录（如 `.agent-manager/`），
      含自忽略的 `.gitignore`（`*`），保证零 git 占用。
- [ ] 该目录内的文件不被 `git status` 扫描、不被清理逻辑删除。
- [ ] 文件面板中该目录默认可见并标注"临时"，不参与改动标色。

### S5 审查闭环
- [ ] Git 面板对 Managed / External 工作区提供：
      **合并回 base 分支**、**丢弃全部改动**、**清理工作区** 三个动作，
      全部带确认与安全检查（脏工作区拒绝清理）。
- [ ] 合并前展示 diff 统计（新增/删除文件数、行数）；合并后提示下一步（保留或清理）。
- [ ] 丢弃改动需要二次确认，并明确"将丢失 N 个文件的未提交改动"。

## 4. 非目标（Non-Goals）

- 不做 PR / CI 集成（那是 ThinkRail 的体量，Agent Manager 保持轻）。
- 不做子代理 / 委派 / DAG。
- 不做多端（手机、浏览器远程）。
- 不替换现有 agent 接入方式（保持多 agent 通用）。
- 不实现 spec 图谱（living specs）本身——但 scratch 目录为将来留门。

## 5. 约束与原则

- **用户资产安全**：External 与 Default 工作区只读引用，任何破坏性操作必须显式确认。
- **配置原子写**：新增的注册表 / 会话文件沿用 tmp + rename。
- **单实例**：已有单实例锁，注册表不需要多进程并发保护，但写入仍原子。
- **Windows 优先**：路径、`taskkill`、CRLF 等行为按现有约定。

## 6. 验收场景（Acceptance Scenarios）

1. **并行两任务**：同一项目开 `claude` 和 `opencode` 各一个 Managed 工作区，
   在各自终端改动文件 → Git 面板各自看到自己的 diff，互不可见对方分支的改动。
2. **重启恢复**：关掉软件再开 → 标签栏出现两个"已退出"会话，点击后回到原来的工作区继续。
3. **挂载外部**：把用户手工 `git worktree add` 的目录挂为 External → 能浏览、能跑终端，
   但"清理工作区"对它不可用或只提示手动处理。
4. **合并闭环**：对一个干净的 Managed 工作区执行"合并回 main" → 二次确认 → 合并成功 →
   提示可清理 → 清理后工作区从列表消失、磁盘目录删除。
5. **拒绝误删**：对有未提交改动的工作区点"清理" → 被拒绝并列出文件数；
   点"丢弃全部改动" → 二次确认后才允许。
