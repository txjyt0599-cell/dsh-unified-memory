#!/usr/bin/env node
/**
 * e2e-flashback-precision.mjs —— 闪回精度回归（防"什么都联想"）
 * [2026-10-24 by Assistant · Round 14]
 *
 * 实测抓到的质量问题：
 *   加 entities 回填后，8 条测试查询触发了 7 次闪回 ——
 *   其中「看了一个视频很震撼」靠**单条弱边（共享 retry，deg=4）**
 *   连到了「500是脚本bug」，明显不相关。
 *
 * 修法：要求**至少 2 条独立线索共振**（flashbackMinShared=2）才允许触发。
 * 修复后 7/8 → 4/8，明显收敛。
 *
 * 本测试锁两件事：
 *   ① 极不相关的查询必须安静（不能靠单条边硬连）
 *   ② 合理相关的查询仍能触发（不能修成死水）
 */
import { createRetriever } from '../lib/retrieval/retriever.js';

const MUST_BE_QUIET = [
  '看了一个视频很震撼',      // 之前靠单条 retry 边连到「500是脚本bug」
  '今天去旅游了',
  '把这行代码格式化一下',
];
const MUST_FIRE = [
  '这个插件损坏了',
  '重启 DSH',
];

const ret = createRetriever({ l0Enabled: false, flashbackEnabled: true }, null);
await ret.warmup();

let fail = 0;
const check = (n, ok, d) => { console.log((ok ? '  ✅ ' : '  ❌ ') + n + (d ? '   ' + d : '')); if (!ok) fail++; };

console.log('── ① 不相关查询必须安静 ──');
let noisy = 0;
for (const q of MUST_BE_QUIET) {
  const r = await ret.search(q, {});
  const hit = !!r.flashback;
  if (hit) { noisy++; console.log('    · ' + q + ' → ' + String(r.flashback.title).slice(0, 24)); }
}
check('不相关查询不触发闪回', noisy === 0, noisy + '/' + MUST_BE_QUIET.length + ' 触发');

console.log('── ② 相关查询仍能触发 ──');
let fired = 0;
for (const q of MUST_FIRE) {
  const r = await ret.search(q, {});
  const hit = !!r.flashback;
  if (hit) fired++;
  console.log('    · ' + q + ' → ' + (hit ? String(r.flashback.title).slice(0, 24) : 'null'));
}
check('相关查询能触发（不是死水）', fired > 0, fired + '/' + MUST_FIRE.length);

console.log('── ③ 整体触发率合理（不吵）──');
const QS = [...MUST_BE_QUIET, ...MUST_FIRE, '记忆系统 打分', '示例设备A再生 示例单据', '我不是装了生图插件吗'];
let total = 0;
for (const q of QS) { const r = await ret.search(q, {}); if (r.flashback) total++; }
const rate = total / QS.length;
console.log('    触发率 ' + total + '/' + QS.length + ' (' + (rate * 100).toFixed(0) + '%)');
check('触发率不超过 60%（宁缺毋滥）', rate <= 0.6, (rate * 100).toFixed(0) + '%');

console.log('\n' + (fail === 0 ? '✅ 全部通过' : '❌ ' + fail + ' 项失败'));
process.exit(fail === 0 ? 0 : 1);
