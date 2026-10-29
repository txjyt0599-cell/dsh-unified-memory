const { execSync } = require('node:child_process');
const fs = require('node:fs');
const ROOT = 'D:/dsh-plugins/dsh-unified-memory';
const F = ROOT + '/lib/dispatch/hotreload-tools.js';
const TEST = 'selftest-hotreload-tools.mjs';
const original = fs.readFileSync(F, 'utf8');

const cases = [
  { name: 'A1 去掉 confirm 门禁（不确认也执行）',
    from: "      if (a.confirm !== true) {",
    to: "      if (false) {" },
  { name: 'A2 没有 rotate 也执行',
    from: "      if (typeof d.rotate !== 'function') {",
    to: "      if (false) {" },
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

console.log('apply 门禁变异自证:');
let all = true;
for (const r of results) {
  if (!r.caught) all = false;
  console.log('  ' + (r.caught ? '✓ 抓到' : '✗ 没抓到') + '  ' + r.name + '  — ' + r.why);
}
console.log('还原:', fs.readFileSync(F, 'utf8') === original ? '✓' : '✗');
process.exit(all ? 0 : 1);
