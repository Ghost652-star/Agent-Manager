# Agent Manager

在隔离的 Git Worktree 中管理并启动多个 AI CLI Agent 的桌面应用。

让多个 AI 编程助手（Claude Code、OpenCode、Pi、Aider、Codex 等）**并行**工作在同一个项目上，而互不干扰——每个 Agent 都运行在独立的 Git Worktree 中，各改各的分支，最后由你决定合并谁的改动。

## 功能特性

- **多 Agent 并行**：同时启动任意多个 Agent 会话，每个会话一个终端 Tab
- **Git Worktree 隔离**：每个 Agent 自动获得独立的工作树和分支（`agent/<agent名>`），彻底避免多 Agent 同时改一个目录导致的冲突
- **终端内嵌**：基于 node-pty + xterm.js 的真实终端体验，支持 256 色
- **Git 状态面板**：只读查看各 Agent 工作树的脏文件、领先/落后主分支的提交数、最新提交，以及单文件 diff
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
# 打包（自动清理旧版本产物，生成 NSIS 安装版 + 便携版到 dist/）
npm run build
```

产物：

- `dist/Agent Manager Setup <版本>.exe` —— NSIS 安装程序
- `dist/AgentManager-Portable-<版本>.exe` —— 便携版，双击即用

## 使用方法

1. **打开项目**：点击「打开新项目」选择一个本地项目目录（非 Git 仓库会自动 `git init`）
2. **选择 Agent**：左侧「已安装 Agent」列表会显示检测到的 CLI Agent，点击即可启动
3. **开始工作**：Agent 会在 `<盘符>:\agent-worktrees\<项目名>\<agent>` 下运行，改动不会影响你的主工作区
4. **查看改动**：通过「⎇ Git 状态」按钮和右侧文件面板，实时查看各 Agent 的改动
5. **合并成果**：哪个 Agent 的改动满意，就到项目目录里把对应分支（`agent/<agent名>`）合并回主分支
6. **清理**：设置中可对指定 Agent 的 Worktree 执行清理（`git worktree remove` + `prune`）

## 配置存储

所有配置数据存放在软件本地的 `data/` 目录（与 exe 同级），**不写** C 盘用户目录和注册表；便携版配置跟随 exe 所在目录，方便整体搬运。

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
