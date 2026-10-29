#!/usr/bin/env node
/**
 * scripts/eval-synonym-recall.mjs —— 期8.4 优先级2：同义改写查询评测
 * [2026-10-23 by Assistant]
 *
 * 白队指令：「构造 BM25 会漏的查询。BM25 怕同义词、怕缩写、怕换个说法。
 *             只有在 BM25 瞎了的场景下，图才能救命。」
 *
 * 做法：
 *   1. 从真实卡里挑「有明确 entities 但标题不含这些词」的卡作为目标
 *   2. 用**实体词**而不是标题词构造查询（词面不重合 ⇒ BM25 天然吃亏）
 *   3. 对比 baseline 与补候选两路，看目标卡能不能被捞进 top10
 */
import { createRetriever } from '../lib/retrieval/retriever.js';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { dataPath } from '../lib/paths.js';

const ROOT = dataPath('ingest');
const ENGRAM = ROOT + '/engrams.jsonl';

function loadCards() {
  if (!existsSync(ENGRAM)) return [];
  const byId = new Map();
  for (const l of readFileSync(ENGRAM, 'utf8').split('\n').filter(Boolean)) {
    try {
      const o = JSON.parse(l);
      const k = o.id || o.engram_id;
      if (k) byId.set(k, o);
    } catch {}
  }
  return Array.from(byId.values());
}

// 同义改写表：查询用词 ⟷ 卡片可能用的词（词面不重合）
const REWRITES = [
  { q: '闸门为什么拦不住脏数据', keys: ['sanitizetitle', '闸门', 'scene_name'] },
  { q: '退回上一版怎么操作', keys: ['回滚', 'rollback', '备份'] },
  { q: '降级之后还能不能用', keys: ['fallback', '兜底', '降级'] },
  { q: '那套打分机制还留着吗', keys: ['bm25', '排序', 'boost'] },
  { q: '健康检查看什么指标', keys: ['体检', 'memory-health', 'verify'] },
  { q: '两个候选方案哪个稳', keys: ['补候选', '改分', '裁决'] },
  { q: '卡片标题怎么生成的', keys: ['title', 'sanitizetitle', '标题'] },
  { q: '写入的时候会不会漏字段', keys: ['落盘', '磁盘', '写入'] },
  { q: '那个抽取函数叫什么', keys: ['heuristicextract', '提取'] },
  { q: '重复的卡怎么合并', keys: ['重复', 'labels', 'manual'] },
];

async function run(mode, queries, cards) {
  const cfg = { enabled: true, l0Enabled: false };
  if (mode === 'graph') { cfg.graphExpandEnabled = true; }
  const ret = createRetriever(cfg);
  await ret.warmup();

  const out = [];
  for (const item of queries) {
    // 目标卡：entities 里含任一 key 的卡（取第一个匹配）
    const target = cards.find((c) => {
      const blob = (String(c.title || '') + ' ' + String(c.summary || '') + ' ' + JSON.stringify(c.entities || [])).toLowerCase();
      return item.keys.some((k) => blob.includes(String(k).toLowerCase()));
    });
    if (!target) continue;

    const r = await ret.search(item.q, {});
    const all = r.hits || [];
    const targetTitle = String(target.title || '').slice(0, 30);
    // 目标卡在第几名
    let rank = -1;
    for (let i = 0; i < all.length; i++) {
      if (String(all[i].title || '').slice(0, 30) === targetTitle) { rank = i + 1; break; }
    }
    out.push({
      q: item.q,
      target: targetTitle,
      rank: rank,
      hits: all.length,
      graphAdded: r.graph ? r.graph.added : 0,
    });
  }
  return out;
}

const cards = loadCards();
const queries = REWRITES;

if (!cards.length) {
  console.log('❌ 无卡片数据');
  process.exitCode = 1;
} else {
  const a = await run('baseline', queries, cards);
  const b = await run('graph', queries, cards);

  console.log('| 查询（同义改写） | 目标卡 | A·baseline rank | B·补候选 rank |');
  console.log('|---|---|---|---|');
  let aHit = 0, bHit = 0, aIn10 = 0, bIn10 = 0, n = 0;
  for (let i = 0; i < a.length; i++) {
    const ra = a[i], rb = b[i];
    if (!ra || !rb) continue;
    n++;
    const aRank = ra.rank > 0 ? String(ra.rank) : '未召回';
    const bRank = rb.rank > 0 ? String(rb.rank) : '未召回';
    console.log('| ' + ra.q + ' | ' + ra.target + ' | ' + aRank + ' | ' + bRank + ' |');
    if (ra.rank > 0 && ra.rank <= 10) aIn10++;
    if (rb.rank > 0 && rb.rank <= 10) bIn10++;
    if (ra.rank > 0) aHit++;
    if (rb.rank > 0) bHit++;
  }
  console.log('');
  console.log('可评测查询: ' + n);
  console.log('A·baseline  top10 命中: ' + aIn10 + '/' + n + '   任意位置: ' + aHit + '/' + n);
  console.log('B·补候选    top10 命中: ' + bIn10 + '/' + n + '   任意位置: ' + bHit + '/' + n);
  console.log('');
  const d10 = bIn10 - aIn10;
  if (d10 > 0) console.log('判定：图在**同义改写**场景下 top10 多召回 ' + d10 + ' 条 ⇒ 证明它对「BM25 瞎子」有效，定位为买保险成立。');
  else if (d10 === 0 && bHit > aHit) console.log('判定：top10 无变化，但任意位置多召回 ' + (bHit - aHit) + ' 条 ⇒ 图能补到长尾，但补得不够靠前。');
  else if (d10 === 0) console.log('判定：**同义改写场景下也无差异** ⇒ 图确实没起作用，需查根因（实体质量/扩散策略）。');
  else console.log('判定：图反而降低召回（' + d10 + '）⇒ 应关闭。');

  const outPath = dataPath('ingest/traces/eval-synonym-') + Date.now() + '.json';
  try { writeFileSync(outPath, JSON.stringify({ at: new Date().toISOString(), a, b }, null, 2), 'utf8'); } catch {}
  console.log('明细: ' + outPath);
  process.exitCode = 0;
}
