/**
 * sendMessage 签名变异自证（v2 · 2026-10-28）
 *
 * 三条变异，对应三次真实失败：
 *   G1 退化成单参数            → Cannot read properties of undefined (reading 'signal')
 *   G2 用 message 而非 content → request.content missing
 *   G3 不传 signal             → signals[0] is not of type AbortSignal
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';

const ROOT = 'D:/dsh-plugins/dsh-unified-memory';
const F = ROOT + '/lib/dispatch/tool.js';
const TEST = 'selftest-dispatch-signature.mjs';

const FROM = [
  '        const res = await d.sendMessage(d.caller || execAgent, {',
  '          target: a.target,',
  "          content: [{ type: 'text', text }],",
  '          signal,',
  '        });',
].join('\n');

const cases = [
  { name: 'G1 退化成单参数',
    to: "        const res = await d.sendMessage({ target: a.target, message: text });" },
  { name: 'G2 用 message 而非 content 数组',
    to: "        const res = await d.sendMessage(d.caller || execAgent, { target: a.target, message: text, signal });" },
  { name: 'G3 不传 signal（漏掉 AbortSignal）',
    to: "        const res = await d.sendMessage(d.caller || execAgent, { target: a.target, content: [{ type: 'text', text }] });" },
];

const results = [];
for (const c of cases) {
  const original = fs.readFileSync(F, 'utf8');
  if (!original.includes(FROM)) { results.push({ name: c.name, caught: false, why: '锚点缺失' }); continue; }
  fs.writeFileSync(F, original.replace(FROM, c.to), 'utf8');
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

console.log('sendMessage 签名变异自证:');
let all = true;
for (const r of results) {
  if (!r.caught) all = false;
  console.log('  ' + (r.caught ? '✓ 抓到' : '✗ 没抓到') + '  ' + r.name + '  — ' + r.why);
}
const restored = fs.readFileSync(F, 'utf8').includes(FROM);
console.log('\n还原:', restored ? '✓ 源码已还原' : '✗ 未还原干净');
console.log('结论:', all && restored ? '三条变异全抓 —— 签名验收是真的' : '⚠️ 有漏');
process.exit(all && restored ? 0 : 1);
