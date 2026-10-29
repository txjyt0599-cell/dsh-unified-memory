const { execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');
const F = ROOT + '/lib/ingest/config.js';
const TEST = 'selftest-defaults.mjs';
const orig = fs.readFileSync(F, 'utf8');

// 变异：把四股力改回 false（复刻"默认关等于没发布"）
const from = 'fourForcesEnabled: true,';
const to = 'fourForcesEnabled: false,';
if (!orig.includes(from)) { console.log('锚点缺失'); process.exit(1); }
fs.writeFileSync(F, orig.replace(from, to), 'utf8');

let caught = false, why = '';
try { execSync('node ' + TEST, { cwd: ROOT, stdio: 'pipe', encoding: 'utf8' }); why = '仍通过'; }
catch (e) { caught = e.status === 1; why = caught ? '红了' : '未跑起来 ' + e.status; }
fs.writeFileSync(F, orig, 'utf8');

console.log('四股力默认值变异自证:', caught ? '✓ 抓到' : '✗ 没抓到', '—', why);
console.log('还原:', fs.readFileSync(F, 'utf8') === orig ? '✓' : '✗');
process.exit(caught ? 0 : 1);
