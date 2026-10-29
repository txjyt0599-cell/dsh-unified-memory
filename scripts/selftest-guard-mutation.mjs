/**
 * 热重载保险变异自证（2026-10-28）
 *
 * 三条变异，对应三种"会真丢插件"的写法：
 *   K1 先 dispose 后挂保险（顺序错 —— 最致命）
 *   K2 reload 抛错时把保险撤掉（等于不救）
 *   K3 没有保险函数也强行 dispose（裸拆）
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';

const ROOT = 'D:/dsh-plugins/dsh-unified-memory';
const F = ROOT + '/lib/dispatch/hotreload-guard.js';
const TEST = 'selftest-hotreload-guard.mjs';

const cases = [
  { name: 'K1 先 dispose 后挂保险（顺序错·最致命）',
    from: `    // ② 先挂保险（关键顺序）
    const delay = Number(o.rescueDelayMs) || 3000;
    const guard = armRescue(delay, o.rescue);
    steps.push('armed rescue in ' + delay + 'ms');

    // ③ 才 dispose
    try {
      pre.fiber.dispose();
      steps.push('disposed');`,
    to: `    // ② 变异：先拆
    const delay = Number(o.rescueDelayMs) || 3000;
    try {
      pre.fiber.dispose();
      steps.push('disposed');` },
  { name: 'K2 reload 抛错时把保险撤掉（等于不救）',
    from: `      // ⚠️ 这里**不 cancel**：让保险到点把插件救回来
      steps.push('reload-threw（保险会接手）');`,
    to: `      guard.cancel();
      steps.push('reload-threw（保险会接手）');` },
  { name: 'K3 没有保险函数也强行 dispose（裸拆）',
    from: `    if (typeof o.rescue !== 'function') {
      return { ok: false, reason: 'no-rescue-fn', steps: steps.concat('拒绝执行：没有保险不拆') };
    }`,
    to: `    if (false) {
      return { ok: false, reason: 'no-rescue-fn', steps: steps.concat('拒绝执行：没有保险不拆') };
    }` },
];

const results = [];
for (const c of cases) {
  const original = fs.readFileSync(F, 'utf8');
  if (!original.includes(c.from)) { results.push({ name: c.name, caught: false, why: '锚点缺失' }); continue; }
  fs.writeFileSync(F, original.replace(c.from, c.to), 'utf8');
  let caught = false, why = '';
  try {
    execSync('node ' + TEST, { cwd: ROOT, stdio: 'pipe', encoding: 'utf8' });
    why = '测试仍通过';
  } catch (e) {
    if (e.status === 1) { caught = true; why = '测试红了（status=1）'; }
    else why = '命令没跑起来 status=' + e.status;
  } finally {
    fs.writeFileSync(F, original, 'utf8');
  }
  results.push({ name: c.name, caught, why });
}

console.log('热重载保险变异自证:');
let all = true;
for (const r of results) {
  if (!r.caught) all = false;
  console.log('  ' + (r.caught ? '✓ 抓到' : '✗ 没抓到') + '  ' + r.name + '  — ' + r.why);
}
const restored = fs.readFileSync(F, 'utf8').includes('先挂保险（关键顺序）');
console.log('\n还原:', restored ? '✓' : '✗');
console.log('结论:', all && restored ? '三条变异全抓 —— 保险顺序是真的' : '⚠️ 有漏');
process.exit(all && restored ? 0 : 1);
