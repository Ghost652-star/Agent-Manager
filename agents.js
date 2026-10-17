const { execFile } = require('child_process');

const KNOWN_AGENTS = [
  { command: 'opencode', label: 'OpenCode' },
  { command: 'claude', label: 'Claude Code' },
  { command: 'claudecode', label: 'Claude Code' },
  { command: 'pi', label: 'Pi' },
  { command: 'aider', label: 'Aider' },
  { command: 'codex', label: 'Codex' }
];

function commandExists(cmd) {
  return new Promise(resolve => {
    const checkCmd = process.platform === 'win32' ? 'where' : 'which';
    execFile(checkCmd, [cmd], { windowsHide: true }, err => resolve(!err));
  });
}

async function detect() {
  const found = [];
  for (const agent of KNOWN_AGENTS) {
    if (await commandExists(agent.command)) {
      // 避免重复命令名
      if (!found.some(a => a.command === agent.command)) {
        found.push({ ...agent });
      }
    }
  }
  return found;
}

module.exports = { detect };
