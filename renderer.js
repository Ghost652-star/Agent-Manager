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
    projectSelect: document.getElementById('project-select'),
    projectMeta: document.getElementById('project-meta'),
    projectName: document.getElementById('project-name'),
    projectPath: document.getElementById('project-path'),
    recentProjects: document.getElementById('recent-projects'),
    recentList: document.getElementById('recent-list'),
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
      const badge = session.tabEl.querySelector('.tab-agent');
      if (badge) badge.style.color = 'var(--text-dim)';
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
      const li = document.createElement('li');
      li.className = 'agent-item';
      li.title = `点击在 worktree 中启动 ${agent.label}`;
      li.innerHTML = `
        <span class="agent-status"></span>
        <span class="agent-name">${escapeHtml(agent.label)}</span>
        <span class="agent-cmd">${escapeHtml(agent.command)}</span>
      `;
      li.addEventListener('click', () => launchAgent(agent));
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
      renderRecentProjects();
      populateProjectSelect();
      // 回退到当前有效项目；如果当前项目也无效，就清空
      if (projectPath && projectPath !== path) return true;
      if (appConfig.currentProject) return setProject(appConfig.currentProject, false);
      return false;
    }

    projectPath = path;
    projectName = projectNameOf(path);
    els.projectName.textContent = projectName;
    els.projectPath.textContent = path;
    els.projectMeta.classList.remove('hidden');
    els.wtRoot.textContent = formatWorktreeRoot(path);

    if (save) {
      appConfig.recentProjects = appConfig.recentProjects || [];
      appConfig.recentProjects = appConfig.recentProjects.filter(p => p !== path);
      appConfig.recentProjects.unshift(path);
      appConfig.recentProjects = appConfig.recentProjects.slice(0, 10);
      appConfig.currentProject = path;
      persistConfig();
    }

    renderRecentProjects();
    populateProjectSelect();
    updateTabProjectLabels();
    syncExplorerRoot();
    return true;
  }

  // 填充项目选择器：最近项目 + 当前打开的所有会话涉及的项目
  function populateProjectSelect() {
    const sel = els.projectSelect;
    sel.innerHTML = '';
    const known = new Set(appConfig.recentProjects || []);
    for (const s of sessions.values()) {
      if (s.projectPath) known.add(s.projectPath);
    }
    const list = [...known];
    if (!projectPath && list.length === 0) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = '请打开一个项目';
      sel.appendChild(opt);
      return;
    }
    for (const p of list) {
      const opt = document.createElement('option');
      opt.value = p;
      opt.textContent = projectNameOf(p);
      opt.title = p;
      sel.appendChild(opt);
    }
    if (projectPath) sel.value = projectPath;
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

  async function launchAgent(agent) {
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

    switchTab(sessionId);

    try {
      const result = await window.api.launchAgent({ projectPath, agentCommand: agent.command, sessionId });
      if (!result.success) {
        content.innerHTML = `<div class="tab-error">启动失败：${escapeHtml(result.error)}</div>`;
        return;
      }
      initTerminal(sessionId, result.worktreePath);
    } catch (err) {
      content.innerHTML = `<div class="tab-error">启动异常：${escapeHtml(err.message)}</div>`;
    }
  }

  function createTab(sessionId, agent) {
    const tab = document.createElement('button');
    tab.className = 'tab';
    tab.dataset.session = sessionId;
    tab.innerHTML = `
      <span class="tab-project hidden">…</span>
      <span class="tab-agent">${escapeHtml(agent.label)}</span>
      <span class="tab-wt">…</span>
      <span class="tab-close" title="关闭">×</span>
    `;
    tab.addEventListener('click', e => {
      if (e.target.classList.contains('tab-close')) {
        closeSession(sessionId);
      } else {
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

  function initTerminal(sessionId, worktreePath) {
    const session = sessions.get(sessionId);
    if (!session) return;

    session.worktreePath = worktreePath;
    expSelection = sessionId; // 启动新 agent 后自动查看它的 worktree
    syncExplorerRoot();

    session.contentEl.innerHTML = '';
    const container = document.createElement('div');
    container.style.width = '100%';
    container.style.height = '100%';
    session.contentEl.appendChild(container);

    // 更新 tab 上的 worktree 路径
    const wtEl = session.tabEl.querySelector('.tab-wt');
    if (wtEl) wtEl.textContent = worktreePath;

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
      session.contentEl.classList.toggle('active', isActive);
      if (isActive && session.terminal) {
        requestAnimationFrame(() => {
          session.fitAddon.fit();
          session.terminal.focus();
        });
      }
    }
    // 切 tab 时面板自动跟随该 agent 的 worktree
    const active = sessions.get(sessionId);
    if (active && active.worktreePath) expSelection = sessionId;
    syncExplorerRoot();
  }

  function closeSession(sessionId) {
    const session = sessions.get(sessionId);
    if (!session) return;

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
      expSelection = 'proj';
      syncExplorerRoot();
    } else if (activeSessionId === sessionId) {
      const first = sessions.values().next().value;
      switchTab(first.sessionId);
    }
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
    els.settingsModal.classList.remove('hidden');
  }

  function closeSettings() {
    els.settingsModal.classList.add('hidden');
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
    populateProjectSelect();
    renderRecentProjects();
  }

  function renderRecentProjects() {
    const list = appConfig.recentProjects || [];
    els.recentList.innerHTML = '';
    if (list.length === 0) {
      els.recentProjects.classList.add('hidden');
      return;
    }
    els.recentProjects.classList.remove('hidden');
    for (const p of list.slice(0, 5)) {
      const li = document.createElement('li');
      li.className = 'recent-item';
      li.title = p;
      const name = p.replace(/\\/g, '/').split('/').pop();
      li.innerHTML = `
        <span class="recent-name">${escapeHtml(name)}</span>
        <span class="recent-path">${escapeHtml(p)}</span>
      `;
      li.addEventListener('click', () => setProject(p));
      els.recentList.appendChild(li);
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

  // 浏览目标：'proj' = 真实项目目录；sessionId = 该 agent 的 worktree
  let expSelection = 'proj';
  let expLoadedRoot = null;      // 当前树已加载的根目录
  let expandedDirs = new Set();  // 已展开目录（相对路径），刷新时保留
  let currentFile = null;        // { root, relPath, name }
  let changedMap = new Map();    // worktree 改动文件（相对路径 → 状态 M/??/A...），用于标色和 diff
  let viewerMode = 'content';    // 'content' | 'diff'

  // 把「所有运行中 agent 的 worktree + 真实项目目录」填进下拉框
  function populateRootSelect() {
    const sel = els.expRootSelect;
    sel.innerHTML = '';

    // 下拉框只显示当前项目的 worktree；多项目时才需要这个过滤
    for (const s of sessions.values()) {
      if (!s.worktreePath || s.projectPath !== projectPath) continue;
      const opt = document.createElement('option');
      opt.value = s.sessionId;
      opt.textContent = `⎇ ${s.agent.label}（worktree）`;
      opt.title = s.worktreePath;
      sel.appendChild(opt);
    }

    const optProj = document.createElement('option');
    optProj.value = 'proj';
    optProj.textContent = '📁 项目目录（真实）';
    optProj.title = projectPath || '';
    sel.appendChild(optProj);

    // 当前选择失效（会话已关闭或不属于当前项目）→ 回退到激活会话或项目目录
    if (expSelection !== 'proj') {
      const s = sessions.get(expSelection);
      if (!s || !s.worktreePath || s.projectPath !== projectPath) {
        const active = activeSessionId ? sessions.get(activeSessionId) : null;
        expSelection = (active && active.worktreePath && active.projectPath === projectPath) ? active.sessionId : 'proj';
      }
    }
    sel.value = expSelection;
  }

  function currentRoot() {
    if (expSelection === 'proj') return projectPath;
    const s = sessions.get(expSelection);
    if (s && s.worktreePath) return s.worktreePath;
    const active = activeSessionId ? sessions.get(activeSessionId) : null;
    if (active && active.worktreePath) return active.worktreePath;
    return projectPath;
  }

  // 会话 / 选择变化后调用：刷新下拉框；根目录变了才重建树（保留展开状态）
  function syncExplorerRoot() {
    populateRootSelect();
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
    els.expRootPath.textContent = expSelection === 'proj' ? `[项目·真实] ${root}` : `[worktree] ${root}`;
    els.expTree.innerHTML = '';
    const ul = document.createElement('ul');
    ul.className = 'tree-list';
    els.expTree.appendChild(ul);

    // worktree 模式：拉取 git 改动列表用于标色，并监视文件变化自动刷新
    changedMap = new Map();
    if (expSelection !== 'proj') {
      const st = await window.api.gitStatus({ projectPath, wtPath: root });
      if (st.success && Array.isArray(st.dirty)) {
        for (const d of st.dirty) {
          changedMap.set(d.file.replace(/\//g, '\\'), d.status);
        }
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
    for (const entry of res.entries) {
      const li = document.createElement('li');
      const rel = relPath ? `${relPath}\\${entry.name}` : entry.name;
      const item = document.createElement('div');
      item.className = `tree-item ${entry.isDir ? 'is-dir' : 'is-file'}`;
      // worktree 改动标色：新增=绿，其他改动=琥珀
      let modClass = '';
      if (!entry.isDir && changedMap.has(rel)) {
        const status = changedMap.get(rel);
        modClass = status === '??' ? ' is-new' : ' is-modified';
        item.title = `${rel}（${status === '??' ? '新增' : '已修改'}）`;
      }
      item.className += modClass;
      item.innerHTML = `
        <span class="tree-caret">${entry.isDir ? '▶' : ''}</span>
        <span class="tree-icon">${entry.isDir ? '▸' : '·'}</span>
        <span class="tree-name">${escapeHtml(entry.name)}</span>
      `;
      li.appendChild(item);

      if (entry.isDir) {
        item.addEventListener('click', () => toggleDir(li, item, rel));
        if (expandedDirs.has(rel)) {
          item.classList.add('expanded');
          const childUl = document.createElement('ul');
          childUl.className = 'tree-list';
          li.appendChild(childUl);
          renderDir(rel, childUl);
        }
      } else {
        item.addEventListener('click', () => {
          els.expTree.querySelectorAll('.tree-item.selected').forEach(el => el.classList.remove('selected'));
          item.classList.add('selected');
          openFile(rel, entry.name);
        });
      }
      container.appendChild(li);
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

  // 渲染 Markdown：去掉 script / on* 事件属性，防注入
  function renderMarkdown(content) {
    try {
      const raw = marked.parse(content, { breaks: true, gfm: true });
      const clean = raw
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<iframe[\s\S]*?<\/iframe>/gi, '')
        .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*')/gi, '');
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
            <span class="git-name">📁 项目主目录</span>
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
        const st = await window.api.gitStatus({ projectPath: projPath, wtPath: s.worktreePath });
        if (!st.success) {
          html += `
            <div class="git-item">
              <div class="git-item-head"><span class="git-name">⎇ ${escapeHtml(s.agent.label)}</span></div>
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
        html += `
          <div class="git-item">
            <div class="git-item-head">
              <span class="git-name">⎇ ${escapeHtml(s.agent.label)}</span>
              <span class="git-branch" title="${escapeHtml(st.wtBranch || '')}">${escapeHtml(st.wtBranch || '')}</span>
            </div>
            <div class="git-sub">
              领先主分支 ${st.ahead} 个提交${st.behind ? ` · 落后 ${st.behind}` : ''}
              ${st.dirty && st.dirty.length ? ` · ${st.dirty.length} 个未提交改动` : ' · 工作区干净'}
              ${st.lastCommit ? `<br>最近提交：${escapeHtml(st.lastCommit)}` : ''}
            </div>
            ${dirtyFiles ? `<div class="git-files">${dirtyFiles}${moreCount ? `<div class="git-file"><span>…</span><span>还有 ${moreCount} 个文件</span></div>` : ''}</div>` : ''}
          </div>`;
      }
    }

    body.innerHTML = html;
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

  // 项目选择器：切换当前 UI 上下文
  els.projectSelect.addEventListener('change', () => {
    const path = els.projectSelect.value;
    if (path && path !== projectPath) {
      setProject(path);
    }
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
