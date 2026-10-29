const { execSync } = require('node:child_process');
const fs = require('node:fs');
const ROOT = require('node:path').resolve(__dirname, '..');
const F = ROOT + '/lib/ingest/index.js';
const TEST = 'selftest-config-warnings.mjs';
const orig = fs.readFileSync(F, 'utf8');

// 变异：删掉启动自检整块（复刻"静默跳过"的旧行为）
const lines = orig.split('\n');
const keep = [];
let removed = 0, inBlock = false;
for (let i = 0; i < lines.length; i++) {
  const L = lines[i];
  if (L.includes('启动自检：一眼看出')) inBlock = true;
  if (inBlock) {
    removed++;
    // 块走到 '} catch { /* 自检失败不影响启动 */ }' 结束
    if (L.includes('自检失败不影响启动')) inBlock = false;
    continue;
  }
  keep.push(L);
}
console.log('删除行数:', removed);
if (removed < 5) { console.log('锚点没找到'); process.exit(1); }
fs.writeFileSync(F, keep.join('\n'), 'utf8');

let caught = false, why = '';
try { execSync('node ' + TEST, { cwd: ROOT, stdio: 'pipe', encoding: 'utf8' }); why = '仍通过'; }
catch (e) { caught = e.status === 1; why = caught ? '红了' : '未跑起来 ' + e.status; }
fs.writeFileSync(F, orig, 'utf8');

console.log('启动告警变异自证:', caught ? '✓ 抓到' : '✗ 没抓到', '—', why);
console.log('还原:', fs.readFileSync(F, 'utf8') === orig ? '✓' : '✗');
process.exit(caught ? 0 : 1);
