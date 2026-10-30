const { execSync } = require('node:child_process');
const fs = require('node:fs');
// [2026-10-30] CJS 文件用 __dirname，别混 ESM 写法
const ROOT = require('node:path').resolve(__dirname, '..');
const F = ROOT + '/lib/dispatch/hotreload-exec.js';
const TEST = 'selftest-hotreload-exec.mjs';
const cases = [
  { name: 'E1 去掉"没重装器就拒绝"的门禁（回到会丢插件的旧行为）',
    from: '  if (!hasExternalReloader) {',
    to: '  if (false) {' },
  { name: 'E2 重装器抛错时假装成功',
    from: "    return { ok: false, reason: 'external-reload-threw:' + String(e && e.message || e), steps };",
    to: "    return { ok: true, reason: 'swallowed', steps };" },
];
const results = [];
for (const c of cases) {
  const orig = fs.readFileSync(F, 'utf8');
  if (!orig.includes(c.from)) { results.push({ name: c.name, caught: false, why: '锚点缺失' }); continue; }
  fs.writeFileSync(F, orig.replace(c.from, c.to), 'utf8');
  let caught = false, why = '';
  try { execSync('node ' + TEST, { cwd: ROOT, stdio: 'pipe', encoding: 'utf8' }); why = '仍通过'; }
  catch (e) { caught = e.status === 1; why = caught ? '红了' : '未跑起来 ' + e.status; }
  fs.writeFileSync(F, orig, 'utf8');
  results.push({ name: c.name, caught, why });
}
console.log('真执行模块变异自证:');
let all = true;
for (const r of results) { if (!r.caught) all = false; console.log('  ' + (r.caught ? '✓ 抓到' : '✗ 没抓到') + '  ' + r.name + '  — ' + r.why); }
console.log('还原:', fs.readFileSync(F, 'utf8').includes('if (!hasExternalReloader)') ? '✓' : '✗');
process.exit(all ? 0 : 1);
