/**
 * 只读探针变异自证（2026-10-28）
 * 把探针的关键判据改坏，看测试会不会红。
 *   H1 永远返回 ok=true（假装可行）—— 最危险的一种
 *   H2 不检查 fiber（有 entry 就当可行）
 *   H3 探针自己去调 dispose（破坏只读性）
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';

const ROOT = 'D:/dsh-plugins/dsh-unified-memory';
const F = ROOT + '/lib/dispatch/hotreload-probe.js';
const TEST = 'selftest-hotreload-probe.mjs';

const cases = [
  { name: 'H1 永远返回 ok=true（假装可行）',
    from: '      report.ok = report.loaderReachable && report.selfFound && report.selfHasFiber;',
    to: '      report.ok = true;' },
  { name: 'H2 不检查 fiber（有 entry 就当可行）',
    from: '      report.ok = report.loaderReachable && report.selfFound && report.selfHasFiber;',
    to: '      report.ok = report.loaderReachable && report.selfFound;' },
  { name: 'H3 探针自己调 dispose（破坏只读性）',
    from: "          try { report.selfHasFiber = !!(e && e.fiber && typeof e.fiber.dispose === 'function'); } catch {}",
    to: "          try { report.selfHasFiber = !!(e && e.fiber && typeof e.fiber.dispose === 'function'); e.fiber.dispose(); } catch {}" },
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

console.log('只读探针变异自证:');
let all = true;
for (const r of results) {
  if (!r.caught) all = false;
  console.log('  ' + (r.caught ? '✓ 抓到' : '✗ 没抓到') + '  ' + r.name + '  — ' + r.why);
}
console.log('\n结论:', all ? '三条变异全抓 —— 探针判据是真的、只读性是真的' : '⚠️ 有漏');
process.exit(all ? 0 : 1);
