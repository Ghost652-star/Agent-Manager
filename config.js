const fs = require('fs');
const path = require('path');

// 配置目录跟软件走，不写 C 盘用户目录：
// - 开发环境：<项目根>/data/
// - 安装版：<安装目录>/data/
// - 便携版：<便携 exe 所在目录>/data/
function baseDir() {
  try {
    const { app } = require('electron');
    if (app && app.isPackaged) {
      if (process.env.PORTABLE_EXECUTABLE_DIR) {
        return process.env.PORTABLE_EXECUTABLE_DIR;
      }
      return path.dirname(app.getPath('exe'));
    }
  } catch {
    // 非主进程环境或测试环境
  }
  return __dirname;
}

let cachedDir = null;

function configDir() {
  if (!cachedDir) {
    cachedDir = path.join(baseDir(), 'data');
  }
  return cachedDir;
}

function configPath() {
  return path.join(configDir(), 'config.json');
}

function read() {
  try {
    return { configDir: configDir(), ...JSON.parse(fs.readFileSync(configPath(), 'utf-8')) };
  } catch {
    return {
      configDir: configDir(),
      recentProjects: [],
      worktreeRoot: null
    };
  }
}

function write(cfg) {
  const dir = configDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  // 原子写：先写临时文件再 rename，避免崩溃/断电时留下半截 config.json
  const target = configPath();
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2));
  fs.renameSync(tmp, target);
}

module.exports = { read, write, configDir, configPath };
