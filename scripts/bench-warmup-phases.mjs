#!/usr/bin/env node
/**
 * bench-warmup-phases.mjs —— 暖机分阶段打点（只读）
 * [2026-10-31 by Assistant · 回应红队 P0「真实路径测量缺失」]
 *
 * 为什么要重做：
 *   第一版基准用 createRetriever({}) 裸配置，L0 根本没加载（l0.files=0），
 *   于是"warmup ≈ 1.0s"漏掉了最大的一块。红队指出生产 l0Enabled:true，
 *   补测后真实值是 1.88s。⇒ 基准必须**贴生产配置**，且分阶段计时。
 *
 * 只读：不写任何库、不改任何配置、不触发重建。
 * 用法：node scripts/bench-warmup-phases.mjs [--runs N] [--json]
 */
import { performance } from 'node:perf_hooks';
import { statSync, readFileSync, readdirSync } from 'node:fs';

const RUNS = (() => {
  const i = process.argv.indexOf('--runs');
  return i >= 0 ? Math.max(1, Number(process.argv[i + 1]) || 3) : 3;
})();
const AS_JSON = process.argv.includes('--json');

const REPO = new URL('..', import.meta.url).pathname.replace(/^\//, '').replace(/\//g, '/');
const LIB = 'file:///' + REPO.replace(/^\/+/, '') + 'lib/';
const { dataPath } = await import(LIB + 'paths.js');
const { createRetriever } = await import(LIB + 'retrieval/retriever.js');
const { readManifest, readAllRecords } = await import(LIB + 'hypergraph/store.js');
const { readCards } = await import(LIB + 'hypergraph/source.js');
const { readTdaiRecords, DEFAULT_TDAI_DIR } = await import(LIB + 'hypergraph/source.js');
const { readOwnIngest, DEFAULT_INGEST_ROOT } = await import(LIB + 'hypergraph/source.js');
const { readSoulMdCards, DEFAULT_SOULMD_ROOT } = await import(LIB + 'hypergraph/source.js');
const { buildL0RoundCards } = await import(LIB + 'hypergraph/l0-rounds.js');
const { createTokenizer } = await import(LIB + 'retrieval/tokenize.js');
const { createBm25Index } = await import(LIB + 'retrieval/bm25.js');
const { createAliasIndex } = await import(LIB + 'retrieval/alias.js');

const p50 = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const rows = [];
function rec(phase, ms, note) { rows.push({ phase, ms: Number(ms.toFixed(2)), note: note || '' }); }

// ── 生产等价配置（照抄 profile 的 retrieval 段）──
const PROD = {
  l0Enabled: true,
  l0RecentDays: 30,
  conversationsDir: dataPath('memory-tencentdb/memory-tdai/conversations'),
  soulMdEnabled: true,
  startluxRerank: false,       // 首次查询才拉起，暖机阶段不计（单独测）
  embedding: null,             // 暖机不联网；向量索引加载单独测
  embeddingFallback: null,
  hypergraph: { indexRoot: dataPath('hypergraph') },
};

// ── 1 · 冷启动各阶段（逐项单独计时，重复 RUNS 次）──
const phases = {
  'readManifest': () => readManifest(dataPath('hypergraph')),
  'readAllRecords(超图)': () => readAllRecords(dataPath('hypergraph'), (readManifest(dataPath('hypergraph')).shards || []).length),
  'readCards(engram)': () => readCards(),
  'readTdaiRecords': () => readTdaiRecords(DEFAULT_TDAI_DIR),
  'readOwnIngest': () => readOwnIngest(DEFAULT_INGEST_ROOT),
  'readSoulMdCards': () => readSoulMdCards(DEFAULT_SOULMD_ROOT),
  'buildL0RoundCards': () => buildL0RoundCards(PROD.conversationsDir, { recentDays: 30 }),
};

const tok = createTokenizer({ mode: 'bigram' });
let lastCards = null, lastL0 = null;
for (const [name, fn] of Object.entries(phases)) {
  const t = [];
  let out = null;
  for (let i = 0; i < RUNS; i++) { const s = performance.now(); out = fn(); t.push(performance.now() - s); }
  if (name === 'readCards(engram)') lastCards = out;
  if (name === 'buildL0RoundCards') lastL0 = out;
  const size = outputSize(out);
  rec(name, p50(t), size);
}
function outputSize(o) {
  if (!o) return '';
  if (Array.isArray(o)) return o.length + ' items';
  // readCards 返回 { all, alive, cards:<数量> } —— 注意 cards 是**数字**不是数组
  if (typeof o.cards === 'number') return o.cards + ' cards (alive ' + (o.alive ? o.alive.length : '?') + ')';
  if (Array.isArray(o.cards)) return o.cards.length + ' cards';
  if (o.episodes) return o.episodes.length + ' ep';
  return '';
}

// ── 2 · BM25 构建（普通池 / L0 池 分开）──
{
  const cards = lastCards ? (lastCards.all || lastCards.alive || []) : [];
  const t = [];
  for (let i = 0; i < RUNS; i++) { const s = performance.now(); createBm25Index(cards, tok); t.push(performance.now() - s); }
  rec('createBm25Index(普通池)', p50(t), cards.length + ' docs');

  const l0 = lastL0 || [];
  const t2 = [];
  for (let i = 0; i < RUNS; i++) { const s = performance.now(); createBm25Index(l0, tok); t2.push(performance.now() - s); }
  rec('createBm25Index(L0池)', p50(t2), l0.length + ' docs');
}

// ── 3 · alias 词表 ──
{
  const t = [];
  for (let i = 0; i < RUNS; i++) { const s = performance.now(); createAliasIndex({ previewPath: dataPath('alias/engram-triggers.preview.jsonl') }); t.push(performance.now() - s); }
  rec('createAliasIndex', p50(t), '');
}

// ── 4 · 端到端 warmup（生产等价配置）──
{
  const t = [];
  let health = null;
  for (let i = 0; i < RUNS; i++) {
    const r = createRetriever(PROD);
    const s = performance.now();
    await r.warmup();
    t.push(performance.now() - s);
    health = r.health();
  }
  rec('warmup() 端到端', p50(t), 'l0.files=' + (health && health.l0 ? health.l0.files : '?') + ' cards=' + (health && health.source ? health.source.alive : '?'));
}

// ── 5 · 首次查询（含 StartLux / 向量是否参与）──
{
  const r = createRetriever(PROD);
  await r.warmup();
  const qs = ['记忆系统 检索 延迟', '插件 安装 报错', '超频 显存 测试'];
  const first = [], steady = [];
  let s = performance.now(); await r.search(qs[0]); first.push(performance.now() - s);
  for (let i = 0; i < 6; i++) { const q = qs[i % qs.length]; s = performance.now(); await r.search(q); steady.push(performance.now() - s); }
  rec('首次查询', first[0], '可能含按需拉起');
  rec('稳态查询 p50', p50(steady), 'n=' + steady.length + ' max=' + Math.max(...steady).toFixed(1));
}

// ── 输出 ──
if (AS_JSON) {
  console.log(JSON.stringify({ runs: RUNS, rows }, null, 2));
} else {
  console.log('');
  console.log('阶段'.padEnd(26) + 'p50(ms)'.padStart(9) + '   备注');
  console.log('-'.repeat(72));
  for (const r of rows) console.log(r.phase.padEnd(26) + String(r.ms).padStart(9) + '   ' + r.note);
  const sumOld = rows.filter(r => /readCards|readTdai|readOwnIngest|readSoulMd|buildL0|readManifest|readAllRecords|createBm25|createAlias/.test(r.phase))
                     .reduce((a, b) => a + b.ms, 0);
  console.log('-'.repeat(72));
  console.log('各阶段合计（参考，不等于端到端）'.padEnd(26) + String(sumOld.toFixed(0)).padStart(9));
}
