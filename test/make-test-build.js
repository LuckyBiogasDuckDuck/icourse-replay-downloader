/* 生成一份"测试构建"：把扩展复制到目标目录，并改成能在本地 fixture 页上跑。
 *
 * 只改测试构建的副本，仓库里的 manifest 保持生产配置（document_idle）。
 *
 * 用法：node test/make-test-build.js <目标目录> [port]
 */
const fs = require('fs');
const path = require('path');

const dest = process.argv[2];
const port = Number(process.argv[3] || 8796);
if (!dest) {
  console.error('用法: node test/make-test-build.js <目标目录> [port]');
  process.exit(1);
}

const src = path.join(__dirname, '..');
const origins = [`http://127.0.0.1:${port}/*`, `http://localhost:${port}/*`];

fs.rmSync(dest, { recursive: true, force: true });
fs.mkdirSync(dest, { recursive: true });

const SKIP = new Set(['test', '.git', '.e2e', 'node_modules', '.github']);
const destAbs = path.resolve(dest);

for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
  if (SKIP.has(entry.name)) continue;
  const from = path.join(src, entry.name);
  if (path.resolve(from) === destAbs || destAbs.startsWith(path.resolve(from) + path.sep)) continue;
  fs.cpSync(from, path.join(dest, entry.name), { recursive: true });
}

const mfPath = path.join(dest, 'manifest.json');
const mf = JSON.parse(fs.readFileSync(mfPath, 'utf8'));

for (const cs of mf.content_scripts) {
  cs.matches.push(...origins);
  // 生产是 document_idle（要等页面 load）；fixture 用一个占位 <img> 拖住 load，
  // 而我们要在 load 之前就把面板建好，所以测试构建提前到 document_end。
  cs.run_at = 'document_end';
}
mf.host_permissions.push(...origins);

// web_accessible_resources 的 matches 也要带上测试来源，
// 否则内容脚本 fetch(chrome.runtime.getURL('src/content/panel.css')) 会被拦掉，
// 面板就变成一堆没样式的原生 HTML（这个坑真踩过一次）。
for (const war of mf.web_accessible_resources || []) {
  war.matches = [...(war.matches || []), ...origins];
}

fs.writeFileSync(mfPath, JSON.stringify(mf, null, 2), 'utf8');

console.log('测试构建已生成：' + dest);
console.log('  额外匹配：' + origins.join(', '));
