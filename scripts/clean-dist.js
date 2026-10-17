// 构建前清理 dist 中的旧版本产物，只保留当前版本的文件
// 用法：node scripts/clean-dist.js（已在 npm run build 中自动执行）
const fs = require('fs');
const path = require('path');

const { version } = require(path.join(__dirname, '..', 'package.json'));
const dist = path.join(__dirname, '..', 'dist');

if (!fs.existsSync(dist)) process.exit(0);

// 只匹配带版本号的产物（安装版/便携版/blockmap），不动 data、win-unpacked 等目录
const VERSIONED = /^(Agent Manager Setup|AgentManager-Portable)/;
const keep = new Set([
  `Agent Manager Setup ${version}.exe`,
  `Agent Manager Setup ${version}.exe.blockmap`,
  `AgentManager-Portable-${version}.exe`
]);

for (const name of fs.readdirSync(dist)) {
  if (VERSIONED.test(name) && !keep.has(name)) {
    fs.rmSync(path.join(dist, name), { recursive: true, force: true });
    console.log(`[clean-dist] 已删除旧版本产物: ${name}`);
  }
}
