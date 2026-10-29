#!/usr/bin/env node
/**
 * e2e-no-signal-gate.mjs —— 「库外话题不该硬凑」回归
 * [2026-10-24 by Assistant · Round 24]
 *
 * 抓到的真问题：
 *   问「量子色动力学胶子禁闭」→ 返回「Live2D 动力学」（只共享"动力学"两字）
 *   问「明天上海天气预报」→ 返回「规律列点预报失误」（只共享"预报"）
 *   问「红烧肉的糖色怎么炒」→ 返回「拳拳到肉」（只共享"肉的"）
 *
 * 根因：BM25 对**任意 token** 都给正分，加上 stage3 的固定 boost 兜底，
 *   于是"库里没有这个话题"也会返回一屏看似相关的东西。
 *   语义上这比返回空更坏 —— User会以为记忆里有这件事。
 *
 * 修法：Top1 必须命中足够比例的实词（覆盖率 >=0.35，或两个长词），
 *   否则整批判为「本轮没有相关往事」。alias 短路通道也过同一把尺。
 */
import { createRetriever } from '../lib/retrieval/retriever.js';

let fail = 0;
const check = (n, ok, d) => { console.log((ok ? '  ✅ ' : '  ❌ ') + n + (d ? '   ' + d : '')); if (!ok) fail++; };

const ret = createRetriever({ l0Enabled: true, l0RecentDays: 30 }, null);
await ret.warmup();

console.log('── ① 库外话题必须返回空 ──');
const ABSENT = ['红烧肉的糖色怎么炒', '宋朝历史小说推荐', '量子色动力学胶子禁闭', '明天上海天气预报'];
let noisy = 0;
for (const q of ABSENT) {
  const r = await ret.search(q, { k: 5 });
  const n = (r.hits || []).length;
  if (n > 0) { noisy++; console.log('    ✗ ' + q + ' → ' + n + ' 条（top1: ' + String(r.hits[0].title).slice(0, 20) + '）'); }
  else console.log('    ✓ ' + q + ' → 空');
}
check('库外话题全部返回空', noisy === 0, noisy + '/' + ABSENT.length + ' 硬凑');

console.log('── ② 库内话题不能被误伤 ──');
const PRESENT = ['9060XT 显存', '记忆改造 四股力', '示例设备A再生怎么操作', '我们刚才在做什么',
  'Assistant的日记写在哪', '桌宠 立绘 绑骨', '粒子视效 混合模式', '重启 DSH 报错'];
let broken = 0;
for (const q of PRESENT) {
  const r = await ret.search(q, { k: 3 });
  const n = (r.hits || []).length;
  if (n === 0) { broken++; console.log('    ✗ 误伤: ' + q); }
}
check('库内话题仍能召回', broken === 0, (PRESENT.length - broken) + '/' + PRESENT.length);

console.log('── ③ 门控可关（保留回滚能力）──');
const r2 = await ret.search('红烧肉的糖色怎么炒', { k: 5, allowEmptyOnNoSignal: false });
check('allowEmptyOnNoSignal=false 时退回旧行为', (r2.hits || []).length > 0, (r2.hits || []).length + ' 条');

console.log('\n' + (fail === 0 ? '✅ 全部通过' : '❌ ' + fail + ' 项失败'));
process.exit(fail === 0 ? 0 : 1);
