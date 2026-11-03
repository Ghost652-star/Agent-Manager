---
id: plan-workspace-v2
type: implementation-plan
status: draft
title: 工作区与会话治理 v2 — 实现方案
parent: spec-workspace-v2
covers: [workspace-registry, session-store, ipc-contract, ui-changes, migration]
tags: [plan]
---

# PLAN — 实现方案

对应 `SPEC.md`。改动集中在四个模块：**注册表**、**worktree 加固**、**会话存储**、**审查动作**。

## 0. 总览

```
config.js        已有配置读写（原子写复用）
worktree.js      加固创建逻辑 + 注册表读写
sessions.js      [新] 会话持久化
main.js          新 IPC：workspace.* / session.* / review.*
preload.js       暴露新 API
renderer.js      根目录选择器改造、Git 面板动作、重启恢复标签
```

数据落盘位置（沿用"跟随 exe 的 data/ 目录"约定）：

```
data/
├── config.json            现有
├── workspaces.json        [新] 工作区注册表
└── sessions.json          [新] 会话记录
```

## 1. 工作区注册表（workspaces.json）

```jsonc
{
  "version": 1,
  "projects": {
    "F:/dianping": [
      { "id": "ws-default",  "kind": "default",  "name": "项目目录",
        "worktreePath": "F:/dianping", "branch": "main", "createdAt": "..." },
      { "id": "ws-1730…",    "kind": "managed",  "name": "claude",
        "worktreePath": "F:/agent-worktrees/dianping/claude",
        "branch": "agent/claude", "baseBranch": "main", "baseRef": "HEAD",
        "createdAt": "..." },
      { "id": "ws-1731…",    "kind": "external", "name": "hotfix",
        "worktreePath": "D:/work/dianping-hotfix",
        "branch": "hotfix/login", "createdAt": "..." }
    ]
  }
}
```

规则：
- `default` 记录在项目首次打开时惰性创建，永不删除。
- `managed` 由工具创建/归档/清理。
- `external` 由用户挂载；工具只写 `name`、`kind`、`worktreePath`，其余字段只读。
- 写入统一走 `atomicWrite`（tmp + rename）。

## 2. worktree.js 改造

| 现状 | 改成 |
|---|---|
| `ensure()` 每次都新建 `claude / claude-2…` | `createManaged(project, agent)` → 注册表登记，再 `worktree add` |
| `git worktree add wtPath -b branch` | `git worktree add wtPath -b branch --no-track` |
| 分支名只查 `show-ref` | 查 `show-ref` **+** 目录存在性 + 注册表占用，三者任一命中即递增 |
| `cleanup(project, wtPath)` | 增加 `kind` 检查：`external` / `default` 一律拒绝 |

新增导出：
- `listWorkspaces(project)` — 合并注册表 + `git worktree list --porcelain` 的真实状态；
  丢失目录的 managed 标记为 `missing`。
- `attachExternal(project, path)` — 校验该路径确实是本仓库的 worktree，登记为 external。
- `archiveWorkspace(id)` — 删除目录 + `worktree prune` + 移出注册表（保留分支）。

## 3. 会话存储（sessions.js，新文件）

```jsonc
{
  "version": 1,
  "sessions": [
    { "id": "session-…", "agentCommand": "claude", "agentLabel": "Claude Code",
      "projectPath": "F:/dianping", "workspaceId": "ws-1730…",
      "worktreePath": "F:/agent-worktrees/dianping/claude",
      "title": "修复分页越界", "createdAt": 1730…, "lastActiveAt": 1730…,
      "status": "exited" }        // running | exited | lost
    ]
  ]
}
```

生命周期：
- 启动会话时写入 `running`；PTY 退出 → `exited`；工作区目录消失 → `lost`。
- 关闭标签**不**删除记录，只置 `exited`（用户可从历史重新打开）。
- 提供 `pruneSessions()`：删除 30 天未活动且 `exited` 的记录。

## 4. IPC 契约（preload 新增）

```
workspace.list     { projectPath }            -> { workspaces: [...] }
workspace.create   { projectPath, agentCommand, name? } -> { workspace }
workspace.attach   { projectPath, path }      -> { workspace }
workspace.rename   { id, name }
workspace.archive  { id }                     -> 安全检查后删除 managed
session.list       { projectPath? }           -> { sessions: [...] }
session.restore    { sessionId }              -> { session, workspace }  // 只回元数据，不 spawn
session.forget     { sessionId }
review.merge       { workspaceId, baseBranch } -> 合并 + diff 统计
review.discard     { workspaceId, confirm: true }
```

## 5. renderer.js 改动点

1. **根目录选择器**：从"下拉 + 会话列表"改为工作区列表，
   每项标注 `默认 / 工具 / 外部`，外部项隐藏"清理"。
2. **重启恢复**：启动时 `session.list()` → 为每个 `exited/lost` 记录建"灰标签"，
   点击 → 确认 → 用原 agent + 原工作区重新 `launch`（复用同一 worktreePath，不再新建）。
3. **Git 面板动作**：现有"清理工作树"扩展为三个按钮；
   `merge` 前展示 diff 统计；`discard` 二次确认。
4. **scratch 目录**：文件树中 `.agent-manager/` 显示"临时"角标，改动标色跳过该目录。

## 6. 迁移

- 现有 `claude / claude-2` 目录：首次启动扫描 `git worktree list`，
  把工具目录自动登记为 managed（名称取目录名），不移动、不改分支。
- `sessions.json` 不存在时从零创建，不回填历史。

## 7. 分阶段落地

| 阶段 | 内容 | 对应任务 |
|---|---|---|
| M1 | 注册表 + 三类工作区 + 创建加固 | T1.x |
| M2 | 会话持久化 + 重启恢复 | T2.x |
| M3 | scratch 目录 | T3.x |
| M4 | 审查闭环（合并/丢弃/清理） | T4.x |
| M5 | 联调、迁移、文档、打包 | T5.x |
