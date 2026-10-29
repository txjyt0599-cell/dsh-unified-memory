#!/usr/bin/env node
/**
 * bench-retrieval-latency.mjs —— 检索延迟基准（区分算法慢 vs 环境慢）
 * [2026-10-24 · Round 19 初版 / Round 26 重写]
 *
 * 【Round 26 更正】初版只取「最近 30 次」算中位，得出「中位 4.7 秒」——
 *   那批刚好是**长尾样本**。全量 455 次实测：
 *     p50=178ms  p75=1640ms  p90=4479ms
 *     61.8% 在 500ms 内，20.2% 超过 3 秒
 *   ⇒ 是**双峰分布**，不是"一直很慢"。
 *   按小时统计更明显：00-12 时中位 1.3~1.5 秒，12-24 时中位 121~136ms（差 10 倍）
 *   ⇒ 强烈指向**机器负载**（那个时段有别的重活在跑），不是代码问题。
 *
 * 教训：**统计口径决定结论**。看最近几条会得出"一直很慢"，看全量才知道是双峰。
 */
import { readFileSync, existsSync } from 'node:fs';
import { createRetriever } from '../lib/retrieval/retriever.js';
import { dataPath } from '../lib/paths.js';

const WAKE = dataPath('logs/wake.log');
const QS = ['完成记忆改造', '显存到底多少G', '我们刚才在做什么', '示例设备A再生怎么操作', '记忆注入为什么会重复'];

function pct(list, p) {
  if (!list.length) return 0;
  const s = list.slice().sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))];
}
function readWake() {
  if (!existsSync(WAKE)) return [];
  return readFileSync(WAKE, 'utf8').split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

console.log('══ ① 本地纯净环境基准（算法下限）══');
const ret = createRetriever({ l0Enabled: true, l0RecentDays: 30 }, null);
const t0 = Date.now();
await ret.warmup();
console.log('  warmup: ' + (Date.now() - t0) + ' ms');
const local = [];
for (const q of QS) {
  const t = Date.now();
  await ret.search(q, {});
  local.push(Date.now() - t);
}
local.sort((a, b) => a - b);
const lMed = local[Math.floor(local.length / 2)];
console.log('  查询延迟: ' + local.join(', ') + ' ms');
console.log('  中位: ' + lMed + ' ms');

console.log('');
console.log('══ ② 生产全量分位数（不是只看最近几条）══');
const arr = readWake();
const prod = arr.filter((o) => o.level === 'prefetch' && Number.isFinite(o.ms)).map((o) => o.ms);
if (!prod.length) {
  console.log('  （日志里没有 prefetch 记录）');
} else {
  console.log('  样本: ' + prod.length + ' 次');
  for (const p of [0.5, 0.75, 0.9, 0.95, 0.99]) {
    console.log('    p' + (p * 100) + ' = ' + pct(prod, p) + ' ms');
  }
  const slow = prod.filter((x) => x > 3000).length;
  const fast = prod.filter((x) => x < 500).length;
  console.log('    <500ms: ' + fast + '/' + prod.length + ' (' + ((fast / prod.length) * 100).toFixed(1) + '%)');
  console.log('    >3s   : ' + slow + '/' + prod.length + ' (' + ((slow / prod.length) * 100).toFixed(1) + '%)');
  const bimodal = fast / prod.length > 0.4 && slow / prod.length > 0.1;
  console.log('    形态: ' + (bimodal ? '**双峰**（快的很快、慢的很慢）⇒ 环境周期性影响' : '单峰'));
}

console.log('');
console.log('══ ③ 按时段看（找环境规律）══');
const pf = arr.filter((o) => o.level === 'prefetch' && o.ms && o.t);
const buckets = new Map();
for (const o of pf) {
  const h = Number(o.t.slice(11, 13));
  const b = h < 6 ? '00-06' : h < 12 ? '06-12' : h < 18 ? '12-18' : '18-24';
  if (!buckets.has(b)) buckets.set(b, []);
  buckets.get(b).push(o.ms);
}
for (const [b, list] of [...buckets.entries()].sort()) {
  console.log('  ' + b + '  n=' + String(list.length).padStart(3) + '  中位=' + String(pct(list, 0.5)).padStart(5) + 'ms');
}

console.log('');
console.log('══ ④ 判定 ══');
const prodMed = pct(prod, 0.5);
console.log('  本地 ' + lMed + ' ms  vs  生产 p50 ' + prodMed + ' ms');
const ratio = prodMed / Math.max(1, lMed);
console.log('  倍率 ' + ratio.toFixed(1) + 'x');
if (ratio > 10) {
  console.log('  ⇒ **环境问题**：算法本身很快，去查机器负载/IO，别改检索代码');
} else if (ratio > 3) {
  console.log('  ⇒ 部分环境开销 + 部分冷路径（首次检索要建索引）');
} else {
  console.log('  ⇒ 算法与生产接近，正常');
}
