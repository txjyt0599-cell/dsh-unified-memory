const { execSync } = require('node:child_process');
const fs = require('node:fs');
const ROOT = 'D:/dsh-plugins/dsh-unified-memory';
const F = ROOT + '/lib/ingest/distill.js';
const TEST = 'selftest-ongoing-thread-pairing.mjs';
const orig = fs.readFileSync(F, 'utf8');

// 完整复刻旧 bug：两处都改回"各自找最后一条"
const OLD_BLOCK = [
  '    let lastUserIdx = -1;',
  '    for (let i = fresh.length - 1; i >= 0; i--) {',
  "      if (fresh[i] && fresh[i].role === 'user') { lastUserIdx = i; break; }",
  '    }',
  '    const lastUser = lastUserIdx >= 0 ? fresh[lastUserIdx] : null;',
].join('\n');

const NEW_BLOCK = [
  "    const lastUser = [...fresh].reverse().find((m) => m && m.role === 'user');",
  '    const lastUserIdx = fresh.length;  // 变异：故意指向末尾，等于"之后无约束"',
].join('\n');

const OLD_ASST = [
  '    let lastAsst = null;',
  '    for (let i = fresh.length - 1; i > lastUserIdx; i--) {',
  "      if (fresh[i] && fresh[i].role === 'assistant') { lastAsst = fresh[i]; break; }",
  '    }',
].join('\n');
const NEW_ASST = [
  "    const lastAsst = [...fresh].reverse().find((m) => m && m.role === 'assistant');",
].join('\n');

let s = orig;
if (!s.includes(OLD_BLOCK) || !s.includes(OLD_ASST)) { console.log('锚点缺失'); process.exit(1); }
s = s.replace(OLD_BLOCK, NEW_BLOCK).replace(OLD_ASST, NEW_ASST);
fs.writeFileSync(F, s, 'utf8');

let caught = false, why = '';
try { execSync('node ' + TEST, { cwd: ROOT, stdio: 'pipe', encoding: 'utf8' }); why = '仍通过'; }
catch (e) { caught = e.status === 1; why = caught ? '红了' : '未跑起来 ' + e.status; }
fs.writeFileSync(F, orig, 'utf8');

console.log('问答配对变异自证（完整复刻旧 bug）:', caught ? '✓ 抓到' : '✗ 没抓到', '—', why);
console.log('还原:', fs.readFileSync(F, 'utf8') === orig ? '✓' : '✗');
process.exit(caught ? 0 : 1);
