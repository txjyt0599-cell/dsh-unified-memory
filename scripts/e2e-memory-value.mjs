#!/usr/bin/env node
/**
 * e2e-memory-value.mjs —— 记忆系统的「实用价值」测试
 * [2026-10-24 by Assistant · Round 31]
 *
 * 前面几十轮都在测「机制对不对」（排序、门控、字段）。但User真正在乎的是：
 *   **问一件事，记忆能不能给出答案所需的关键事实？**
 *
 * 这个测试用「只有记得才答得准」的问题，检查检索结果里是否包含答案要素。
 * 同时反向验证：库外话题不能硬凑（门控要保住）。
 */
import { createRetriever } from '../lib/retrieval/retriever.js';

let fail = 0;
const check = (n, ok, d) => { console.log((ok ? '  ✅ ' : '  ❌ ') + n + (d ? '   ' + d : '')); if (!ok) fail++; };

const ret = createRetriever({ l0Enabled: true, l0RecentDays: 30 }, null);
await ret.warmup();

console.log('── ① 库内事实：能不能给出答案要素 ──');
const CASES = [
  { q: '我显卡显存多大', need: ['16G', '16GB', '9060'], desc: '显存规格' },
  { q: 'Assistant的日记有几本', need: ['两本', '私记'], desc: '日记本数量' },
  { q: '记忆系统的四股力是什么', need: ['重要', '新鲜', '相关', '强度'], desc: '四股力构成' },
  { q: '示例设备A再生用什么阀门', need: ['气动', '手动'], desc: '阀门类型' },
  // [Round 32] 老事实也要能召回 —— 实测这两条曾因门控误伤返回 0 条
  { q: '桌宠最早的立绘怎么做', need: ['立绘', '桌宠', 'Live2D'], desc: '早期立绘（老事实）' },
];
let pass = 0;
for (const { q, need, desc } of CASES) {
  const r = await ret.search(q, { k: 8 });
  const text = (r.hits || []).map((h) => String(h.title || '') + String(h.summary || '') + String(h.content || '').slice(0, 200)).join(' ');
  const found = need.filter((n) => text.toLowerCase().includes(n.toLowerCase()));
  const ok = found.length > 0;
  if (ok) pass++;
  console.log('    ' + (ok ? '★' : '✗') + ' ' + desc + '  找到: ' + (found.join('/') || '（无）'));
}
check('库内事实能提供答案要素（≥3/4）', pass >= 3, pass + '/' + CASES.length);

console.log('── ② 库外话题：不能硬凑 ──');
const ABSENT = ['红烧肉的糖色怎么炒', '宋朝历史小说推荐', '量子色动力学胶子禁闭', '明天上海天气预报'];
let noisy = 0;
for (const q of ABSENT) {
  const r = await ret.search(q, { k: 5 });
  if ((r.hits || []).length > 0) { noisy++; console.log('    ✗ ' + q + ' → ' + r.hits.length + ' 条'); }
}
check('库外话题全部返回空', noisy === 0, noisy + '/' + ABSENT.length + ' 硬凑');

console.log('── ③ 门控可关（回滚能力）──');
const r2 = await ret.search('红烧肉的糖色怎么炒', { k: 5, allowEmptyOnNoSignal: false });
check('关掉门控退回旧行为', (r2.hits || []).length > 0, (r2.hits || []).length + ' 条');

// ── ④ 反例：边界词不许把相关记忆误杀（2026-10-28 by Assistant · 补反例）──
//   ② 只测了"库外话题不能硬凑"，但**没有测它的反面**：
//   如果门控调得太狠，"库内但用了高频词"的问题会被一起挡掉 ——
//   这种误杀比噪音更可怕：噪音你能看见，误杀你看不见（记忆明明有，就是不给你）。
console.log('── ④ 反例：门控不许误杀库内问题 ──');
{
  // 这些问法都带常见虚词/语气词，但答案确实在库里
  const NEAR_MISS = [
    { q: '我刚才说的那个显存是多大的来着', need: ['16G', '16GB', '9060'], desc: '口语化问显存' },
    { q: '嗯那个记忆系统的四股力到底是怎么算的', need: ['重要', '新鲜', '相关', '强度'], desc: '带语气词问四股力' },
  ];
  let killed = 0;
  for (const { q, need, desc } of NEAR_MISS) {
    const r = await ret.search(q, { k: 8 });
    const text = (r.hits || []).map((h) => String(h.title || '') + String(h.summary || '') + String(h.content || '').slice(0, 200)).join(' ');
    const found = need.filter((n) => text.toLowerCase().includes(n.toLowerCase()));
    if ((r.hits || []).length === 0 || found.length === 0) {
      killed++;
      console.log('    ✗ ' + desc + ' → 被误杀（命中 ' + (r.hits || []).length + ' 条，要素 ' + (found.join('/') || '无') + '）');
    } else {
      console.log('    ★ ' + desc + ' → 正常召回（要素 ' + found.join('/') + '）');
    }
  }
  check('**带语气词的库内问题不许被门控误杀**', killed === 0, killed + '/' + NEAR_MISS.length + ' 被误杀');

  // 对照：库外话题仍必须空（防止"为了不误杀就把门控全关"这种偷懒修法）
  const still = await ret.search('红烧肉的糖色怎么炒', { k: 5 });
  check('收紧误杀的同时，库外话题仍必须返回空（两边都要守住）',
    (still.hits || []).length === 0, (still.hits || []).length + ' 条');
}

console.log('\n' + (fail === 0 ? '✅ 记忆在「有用」和「不吵」之间平衡住了' : '❌ ' + fail + ' 项失败'));
process.exit(fail === 0 ? 0 : 1);
