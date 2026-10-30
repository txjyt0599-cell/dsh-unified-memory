const { execSync } = require('node:child_process');
const fs = require('node:fs');
// [2026-10-30] CJS 文件用 __dirname，别混 ESM 写法
const ROOT = require('node:path').resolve(__dirname, '..');
const F = ROOT + '/lib/dispatch/event-source.js';
const TEST = 'selftest-dispatch-eventsource.mjs';
const orig = fs.readFileSync(F, 'utf8');

// 变异：把 eventCountBefore 优先改回 messageId 优先（复刻真实 bug）
const OLD = [
  '  if (Number.isFinite(before) && before >= 0 && before <= all.length) {',
  '    return all.slice(before);',
  '  }',
].join('\n');
const NEW = '  // mutated: 跳过 eventCountBefore 优先';

if (!orig.includes(OLD)) { console.log('锚点缺失'); process.exit(1); }
fs.writeFileSync(F, orig.replace(OLD, NEW), 'utf8');

let caught = false, why = '';
try { execSync('node ' + TEST, { cwd: ROOT, stdio: 'pipe', encoding: 'utf8' }); why = '仍通过'; }
catch (e) { caught = e.status === 1; why = caught ? '红了' : '未跑起来 ' + e.status; }
fs.writeFileSync(F, orig, 'utf8');

console.log('切片优先级变异自证:', caught ? '✓ 抓到' : '✗ 没抓到', '—', why);
console.log('还原:', fs.readFileSync(F, 'utf8') === orig ? '✓' : '✗');
process.exit(caught ? 0 : 1);
