#!/usr/bin/env node
/**
 * bench-l0-ablation.mjs —— L0 构建消融（只读）
 * [2026-10-31 by Assistant · 红队三审排序：先做 L0 消融]
 *
 * 为什么要它：
 *   L0 整条链实测 752ms（解析 411 + 建索引 341），比普通池 BM25 更大。
 *   但"411ms 解析"内部到底花在哪，之前没人拆过。
 *
 * 只读：不写库、不改配置。
 * 用法：PM_DATA_ROOT=<数据根> node scripts/bench-l0-ablation.mjs
 */
import { performance } from 'node:perf_hooks';
import { readdirSync, readFileSync } from 'node:fs';

const REPO = new URL('..', import.meta.url).pathname.replace(/^\//, '');
const LIB = 'file:///' + REPO.replace(/^\/+/, '') + 'lib/';
const { buildL0RoundCards, stripMarkup } = await import(LIB + 'hypergraph/l0-rounds.js');
const { dataPath } = await import(LIB + 'paths.js');
const { createTokenizer } = await import(LIB + 'retrieval/tokenize.js');
const { createBm25Index } = await import(LIB + 'retrieval/bm25.js');

const p50 = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const N = 3;
const conv = dataPath('memory-tencentdb/memory-tdai/conversations');

console.log('════ L0 消融 ════');
console.log('会话目录:', conv);

// ── 1 · buildL0RoundCards 总耗时 ──
const tBuild = [];
let cards = [];
for (let i = 0; i < N; i++) { const s = performance.now(); cards = buildL0RoundCards(conv, { recentDays: 30 }); tBuild.push(performance.now() - s); }
const TB = p50(tBuild);
console.log('');
console.log('buildL0RoundCards p50 =', TB.toFixed(0), 'ms   rounds =', cards.length);

// ── 2 · 拆：读文件 / JSON.parse / stripMarkup ──
//
//   ⚠️ 关键口径：L0 只读 **recentDays 窗口内**的文件（默认 30 天）。
//   本机 64 个文件里只有 22 个落在窗口内（21MB / 30606 行），
//   拿全部 64 个文件（62MB / 107427 行）来算会把内部分解放大 3 倍，对不上总耗时。
//   这里两种口径都打出来，避免下次又对不上。
const allFiles = readdirSync(conv).filter((f) => f.endsWith('.jsonl')).sort();
const TZ_OFF = 8 * 3600000, WINDOW_DAYS = 30;
const sinceMs = Date.now() - WINDOW_DAYS * 86400000;
const files = allFiles.filter((name) => {
  const pfd = Date.parse(name.slice(0, 10) + 'T00:00:00Z');
  const fileDay = Number.isFinite(pfd) ? pfd - TZ_OFF : NaN;
  return Number.isFinite(fileDay) && fileDay + 86400000 >= sinceMs;
});
let bytes = 0, lines = 0;
const rawAll = [];
for (const f of files) { const t = readFileSync(conv + '/' + f, 'utf8'); rawAll.push(t); bytes += t.length; lines += t.split('\n').length - 1; }
console.log('  窗口内文件 =', files.length, '/', allFiles.length, ' 字节 =', (bytes / 1024 / 1024).toFixed(2), 'MB  行数 =', lines);

// readFile 计时（已在上面的 rawAll 里做过一次，单独再测）
{
  const t = [];
  for (let i = 0; i < N; i++) { const s = performance.now(); for (const f of files) readFileSync(conv + '/' + f, 'utf8'); t.push(performance.now() - s); }
  console.log('    readFile 全量 p50 =', p50(t).toFixed(0), 'ms');
}
// JSON.parse
{
  const t = [];
  for (let i = 0; i < N; i++) {
    const s = performance.now();
    for (const raw of rawAll) for (const line of raw.split('\n')) { if (!line) continue; try { JSON.parse(line); } catch {} }
    t.push(performance.now() - s);
  }
  console.log('    JSON.parse 全量 p50 =', p50(t).toFixed(0), 'ms');
}
// stripMarkup
const msgs = [];
for (const raw of rawAll) for (const line of raw.split('\n')) { if (!line) continue; try { const o = JSON.parse(line); if (o.content) msgs.push(String(o.content)); } catch {} }
{
  const t = [];
  for (let i = 0; i < N; i++) { const s = performance.now(); for (const m of msgs) stripMarkup(m); t.push(performance.now() - s); }
  console.log('    stripMarkup 全量 p50 =', p50(t).toFixed(0), 'ms   (n=' + msgs.length + ')');
  let withTag = 0;
  for (const m of msgs) if (/[<&]/.test(m)) withTag++;
  console.log('      其中含 < 或 & 的 =', withTag, '(' + ((withTag / msgs.length) * 100).toFixed(1) + '%)');
}

// ── 3 · L0 BM25 建索引 ──
{
  const tok = createTokenizer({ mode: 'bigram' });
  const t = [];
  let idx = null;
  for (let i = 0; i < N; i++) { const s = performance.now(); idx = createBm25Index(cards, tok); t.push(performance.now() - s); }
  console.log('');
  console.log('L0 BM25 建索引 p50 =', p50(t).toFixed(0), 'ms   vocab =', idx.vocabSize, ' pairs =', idx.postingsPairs);
}
console.log('');
console.log('════ 汇总 ════');
console.log('  L0 解析(buildL0RoundCards) =', TB.toFixed(0), 'ms');
console.log('  L0 建索引                  = 见上');
console.log('  合计                       = 约', TB.toFixed(0), '+ 建索引');
