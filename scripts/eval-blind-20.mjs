#!/usr/bin/env node
/**
 * scripts/eval-blind-20.mjs —— 期8.4 盲测集（红队优先级3后半）
 * [2026-10-23 by Assistant]
 *
 * 与上一轮的根本区别：**先出题，再看图**。
 *   20 条查询从 64 天真实对话里按时间均匀盲抽，选题时**不看任何卡片内容**。
 * 判据不预设立场，只报三个数：
 *   A. baseline 的 top5 / top8 命中了多少条「相关卡」
 *   B. graph 的 top5 / top8 命中
 *   C. 两边 top5 的重合度（衡量图有没有挤掉原有结果）
 *
 * 「相关」定义：返回卡的文本里，与查询有 >=3 个共同 bigram（不依赖人工标注）。
 */
import { createRetriever } from '../lib/retrieval/retriever.js';

// 20 条盲抽查询（选取脚本见 eval-blind-20 的 seed 逻辑，固定写死便于复现）
const QUERIES = [
  '想要在qq部署ai bot小Assistant可以帮我吗',
  '提前设置的选项还有美化和之前设置的Assistant圣域同步',
  '帮我打包 注册表命令会导致dsh重启吗',
  '我不是装了生图插件吗 你查询一下',
  '你没办法查现在端口走到局域网哪里被拦截了吗',
  '我要解决的是我以后装其他模型的路子',
  '你之前 不是说评论区推荐66吗',
  '这眼睛怎么还带下脸蛋的 我才发现',
  '怎么多了一层嘴 原来的嘴跟个胡子一样在前面',
  '为什么人物脸上还是感觉有个圈 放大又没有',
  '你现在是打算用这个接收器给zako信号吗',
  'publish_now 为什么我看修改日期是9.16',
  '那实际用起来需要跑任务前先让会话进行一次升级吗',
  '改完你先试试看 这个插件的功能是否正常',
  '你可以帮我把low降权这部分功能直接永久关闭吗',
  '-b512之前不是在我们机械上被证有问题要用1024吗',
  '有什么可以优化到我们融合版本上的吗',
  '你先把可以优化的清单整好',
  '两个号轮流切 都这样子是上游炸了吗',
  '这是每周的不是刚刚我发在吗掉的',
];

function bigrams(s) {
  const t = String(s || '').toLowerCase();
  const o = new Set();
  for (let i = 0; i < t.length - 1; i++) {
    const b = t.slice(i, i + 2);
    if (/[\u4e00-\u9fff]{2}/.test(b)) o.add(b);
  }
  for (const w of t.match(/[a-z][a-z0-9_+.-]{2,}/gi) || []) o.add(w);
  return o;
}

async function run(graphOn) {
  const cfg = { enabled: true, l0Enabled: false };
  if (graphOn) cfg.graphExpandEnabled = true;
  const ret = createRetriever(cfg);
  await ret.warmup();

  const rows = [];
  for (const q of QUERIES) {
    const qb = bigrams(q);
    let r;
    try { r = await ret.search(q, {}); } catch { r = { hits: [] }; }
    const hits = r.hits || [];
    const isRel = (h) => {
      const tb = bigrams(String(h.title || '') + ' ' + String(h.summary || '') + ' ' + String(h.content || ''));
      let n = 0;
      for (const t of qb) if (tb.has(t)) n++;
      return n >= 3;
    };
    const top5 = hits.slice(0, 5).filter(isRel).length;
    const top8 = hits.slice(0, 8).filter(isRel).length;
    rows.push({
      q,
      n: hits.length,
      top5, top8,
      ids: hits.slice(0, 5).map((h) => String(h.id)),
      via: hits.slice(0, 5).map((h) => String(h.via || '')),
      graphAdded: r.graph ? Number(r.graph.added) || 0 : 0,
    });
  }
  return rows;
}

const A = await run(false);
const B = await run(true);

console.log('| # | 查询 | A top5 | B top5 | A top8 | B top8 | 图候选 | B的via |');
console.log('|---|---|---|---|---|---|---|---|');
let a5 = 0, b5 = 0, a8 = 0, b8 = 0, overlap = 0;
for (let i = 0; i < A.length; i++) {
  const a = A[i], b = B[i];
  a5 += a.top5; b5 += b.top5; a8 += a.top8; b8 += b.top8;
  const same = a.ids.filter((x) => b.ids.includes(x)).length;
  overlap += same;
  const viaStr = b.via.filter((v) => v.includes('1hop')).length;
  console.log('| ' + (i + 1) + ' | ' + a.q.slice(0, 16) + ' | ' + a.top5 + ' | ' + b.top5 + ' | '
    + a.top8 + ' | ' + b.top8 + ' | ' + b.graphAdded + ' | ' + (viaStr ? viaStr + '条1hop' : '-') + ' |');
}
console.log('');
console.log('合计:');
console.log('  A·baseline  top5 相关卡: ' + a5 + ' / ' + A.length * 5);
console.log('  B·graph     top5 相关卡: ' + b5 + ' / ' + B.length * 5);
console.log('  A·baseline  top8 相关卡: ' + a8 + ' / ' + A.length * 8);
console.log('  B·graph     top8 相关卡: ' + b8 + ' / ' + B.length * 8);
console.log('  top5 重合度: ' + overlap + ' / ' + A.length * 5 + ' (' + (overlap / (A.length * 5) * 100).toFixed(1) + '%)');
console.log('');
console.log('解读:');
console.log('  · 若 b5 > a5  ⇒ 图提升了相关卡占比');
console.log('  · 若 b5 < a5  ⇒ 图挤掉了精准结果（红队警告的 Precision Regression）');
console.log('  · 若 b5 = a5  ⇒ 图在真实查询上无影响（大概率因为大多数查询 BM25 已够）');
process.exitCode = 0;
