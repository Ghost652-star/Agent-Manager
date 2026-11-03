// 构建前清理 dist 中的旧版本产物，只保留当前版本的文件
// 用法：node scripts/clean-dist.js（已在 npm run build 中自动执行）
const fs = require('fs');
const path = require('path');

const { version } = require(path.join(__dirname, '..', 'package.json'));
const dist = path.join(__dirname, '..', 'dist');

if (!fs.existsSync(dist)) process.exit(0);

// 只匹配带版本号的产物（安装版/绿色版/blockmap），不动 data、win-unpacked 等目录
const VERSIONED = /^(Agent Manager Setup|AgentManager-Portable|AgentManager-Green)/;
const keep = new Set([
  `Agent Manager Setup ${version}.exe`,
  `Agent Manager Setup ${version}.exe.blockmap`,
  `AgentManager-Portable-${version}.exe`,
  `AgentManager-Green-${version}.zip`
]);

for (const name of fs.readdirSync(dist)) {
  if (!VERSIONED.test(name) || keep.has(name)) continue;
  try {
    fs.rmSync(path.join(dist, name), { recursive: true, force: true });
    console.log(`[clean-dist] 已删除旧版本产物: ${name}`);
  } catch (err) {
    // 旧包正被运行中时无法删除：只告警，不阻断构建（否则每次重打包都要先关软件）
    console.warn(`[clean-dist] 跳过（文件被占用）: ${name}`);
  }
}
