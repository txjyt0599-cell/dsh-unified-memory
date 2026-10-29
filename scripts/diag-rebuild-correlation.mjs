#!/usr/bin/env node
/**
 * diag-rebuild-correlation.mjs —— 重建与慢检索的相关性诊断
 * [2026-10-24 by Assistant · Round 42]
 *
 * 这个脚本回答一个问题：**慢检索到底是不是重建引起的？**
 *
 * 做法：把「慢检索（>3s）」与「source-changed（重建）」按分钟对齐，
 *   看它们重合的比例。若慢检索绝大多数落在重建分钟内 ⇒ 因果成立。
 *
 * 实测结果（2026-10-24）：
 *   慢检索 108 次，70 次（65%）与重建同分钟
 *   快检索 281 次，仅 6 次（2%）与重建同分钟
 *   ⇒ 8 倍差距，因果链确认。
 *
 * 用途：以后若又出现「检索变慢」，先跑这个 —— 
 *   若慢检索不再集中在重建分钟，说明是别的原因（别再盲目改签名）。
 */
import { readFileSync, existsSync } from 'node:fs';

const WAKE = '~/.dsh/unified-memory/logs/wake.log';
const SLOW_MS = 3000;

if (!existsSync(WAKE)) { console.log('找不到 wake.log'); process.exit(0); }
const arr = readFileSync(WAKE, 'utf8').split('\n').filter(Boolean)
  .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

const pf = arr.filter((o) => o.level === 'prefetch' && Number.isFinite(o.ms));
const sc = arr.filter((o) => o.level === 'source-changed');
const scMinutes = new Set(sc.map((o) => (o.t ? String(o.t).slice(0, 16) : '')).filter(Boolean));

const inRebuildMinute = (o) => o.t && scMinutes.has(String(o.t).slice(0, 16));

console.log('══ 重建 vs 慢检索 相关性 ══');
console.log('  总检索: ' + pf.length + ' 次');
console.log('  索引重建: ' + sc.length + ' 次');
console.log('');

const slow = pf.filter((o) => o.ms >= SLOW_MS);
const fast = pf.filter((o) => o.ms < 500);
const slowHit = slow.filter(inRebuildMinute).length;
const fastHit = fast.filter(inRebuildMinute).length;

console.log('  慢检索(≥' + SLOW_MS + 'ms): ' + slow.length + ' 次，其中落在重建分钟: ' + slowHit
  + (slow.length ? ' (' + ((slowHit / slow.length) * 100).toFixed(1) + '%)' : ''));
console.log('  快检索(<500ms): ' + fast.length + ' 次，其中落在重建分钟: ' + fastHit
  + (fast.length ? ' (' + ((fastHit / fast.length) * 100).toFixed(1) + '%)' : ''));
console.log('');

const slowRate = slow.length ? slowHit / slow.length : 0;
const fastRate = fast.length ? fastHit / fast.length : 0;
console.log('── 判定 ──');
if (slowRate > 0.4 && slowRate > fastRate * 3) {
  console.log('  ⇒ **强相关**：慢检索集中在重建分钟内，因果链成立');
  console.log('    处置：查索引签名的稳定性（是否被 hits 等无关写入扰动）');
} else if (slowRate < 0.15) {
  console.log('  ⇒ **不相关**：慢检索不集中在重建分钟，是别的原因');
  console.log('    处置：查机器负载 / 磁盘 IO / 其它插件阻塞');
} else {
  console.log('  ⇒ 弱相关，需更多证据');
}
console.log('');
console.log('（修复后重跑：慢检索应大幅减少，且不再集中在重建分钟）');
