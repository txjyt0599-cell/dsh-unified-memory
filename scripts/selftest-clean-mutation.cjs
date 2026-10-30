const { execSync } = require('node:child_process');
const fs = require('node:fs');
// [2026-10-30] CJS 文件用 __dirname，别混 ESM 写法
const ROOT = require('node:path').resolve(__dirname, '..');
const F = ROOT + '/lib/ingest/distill.js';
const TEST = 'selftest-ongoing-thread-pairing.mjs';
const orig = fs.readFileSync(F, 'utf8');

// 用 indexOf 找关键行，按行号删（避开转义地狱）
const lines = orig.split('\n');
const keep = [];
let removed = 0;
for (const L of lines) {
  const isBlockDelete = L.includes('.replace(/<style') || L.includes('.replace(/<script') || L.includes('.replace(/<svg');
  const isCssRule = L.includes('[^{};]') && L.includes('\\{[^{}]*\\}');
  if (isBlockDelete || isCssRule) { removed++; keep.push('      // mutated'); continue; }
  keep.push(L);
}
console.log('删除行数:', removed);
if (removed === 0) { console.log('没找到可删的行'); process.exit(1); }
fs.writeFileSync(F, keep.join('\n'), 'utf8');

let caught = false, why = '';
try { execSync('node ' + TEST, { cwd: ROOT, stdio: 'pipe', encoding: 'utf8' }); why = '仍通过'; }
catch (e) { caught = e.status === 1; why = caught ? '红了' : '未跑起来 ' + e.status; }
fs.writeFileSync(F, orig, 'utf8');

console.log('CSS 清洗变异自证:', caught ? '✓ 抓到' : '✗ 没抓到', '—', why);
console.log('还原:', fs.readFileSync(F, 'utf8') === orig ? '✓' : '✗');
process.exit(caught ? 0 : 1);
