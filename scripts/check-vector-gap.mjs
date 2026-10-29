#!/usr/bin/env node
/**
 * scripts/check-vector-gap.mjs —— 向量覆盖缺口体检
 * [2026-10-26 by Assistant · 交接计划配套]
 *
 * 用途：一眼看出「有多少活卡还没有向量」。
 * 下个会话接手动工时，先跑这个确认缺口数字没变。
 *
 * 用法：node scripts/check-vector-gap.mjs
 */
import { loadIndex } from '../lib/embedding/index-store.js';
import { readCards, readTdaiRecords, readOwnIngest } from '../lib/hypergraph/source.js';

const idx = loadIndex();
if (!idx) {
  console.log('❌ 没有向量索引（或索引损坏）');
  process.exit(1);
}

const all = [];
for (const c of readCards().alive) all.push(c);
for (const c of (readTdaiRecords().cards || [])) all.push(c);
for (const c of (readOwnIngest().cards || [])) all.push(c);

const have = new Set(idx.ids);
const missing = all.filter((c) => !have.has(String(c.id)));

console.log('══════ 向量覆盖体检 ══════');
console.log('索引模型:   ' + idx.model);
console.log('索引维度:   ' + idx.dim);
console.log('索引条数:   ' + idx.ids.length);
console.log('构建时间:   ' + new Date(idx.builtAt).toISOString());
console.log('');
console.log('全库活卡:   ' + all.length);
console.log('缺向量:     ' + missing.length + '  (' + ((missing.length / all.length) * 100).toFixed(1) + '%)');
console.log('');

if (missing.length === 0) {
  console.log('✅ 所有活卡都有向量');
} else {
  missing.sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));
  console.log('缺向量里最新的 8 张:');
  for (const c of missing.slice(0, 8)) {
    const t = new Date(Number(c.createdAt || 0)).toISOString().slice(0, 16).replace('T', ' ');
    console.log('  · ' + t + '  ' + String(c.title || '').slice(0, 36));
  }
  console.log('');
  console.log('补齐命令: node scripts/build-embeddings.mjs');
  console.log('（增量模式，只会补缺的，不会重算已有的）');
}

// 判定：缺口 >5% 视为不健康
const pct = (missing.length / all.length) * 100;
process.exitCode = pct > 5 ? 2 : 0;
