(() => {
  let projectPath = null;
  let projectName = null;
  let agents = [];
  const sessions = new Map();
  let activeSessionId = null;
  let sessionCounter = 0;
  let appConfig = {};
  let pendingWtRoot = null;

  const els = {
    btnOpenProject: document.getElementById('btn-open-project'),
    projectList: document.getElementById('project-list'),
    workspaceList: document.getElementById('workspace-list'),
    agentList: document.getElementById('agent-list'),
    btnRefreshAgents: document.getElementById('btn-refresh-agents'),
    wtRoot: document.getElementById('wt-root'),
    emptyState: document.getElementById('empty-state'),
    terminalArea: document.getElementById('terminal-area'),
    tabs: document.getElementById('tabs'),
    tabContents: document.getElementById('tab-contents'),
    btnSettings: document.getElementById('btn-settings'),
    settingsModal: document.getElementById('settings-modal'),
    btnCloseSettings: document.getElementById('btn-close-settings'),
    settingsConfigDir: document.getElementById('settings-config-dir'),
    settingsWtRoot: document.getElementById('settings-wt-root'),
    btnSelectWtRoot: document.getElementById('btn-select-wt-root'),
    btnResetWtRoot: document.getElementById('btn-reset-wt-root'),
    btnSaveSettings: document.getElementById('btn-save-settings'),

    // 折叠/展开
    btnCollapseSidebar: document.getElementById('btn-collapse-sidebar'),
    btnExpandSidebar: document.getElementById('btn-expand-sidebar'),
    btnCollapseExplorer: document.getElementById('btn-exp-collapse'),
    btnExpandExplorer: document.getElementById('btn-expand-explorer'),
    splitterLeft: document.getElementById('splitter-left'),
    splitterRight: document.getElementById('splitter-right'),
    splitterInner: document.getElementById('splitter-inner'),

    // 文件面板
    expRootSelect: document.getElementById('exp-root-select'),
    btnExpRefresh: document.getElementById('btn-exp-refresh'),
    expRootPath: document.getElementById('exp-root-path'),
    expTree: document.getElementById('exp-tree'),
    expViewer: document.getElementById('exp-viewer'),
    viewerName: document.getElementById('viewer-name'),
    btnViewerReload: document.getElementById('btn-viewer-reload'),
    btnViewerClose: document.getElementById('btn-viewer-close'),
    viewerBody: document.getElementById('viewer-body'),
    btnViewerDiff: document.getElementById('btn-viewer-diff'),

    // Git 状态浮窗
    btnGitStatus: document.getElementById('btn-git-status'),
    gitPopover: document.getElementById('git-popover'),
    btnGitClose: document.getElementById('btn-git-close'),
    gitPopoverBody: document.getElementById('git-popover-body')
  };

  // 全局数据监听器：每个会话自己处理，避免重复
  window.api.onPtyData(({ sessionId, data }) => {
    const session = sessions.get(sessionId);
    if (session && session.terminal) {
      session.terminal.write(data);
    }
  });

  window.api.onPtyExit(({ sessionId }) => {
    const session = sessions.get(sessionId);
    if (session) {
      session.exited = true;
      // 用类名控制视觉状态，避免直接写内联样式
      session.tabEl.classList.add('exited');
      renderProjectList();
      renderWorkspaceList();
      renderAgents();
    }
  });

  async function loadAgents() {
    agents = await window.api.detectAgents();
    renderAgents();
  }

  function renderAgents() {
    els.agentList.innerHTML = '';
    if (agents.length === 0) {
      els.agentList.innerHTML = '<li class="agent-empty">未检测到 agent，请确认已安装 opencode / claude 等命令。</li>';
      return;
    }
    for (const agent of agents) {
      // 运行中的 agent 状态点点亮
      let running = 0;
      for (const s of sessions.values()) {
        if (s.agent && s.agent.command === agent.command && !s.exited) running += 1;
      }
      const li = document.createElement('li');
      li.className = 'agent-item' + (running ? ' is-running' : '');
      li.title = running
        ? `点击在 worktree 中启动 ${agent.label}（当前有 ${running} 个会话在跑）`
        : `点击在 worktree 中启动 ${agent.label}`;
      li.tabIndex = 0;
      li.setAttribute('role', 'button');
      li.innerHTML = `
        <span class="agent-status"></span>
        <span class="agent-name">${escapeHtml(agent.label)}</span>
        <span class="agent-cmd">${escapeHtml(agent.command)}</span>
      `;
      li.addEventListener('click', () => openAgentMenu(agent, li));
      li.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          openAgentMenu(agent, li);
        }
      });
      els.agentList.appendChild(li);
    }
  }

  function projectNameOf(path) {
    return path.replace(/\\/g, '/').split('/').pop();
  }

  async function chooseProject() {
    const path = await window.api.selectProject();
    if (!path) return;
    await setProject(path);
  }

  function setProject(path, save = true) {
    return _setProjectInner(path, save);
  }

  async function _setProjectInner(path, save) {
    if (!path) return false;

    // 校验路径确实存在
    const check = await window.api.readDir({ root: path });
    if (!check.success) {
      alert(`项目目录已不存在或无法访问：\n${path}\n已从最近列表移除。`);
      appConfig.recentProjects = (appConfig.recentProjects || []).filter(p => p !== path);
      appConfig.currentProject = appConfig.recentProjects[0] || null;
      persistConfig();
      renderProjectList();
      // 回退到当前有效项目；如果当前项目也无效，就清空
      if (projectPath && projectPath !== path) return true;
      if (appConfig.currentProject) return setProject(appConfig.currentProject, false);
      return false;
    }

    projectPath = path;
    projectName = projectNameOf(path);
    els.wtRoot.textContent = formatWorktreeRoot(path);

    if (save) {
      appConfig.recentProjects = appConfig.recentProjects || [];
      appConfig.recentProjects = appConfig.recentProjects.filter(p => p !== path);
      appConfig.recentProjects.unshift(path);
      appConfig.recentProjects = appConfig.recentProjects.slice(0, 10);
      appConfig.currentProject = path;
      persistConfig();
    }

    renderProjectList();
    updateTabProjectLabels();
    syncExplorerRoot();
    return true;
  }

  // 项目列表：图标 + 名称 + 路径（等宽）+ 运行中会话数；当前项目以卡片边框标记
  function renderProjectList() {
    const ul = els.projectList;
    if (!ul) return;
    ul.innerHTML = '';

    const known = [];
    const push = p => {
      if (!p) return;
      if (known.some(x => x.toLowerCase() === p.toLowerCase())) return;
      known.push(p);
    };
    for (const p of (appConfig.recentProjects || [])) push(p);
    for (const s of sessions.values()) if (s.projectPath) push(s.projectPath);
    push(projectPath);

    if (known.length === 0) {
      ul.innerHTML = '<li class="list-empty">还没有项目，先打开一个</li>';
      return;
    }

    for (const p of known) {
      const isCurrent = (projectPath || '').toLowerCase() === p.toLowerCase();
      let running = 0;
      for (const s of sessions.values()) {
        if (s.projectPath === p && !s.exited) running += 1;
      }
      const li = document.createElement('li');
      li.className = 'proj-item' + (isCurrent ? ' is-current' : '');
      li.title = p;
      li.innerHTML = `
        <span class="proj-icon">${icon(isCurrent ? 'app' : 'folder', 'icon icon-node')}</span>
        <span class="proj-body">
          <span class="proj-name">${escapeHtml(projectNameOf(p))}</span>
          <span class="proj-path">${escapeHtml(p)}</span>
        </span>
        ${running ? `<span class="proj-badge">${running}</span>` : ''}
      `;
      if (!isCurrent) {
        li.tabIndex = 0;
        li.setAttribute('role', 'button');
        li.addEventListener('click', () => setProject(p));
        li.addEventListener('keydown', e => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setProject(p);
          }
        });
      }
      ul.appendChild(li);
    }
  }

  // 当存在多个项目时，tab 标签才显示项目名前缀
  function updateTabProjectLabels() {
    const distinctProjects = new Set();
    for (const s of sessions.values()) {
      if (s.projectPath) distinctProjects.add(s.projectPath);
    }
    const multi = distinctProjects.size > 1;
    for (const s of sessions.values()) {
      const badge = s.tabEl.querySelector('.tab-project');
      if (!badge) continue;
      if (multi && s.projectPath) {
        badge.classList.remove('hidden');
        badge.textContent = projectNameOf(s.projectPath);
      } else {
        badge.classList.add('hidden');
      }
    }
  }

  function formatWorktreeRoot(path) {
    if (appConfig.worktreeRoot) {
      return `${appConfig.worktreeRoot}\\${path.replace(/\\/g, '/').split('/').pop()}`;
    }
    const drive = path[0] ? path[0].toUpperCase() : 'C';
    return `${drive}:\\agent-worktrees\\${path.replace(/\\/g, '/').split('/').pop()}`;
  }

  // ---------- 启动时选择工作区（M6） ----------

  function sanitizeCmd(cmd) {
    return String(cmd || '').replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase();
  }

  // 绝对时间更适合"上次用的是哪一次"：今天 19:41 / 昨天 09:12 / 10-31 14:05
  function formatLastUsed(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const now = new Date();
    const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    if (d.toDateString() === now.toDateString()) return `今天 ${hm}`;
    const y = new Date(now);
    y.setDate(now.getDate() - 1);
    if (d.toDateString() === y.toDateString()) return `昨天 ${hm}`;
    return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${hm}`;
  }

  // 工作区显示名：改过名用名字，否则用目录名（claude-2 / claude-3），避免多开时全是 claude
  function workspaceLabel(w) {
    if (w.renamed && w.name) return w.name;
    const parts = String(w.worktreePath || '').replace(/\\/g, '/').split('/').filter(Boolean);
    return parts[parts.length - 1] || w.name || '';
  }

  let agentMenuEl = null;

  function closeAgentMenu() {
    if (agentMenuEl) {
      agentMenuEl.remove();
      agentMenuEl = null;
    }
    document.removeEventListener('mousedown', onAgentMenuOutside, true);
    document.removeEventListener('keydown', onAgentMenuKey, true);
  }

  function onAgentMenuOutside(e) {
    if (agentMenuEl && !agentMenuEl.contains(e.target)) closeAgentMenu();
  }

  function onAgentMenuKey(e) {
    if (e.key === 'Escape') closeAgentMenu();
  }

  // 从某个项目的工作区列表里筛出"这个 agent 可复用"的项
  function reusableFrom(list, agent) {
    const safe = sanitizeCmd(agent.command);
    const exact = new RegExp('^agent/' + safe + '(-\\d+)?$');
    return list.filter(w => {
      if (w.kind !== 'managed') return false;
      if (w.status === 'missing' || w.status === 'broken') return false;
      if (w.running) return false;
      if (w.agentCommand) return w.agentCommand === safe;
      return exact.test(w.branch || '');
    }).sort((a, b) => {
      const ta = new Date(a.lastUsedAt || a.createdAt || 0).getTime();
      const tb = new Date(b.lastUsedAt || b.createdAt || 0).getTime();
      return tb - ta;
    });
  }

  function makeReuseItem(agent, w, projPath, menu) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'agent-menu-item';
    btn.setAttribute('role', 'menuitem');
    const label = workspaceLabel(w);
    const when = w.lastUsedAt
      ? `上次使用 ${formatLastUsed(w.lastUsedAt)}`
      : `创建于 ${formatLastUsed(w.createdAt)}`;
    btn.title = `${w.worktreePath}\n项目：${projPath}\n分支：${w.branch || '—'}\n${when}`;
    btn.innerHTML = `
      <span class="ami-icon">${icon('restore')}</span>
      <span class="ami-body">
        <span class="ami-name">${escapeHtml(label)}</span>
        <span class="ami-sub">${escapeHtml(w.branch || '')} · ${escapeHtml(when)}</span>
      </span>
      <span class="ami-dirty" data-ws="${escapeHtml(w.id)}">…</span>`;

    btn.addEventListener('click', async () => {
      closeAgentMenu();
      const sameProject = (projPath || '').toLowerCase() === (projectPath || '').toLowerCase();
      if (!sameProject) {
        const ok = confirm(
          `「${label}」属于另一个项目：\n${projPath}\n\n是否切换到该项目并启动？`
        );
        if (!ok) return;
        const okSwitch = await setProject(projPath, true);
        if (!okSwitch) return;
      }
      launchAgent(agent, w.id);
    });

    // 异步补未提交改动数
    window.api.gitStatus({ projectPath: projPath, wtPath: w.worktreePath }).then(st => {
      const el = btn.querySelector('.ami-dirty');
      if (!el) return;
      if (!st || !st.success) { el.textContent = ''; return; }
      const n = (st.dirty || []).length;
      el.textContent = n ? `${n} 个改动` : '干净';
      el.classList.toggle('is-clean', n === 0);
    }).catch(() => {});

    menu.appendChild(btn);
  }

  async function openAgentMenu(agent, anchorEl) {
    closeAgentMenu();
    if (!projectPath) {
      launchAgent(agent); // 交给 launchAgent 提示"请先打开项目"
      return;
    }

    // 当前项目 + 最近项目（最多扫描 6 个），跨项目列出可复用工作区
    const paths = [];
    const pushPath = p => {
      if (!p) return;
      if (paths.some(x => x.toLowerCase() === p.toLowerCase())) return;
      paths.push(p);
    };
    pushPath(projectPath);
    for (const p of (appConfig.recentProjects || [])) pushPath(p);

    await populateRootSelect(); // 刷新当前项目缓存（running / 状态）
    const res = await window.api.listAllWorkspaces({ projectPaths: paths.slice(0, 6) });
    const groups = [];
    if (res && res.success) {
      for (const proj of res.projects) {
        const items = reusableFrom(proj.workspaces || [], agent);
        if (items.length) groups.push({ projectPath: proj.projectPath, items });
      }
    }
    // 当前项目排在前面
    groups.sort((a, b) => {
      const cur = (projectPath || '').toLowerCase();
      return (b.projectPath.toLowerCase() === cur ? 1 : 0) - (a.projectPath.toLowerCase() === cur ? 1 : 0);
    });

    const total = groups.reduce((n, g) => n + g.items.length, 0);
    if (total === 0) {
      launchAgent(agent); // 没有可复用的 → 直接新建，保持原来的手感
      return;
    }

    const menu = document.createElement('div');
    menu.className = 'agent-menu';
    menu.setAttribute('role', 'menu');

    const createBtn = document.createElement('button');
    createBtn.type = 'button';
    createBtn.className = 'agent-menu-item is-primary';
    createBtn.setAttribute('role', 'menuitem');
    createBtn.innerHTML = `
      <span class="ami-icon">${icon('plus')}</span>
      <span class="ami-body">
        <span class="ami-name">新建工作区</span>
        <span class="ami-sub">在 ${escapeHtml(projectNameOf(projectPath))} 里开一个全新分支</span>
      </span>`;
    createBtn.addEventListener('click', () => {
      closeAgentMenu();
      launchAgent(agent);
    });
    menu.appendChild(createBtn);

    const sep = document.createElement('div');
    sep.className = 'agent-menu-sep';
    menu.appendChild(sep);

    const head = document.createElement('div');
    head.className = 'agent-menu-head';
    head.innerHTML = `<span class="agent-menu-hint">复用已有工作区</span><span class="agent-menu-proj">${groups.length} 个项目</span>`;
    menu.appendChild(head);

    for (const g of groups) {
      const gHead = document.createElement('div');
      gHead.className = 'agent-menu-group';
      const isCurrent = g.projectPath.toLowerCase() === (projectPath || '').toLowerCase();
      const prettyPath = String(g.projectPath).replace(/\\/g, '/').replace(/\/{2,}/g, '/');
      gHead.innerHTML = `
        <span class="amg-name">${escapeHtml(projectNameOf(g.projectPath))}${isCurrent ? '<span class="amg-cur">当前</span>' : ''}</span>
        <span class="amg-path" title="${escapeHtml(g.projectPath)}">${escapeHtml(prettyPath)}</span>`;
      menu.appendChild(gHead);

      for (const w of g.items) makeReuseItem(agent, w, g.projectPath, menu);
    }

    document.body.appendChild(menu);

    // 贴着 agent 项下方展开，超出视口就修正
    const r = anchorEl.getBoundingClientRect();
    const mw = menu.offsetWidth;
    const mh = menu.offsetHeight;
    let left = r.left;
    let top = r.bottom + 6;
    if (left + mw > window.innerWidth - 8) left = Math.max(8, window.innerWidth - mw - 8);
    if (top + mh > window.innerHeight - 8) top = Math.max(8, r.top - mh - 6);
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
    agentMenuEl = menu;

    document.addEventListener('mousedown', onAgentMenuOutside, true);
    document.addEventListener('keydown', onAgentMenuKey, true);
  }

  // ---------- 轻量提示条 ----------

  let toastTimer = null;

  function toast(message, kind = 'ok') {
    let el = document.getElementById('toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'toast';
      document.body.appendChild(el);
    }
    el.textContent = message;
    el.className = `toast is-${kind} is-visible`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('is-visible'), 4000);
  }

  // workspaceId 有值时复用既有工作区，否则后端新建一个 managed 工作区
  async function launchAgent(agent, workspaceId) {
    if (!projectPath) {
      alert('请先打开一个项目目录');
      return;
    }

    sessionCounter += 1;
    const sessionId = `session-${Date.now()}-${sessionCounter}`;
    const tab = createTab(sessionId, agent);
    const content = createContent(sessionId);

    els.emptyState.classList.add('hidden');
    els.terminalArea.classList.remove('hidden');
    els.tabs.appendChild(tab);
    els.tabContents.appendChild(content);

    sessions.set(sessionId, {
      sessionId,
      agent,
      tabEl: tab,
      contentEl: content,
      terminal: null,
      exited: false,
      projectPath,
      worktreePath: null
    });
    updateTabProjectLabels();
    renderProjectList();
    renderAgents();

    switchTab(sessionId);

    try {
      const result = await window.api.launchAgent({ projectPath, agentCommand: agent.command, sessionId, workspaceId });
      if (!result.success) {
        content.innerHTML = `<div class="tab-error">启动失败：${escapeHtml(result.error)}</div>`;
        return;
      }
      initTerminal(sessionId, result.worktreePath, result.workspaceId);
    } catch (err) {
      content.innerHTML = `<div class="tab-error">启动异常：${escapeHtml(err.message)}</div>`;
    }
  }

  function createTab(sessionId, agent) {
    // 用 div + role=tab 而不是 button：内部还要放关闭按钮，嵌套 button 不合法
    const tab = document.createElement('div');
    tab.className = 'tab';
    tab.dataset.session = sessionId;
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-selected', 'false');
    tab.tabIndex = 0;
    tab.innerHTML = `
      <span class="tab-project hidden">…</span>
      <span class="tab-agent">${escapeHtml(agent.label)}</span>
      <span class="tab-wt">…</span>
      <button class="tab-close" type="button" title="关闭会话" aria-label="关闭会话">${icon('x', 'icon icon-xs')}</button>
    `;
    tab.addEventListener('click', e => {
      if (e.target.closest('.tab-close')) {
        closeSession(sessionId);
      } else {
        switchTab(sessionId);
      }
    });
    tab.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        switchTab(sessionId);
      }
    });
    return tab;
  }

  function createContent(sessionId) {
    const div = document.createElement('div');
    div.className = 'tab-content';
    div.dataset.session = sessionId;
    div.innerHTML = '<div class="tab-loading">正在创建 worktree 并启动终端…</div>';
    return div;
  }

  function initTerminal(sessionId, worktreePath, workspaceId) {
    const session = sessions.get(sessionId);
    if (!session) return;

    session.worktreePath = worktreePath;
    session.workspaceId = workspaceId;
    if (workspaceId) expSelection = workspaceId; // 启动新 agent 后自动查看它的工作区
    syncExplorerRoot();

    session.contentEl.innerHTML = '';
    const container = document.createElement('div');
    container.style.width = '100%';
    container.style.height = '100%';
    session.contentEl.appendChild(container);

    // 更新 tab 上的 worktree 路径（只显示末两段，完整路径放 title，避免标签过长）
    const wtEl = session.tabEl.querySelector('.tab-wt');
    if (wtEl) {
      const segs = worktreePath.replace(/\\/g, '/').split('/').filter(Boolean);
      wtEl.textContent = segs.slice(-2).join('/');
      wtEl.title = worktreePath;
    }

    const term = new Terminal({
      cursorBlink: true,
      fontFamily: "'JetBrains Mono', 'SF Mono', Consolas, monospace",
      fontSize: 14,
      lineHeight: 1.25,
      convertEol: true,
      theme: {
        background: '#0c0c0c',
        foreground: '#f2f2f2',
        cursor: '#f59e0b',
        selectionBackground: 'rgba(245, 158, 11, 0.3)',
        black: '#1a1a1a',
        red: '#ef4444',
        green: '#22c55e',
        yellow: '#f59e0b',
        blue: '#3b82f6',
        magenta: '#a855f7',
        cyan: '#06b6d4',
        white: '#e5e5e5'
      }
    });

    const fitAddon = new FitAddon.FitAddon();
    term.loadAddon(fitAddon);
    if (typeof WebLinksAddon !== 'undefined') {
      term.loadAddon(new WebLinksAddon.WebLinksAddon());
    }

    term.open(container);
    fitAddon.fit();

    term.onData(data => window.api.ptyInput({ sessionId, data }));
    term.onResize(({ cols, rows }) => window.api.ptyResize({ sessionId, cols, rows }));

    session.terminal = term;
    session.fitAddon = fitAddon;

    // 初始 resize
    window.api.ptyResize({ sessionId, cols: term.cols, rows: term.rows });

    setTimeout(() => {
      fitAddon.fit();
      term.focus();
    }, 50);
  }

  function switchTab(sessionId) {
    activeSessionId = sessionId;
    for (const session of sessions.values()) {
      const isActive = session.sessionId === sessionId;
      session.tabEl.classList.toggle('active', isActive);
      session.tabEl.setAttribute('aria-selected', isActive ? 'true' : 'false');
      session.contentEl.classList.toggle('active', isActive);
      if (isActive && session.terminal) {
        requestAnimationFrame(() => {
          session.fitAddon.fit();
          session.terminal.focus();
        });
      }
    }
    // 切 tab 时面板自动跟随该 agent 的工作区
    const active = sessions.get(sessionId);
    if (active && active.workspaceId) expSelection = active.workspaceId;
    syncExplorerRoot();
  }

  function closeSession(sessionId) {
    const session = sessions.get(sessionId);
    if (!session) return;

    // agent 还在跑时先确认，避免误点把正在进行的任务中断
    if (!session.exited) {
      const ok = confirm(`「${session.agent.label}」可能仍在运行，确定关闭会话？\n\n未提交的改动会保留在工作树中。`);
      if (!ok) return;
    }

    window.api.ptyKill({ sessionId });
    if (session.terminal) session.terminal.dispose();

    session.tabEl.remove();
    session.contentEl.remove();
    sessions.delete(sessionId);
    updateTabProjectLabels();

    if (sessions.size === 0) {
      activeSessionId = null;
      els.terminalArea.classList.add('hidden');
      els.emptyState.classList.remove('hidden');
      syncExplorerRoot();
    } else if (activeSessionId === sessionId) {
      const first = sessions.values().next().value;
      switchTab(first.sessionId);
    }
  }

  // 复用 index.html 里的 SVG sprite，保持图标与工具栏一致
  function icon(name, cls = 'icon') {
    return `<svg class="${cls}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  window.addEventListener('resize', () => {
    for (const session of sessions.values()) {
      if (session.fitAddon) session.fitAddon.fit();
    }
  });

  function openSettings() {
    pendingWtRoot = appConfig.worktreeRoot || null;
    els.settingsConfigDir.textContent = appConfig.configDir || '<软件目录>\\data\\config.json';
    renderSettingsWtRoot();
    els.settingsModal.classList.add('open');
    els.settingsModal.setAttribute('aria-hidden', 'false');
    // 打开后把焦点移进弹窗，键盘用户不会迷失位置
    setTimeout(() => els.btnCloseSettings.focus(), 120);
  }

  function closeSettings() {
    els.settingsModal.classList.remove('open');
    els.settingsModal.setAttribute('aria-hidden', 'true');
    els.btnSettings.focus();
  }

  function renderSettingsWtRoot() {
    if (pendingWtRoot) {
      els.settingsWtRoot.textContent = pendingWtRoot;
    } else {
      els.settingsWtRoot.textContent = '默认：与项目同盘符 \\agent-worktrees';
    }
  }

  async function selectWtRoot() {
    const dir = await window.api.selectDirectory({ title: '选择 worktree 根目录' });
    if (!dir) return;
    pendingWtRoot = dir;
    renderSettingsWtRoot();
  }

  function resetWtRoot() {
    pendingWtRoot = null;
    renderSettingsWtRoot();
  }

  async function saveSettings() {
    appConfig.worktreeRoot = pendingWtRoot || undefined;
    await persistConfig();
    if (projectPath) setProject(projectPath, false);
    closeSettings();
  }

  async function initConfig() {
    appConfig = await window.api.getConfig();
    restoreLayout();
    const initialProject = appConfig.currentProject || (appConfig.recentProjects && appConfig.recentProjects[0]);
    if (initialProject) {
      await setProject(initialProject, false);
    }
    renderProjectList();
    renderWorkspaceList();
    restoreSessions(); // T2.6：恢复历史会话为灰标签
  }

  // ---------- 会话恢复（T2.6 / T2.7） ----------

  async function restoreSessions() {
    if (!projectPath) return;
    const res = await window.api.listSessions({ projectPath });
    if (!res.success) return;
    for (const rec of res.sessions) {
      if (rec.status === 'running') continue; // 不应出现，防御
      addRestoredTab(rec);
    }
    if (res.sessions.some(s => s.status !== 'running')) {
      els.emptyState.classList.add('hidden');
      els.terminalArea.classList.remove('hidden');
    }
  }

  function addRestoredTab(rec) {
    const tab = document.createElement('div');
    tab.className = 'tab tab-restored';
    tab.dataset.session = rec.id;
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-selected', 'false');
    tab.tabIndex = 0;
    const segs = (rec.worktreePath || '').replace(/\\/g, '/').split('/').filter(Boolean);
    const wtLabel = segs.slice(-2).join('/') || '—';
    tab.innerHTML = `
      <span class="tab-project hidden">…</span>
      <span class="tab-agent">${escapeHtml(rec.agentLabel || rec.agentCommand)}</span>
      <span class="tab-wt">${escapeHtml(wtLabel)}</span>
      <button class="tab-close" type="button" title="忘记此会话" aria-label="忘记此会话">${icon('x', 'icon icon-xs')}</button>
    `;
    tab.title = `${rec.title || rec.agentLabel} · ${rec.worktreePath || ''}\n点击恢复会话`;

    const content = document.createElement('div');
    content.className = 'tab-content';
    content.dataset.session = rec.id;
    content.innerHTML = `
      <div class="tab-loading">
        会话已退出（${escapeHtml(rec.status === 'lost' ? '工作区目录丢失' : '进程已结束')}）<br>
        点击此标签可重新启动。
      </div>`;

    sessions.set(rec.id, {
      sessionId: rec.id,
      agent: { label: rec.agentLabel || rec.agentCommand, command: rec.agentCommand },
      tabEl: tab,
      contentEl: content,
      terminal: null,
      exited: true,
      restored: true,
      projectPath,
      worktreePath: rec.worktreePath,
      workspaceId: rec.workspaceId
    });

    tab.addEventListener('click', e => {
      if (e.target.closest('.tab-close')) {
        window.api.forgetSession({ sessionId: rec.id });
        closeRestoredTab(rec.id);
        return;
      }
      if (!sessions.get(rec.id)?.restored) { switchTab(rec.id); return; }
      restoreSession(rec);
    });
    tab.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        if (sessions.get(rec.id)?.restored) restoreSession(rec);
        else switchTab(rec.id);
      }
    });

    els.tabs.appendChild(tab);
    els.tabContents.appendChild(content);
    updateTabProjectLabels();
    switchTab(rec.id);
  }

  function closeRestoredTab(sessionId) {
    const s = sessions.get(sessionId);
    if (!s) return;
    s.tabEl.remove();
    s.contentEl.remove();
    sessions.delete(sessionId);
    updateTabProjectLabels();
    if (sessions.size === 0) {
      activeSessionId = null;
      els.terminalArea.classList.add('hidden');
      els.emptyState.classList.remove('hidden');
    }
  }

  // 恢复会话：体检 → 用原 agent + 原工作区重新启动
  async function restoreSession(rec) {
    const s = sessions.get(rec.id);
    if (!s) return;

    // T2.7：恢复前体检
    const check = await window.api.checkSession({ projectPath, sessionId: rec.id });
    if (!check.success) {
      alert(`恢复失败：${check.error}`);
      return;
    }
    if (check.workspaceMissing) {
      alert('工作区目录已丢失，无法恢复。可关闭此标签或手动检查目录。');
      return;
    }
    if (!check.agentOk) {
      alert(`agent「${rec.agentCommand}」当前不可用，请先安装或刷新检测。`);
      return;
    }

    // 复用原工作区启动
    s.restored = false;
    s.contentEl.innerHTML = '<div class="tab-loading">正在重新启动…</div>';
    try {
      const result = await window.api.launchAgent({
        projectPath,
        agentCommand: rec.agentCommand,
        sessionId: rec.id,
        workspaceId: rec.workspaceId
      });
      if (!result.success) {
        s.contentEl.innerHTML = `<div class="tab-error">恢复失败：${escapeHtml(result.error)}</div>`;
        return;
      }
      initTerminal(rec.id, result.worktreePath, result.workspaceId);
    } catch (err) {
      s.contentEl.innerHTML = `<div class="tab-error">恢复异常：${escapeHtml(err.message)}</div>`;
    }
  }

  // 工作区列表：状态点（运行中/空闲）+ 名称 + 分支（等宽、右对齐）
  function renderWorkspaceList() {
    const ul = els.workspaceList;
    if (!ul) return;
    ul.innerHTML = '';

    if (!projectPath) {
      ul.innerHTML = '<li class="list-empty">打开项目后显示工作区</li>';
      return;
    }

    const wss = workspaceCache.filter(w => w.kind === 'managed');
    if (wss.length === 0) {
      ul.innerHTML = '<li class="list-empty">还没有工作区，点下面的 Agent 启动</li>';
      return;
    }

    const runningIds = new Set();
    for (const s of sessions.values()) {
      if (s.workspaceId && !s.exited) runningIds.add(s.workspaceId);
    }

    for (const w of wss) {
      const running = runningIds.has(w.id);
      const li = document.createElement('li');
      li.className = 'ws-item'
        + (running ? ' is-running' : '')
        + (w.status === 'broken' ? ' is-broken' : '');
      li.title = `${w.worktreePath}\n分支：${w.branch || '—'}`;
      li.innerHTML = `
        <span class="ws-dot"></span>
        <span class="ws-name">${escapeHtml(workspaceLabel(w))}</span>
        <span class="ws-branch">${escapeHtml(w.branch || '')}</span>
      `;
      li.addEventListener('click', async () => {
        if (w.status === 'missing' || w.status === 'broken') return;
        expSelection = w.id;
        await syncExplorerRoot();
      });
      ul.appendChild(li);
    }
  }

  // ---------- 侧栏 / 文件面板 折叠 ----------

  function fitAllTerminals() {
    for (const session of sessions.values()) {
      if (session.fitAddon) session.fitAddon.fit();
    }
  }

  function toggleSidebar() {
    const collapsed = document.querySelector('.app').classList.toggle('sidebar-collapsed');
    els.btnExpandSidebar.classList.toggle('hidden', !collapsed);
    setTimeout(fitAllTerminals, 280);
    saveLayoutDebounced();
  }

  function toggleExplorer() {
    const collapsed = document.querySelector('.app').classList.toggle('explorer-collapsed');
    els.btnExpandExplorer.classList.toggle('hidden', !collapsed);
    setTimeout(fitAllTerminals, 280);
    saveLayoutDebounced();
  }

  // ---------- 可拖拽分隔条（类似 VSCode） ----------

  function initSplitter(el, dir) {
    // dir: 'left' = 左侧栏（拖右变宽） | 'right' = 右侧面板（拖左变宽） | 'inner' = 文件树（拖右变宽）
    const appEl = document.querySelector('.app');
    const cssVar = dir === 'left' ? '--sidebar-w' : dir === 'right' ? '--explorer-w' : '--tree-w';
    const fallbackW = dir === 'left' ? 280 : dir === 'right' ? 320 : 240;
    const minW = dir === 'left' ? 180 : dir === 'right' ? 240 : 160;
    const maxW = dir === 'inner' ? 420 : 640;
    let startX = 0;
    let startW = 0;
    let dragging = false;

    el.addEventListener('mousedown', e => {
      dragging = true;
      startX = e.clientX;
      const cur = parseFloat(getComputedStyle(appEl).getPropertyValue(cssVar));
      startW = Number.isFinite(cur) ? cur : fallbackW;
      document.body.classList.add('dragging');
      e.preventDefault();
    });

    window.addEventListener('mousemove', e => {
      if (!dragging) return;
      const delta = e.clientX - startX;
      // left/inner：往右拖变宽；right：往左拖变宽（因为右侧面板在右侧）
      let w = (dir === 'left' || dir === 'inner') ? startW + delta : startW - delta;
      w = Math.max(minW, Math.min(w, maxW));
      appEl.style.setProperty(cssVar, `${w}px`);
      if (dir === 'inner') {
        // 拖动内部条时，若文件树变宽，应同步撑开外部文件面板，避免文件树被截断
        const explorerW = parseFloat(getComputedStyle(appEl).getPropertyValue('--explorer-w')) || 560;
        const newExplorerW = Math.max(explorerW, Math.min(640, w + 80));
        appEl.style.setProperty('--explorer-w', `${newExplorerW}px`);
      }
      if (dir !== 'inner') fitAllTerminals();
    });

    window.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      document.body.classList.remove('dragging');
      fitAllTerminals();
      saveLayoutDebounced();
    });
  }

  // ---------- 右侧文件面板 ----------

  // 浏览目标：工作区 id（default / managed / external）
  let expSelection = '';
  let expLoadedRoot = null;      // 当前树已加载的根目录
  let expandedDirs = new Set();  // 已展开目录（相对路径），刷新时保留
  let currentFile = null;        // { root, relPath, name }
  let changedMap = new Map();    // worktree 改动文件（相对路径 → 状态 M/??/A...），用于标色和 diff
  let gitStatusRoot = null;      // 上次 git status 对应的根目录
  let gitStatusAt = 0;           // 上次 git status 的时间戳（用于节流）
  let viewerMode = 'content';    // 'content' | 'diff'
  let workspaceCache = [];       // 当前项目的工作区列表（default/managed/external）

  // 把工作区列表（default / managed / external）填进下拉框
  async function populateRootSelect() {
    const sel = els.expRootSelect;
    sel.innerHTML = '';

    if (!projectPath) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = '未选择项目';
      sel.appendChild(opt);
      return;
    }

    const res = await window.api.listWorkspaces({ projectPath });
    workspaceCache = res.success ? (res.workspaces || []) : [];
    renderWorkspaceList(); // 侧栏工作区列表跟随缓存刷新

    const kindLabel = { default: '默认', managed: '工具', external: '外部' };
    for (const w of workspaceCache) {
      const opt = document.createElement('option');
      opt.value = w.id;
      const tag = kindLabel[w.kind] || w.kind;
      const missing = w.status === 'missing' ? '（目录丢失）' : '';
      opt.textContent = `[${tag}] ${w.name}${missing}`;
      opt.title = `${w.worktreePath}${w.branch ? `\n分支：${w.branch}` : ''}`;
      if (w.status === 'missing') opt.disabled = true;
      sel.appendChild(opt);
    }

    // 当前选择失效 → 回退到 default 或第一个工作区
    const ids = workspaceCache.map(w => w.id);
    if (!ids.includes(expSelection)) {
      const def = workspaceCache.find(w => w.kind === 'default');
      expSelection = def ? def.id : (ids[0] || '');
    }
    sel.value = expSelection;
  }

  function currentWorkspace() {
    return workspaceCache.find(w => w.id === expSelection) || null;
  }

  function currentRoot() {
    const ws = currentWorkspace();
    return ws ? ws.worktreePath : (projectPath || null);
  }

  // 会话 / 选择变化后调用：刷新下拉框；根目录变了才重建树（保留展开状态）
  async function syncExplorerRoot() {
    await populateRootSelect();
    const root = currentRoot();
    if (!root || root === expLoadedRoot) return;
    resetExplorer();
    loadTree();
  }

  function resetExplorer() {
    expLoadedRoot = null;
    expandedDirs = new Set();
    currentFile = null;
    changedMap = new Map();
    viewerMode = 'content';
    els.viewerName.textContent = '未选择文件';
    els.btnViewerDiff.classList.add('hidden');
    els.viewerBody.innerHTML = '<div class="viewer-hint">点击右侧文件树中的文件，在这里查看内容</div>';
  }

  async function loadTree() {
    const root = currentRoot();
    if (!root) {
      els.expRootPath.textContent = '未选择项目';
      els.expTree.innerHTML = '<div class="explorer-hint">打开项目后可浏览文件</div>';
      changedMap = new Map();
      return;
    }
    expLoadedRoot = root;
    const ws = currentWorkspace();
    const kindLabel = { default: '默认', managed: '工具', external: '外部' };
    const tag = ws ? (kindLabel[ws.kind] || ws.kind) : '工具';
    els.expRootPath.textContent = `[${tag}] ${root}`;
    els.expRootPath.title = root;
    els.expTree.innerHTML = '';
    const ul = document.createElement('ul');
    ul.className = 'tree-list';
    els.expTree.appendChild(ul);

    // 拉取 git 改动列表用于标色，并监视文件变化自动刷新
    {
      const now = Date.now();
      // git status 在大仓库上开销不低：同一根目录 1.5 秒内复用上次结果
      if (gitStatusRoot !== root || now - gitStatusAt > 1500) {
        const st = await window.api.gitStatus({ projectPath, wtPath: root });
        changedMap = new Map();
        if (st.success && Array.isArray(st.dirty)) {
          for (const d of st.dirty) {
            changedMap.set(d.file.replace(/\//g, '\\'), d.status);
          }
        }
        gitStatusRoot = root;
        gitStatusAt = now;
      }
      window.api.watchTree({ root }).catch(() => {});
    }

    await renderDir('', ul);
  }

  async function renderDir(relPath, container) {
    const res = await window.api.readDir({ root: expLoadedRoot, relPath });
    if (!res.success) {
      container.innerHTML = `<li class="explorer-hint">${escapeHtml(res.error)}</li>`;
      return;
    }
    if (res.entries.length === 0 && relPath === '') {
      container.innerHTML = '<li class="explorer-hint">（空目录）</li>';
      return;
    }
    // 超大目录只渲染前 800 项，避免一次生成上万个 DOM 节点把界面卡死
    const MAX_DIR_ENTRIES = 800;
    const shownEntries = res.entries.slice(0, MAX_DIR_ENTRIES);
    for (const entry of shownEntries) {
      const li = document.createElement('li');
      const rel = relPath ? `${relPath}\\${entry.name}` : entry.name;
      const item = document.createElement('div');
      item.className = `tree-item ${entry.isDir ? 'is-dir' : 'is-file'}`;
      item.tabIndex = 0;
      item.setAttribute('role', 'treeitem');
      item.dataset.rel = rel;
      // T3.3：scratch 目录（.agent-manager）显示"临时"角标，不参与改动标色
      const isScratch = entry.isDir && entry.name === '.agent-manager';
      if (isScratch) item.classList.add('is-scratch');
      // git 装饰色：按编辑器通行约定（新增=绿、修改=琥珀、删除=红、未跟踪=绿）
      let modClass = '';
      if (!entry.isDir && !isScratch && changedMap.has(rel)) {
        const status = changedMap.get(rel);
        const kind = status === '??' ? 'new' : status[0] === 'A' ? 'added'
          : status[0] === 'D' ? 'deleted' : status[0] === 'R' ? 'renamed' : 'modified';
        modClass = ` is-${kind}`;
        const label = { new: '未跟踪', added: '新增', deleted: '已删除', renamed: '已重命名', modified: '已修改' }[kind];
        item.title = `${rel}（${label}）`;
      }
      item.className += modClass;
      const scratchBadge = isScratch ? '<span class="tree-badge">临时</span>' : '';
      // 文件图标按类型着色，遵循编辑器通行约定
      const ext = entry.isDir ? '' : (entry.name.split('.').pop() || '').toLowerCase();
      const typeCls = entry.isDir ? 'is-folder' : `is-${ext}`;
      item.innerHTML = `
        <span class="tree-caret">${entry.isDir ? icon('chevron-right', 'icon icon-caret') : ''}</span>
        <span class="tree-icon ${typeCls}">${entry.isDir ? icon('folder', 'icon icon-node') : icon('file', 'icon icon-node')}</span>
        <span class="tree-name">${escapeHtml(entry.name)}</span>
        ${scratchBadge}
      `;
      li.appendChild(item);

      if (entry.isDir) {
        item.addEventListener('click', () => toggleDir(li, item, rel));
        item.addEventListener('keydown', e => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            toggleDir(li, item, rel);
          }
        });
        if (expandedDirs.has(rel)) {
          item.classList.add('expanded');
          const childUl = document.createElement('ul');
          childUl.className = 'tree-list';
          li.appendChild(childUl);
          renderDir(rel, childUl);
        }
      } else {
        const selectFile = () => {
          els.expTree.querySelectorAll('.tree-item.selected').forEach(el => el.classList.remove('selected'));
          item.classList.add('selected');
          openFile(rel, entry.name);
        };
        item.addEventListener('click', selectFile);
        item.addEventListener('keydown', e => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            selectFile();
          }
        });
      }
      container.appendChild(li);
    }

    if (res.entries.length > MAX_DIR_ENTRIES) {
      const more = document.createElement('li');
      more.className = 'explorer-hint';
      more.textContent = `目录项过多，仅显示前 ${MAX_DIR_ENTRIES} 项（共 ${res.entries.length} 项）`;
      container.appendChild(more);
    }
  }

  function toggleDir(li, item, rel) {
    const existing = li.querySelector(':scope > .tree-list');
    if (existing) {
      // 收起
      expandedDirs.delete(rel);
      item.classList.remove('expanded');
      existing.remove();
      return;
    }
    // 展开
    expandedDirs.add(rel);
    item.classList.add('expanded');
    const childUl = document.createElement('ul');
    childUl.className = 'tree-list';
    childUl.innerHTML = '<li class="explorer-hint">…</li>';
    li.appendChild(childUl);
    renderDir(rel, childUl);
  }

  async function openFile(relPath, name, keepScroll = null) {
    if (!expLoadedRoot) return;
    currentFile = { root: expLoadedRoot, relPath, name };
    viewerMode = 'content';
    els.viewerName.textContent = name;
    els.btnViewerDiff.classList.toggle('hidden', !changedMap.has(relPath) || isMarkdown(relPath));
    els.viewerBody.innerHTML = '<div class="viewer-hint">加载中…</div>';

    const res = await window.api.readFile({ root: currentFile.root, relPath });
    if (!res.success) {
      els.viewerBody.innerHTML = `<div class="viewer-hint">${escapeHtml(res.error)}</div>`;
      return;
    }

    // Markdown 文件：渲染成排版后的 HTML 预览
    if (isMarkdown(relPath)) {
      renderMarkdown(res.content);
      return;
    }

    const lines = res.content.split(/\r?\n/);
    let html = '';
    const shown = Math.min(lines.length, res.maxLines);
    for (let i = 0; i < shown; i++) {
      html += `<div class="ln"><span class="ln-no">${i + 1}</span><span class="ln-text">${escapeHtml(lines[i]) || ' '}</span></div>`;
    }
    if (lines.length > res.maxLines) {
      html += `<div class="viewer-hint">… 内容过长，仅显示前 ${res.maxLines} 行</div>`;
    }
    els.viewerBody.innerHTML = html;
    els.viewerBody.scrollTop = keepScroll !== null ? keepScroll : 0;
  }

  function isMarkdown(relPath) {
    return /\.(md|markdown)$/i.test(relPath);
  }

  // 渲染 Markdown：交给 DOMPurify 做白名单清洗，避免 javascript: 链接 / 事件属性等注入
  function renderMarkdown(content) {
    try {
      const raw = marked.parse(content, { breaks: true, gfm: true });
      const clean = window.DOMPurify
        ? window.DOMPurify.sanitize(raw, {
            FORBID_TAGS: ['style', 'form', 'input', 'button', 'textarea', 'select', 'meta', 'link', 'base', 'object', 'embed'],
            FORBID_ATTR: ['style', 'srcdoc'],
            ALLOW_DATA_ATTR: false
          })
        : escapeHtml(raw);
      els.viewerBody.innerHTML = `<div class="md-body">${clean}</div>`;
    } catch (err) {
      // 解析失败退回纯文本
      els.viewerBody.innerHTML = `<div class="ln"><span class="ln-text">${escapeHtml(content)}</span></div>`;
    }
    els.viewerBody.scrollTop = 0;
  }

  async function showDiff(keepScroll = null) {
    if (!currentFile) return;
    viewerMode = 'diff';
    els.viewerName.textContent = `${currentFile.name}（改动 diff）`;
    els.viewerBody.innerHTML = '<div class="viewer-hint">加载 diff…</div>';

    const res = await window.api.gitDiff({ wtPath: currentFile.root, relPath: currentFile.relPath });
    if (!res.success) {
      els.viewerBody.innerHTML = `<div class="viewer-hint">${escapeHtml(res.error)}</div>`;
      return;
    }

    const lines = (res.diff || '').split('\n');
    if (lines.length === 1 && lines[0] === '') {
      els.viewerBody.innerHTML = '<div class="viewer-hint">没有未暂存的改动（可能是新文件，或改动已被 agent 提交）</div>';
      return;
    }
    let html = '';
    for (const line of lines) {
      let cls = '';
      if (line.startsWith('+++') || line.startsWith('---')) cls = 'd-meta';
      else if (line.startsWith('@@')) cls = 'd-hunk';
      else if (line.startsWith('+')) cls = 'd-add';
      else if (line.startsWith('-')) cls = 'd-del';
      html += `<div class="ln"><span class="ln-no"></span><span class="ln-text ${cls}">${escapeHtml(line) || ' '}</span></div>`;
    }
    els.viewerBody.innerHTML = html;
    els.viewerBody.scrollTop = keepScroll !== null ? keepScroll : 0;
  }

  function toggleDiffView() {
    if (!currentFile) return;
    const scroll = els.viewerBody.scrollTop;
    if (viewerMode === 'content') showDiff(scroll);
    else openFile(currentFile.relPath, currentFile.name, scroll);
  }

  function closeViewer() {
    currentFile = null;
    viewerMode = 'content';
    els.viewerName.textContent = '未选择文件';
    els.btnViewerDiff.classList.add('hidden');
    els.viewerBody.innerHTML = '<div class="viewer-hint">点击右侧文件树中的文件，在这里查看内容</div>';
  }

  // ---------- Git 工作区状态浮窗 ----------

  function toggleGitPopover() {
    const hidden = els.gitPopover.classList.toggle('hidden');
    els.btnGitStatus.classList.toggle('active', !hidden);
    if (!hidden) renderGitStatus();
  }

  async function renderGitStatus() {
    const body = els.gitPopoverBody;
    body.innerHTML = '<div class="git-hint">加载中…</div>';

    if (!projectPath) {
      body.innerHTML = '<div class="git-hint">未选择项目</div>';
      return;
    }

    let html = '';

    // 项目主目录状态
    const proj = await window.api.gitStatus({ projectPath, wtPath: projectPath });
    if (proj.success) {
      const dirtyCount = proj.dirty ? proj.dirty.length : 0;
      html += `
        <div class="git-item">
          <div class="git-item-head">
            <span class="git-name">${icon('folder', 'icon icon-node')} 项目主目录</span>
            <span class="git-branch">${escapeHtml(proj.wtBranch || '未知分支')}</span>
          </div>
          <div class="git-sub">${dirtyCount ? `${dirtyCount} 个未提交改动` : '工作区干净'}</div>
        </div>`;
    } else {
      html += `<div class="git-hint">读取项目状态失败：${escapeHtml(proj.error || '')}</div>`;
    }

    // 把会话按项目分组；多项目时浮窗也能一目了然
    const byProject = new Map();
    for (const s of sessions.values()) {
      if (!s.worktreePath) continue;
      const key = s.projectPath || projectPath || '未关联项目';
      if (!byProject.has(key)) byProject.set(key, []);
      byProject.get(key).push(s);
    }

    if (byProject.size === 0) {
      html += '<div class="git-hint">当前没有运行中的 agent 工作树</div>';
    }

    for (const [projPath, sessList] of byProject) {
      const projName = projectNameOf(projPath);
      html += `<div class="git-project-header">${escapeHtml(projName)}</div>`;

      for (const s of sessList) {
        if (s.worktreeCleaned) {
          html += `
            <div class="git-item">
              <div class="git-item-head"><span class="git-name">${icon('branch', 'icon icon-node')} ${escapeHtml(s.agent.label)}</span></div>
              <div class="git-sub">工作树已清理</div>
            </div>`;
          continue;
        }
        const st = await window.api.gitStatus({ projectPath: projPath, wtPath: s.worktreePath });
        if (!st.success) {
          html += `
            <div class="git-item">
              <div class="git-item-head"><span class="git-name">${icon('branch', 'icon icon-node')} ${escapeHtml(s.agent.label)}</span></div>
              <div class="git-sub">读取状态失败：${escapeHtml(st.error || '')}</div>
            </div>`;
          continue;
        }
        const dirtyFiles = (st.dirty || []).slice(0, 15).map(d => `
          <div class="git-file">
            <span class="${d.status === '??' ? 'st-new' : 'st-mod'}">${escapeHtml(d.status || 'M')}</span>
            <span>${escapeHtml(d.file)}</span>
          </div>`).join('');
        const moreCount = Math.max(0, (st.dirty || []).length - 15);

        // 审查闭环按钮（M4）：合并 / 丢弃 / 清理
        const wsId = s.workspaceId || '';
        const canReview = wsId && s.worktreePath && !s.worktreeCleaned;
        let actionBtns = '';
        if (s.worktreeCleaned) {
          actionBtns = '<span class="git-cleaned">工作树已清理</span>';
        } else if (canReview) {
          const mergeBtn = wsId ? `<button class="btn btn-primary btn-mini git-merge" data-ws="${escapeHtml(wsId)}" data-session="${s.sessionId}">合并回主分支</button>` : '';
          const discardBtn = wsId ? `<button class="btn btn-secondary btn-mini git-discard" data-ws="${escapeHtml(wsId)}" data-session="${s.sessionId}">丢弃全部改动</button>` : '';
          const cleanBtn = s.exited
            ? `<button class="btn btn-secondary btn-mini git-cleanup" data-session="${s.sessionId}">清理工作树</button>`
            : '<span class="git-cleaned">会话运行中，退出后可清理</span>';
          actionBtns = `<div class="git-btn-row">${mergeBtn}${discardBtn}${cleanBtn}</div>`;
        } else {
          actionBtns = '<span class="git-cleaned">会话运行中，退出后可清理</span>';
        }

        html += `
          <div class="git-item">
            <div class="git-item-head">
              <span class="git-name">${icon('branch', 'icon icon-node')} ${escapeHtml(s.agent.label)}</span>
              <span class="git-branch" title="${escapeHtml(st.wtBranch || '')}">${escapeHtml(st.wtBranch || '')}</span>
            </div>
            <div class="git-sub">
              领先主分支 ${st.ahead} 个提交${st.behind ? ` · 落后 ${st.behind}` : ''}
              ${st.dirty && st.dirty.length ? ` · ${st.dirty.length} 个未提交改动` : ' · 工作区干净'}
              ${st.lastCommit ? `<br>最近提交：${escapeHtml(st.lastCommit)}` : ''}
            </div>
            ${dirtyFiles ? `<div class="git-files">${dirtyFiles}${moreCount ? `<div class="git-file"><span>…</span><span>还有 ${moreCount} 个文件</span></div>` : ''}</div>` : ''}
            <div class="git-actions">${actionBtns}</div>
          </div>`;
      }
    }

    body.innerHTML = html;

    // 清理工作树：有未提交改动时主进程会拒绝，不会误删
    body.querySelectorAll('.git-cleanup').forEach(btn => {
      btn.addEventListener('click', async () => {
        const s = sessions.get(btn.dataset.session);
        if (!s || !s.worktreePath) return;
        const ok = confirm(`确定清理「${s.agent.label}」的 worktree？\n\n${s.worktreePath}\n\n有未提交改动时会自动取消。`);
        if (!ok) return;
        btn.disabled = true;
        btn.textContent = '清理中…';
        const res = await window.api.cleanupWorktree({ projectPath: s.projectPath, wtPath: s.worktreePath });
        if (!res.success) {
          alert(`清理失败：${res.error}`);
          btn.disabled = false;
          btn.textContent = '清理工作树';
          return;
        }
        s.worktreeCleaned = true;
        const def = workspaceCache.find(w => w.kind === 'default');
        if (def) expSelection = def.id;
        syncExplorerRoot();
        renderGitStatus();
      });
    });

    // 合并回主分支（M4）
    body.querySelectorAll('.git-merge').forEach(btn => {
      btn.addEventListener('click', async () => {
        const wsId = btn.dataset.ws;
        const s = sessions.get(btn.dataset.session);
        if (!wsId) return;

        // 先看 diff 统计
        btn.disabled = true;
        btn.textContent = '分析中…';
        const ds = await window.api.reviewDiffstat({ projectPath, workspaceId: wsId });
        if (!ds.success) {
          alert(`获取 diff 统计失败：${ds.error}`);
          btn.disabled = false;
          btn.textContent = '合并回主分支';
          return;
        }
        if (ds.files === 0) {
          alert('没有新提交可合并。');
          btn.disabled = false;
          btn.textContent = '合并回主分支';
          return;
        }

        const ok = confirm(
          `确定把「${s ? s.agent.label : wsId}」合并回主分支？\n\n` +
          `改动文件：${ds.files} 个（+${ds.insertions} / -${ds.deletions}）\n\n` +
          `合并后可选择保留或归档此工作区。`
        );
        if (!ok) {
          btn.disabled = false;
          btn.textContent = '合并回主分支';
          return;
        }

        btn.textContent = '合并中…';
        const res = await window.api.reviewMerge({ projectPath, workspaceId: wsId });
        if (!res.success) {
          alert(`合并失败：${res.error}`);
          btn.disabled = false;
          btn.textContent = '合并回主分支';
          return;
        }

        // T6.5：合并成功后，工作树干净就自动归档（只删目录，分支保留可回溯）
        const wsRec = workspaceCache.find(w => w.id === wsId);
        const branchName = (wsRec && wsRec.branch) || '';
        const st = await window.api.gitStatus({ projectPath, wtPath: s && s.worktreePath });
        const dirtyCount = st && st.success ? (st.dirty || []).length : -1;

        if (dirtyCount === 0) {
          const res2 = await window.api.archiveWorkspace({ projectPath, id: wsId });
          if (res2.success) {
            if (s) s.worktreeCleaned = true;
            // 工作区已归档：关联的"已退出"会话也没意义了，顺手清掉，避免点开报"目录丢失"
            for (const [sid, sess] of [...sessions.entries()]) {
              if (sess.workspaceId !== wsId || !sess.exited) continue;
              sess.tabEl.remove();
              sess.contentEl.remove();
              sessions.delete(sid);
              window.api.forgetSession({ sessionId: sid }).catch(() => {});
            }
            if (sessions.size === 0) {
              els.terminalArea.classList.add('hidden');
              els.emptyState.classList.remove('hidden');
            }
            const def = workspaceCache.find(w => w.kind === 'default');
            if (def) expSelection = def.id;
            await syncExplorerRoot();
            toast(`已合并并清理工作目录${branchName ? `（分支 ${branchName} 保留）` : ''}`);
          } else {
            toast(`合并成功，但清理失败：${res2.error || '未知原因'}`, 'warn');
          }
        } else if (dirtyCount > 0) {
          toast(`合并成功；工作目录还有 ${dirtyCount} 个未提交改动，已保留`, 'warn');
        } else {
          toast('合并成功；未能确认工作目录状态，已保留', 'warn');
        }
        renderGitStatus();
      });
    });

    // 丢弃全部改动（M4）
    body.querySelectorAll('.git-discard').forEach(btn => {
      btn.addEventListener('click', async () => {
        const wsId = btn.dataset.ws;
        const s = sessions.get(btn.dataset.session);
        if (!wsId) return;

        // 先查有多少文件
        const ds = await window.api.reviewDiscard({ projectPath, workspaceId: wsId, confirm: false });
        const count = ds.dirtyCount || 0;
        if (count === 0) {
          alert('工作区干净，没有需要丢弃的改动。');
          return;
        }

        const ok = confirm(
          `⚠️ 确定丢弃「${s ? s.agent.label : wsId}」的全部未提交改动？\n\n` +
          `将丢失 ${count} 个文件的改动，此操作不可撤销！`
        );
        if (!ok) return;

        btn.disabled = true;
        btn.textContent = '丢弃中…';
        const res = await window.api.reviewDiscard({ projectPath, workspaceId: wsId, confirm: true });
        if (!res.success) {
          alert(`丢弃失败：${res.error}`);
          btn.disabled = false;
          btn.textContent = '丢弃全部改动';
          return;
        }
        renderGitStatus();
      });
    });
  }

  // ---------- 布局持久化 ----------

  let layoutSaveTimer = null;

  function persistConfig() {
    return window.api.setConfig({
      worktreeRoot: appConfig.worktreeRoot,
      recentProjects: appConfig.recentProjects || [],
      currentProject: appConfig.currentProject || null,
      layout: appConfig.layout || null
    }).catch(() => {});
  }

  function saveLayoutDebounced() {
    clearTimeout(layoutSaveTimer);
    layoutSaveTimer = setTimeout(() => {
      const appEl = document.querySelector('.app');
      appConfig.layout = {
        sidebarW: appEl.style.getPropertyValue('--sidebar-w') || null,
        explorerW: appEl.style.getPropertyValue('--explorer-w') || null,
        treeW: appEl.style.getPropertyValue('--tree-w') || null,
        sidebarCollapsed: appEl.classList.contains('sidebar-collapsed'),
        explorerCollapsed: appEl.classList.contains('explorer-collapsed')
      };
      persistConfig();
    }, 400);
  }

  function restoreLayout() {
    const ly = appConfig.layout;
    if (!ly) return;
    const appEl = document.querySelector('.app');
    if (ly.sidebarW) appEl.style.setProperty('--sidebar-w', ly.sidebarW);
    if (ly.explorerW) appEl.style.setProperty('--explorer-w', ly.explorerW);
    if (ly.treeW) appEl.style.setProperty('--tree-w', ly.treeW);
    if (ly.sidebarCollapsed) {
      appEl.classList.add('sidebar-collapsed');
      els.btnExpandSidebar.classList.remove('hidden');
    }
    if (ly.explorerCollapsed) {
      appEl.classList.add('explorer-collapsed');
      els.btnExpandExplorer.classList.remove('hidden');
    }
  }

  // ---------- 文件树自动刷新（fs.changed 事件） ----------

  let fsChangeTimer = null;

  function onFsChanged({ root }) {
    if (!root || !expLoadedRoot) return;
    if (root.toLowerCase() !== expLoadedRoot.toLowerCase()) return;
    clearTimeout(fsChangeTimer);
    fsChangeTimer = setTimeout(() => {
      // 刷新树（保留展开状态）
      loadTree();
      // 正在查看的文件若被改动，自动重载（保留滚动位置）
      if (currentFile && currentFile.root.toLowerCase() === expLoadedRoot.toLowerCase()) {
        const scroll = els.viewerBody.scrollTop;
        if (viewerMode === 'diff') showDiff(scroll);
        else openFile(currentFile.relPath, currentFile.name, scroll);
      }
    }, 800);
  }

  els.btnOpenProject.addEventListener('click', chooseProject);
  els.btnRefreshAgents.addEventListener('click', loadAgents);
  els.btnSettings.addEventListener('click', openSettings);
  els.btnCloseSettings.addEventListener('click', closeSettings);
  els.btnSelectWtRoot.addEventListener('click', selectWtRoot);
  els.btnResetWtRoot.addEventListener('click', resetWtRoot);
  els.btnSaveSettings.addEventListener('click', saveSettings);

  // 弹窗：点击遮罩或按 Esc 关闭
  els.settingsModal.querySelector('.modal-backdrop').addEventListener('click', closeSettings);
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && els.settingsModal.classList.contains('open')) closeSettings();
  });

  els.btnCollapseSidebar.addEventListener('click', toggleSidebar);
  els.btnExpandSidebar.addEventListener('click', toggleSidebar);
  els.btnCollapseExplorer.addEventListener('click', toggleExplorer);
  els.btnExpandExplorer.addEventListener('click', toggleExplorer);

  // 拖拽分隔条
  initSplitter(els.splitterLeft, 'left');
  initSplitter(els.splitterRight, 'right');
  initSplitter(els.splitterInner, 'inner');

  // 文件面板
  els.expRootSelect.addEventListener('change', () => {
    expSelection = els.expRootSelect.value;
    resetExplorer();
    loadTree();
  });
  els.btnExpRefresh.addEventListener('click', () => {
    if (expLoadedRoot !== currentRoot()) {
      resetExplorer();
    }
    loadTree();
  });
  els.btnViewerReload.addEventListener('click', () => {
    if (!currentFile) return;
    const scroll = els.viewerBody.scrollTop;
    if (viewerMode === 'diff') showDiff(scroll);
    else openFile(currentFile.relPath, currentFile.name, scroll);
  });
  els.btnViewerClose.addEventListener('click', closeViewer);
  els.btnViewerDiff.addEventListener('click', toggleDiffView);

  // Markdown 里的链接交给系统浏览器打开，绝不让窗口自己导航走
  els.viewerBody.addEventListener('click', e => {
    const link = e.target.closest('a[href]');
    if (!link) return;
    e.preventDefault();
    const href = link.getAttribute('href') || '';
    if (/^(https?:\/\/|mailto:)/i.test(href)) {
      window.api.openExternal(href);
    }
  });

  // Git 状态浮窗
  els.btnGitStatus.addEventListener('click', toggleGitPopover);
  els.btnGitClose.addEventListener('click', toggleGitPopover);
  document.addEventListener('mousedown', e => {
    // 点击浮窗和按钮以外区域时关闭
    if (els.gitPopover.classList.contains('hidden')) return;
    if (els.gitPopover.contains(e.target) || els.btnGitStatus.contains(e.target)) return;
    toggleGitPopover();
  });

  // 文件变化自动刷新
  window.api.onFsChanged(onFsChanged);

  // 点击系统通知 → 跳转到对应 agent 的 tab
  window.api.onSessionActivate(({ sessionId }) => {
    if (sessions.has(sessionId)) switchTab(sessionId);
  });

  loadAgents();
  initConfig();
})();
