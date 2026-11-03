---
id: tasks-workspace-v2
type: task-list
status: active
title: 工作区与会话治理 v2 — 任务清单
parent: plan-workspace-v2
tags: [tasks]
---

# TASKS — 任务清单

> **用法**：做完一项就把 `[ ]` 改成 `[x]`。每完成一个里程碑，回来更新 `SPEC.md` 的成功标准勾选。
> 勾选 = 已在代码里实现并通过验证；"进行中"请改文字标注。

## M1 注册表与三类工作区

- [x] T1.1 新增 `data/workspaces.json` 读写模块（复用原子写），含 schema 版本号
- [x] T1.2 `default` 工作区惰性创建（项目首次打开时登记，不可删/不可重命名）
- [x] T1.3 `managed` 创建流程改为 `worktree add -b <branch> --no-track`
- [x] T1.4 分支名三重查重：refs + 磁盘目录 + 注册表占用
- [x] T1.5 `attachExternal()`：校验路径是本仓库 worktree，登记为 external
- [x] T1.6 `archiveWorkspace()`：删除 managed 目录 + `worktree prune`，external/default 拒绝
- [x] T1.7 IPC：`workspace.list / create / attach / rename / archive`
- [x] T1.8 前端根目录选择器改造：按类型标注（默认/工具/外部），外部隐藏清理

## M2 会话持久化与重启恢复

- [x] T2.1 新增 `sessions.js`：`data/sessions.json` 同目录，原子写
- [x] T2.2 会话生命周期：启动写 `running`、PTY 退出写 `exited`、工作区丢失写 `lost`
- [x] T2.3 关闭标签时保留记录（仅置 exited），不删
- [x] T2.4 `pruneSessions()`：清理 30 天未活动的 exited 记录（启动时执行一次）
- [x] T2.5 IPC：`session.list / restore / forget`
- [x] T2.6 前端：启动时恢复历史会话为灰标签，点击确认后用原 agent + 原工作区重启
- [x] T2.7 恢复失败处理：agent 未安装 / 工作区不存在 → 明确提示，不静默丢弃

## M3 Scratch 目录

- [x] T3.1 Managed 工作区创建时生成 `.agent-manager/` + 自忽略 `.gitignore`（`*`）
- [x] T3.2 确认 `git status` 不扫描该目录、清理逻辑不删除它
- [x] T3.3 文件树：该目录显示"临时"角标，不参与改动标色

## M4 审查闭环

- [x] T4.1 Git 面板：Managed 工作区新增"合并回 base 分支"按钮（先展示 diff 统计）
- [x] T4.2 合并动作：`git merge` 到 base 分支，冲突时中止并提示，不自动解冲突
- [x] T4.3 "丢弃全部改动"按钮：二次确认，提示将丢失的文件数
- [x] T4.4 "清理工作区"保留并接上 `workspace.archive`，external/default 不显示
- [x] T4.5 合并成功后提示"保留 / 归档"二选一

## M5 联调、迁移与交付

- [x] T5.1 迁移：首次启动扫描 `git worktree list`，把既有工具目录登记为 managed
- [x] T5.2 全流程手测：M1-M5 全部单测通过（15 项断言）
- [x] T5.3 回归：P0/P1 已有功能不回退（CDP 冒烟无异常）
- [x] T5.4 更新 `README.md`（工作区类型、恢复、审查闭环说明）
- [x] T5.5 版本号 + 打包 + GitHub Release

## M6 复用与自愈（v1.1.4）

- [x] T6.1 工作区记录补 `agentCommand` / `lastUsedAt`，复用启动时刷新 lastUsedAt
- [x] T6.2 `workspace:list` 返回 `running`（是否被运行中会话占用）
- [x] T6.3 点 Agent 时弹层：新建 / 复用空闲工作区（无可用项则直接新建，不弹）
- [x] T6.4 复用启动走 `agent:launch` 的 `workspaceId`，不新建目录
- [x] T6.5 合并成功后：工作树干净则自动归档（保留分支）并给出结果文案
- [x] T6.6 空壳工作区自愈：分支不存在且目录为空 → 自动 remove + prune
- [x] T6.7 单测 + 成品 exe CDP 验证，打包发布

---

## 进度记录

| 日期 | 事项 | 备注 |
|---|---|---|
| 2026-11-03 | 文档建立 | SPEC / PLAN / TASKS 初稿 |
| 2026-11-03 | M1 完成 | workspaces.js 注册表 + 三类工作区 + --no-track + 三重查重；T1.1–T1.8 全勾 |
| 2026-11-03 | M2 完成 | sessions.js 会话持久化 + 重启恢复 + 灰标签；T2.1–T2.7 全勾 |
| 2026-11-03 | M3 完成 | scratch 目录 + 文件树角标；T3.1–T3.3 全勾 |
| 2026-11-03 | M4 完成 | 合并/丢弃/清理三按钮 + diff 统计 + 归档提示；T4.1–T4.5 全勾 |
| 2026-11-03 | M5 迁移完成 | migrateExisting + 大小写修复；15 项断言全过 |
| 2026-11-03 | 全部完成 | M1-M5 全勾，v1.1.0 打包发布 |
| 2026-11-03 | M6 完成 | 复选工作区 + 合并自动清理 + 空壳自愈；7 项后端断言 + 成品 exe 三轮验证；v1.1.4 |
