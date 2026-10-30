/**
 * 工具 schema 变异自证（2026-10-28）
 *
 * ## 为什么要两组变异
 * 线上真实踩过**两次**不同的注册失败，都必须能被测试抓到：
 *   M1 缺 output 声明        → tool "x" must declare output { schema, render }
 *   M2 type 用联合类型        → unsupported JSON schema: type must be a single type string
 * 只测 M1 不够——M2 那次就是"测试全绿但线上挂了"。
 *
 * ## 判据纪律（踩过的坑）
 *   ① 路径必须对（初版写成 scripts/ 但文件在根目录 ⇒ 找不到 ⇒ 被 catch 误当"抓到"）
 *   ② 必须区分「测试失败(status=1)」和「命令没跑起来」——后者是假阳性
 *   ③ 每轮跑完必须还原，且还原要有断言
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import fs from 'node:fs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const F = ROOT + '/lib/dispatch/tool.js';
const TEST_REL = 'selftest-tool-schema.mjs';
const TEST_ABS = ROOT + '/' + TEST_REL;

if (!fs.existsSync(TEST_ABS)) {
  console.log('✗ 检查脚本不存在:', TEST_ABS);
  process.exit(1);
}

const original = fs.readFileSync(F, 'utf8');

const mutations = [
  {
    name: 'M1 删掉三处 output 声明（复刻"缺 output"事故）',
    make: () => original
      .replace(/    output: \{ schema: SEND_OUTPUT, render: renderSend \},\n/, '')
      .replace(/    output: \{ schema: SCAN_OUTPUT, render: renderScan \},\n/, '')
      .replace(/    output: \{ schema: CLOSE_OUTPUT, render: renderClose \},\n/, ''),
  },
  {
    name: 'M2 messageId 改回联合类型（复刻"single type string"事故）',
    make: () => original.replace(
      "    messageId: { type: 'string' },",
      "    messageId: { type: ['string', 'null'] },"
    ),
  },
];

const results = [];
for (const mu of mutations) {
  const mutated = mu.make();
  if (mutated === original) {
    results.push({ name: mu.name, caught: false, why: '变异没生效（变异本身坏了）' });
    continue;
  }
  fs.writeFileSync(F, mutated, 'utf8');
  let verdict;
  try {
    execSync('node ' + TEST_REL, { cwd: ROOT, stdio: 'pipe' });
    verdict = { caught: false, why: '测试仍通过（抓不到）' };
  } catch (e) {
    if (e.status === 1) verdict = { caught: true, why: '测试按预期红了' };
    else verdict = { caught: false, why: '命令没跑起来（status=' + e.status + '），不是测试失败' };
  } finally {
    fs.writeFileSync(F, original, 'utf8');
  }
  results.push({ name: mu.name, ...verdict });
}

// 还原断言：跑完必须与原文逐字节一致
const restored = fs.readFileSync(F, 'utf8') === original;

console.log('变异自证:');
let allCaught = true;
for (const r of results) {
  if (!r.caught) allCaught = false;
  console.log('  ' + (r.caught ? '✓ 抓到' : '✗ 没抓到') + '  ' + r.name + (r.why ? '  — ' + r.why : ''));
}
console.log('\n还原断言:', restored ? '✓ 源码与变异前逐字节一致' : '✗ 源码没还原干净！');
console.log('结论:', allCaught && restored ? '✅ 两组变异全部被抓，源码已还原' : '⚠️ 有问题');
process.exit(allCaught && restored ? 0 : 1);
