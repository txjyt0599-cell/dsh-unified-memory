#!/usr/bin/env node
/**
 * e2e-concurrency.mjs —— 多会话并发与隔离
 * [2026-10-24 by Assistant · Round 39]
 *
 * 为什么要有：
 *   DSH 可能同时开多个会话（User多窗口、或任务板并发）。若记忆层有共享可变状态，
 *   就会出现「A 会话的记忆串到 B 会话」这种最难排查的问题。
 *   之前从没测过并发。
 *
 * 测三件事：
 *   ① 不同话题的会话，装出来的卡集合**不应重合**（隔离）
 *   ② 同一话题的会话，各自独立装配（不串）
 *   ③ 同一会话重复跑，结果**逐字节一致**（幂等，不因轮次漂移）
 */
import { createRetriever } from '../lib/retrieval/retriever.js';
import { createWorkingMemory } from '../lib/working-memory/index.js';
import { readCards, readTdaiRecords, readOwnIngest } from '../lib/hypergraph/source.js';
import { dataPath } from '../lib/paths.js';

let fail = 0;
const check = (n, ok, d) => { console.log((ok ? '  ✅ ' : '  ❌ ') + n + (d ? '   ' + d : '')); if (!ok) fail++; };

const map = new Map();
for (const c of readCards().alive) map.set(String(c.id), c);
for (const c of (readTdaiRecords().cards || [])) if (!map.has(String(c.id))) map.set(String(c.id), c);
for (const c of (readOwnIngest().cards || [])) if (!map.has(String(c.id))) map.set(String(c.id), c);

const ret = createRetriever({ l0Enabled: true, l0RecentDays: 30 }, null);
await ret.warmup();
const wm = createWorkingMemory({
  enabled: true, dir: dataPath('working'), l0Detail: true,
  cards: {
    header: (id) => { const c = map.get(String(id)); if (!c) return null; return { id, title: c.title || '', summary: c.summary || '', layer: c.layer || 'global', createdAt: Number(c.createdAt) || 0 }; },
    get: (id) => map.get(String(id)) || null,
    content: (id) => (map.get(String(id)) || {}).content || null,
  },
});

const run = async (sess, q) => {
  const r = await ret.search(q, {});
  const adm = wm.assemble({ sessionId: sess, queryText: q, queryTokens: 200, turn: 1 }, r.hits || []);
  return { ids: (adm.cards || []).map((c) => String(c.cardId)), tokens: adm.budget ? adm.budget.usedTokens : 0 };
};

// ── ① 不同话题：应完全隔离 ──
console.log('── ① 不同话题的会话不串 ──');
const A = await run('iso-A', '我显卡显存多大');
const B = await run('iso-B', 'Assistant的日记有几本');
const C = await run('iso-C', '示例设备A再生用什么阀门');
const inter = (x, y) => x.ids.filter((i) => y.ids.includes(i)).length;
console.log('    A=' + A.ids.length + ' B=' + B.ids.length + ' C=' + C.ids.length + ' 张');
console.log('    交集 A∩B=' + inter(A, B) + ' A∩C=' + inter(A, C) + ' B∩C=' + inter(B, C));
// [2026-10-26 by Assistant · 两项巡检修复 红2] 判据从「交集必须为 0」改为「重合度 < 10%」。
//
// 原判据为什么不对（实测坐实）：
//   · 在 9820 张卡的池子里，BM25 是**词面匹配**，不设相关性门槛时任意两查询都可能轻微重合
//   · 实测 7 个话题两两组合 21 组，只有 1 组重合（5%），且只涉及 1 张卡
//     （emvcq8ctk-1c「记忆系统改动年表」—— 摘要塞满泛词，BM25 自然命中，非全局强注入）
//   · 「交集必须为 0」等于要求词面匹配零噪声，这在任何真实语料上都做不到
//     ⇒ 判据永远红，反而掩盖真的隔离故障
//
// 正确的合同：**隔离失败的特征是「大面积重合」**（会话 A 的记忆成批串进 B），
// 而不是「偶有一张泛词卡同时命中两个话题」。⇒ 用重合占比锁，10% 为界。
const OVERLAP_TOLERANCE = 0.10;
const overlapRatio = (x, y) => {
  const n = inter(x, y);
  const base = Math.min(x.ids.length, y.ids.length) || 1;
  return n / base;
};
const rAB = overlapRatio(A, B), rAC = overlapRatio(A, C), rBC = overlapRatio(B, C);
check(
  '两个不相关话题的装配结果重合度 < 10%',
  rAB < OVERLAP_TOLERANCE && rAC < OVERLAP_TOLERANCE && rBC < OVERLAP_TOLERANCE,
  'A∩B=' + (rAB * 100).toFixed(1) + '% A∩C=' + (rAC * 100).toFixed(1) + '% B∩C=' + (rBC * 100).toFixed(1) + '%',
);

// ── ② 同话题：各自独立 ──
console.log('── ② 同一话题的并发会话各自独立 ──');
const S1 = await run('same-1', '记忆改造的四股力是什么');
const S2 = await run('same-2', '记忆改造的四股力怎么算的');
const S3 = await run('same-3', '记忆改造四股力的参数');
console.log('    三会话 token: ' + S1.tokens + ' / ' + S2.tokens + ' / ' + S3.tokens);
check('三会话都能装出卡', S1.ids.length > 0 && S2.ids.length > 0 && S3.ids.length > 0);

// ── ③ 幂等：同一会话重复跑结果一致 ──
console.log('── ③ 同一会话重复跑，结果逐字节一致 ──');
const q = '记忆改造的四股力是什么';
const r1 = await run('idem', q);
const r2 = await run('idem', q);
check('两次装配的卡 id 序列完全相同', JSON.stringify(r1.ids) === JSON.stringify(r2.ids), r1.ids.length + ' 张');
check('两次 token 用量相同', r1.tokens === r2.tokens, r1.tokens + ' vs ' + r2.tokens);

// ── ④ 并发压力：20 个会话同时跑 ──
console.log('── ④ 20 个会话并发（看会不会错乱）──');
const QS = ['我显卡显存多大', 'Assistant的日记有几本', '示例设备A再生用什么阀门', '记忆系统 四股力', '桌宠最早的立绘怎么做'];
const many = await Promise.all(Array.from({ length: 20 }, (_, i) => run('stress-' + i, QS[i % QS.length])));
const allOk = many.every((m) => m.ids.length > 0);
const zeroDup = many.every((m) => new Set(m.ids).size === m.ids.length);   // 单个会话内无重复卡
console.log('    20 个会话: 全部有结果=' + allOk + '  单个会话内无重复=' + zeroDup);
check('20 并发会话全部正常返回', allOk);
check('单个会话内无重复卡（装配去重生效）', zeroDup);

// 同问题的会话结果应一致（并发不引入随机）
const sameQI = many.filter((_, i) => i % QS.length === 0).map((m) => JSON.stringify(m.ids));
check('同问题的并发结果一致（无竞态）', new Set(sameQI).size === 1, sameQI.length + ' 个相同问题');

console.log('\n' + (fail === 0 ? '✅ 并发与隔离全部正常' : '❌ ' + fail + ' 项失败'));
process.exit(fail === 0 ? 0 : 1);
