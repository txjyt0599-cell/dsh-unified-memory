#!/usr/bin/env node
/**
 * bench-production-warmup.mjs —— 从生产探针日志里统计真实 warmup 耗时（只读）
 * [2026-10-31 by Assistant]
 *
 * 为什么这个比"复刻配置跑一遍"更可信：
 *   probe/section-register.jsonl 里 phase=retrieval-health 的 warm.ms
 *   是**插件自己在线记录的**，来自真实 DSH 进程、真实配置、真实数据。
 *   复刻配置总会有偏差（我第一版就漏了 L0，差了 630ms）。
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.argv[2] || 'C:/Users/Administrator/.dsh/phoebe-memory/probe';
const files = ['section-register.jsonl', 'section-register.jsonl.1']
  .map(f => join(ROOT, f)).filter(existsSync);

const recs = [];
for (const f of files) {
  let raw = '';
  try { raw = readFileSync(f, 'utf8'); } catch { continue; }
  for (const line of raw.split('\n')) {
    if (!line || line.indexOf('retrieval-health') < 0) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.phase !== 'retrieval-health' || !o.warm || !Number.isFinite(o.warm.ms)) continue;
    recs.push({ at: o.at, ms: o.warm.ms, src: o.src || '?', l0files: o.l0 ? o.l0.files : null, l0rounds: o.l0 ? o.l0.rounds : null });
  }
}
recs.sort((a, b) => a.at < b.at ? -1 : 1);
const q = (arr, p) => { const s = [...arr].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };
const ms = recs.map(r => r.ms);

console.log('样本数:', recs.length, ' 时间范围:', recs[0] && recs[0].at, '→', recs[recs.length - 1] && recs[recs.length - 1].at);
if (ms.length) {
  console.log('min:', Math.min(...ms).toFixed(0), ' p50:', q(ms, 0.5).toFixed(0), ' p90:', q(ms, 0.9).toFixed(0), ' max:', Math.max(...ms).toFixed(0));
  console.log('均值:', (ms.reduce((a, b) => a + b, 0) / ms.length).toFixed(0), 'ms');
}
console.log('');
console.log('最近 15 条:');
for (const r of recs.slice(-15)) {
  console.log('  ' + r.at.replace('T', ' ').slice(0, 19) + '  warm=' + String(Math.round(r.ms)).padStart(5) + 'ms  src=' + r.src.padEnd(6) + ' l0.files=' + r.l0files + ' rounds=' + r.l0rounds);
}
// 按 src 分组
const bySrc = {};
for (const r of recs) { (bySrc[r.src] = bySrc[r.src] || []).push(r.ms); }
console.log('');
for (const [k, v] of Object.entries(bySrc)) {
  console.log('  src=' + k.padEnd(8) + ' n=' + String(v.length).padStart(4) + '  p50=' + q(v, 0.5).toFixed(0) + 'ms  max=' + Math.max(...v).toFixed(0) + 'ms');
}
