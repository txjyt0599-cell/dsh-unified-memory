/**
 * 接线自证：把接线逻辑故意改错，看 selftest-dispatch-wiring 会不会红。
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';

const F = 'D:/dsh-plugins/dsh-unified-memory/lib/dispatch/tool.js';
const original = fs.readFileSync(F, 'utf8');
const results = [];

function runOnce(label) {
  try {
    execSync('node selftest-dispatch-wiring.mjs', { cwd: 'D:/dsh-plugins/dsh-unified-memory', stdio: 'pipe' });
    return { label, caught: false };
  } catch (e) {
    const out = String(e.stdout || '');
    const m = out.match(/pass=(\d+) fail=(\d+)/);
    return { label, caught: true, fail: m ? m[2] : '?' };
  }
}

const mutations = [
  // [2026-10-28 修正] 第一版这个变异是假的：它只是把返回值换成 {}，
  //   ledger.begin() 仍然被调用 ⇒ Write-Ahead 依然生效 ⇒ 测不出问题是**正确的**。
  //   真正的"先投递后落盘"必须把 begin 移到 sendMessage 之后。这才是 W1 该测的东西。
  // [2026-10-28 二次修正] 上一版锚点含"sentAt 之后立刻 });"，
  //   但后来我在 begin() 里加了 dstSessionId/srcSessionId 两行 ⇒ 锚点失配 ⇒ SKIP。
  //   ⚠️ **SKIP 看起来像"通过"** —— 这正是最危险的形态：变异没生效，却报"没抓到"。
  //   所以下面把失配从 SKIP 改成显式失败（fail-fast），不再静默跳过。
  // [2026-10-28 四次修正 —— 这一版才是对的]
  //   前三次都错：v1 没真破坏；v2 锚点含后来被改的行 ⇒ 失配；v3 只是包了一层照样先调用。
  //   正确做法：用**正则把 begin 整块剪下来，真搬到 sendMessage 之后**。
  //   （已验证：这样改完 A10 立刻 FAIL，说明断言本身是有效的）
  { name: 'W1 把 begin 整块搬到投递之后（真破坏时序）', kind: 'reorder' },
  { name: 'W2 投递抛错时不转 aborted（留孤儿 pending）',
    from: "        ledger.settle(taskId, 'dispatch-error', { reason, now: Date.now() });",
    to: "        /* 故意不 settle */" },
  { name: 'W3 标签不加独占行（破 A6/A7）',
    from: "  return '[[TASK:' + taskId + ']]\\n' + String(body || '');",
    to: "  return String(body || '') + ' [[TASK:' + taskId + ']]';" },
  { name: 'W4 服务缺失时假装成功',
    from: "        const reason = String(e && e.message || e).slice(0, 200);",
    to: "        return { ok: true, taskId, status: STATE.CONFIRMED };\n        const reason = String(e && e.message || e).slice(0, 200);" },
];

for (const mu of mutations) {
  let mutated = null;

  if (mu.kind === 'reorder') {
    // 真·块搬移：把 begin 整块剪出来，插到 sendMessage 之后
    const block = original.match(/      const rec = ledger\.begin\(taskId, \{[\s\S]*?\}\);/);
    if (block) {
      let m2 = original.replace(block[0], '      let rec = null;');
      m2 = m2.replace(
        '        const res = await d.sendMessage({ target: a.target, message: text });',
        '        const res = await d.sendMessage({ target: a.target, message: text });\n        ' + block[0].trim().replace(/^const rec =/, 'rec =')
      );
      if (m2 !== original) mutated = m2;
    }
  } else {
    // [2026-10-28] 锚点失配必须 fail-fast，不能 SKIP 后当成"通过"。
    //   真踩到过：改了被测代码后锚点失配，脚本报「✗ 没抓到」，看起来像测试漏洞，
    //   实际是**变异根本没施加**。两种情况处置完全不同，必须区分。
    if (!original.includes(mu.from)) {
      results.push({ label: mu.name, caught: false, anchorMissing: true });
      continue;
    }
    mutated = original.replace(mu.from, mu.to);
  }

  if (mutated === null) {
    results.push({ label: mu.name, caught: false, anchorMissing: true });
    continue;
  }
  fs.writeFileSync(F, mutated, 'utf8');
  results.push(runOnce(mu.name));
  fs.writeFileSync(F, original, 'utf8');
}

console.log('接线自证（故意改错，看测试能否抓到）:');
let allCaught = true;
for (const r of results) {
  const ok = r.caught === true;
  if (!ok) allCaught = false;
  console.log('  ' + (ok ? '✓ 抓到' : '✗ 没抓到') + '  ' + r.label + (r.fail ? '  (fail=' + r.fail + ')' : ''));
}
console.log('\n结论:', allCaught ? '四条接线变异全部被抓 —— 接线是真的' : '⚠️ 有变异没被抓，接线验收是假的');
process.exit(allCaught ? 0 : 1);
