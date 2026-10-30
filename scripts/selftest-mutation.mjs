/**
 * 反例自证：把状态机故意改错，看测试会不会红。
 * 这是今天最硬的一条纪律——反例不报 = 检查是假的。
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = fileURLToPath(new URL('./', import.meta.url)).replace(/[\\/]$/, '');

const F = join(ROOT, 'lib/dispatch/state-machine.js');
const original = fs.readFileSync(F, 'utf8');
const results = [];

function runOnce(label) {
  try {
    execSync('node selftest-dispatch-machine.mjs', { cwd: ROOT, stdio: 'pipe' });
    return { label, caught: false };
  } catch (e) {
    const out = String(e.stdout || '');
    const m = out.match(/pass=(\d+) fail=(\d+)/);
    return { label, caught: true, fail: m ? m[2] : '?' };
  }
}

const mutations = [
  { name: 'M1 把 inactive 当死（复刻红队上一版的错）',
    from: "if (t.phase === 'failed' || t.status === 'failed') {",
    to: "if (t.phase === 'failed' || t.status === 'failed' || t.status === 'inactive') {" },
  { name: 'M2 把 in_progress 判成 orphaned（白队补的反例 D）',
    from: "    return { state: STATE.IN_PROGRESS, reason: 'accepted-not-finished', evidence: { elapsed } };",
    to: "    return { state: STATE.ORPHANED, reason: 'accepted-not-finished', evidence: { elapsed } };" },
  { name: 'M3 把 delivery_lost 归成 busy_ignored（反例 G）',
    from: "    return { state: STATE.DELIVERY_LOST, reason: 'no-messageId-no-taskId', evidence: { messageId: (c.baseline && c.baseline.messageId) || null } };",
    to: "    return { state: STATE.BUSY_IGNORED, reason: 'no-messageId-no-taskId', evidence: {} };" },
  { name: 'M4 标签解析改用行内匹配（破反例 E/F 的独占行判据）',
    from: "  const re = /^[ \\t]*\\[\\[TASK:([A-Za-z0-9._:-]{1,120})\\]\\][ \\t]*$/gm;",
    to: "  const re = /\\[\\[TASK:([A-Za-z0-9._:-]{1,120})\\]\\]/g;" },
];

for (const mu of mutations) {
  if (!original.includes(mu.from)) { results.push({ label: mu.name, caught: 'SKIP-未找到锚点' }); continue; }
  fs.writeFileSync(F, original.replace(mu.from, mu.to), 'utf8');
  results.push(runOnce(mu.name));
  fs.writeFileSync(F, original, 'utf8');
}

console.log('反例自证（故意改错，看测试能否抓到）:');
let allCaught = true;
for (const r of results) {
  const ok = r.caught === true;
  if (!ok) allCaught = false;
  console.log('  ' + (ok ? '✓ 抓到' : '✗ 没抓到') + '  ' + r.label + (r.fail ? '  (fail=' + r.fail + ')' : ''));
}
console.log('\n结论:', allCaught ? '四条变异全部被测试抓到 —— 这七条反例是真的' : '⚠️ 有变异没被抓到，反例是假的');
process.exit(allCaught ? 0 : 1);
