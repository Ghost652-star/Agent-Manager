# Agent Manager

在隔离的 Git Worktree 中管理并启动多个 AI CLI Agent 的桌面应用。

让多个 AI 编程助手（Claude Code、OpenCode、Pi、Aider、Codex 等）**并行**工作在同一个项目上，而互不干扰——每个 Agent 都运行在独立的 Git Worktree 中，各改各的分支，最后由你决定合并谁的改动。

## 功能特性

- **多 Agent 并行**：同时启动任意多个 Agent 会话，每个会话一个终端 Tab
- **三类工作区**：
  - **默认工作区**（`default`）= 项目主目录，不可删/不可重命名
  - **工具工作区**（`managed`）= 工具创建的 Git Worktree，可重命名/归档/清理
  - **外部工作区**（`external`）= 挂载你已有的 Worktree，工具只引用、绝不改动
- **Git Worktree 隔离**：每个 Agent 自动获得独立的工作树和分支（`agent/<agent名>`）；同一个 Agent 多开时自动编号为 `agent/claude-2`、`agent/claude-3`，不会互相覆盖；创建时带 `--no-track`，`git push` 不会误推到 base 分支
- **终端内嵌**：基于 node-pty + xterm.js 的真实终端体验，支持 256 色
- **审查闭环**：Git 面板直接合并回主分支（先看 diff 统计）、丢弃全部改动（二次确认）、清理工作区
- **会话持久化**：重启后历史会话以灰标签恢复，一键用原 agent + 原工作区重启
- **Scratch 目录**：每个工具工作区自带 `.agent-manager/` 临时目录（零 git 占用），放 agent 的临时文档
- **文件浏览器**：实时浏览各 Agent Worktree 的文件改动，支持只读文件预览（2MB 以内文本文件）
- **完成通知**：Agent 空闲 60 秒且窗口不在前台时弹系统通知，点击跳转到对应会话
- **Agent 自动检测**：自动扫描系统 PATH，识别已安装的 CLI Agent
- **布局记忆**：侧栏/文件面板宽度、折叠状态自动持久化

## 环境要求

- Windows 10/11（当前仅支持 Windows）
- [Node.js](https://nodejs.org/) ≥ 18
- [Git](https://git-scm.com/)
- 至少安装一个 CLI Agent（如 `claude`、`opencode`、`pi`、`aider`、`codex`）

## 开发运行

```bash
# 安装依赖
npm install

# 启动开发版
npm start
```

## 构建打包

```bash
# 打包（自动清理旧版本产物，生成 NSIS 安装版 + 绿色版 zip 到 dist/）
npm run build
```

产物：

- `dist/Agent Manager Setup <版本>.exe` —— NSIS 安装程序（安装时可自定义目录，建议装到非 C 盘）
- `dist/AgentManager-Green-<版本>.zip` —— 绿色版，解压到任意目录（如 `F:\AgentManager`）双击 `Agent Manager.exe` 运行

> **为什么不再提供单文件便携 exe**：electron-builder 的 portable 目标运行时会把自身解压到
> `C:\Users\<用户>\AppData\Local\Temp`，与"不碰 C 盘"的约定冲突。绿色版解压后直接在原地运行，
> Electron 的 userData / 缓存 / 日志 / 临时目录也已全部重定向到软件目录下的 `data/`。

## 使用方法

1. **打开项目**：点击「打开新项目」选择一个本地项目目录（非 Git 仓库会自动 `git init`）
2. **选择 Agent**：左侧「已安装 Agent」列表会显示检测到的 CLI Agent，点击即可启动
3. **开始工作**：Agent 会在 `<盘符>:\agent-worktrees\<项目名>\<agent>` 下运行（同一 Agent 多开时依次为 `<agent>-2`、`<agent>-3`），改动不会影响你的主工作区
4. **查看改动**：通过「⎇ Git 状态」按钮和右侧文件面板，实时查看各 Agent 的改动
5. **合并成果**：哪个 Agent 的改动满意，就到项目目录里把对应分支（`agent/<agent名>`）合并回主分支
6. **清理**：在「⎇ Git 状态」面板里清理已退出会话的 Worktree；如果工作树还有未提交改动，清理会被拒绝，不会误删

## 配置存储

所有配置数据存放在软件本地的 `data/` 目录（与 exe 同级），**不写** C 盘用户目录和注册表：配置、工作区/会话记录、Electron 的 userData、缓存、日志、崩溃转储、临时文件全部落在 `data/` 下，整个软件目录可以直接搬走。

## 项目结构

```
agent_manager/
├── main.js        # Electron 主进程：窗口、PTY 会话、IPC、空闲通知
├── preload.js     # 预加载脚本（contextIsolation 安全桥接）
├── renderer.js    # 渲染进程：UI 逻辑、终端、文件树、Git 面板
├── index.html     # 主界面布局
├── styles.css     # 样式
├── agents.js      # CLI Agent 检测
├── worktree.js    # Git Worktree 生命周期管理
├── git.js         # 只读 Git 查询（状态/diff，不提供写操作）
├── config.js      # 配置读写（跟随 exe 的 data/ 目录）
└── scripts/
    └── clean-dist.js  # 打包前清理旧版本产物
```

## 设计原则

- **Worktree 隔离**：主工作区永远干净，Agent 的所有改动都在独立分支上，可审查、可丢弃
- **Git 面板只读**：软件只负责展示状态和 diff，所有 git 写操作（合并、提交、清理）由用户显式执行
- **通知靠稳定信号**：完成通知只基于「终端空闲 + 窗口失焦」两个信号，不做提示语关键词匹配，避免误报

## License

MIT
