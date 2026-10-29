#!/usr/bin/env node
/**
 * scripts/eval-four-forces-20.mjs —— 四股力 20 条盲测（红队验收标准）
 * [2026-10-24 by Assistant · goal round 2]
 *
 * 为什么用 20 条而不是 5 条：
 *   上一轮只 A/B 了 5 条真查询，样本太小，结论可能是运气。
 *   这里复用**期8.4 那套盲抽的 20 条**（当时选题不看卡片内容，避免预设立场），
 *   对比「四股力关 / 开」两种配置。
 *
 * 判据（三条都要看）：
 *   ① 相关卡占比不能掉（掉了 = 四股力在挤掉精准结果）
 *   ② Top1 命中率不能掉（最贴题那张必须还在第 1）
 *   ③ 有变化但没伤害 ⇒ 才算通过
 */
import { createRetriever } from '../lib/retrieval/retriever.js';

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

async function run(fourForces) {
  const ret = createRetriever({ enabled: true, l0Enabled: false, fourForcesEnabled: fourForces }, null);
  await ret.warmup();
  const rows = [];
  for (const q of QUERIES) {
    const qb = bigrams(q);
    let r;
    try { r = await ret.search(q, {}); } catch (e) { r = { hits: [] }; }
    const hits = r.hits || [];
    const isRel = (h) => {
      const tb = bigrams(String(h.title || '') + ' ' + String(h.summary || '') + ' ' + String(h.content || ''));
      let n = 0;
      for (const t of qb) if (tb.has(t)) n++;
      return n >= 3;
    };
    rows.push({
      q,
      top1: hits.length && isRel(hits[0]) ? 1 : 0,
      top5: hits.slice(0, 5).filter(isRel).length,
      top8: hits.slice(0, 8).filter(isRel).length,
      ids: hits.slice(0, 5).map((h) => String(h.id)),
      titles: hits.slice(0, 3).map((h) => String(h.title || '').slice(0, 20)),
      ff: r.fourForces || null,
    });
  }
  return rows;
}

const A = await run(false);
const B = await run(true);

let a1 = 0, b1 = 0, a5 = 0, b5 = 0, a8 = 0, b8 = 0, overlap = 0, changed = 0;
const regressions = [];
console.log('| # | 查询 | A top1 | B top1 | A top5 | B top5 | 变? |');
console.log('|---|---|---|---|---|---|---|');
for (let i = 0; i < A.length; i++) {
  const a = A[i], b = B[i];
  a1 += a.top1; b1 += b.top1; a5 += a.top5; b5 += b.top5; a8 += a.top8; b8 += b.top8;
  const same = JSON.stringify(a.ids) === JSON.stringify(b.ids);
  if (!same) changed++;
  overlap += a.ids.filter((x) => b.ids.includes(x)).length;
  if (b.top1 < a.top1) regressions.push({ q: a.q, aTitle: a.titles[0], bTitle: b.titles[0] });
  console.log('| ' + (i + 1) + ' | ' + a.q.slice(0, 14) + ' | ' + a.top1 + ' | ' + b.top1 + ' | '
    + a.top5 + ' | ' + b.top5 + ' | ' + (same ? '-' : '变') + ' |');
}

console.log('');
console.log('合计（' + QUERIES.length + ' 条）:');
console.log('  Top1 相关: 关=' + a1 + '  开=' + b1 + '  （差 ' + (b1 - a1) + '）');
console.log('  Top5 相关: 关=' + a5 + '/' + QUERIES.length * 5 + '  开=' + b5 + '/' + QUERIES.length * 5 + '  （差 ' + (b5 - a5) + '）');
console.log('  Top8 相关: 关=' + a8 + '/' + QUERIES.length * 8 + '  开=' + b8 + '/' + QUERIES.length * 8 + '  （差 ' + (b8 - a8) + '）');
console.log('  Top5 重合: ' + overlap + '/' + QUERIES.length * 5 + ' (' + (overlap / (QUERIES.length * 5) * 100).toFixed(1) + '%)');
console.log('  排序有变化的查询: ' + changed + '/' + QUERIES.length);

console.log('');
console.log('判定:');
const c1 = b5 >= a5;
const c2 = b1 >= a1;
console.log('  ' + (c1 ? '✅' : '❌') + ' ① Top5 相关卡不掉   ' + a5 + ' → ' + b5);
console.log('  ' + (c2 ? '✅' : '❌') + ' ② Top1 命中不掉     ' + a1 + ' → ' + b1);
if (regressions.length) {
  console.log('  ⚠ Top1 被顶掉的 ' + regressions.length + ' 条:');
  for (const r of regressions) console.log('     · ' + r.q.slice(0, 20) + '  原=' + r.aTitle + '  新=' + r.bTitle);
}
process.exit(c1 && c2 ? 0 : 1);
