/**
 * 名册变异自证（2026-10-28）
 * 两条变异，对应真实事故：
 *   M1 把 listMembers 改回 listAgents（方法名写错 → 恒空 → 全判死）
 *   M2 去掉 rosterUnreadable 分支（读失败也判死）
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';

const ROOT = 'D:/dsh-plugins/dsh-unified-memory';
const TEST = 'selftest-dispatch-roster.mjs';

const cases = [
  { file: ROOT + '/lib/index.js', name: 'M1 方法名写错（listMembers → listAgents）',
    from: 'teams.listMembers(caller)', to: 'teams.listAgents(caller)' },
  { file: ROOT + '/lib/dispatch/tool.js', name: 'M3 不自动补 dstSessionId（事件源永远读不到会话）',
    from: 'if (!dstSidUsed && ag && typeof d.getAgentSessionId === \'function\') {',
    to: 'if (false && ag && typeof d.getAgentSessionId === \'function\') {' },
  { file: ROOT + '/lib/dispatch/state-machine.js', name: 'M2 去掉 rosterUnreadable 分支',
    from: "  if (c.rosterUnreadable === true) {\n    return { state: STATE.UNDETERMINED, reason: 'roster-unreadable', evidence: { note: '名册读取失败，无法判断目标是否存活' } };\n  }",
    to: '  /* removed */' },
];

const results = [];
for (const c of cases) {
  const original = fs.readFileSync(c.file, 'utf8');
  if (!original.includes(c.from)) { results.push({ name: c.name, caught: false, why: '锚点缺失' }); continue; }
  fs.writeFileSync(c.file, original.replace(c.from, c.to), 'utf8');
  let caught = false, why = '';
  try {
    execSync('node ' + TEST, { cwd: ROOT, stdio: 'pipe', encoding: 'utf8' });
    why = '测试仍通过';
  } catch (e) {
    if (e.status === 1) { caught = true; why = '测试红了（status=1）'; }
    else why = '命令没跑起来 status=' + e.status;
  } finally {
    fs.writeFileSync(c.file, original, 'utf8');
  }
  results.push({ name: c.name, caught, why });
}

console.log('名册变异自证:');
let all = true;
for (const r of results) {
  if (!r.caught) all = false;
  console.log('  ' + (r.caught ? '✓ 抓到' : '✗ 没抓到') + '  ' + r.name + '  — ' + r.why);
}
console.log('\n结论:', all ? '三条变异全抓 —— 名册验收是真的' : '⚠️ 有漏');
process.exit(all ? 0 : 1);
