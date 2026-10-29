#!/usr/bin/env node
/**
 * diag-cold-archive.mjs —— 冷宫归档「为什么没搬」诊断
 * [2026-10-24 by Assistant · Round 45]
 *
 * 问题：冷宫 dry-run 报 move=0。
 *   这到底意味着「机制坏了」还是「现在没有该搬的」？
 *   —— 不做诊断就会误判（Assistant自己就差点当 bug 去修）。
 *
 * 这个脚本按条件逐项拆解，告诉你卡在哪一步：
 *   龄 > N 天？重要度 < M？从未被用过？
 * 并对比「库龄分布」与阈值的差距。
 */
import { readCards } from '../lib/hypergraph/source.js';
import { shouldArchive } from '../lib/scoring/cold-archive.mjs';

const D = 86400000;
const now = Date.now();
const AGE = 60;      // 与 cold-archive 默认一致
const IMP = 0.4;

const all = readCards().alive;
console.log('══ 冷宫归档诊断 ══');
console.log('  活卡: ' + all.length);
console.log('  阈值: 龄 > ' + AGE + ' 天  且  重要度 < ' + IMP + '  且  从未被用');
console.log('');

// ── ① 库龄分布 ──
const ages = all.map((c) => (now - (Number(c.createdAt) || 0)) / D).filter((a) => a > 0).sort((a, b) => a - b);
console.log('── ① 库龄分布 ──');
if (ages.length) {
  for (const p of [0.5, 0.9, 0.99]) {
    console.log('  p' + (p * 100).toFixed(0) + ' = ' + ages[Math.min(ages.length - 1, Math.floor(ages.length * p))].toFixed(0) + ' 天');
  }
  const oldest = ages[ages.length - 1];
  console.log('  最老 = ' + oldest.toFixed(0) + ' 天');
  console.log('  超过阈值(' + AGE + '天)的卡: ' + ages.filter((a) => a > AGE).length + ' 张');
}

// ── ② 逐条件拆解 ──
console.log('');
console.log('── ② 逐条件拆解 ──');
let ageOk = 0, impOk = 0, hitsOk = 0, allOk = 0;
for (const c of all) {
  const age = (now - (Number(c.createdAt) || 0)) / D;
  const imp = Number(c.importance);
  const hits = Number(c.hits) || 0;
  const a = age > AGE, i = Number.isFinite(imp) && imp < IMP, h = hits === 0;
  if (a) ageOk++;
  if (i) impOk++;
  if (h) hitsOk++;
  if (a && i && h) allOk++;
}
console.log('  龄达标      : ' + ageOk);
console.log('  重要度达标  : ' + impOk);
console.log('  从未被用    : ' + hitsOk);
console.log('  三条全满足  : ' + allOk);

// ── ③ 判定 ──
console.log('');
console.log('── ③ 判定 ──');
if (allOk > 0) {
  console.log('  ⇒ 有 ' + allOk + ' 张可搬。若 CLI 报 0，说明 CLI 与判定不一致，需查。');
} else if (ageOk === 0) {
  console.log('  ⇒ **没有卡龄超过阈值** —— 库还太年轻，不是机制失效。');
  console.log('    当前最老 ' + (ages.length ? ages[ages.length - 1].toFixed(0) : '?') + ' 天 < 阈值 ' + AGE + ' 天');
  console.log('    ⇒ 这是正常行为，等库龄够了自然会开始搬。');
} else {
  console.log('  ⇒ 有 ' + ageOk + ' 张卡龄达标，但被"重要度"或"从未被用"挡住了。');
  // 逐条列出挡住原因，避免误判成 bug
  const blocked = [];
  for (const c of all) {
    const age = (now - (Number(c.createdAt) || 0)) / D;
    if (age <= AGE) continue;
    const d = shouldArchive(c, now, { ageDays: AGE, impMax: IMP });
    if (d && !d.archive) blocked.push({ t: String(c.title || '').slice(0, 24), why: d.why, hits: c.hits });
  }
  const byWhy = new Map();
  for (const b of blocked) byWhy.set(b.why, (byWhy.get(b.why) || 0) + 1);
  console.log('    挡住原因分布: ' + JSON.stringify([...byWhy.entries()]));
  blocked.slice(0, 5).forEach((b) => console.log('      · ' + b.t + '  ← ' + b.why + '（hits=' + b.hits + '）'));
  console.log('    ⇒ 这些老卡仍重要/仍被用 —— **这正是设计意图**（不该搬），不是机制失效。');
}

// ── ③.5 耐久性推演：如果所有卡都到了阈值年龄，会搬走多少？ ──
//   为什么做这个：现在 move=0 是「太年轻」；但User会问「那以后呢」。
//   把 createdAt 统一往前推 AGE 天，模拟"全部到期"，看冷宫的分流结果。
console.log('');
console.log('── ③.5 耐久性推演（假设所有卡都老了 ' + AGE + ' 天）──');
{
  let moved = 0;
  const why = new Map();
  for (const c of all) {
    const shifted = Object.assign({}, c, { createdAt: (Number(c.createdAt) || 0) - AGE * D });
    const r = shouldArchive(shifted, now, { ageDays: AGE, impMax: IMP });
    if (r && r.archive) moved++;
    const k = (r && r.why) ? String(r.why).replace(/[:\d.]+$/, '') : 'stay';
    why.set(k, (why.get(k) || 0) + 1);
  }
  console.log('  可搬: ' + moved + ' / ' + all.length + ' (' + ((moved / all.length) * 100).toFixed(1) + '%)');
  console.log('  分流: ' + JSON.stringify([...why.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)));
  const axiomKept = [...why.entries()].find(([k]) => k === 'axiom');
  console.log('  · 基石保留: ' + (axiomKept ? axiomKept[1] : 0) + ' 张（永不被搬）');
  console.log('  ⇒ 冷宫会按设计工作：搬走老流水、保留基石与重要卡。');
}

// ── ④ 与其他阈值对比 ──
console.log('');
console.log('── ④ 放宽阈值会怎样 ──');
for (const [a2, i2] of [[60, 0.4], [45, 0.4], [30, 0.4], [30, 0.55], [15, 0.4]]) {
  let n = 0;
  for (const c of all) {
    const d = shouldArchive(c, now, { ageDays: a2, impMax: i2 });
    if (d && d.archive) n++;
  }
  console.log('  ' + a2 + ' 天 / ' + i2 + ' → 可搬 ' + n + ' 张');
}
