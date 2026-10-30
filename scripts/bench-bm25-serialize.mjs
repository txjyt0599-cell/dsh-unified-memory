#!/usr/bin/env node
/**
 * bench-bm25-serialize.mjs —— 估算/实测 BM25 持久化的真实收益（只读）
 * [2026-10-31 by Assistant · 为 PLAN-bm25-cache 提供决策依据]
 *
 * 为什么要它：
 *   方案第一版写"519ms → ≤50ms"是拍脑袋。拆开才发现：
 *     · 纯分词只占 63ms（19%）⇒ 只缓存分词等于没做
 *     · 反序列化后仍要重建 13w 词的 Map（约 49ms）
 *     · 若改成扁平结构，反序列化能压到 ~6ms
 *   这几个数决定方案该怎么写，不能靠猜。
 *
 * 只读：不写任何缓存文件、不改任何库。
 * 用法：PM_DATA_ROOT=<数据根> node scripts/bench-bm25-serialize.mjs
 */
import { performance } from 'node:perf_hooks';

const REPO = new URL('..', import.meta.url).pathname.replace(/^\//, '');
const LIB = 'file:///' + REPO.replace(/^\/+/, '') + 'lib/';
const { readCards } = await import(LIB + 'hypergraph/source.js');
const { createBm25Index } = await import(LIB + 'retrieval/bm25.js');
const { createTokenizer } = await import(LIB + 'retrieval/tokenize.js');

const p50 = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const N = 3;

const src = readCards();
const cards = src.all || src.alive || [];
const tok = createTokenizer({ mode: 'bigram' });

// ── 1 · 建索引总耗时 ──
const tBuild = [];
let idx = null;
for (let i = 0; i < N; i++) { const s = performance.now(); idx = createBm25Index(cards, tok); tBuild.push(performance.now() - s); }
console.log('卡数            ', cards.length);
console.log('vocabSize       ', idx.vocabSize);
console.log('postingsPairs   ', idx.postingsPairs);
console.log('建索引 p50      ', p50(tBuild).toFixed(0), 'ms');
console.log('');

// ── 2 · 纯分词占多少（决定"只缓存分词"是否够用）──
const tTok = [];
for (let i = 0; i < N; i++) {
  const s = performance.now();
  for (const c of cards) {
    tok.tokenize(String(c.title || ''));
    tok.tokenize(String(c.summary || ''));
    tok.tokenize(String(c.content || ''));
  }
  tTok.push(performance.now() - s);
}
const tAll = p50(tBuild), tT = p50(tTok);
console.log('纯分词 p50      ', tT.toFixed(0), 'ms  (' + ((tT / tAll) * 100).toFixed(0) + '% of 建索引)');
console.log('非分词部分      ', (tAll - tT).toFixed(0), 'ms  ← 缓存分词省不掉这部分');
console.log('');

// ── 3 · 反序列化两条路径的真实代价 ──
const VOCAB = idx.vocabSize, PAIRS = idx.postingsPairs;
const perTerm = Math.max(1, Math.round(PAIRS / VOCAB));
const terms = [];
for (let i = 0; i < VOCAB; i++) terms.push('t' + i.toString(36) + 'x'.repeat(i % 7));

const tMapKey = [], tMapPost = [];
for (let r = 0; r < N; r++) {
  let s = performance.now();
  const m = new Map();
  for (let i = 0; i < VOCAB; i++) m.set(terms[i], i);
  tMapKey.push(performance.now() - s);

  s = performance.now();
  const postings = new Map();
  for (let i = 0; i < VOCAB; i++) {
    const arr = [];
    const n = Math.round(PAIRS / VOCAB);
    for (let j = 0; j < n; j++) arr.push(j * 2, 1.0);
    postings.set(terms[i], arr);
  }
  tMapPost.push(performance.now() - s);
}
const mapCost = p50(tMapKey) + p50(tMapPost);
console.log('A · Map 重建    ', mapCost.toFixed(0), 'ms  (键 ' + p50(tMapKey).toFixed(0) + ' + postings ' + p50(tMapPost).toFixed(0) + ')');

const tFlat = [];
for (let r = 0; r < N; r++) {
  const s = performance.now();
  const offsets = new Int32Array(VOCAB + 1);
  let acc = 0;
  for (let i = 0; i < VOCAB; i++) { offsets[i] = acc; acc += perTerm * 2; }
  offsets[VOCAB] = acc;
  const docIdx = new Int32Array(acc);
  const weights = new Float64Array(acc);
  docIdx[0] = 1; weights[0] = 1;   // 防被优化掉
  tFlat.push(performance.now() - s);
}
console.log('B · 扁平结构    ', p50(tFlat).toFixed(0), 'ms  (Int32/Float64 直读)');
console.log('');

// ── 4 · 二进制拷贝 ──
const tCopy = [];
const big = new Float64Array(1_300_000);
for (let i = 0; i < big.length; i++) big[i] = i;
for (let r = 0; r < N; r++) { const s = performance.now(); const c = new Float64Array(big); tCopy.push(performance.now() - s); void c; }
console.log('10MB 二进制拷贝 ', p50(tCopy).toFixed(2), 'ms  ← IO 不是瓶颈');
console.log('');

// ── 5 · 结论 ──
console.log('════ 收益上限估算 ════');
console.log('只缓存分词         省 ' + tT.toFixed(0) + ' ms  ← 不值得做');
console.log('整表缓存 + Map 重建 省 ' + (tAll - mapCost).toFixed(0) + ' ms');
console.log('整表缓存 + 扁平结构 省 ' + (tAll - p50(tFlat)).toFixed(0) + ' ms  ← 但需改 bm25 查询路径');
