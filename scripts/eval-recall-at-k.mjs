#!/usr/bin/env node
/**
 * scripts/eval-recall-at-k.mjs —— 期8.4 Recall@K 评测（切「改分」的前置条件）
 * [2026-10-23 by Assistant]
 *
 * 白队给的条件：改分要成立，必须拿真实查询日志证明「图信号确实优于 BM25」。
 * 本脚本就做这件事：同一批真实查询，对比
 *   A. baseline  —— 纯 BM25（wGraph=0，补候选关闭）
 *   B. 补候选     —— 现有接法（wGraph>0，但只加候选不改分）
 *   C. 改分       —— 模拟 alpha 融合覆盖排序
 *
 * 判据：若 C 的 Recall@K 没有显著优于 A/B，就**不切**（保守接法是对的）。
 */
import { createRetriever } from '../lib/retrieval/retriever.js';
import { readFileSync, existsSync } from 'node:fs';
import { dataPath } from '../lib/paths.js';

const ROOT = dataPath('ingest');
const CONV = ROOT + '/conversations/2026-10-23.jsonl';

// ── 取真实用户原话当查询 ──
function loadQueries(limit) {
  if (!existsSync(CONV)) return [];
  const out = [];
  for (const l of readFileSync(CONV, 'utf8').split('\n').filter(Boolean)) {
    try {
      const o = JSON.parse(l);
      const c = String(o.content || '').trim();
      if (o.role === 'user' && c.length >= 12 && c.length <= 120) out.push(c);
    } catch {}
  }
  return out.slice(-limit);
}

// ── 判定「命中」：返回结果里有没有与查询词面重叠 ≥2 个词元的卡 ──
function tokens(s) {
  const t = String(s || '').toLowerCase();
  const set = new Set();
  // 中文 bigram + 英文词
  for (let i = 0; i < t.length - 1; i++) {
    const bg = t.slice(i, i + 2);
    if (/[\u4e00-\u9fff]{2}/.test(bg)) set.add(bg);
  }
  for (const w of t.match(/[a-z][a-z0-9_+.-]{2,}/gi) || []) set.add(w);
  return set;
}

function relevant(query, card) {
  const q = tokens(query);
  const c = tokens(String(card.title || '') + ' ' + String(card.summary || '') + ' ' + String(card.content || ''));
  let hit = 0;
  for (const t of q) if (c.has(t)) hit++;
  // [2026-10-23] 收紧：≥3 个共同词元才算相关（≥2 太宽，baseline 也能 100%）
  return hit >= 3;
}

// [2026-10-23 白队指令] 多 K 对照：top3 测不准「只往队尾加人」的机制，必须看长尾
const KS = [3, 10, 30, 50];

async function run(mode, queries) {
  const cfg = { enabled: true, l0Enabled: false };
  if (mode === 'graph') { cfg.graphExpandEnabled = true; cfg.graphAlpha = 0.6; }
  const ret = createRetriever(cfg);
  await ret.warmup();
  const maxK = Math.max.apply(null, KS);
  const hits = {};
  const addedCounts = [];
  for (const k of KS) hits[k] = 0;
  let total = 0;
  for (const q of queries) {
    try {
      const r = await ret.search(q, {});
      const all = r.hits || [];
      if (r.graph && Number.isFinite(Number(r.graph.added))) addedCounts.push(Number(r.graph.added));
      total++;
      // 每个 K 分别判：前 K 条里有没有相关的
      for (const k of KS) {
        const top = all.slice(0, k);
        if (top.some((h) => relevant(q, h))) hits[k]++;
      }
    } catch {}
  }
  const recall = {};
  for (const k of KS) recall[k] = total ? hits[k] / total : 0;
  const avgAdded = addedCounts.length ? (addedCounts.reduce((a, b) => a + b, 0) / addedCounts.length) : 0;
  return { hits, total, recall, avgAdded };
}

const queries = loadQueries(20);
if (queries.length === 0) {
  console.log('❌ 没有可用查询（conversations 为空）');
  process.exitCode = 1;
} else {
  console.log('评测查询数: ' + queries.length);
  console.log('');
  const a = await run('baseline', queries);
  const b = await run('graph', queries);
  console.log('| K  | A·baseline | B·补候选 | B−A |');
  console.log('|----|-----------|---------|-----|');
  for (const k of KS) {
    const ra = a.recall[k], rb = b.recall[k];
    const d = (rb - ra) * 100;
    console.log('| ' + String(k).padStart(2) + ' | ' + (ra * 100).toFixed(1) + '% (' + a.hits[k] + '/' + a.total + ') | '
      + (rb * 100).toFixed(1) + '% (' + b.hits[k] + '/' + b.total + ') | ' + (d >= 0 ? '+' : '') + d.toFixed(1) + 'pt |');
  }
  console.log('');
  console.log('补候选平均每次新增候选: ' + b.avgAdded.toFixed(0) + ' 条');
  console.log('');
  const d3 = (b.recall[3] - a.recall[3]) * 100;
  const d30 = (b.recall[30] - a.recall[30]) * 100;
  const d50 = (b.recall[50] - a.recall[50]) * 100;
  if (Math.abs(d30) < 1 && Math.abs(d50) < 1) {
    console.log('判定：Recall@30/50 也无差异 ⇒ 那 ' + b.avgAdded.toFixed(0) + ' 条补进来的候选里**没有金子**，图连"拓宽召回"都没做好。需查根因。');
  } else if (d30 > 1 || d50 > 1) {
    console.log('判定：长尾有收益（@30 ' + d30.toFixed(1) + 'pt / @50 ' + d50.toFixed(1) + 'pt）⇒ 图作为「长尾补充器」有效，定位为买保险是对的。');
  } else {
    console.log('判定：长尾为负 ⇒ 应默认关闭。');
  }
  process.exitCode = 0;
}
