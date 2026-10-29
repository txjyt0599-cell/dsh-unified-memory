#!/usr/bin/env node
/**
 * e2e-lifecycle.mjs —— 完整生命周期演练（写入→检索→注入→采纳→hits→排序）
 * [2026-10-24 by Assistant · Round 15]
 *
 * 之前的测试都是"分段"验证的：写入测一次、检索测一次、采纳测一次。
 * 但真正的风险在**接缝处**（这个项目所有大坑都在接缝）。
 * 这个脚本用临时沙箱跑完整条链，模拟一个真人回合。
 */
import { writeFileSync, readFileSync, existsSync, mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scoreImportance } from '../lib/scoring/importance.js';
import { applyFourForces } from '../lib/scoring/four-forces.js';
import { isAdopted, commitAdoptions } from '../lib/scoring/adoption.js';
import { cleanTitle } from '../lib/ingest/title-clean.js';

const D = 86400000;
const now = Date.now();
const dir = mkdtempSync(join(tmpdir(), 'life-'));
const file = join(dir, 'engrams.jsonl');

let fail = 0;
const step = (n) => console.log('\n── ' + n + ' ──');
const check = (n, ok, d) => { console.log((ok ? '  ✅ ' : '  ❌ ') + n + (d ? '   ' + d : '')); if (!ok) fail++; };

// ═══ 模拟一轮对话：User说了一句纠错 ═══
const userTurn = '不是 4G，9060XT 真实显存是 16G，WMI 32 位会溢出报 4095MB';
step('① 写入：从对话里产卡');
const imp = scoreImportance({ text: userTurn, role: 'user' });
const card = {
  id: 'life-1',
  title: cleanTitle('9060XT 显存误报 4G', userTurn),
  summary: 'WMI 32 位整数溢出会把 16GB 报成 4095MB',
  content: '9060XT 真实显存 16GB，Windows WMI AdapterRAM 是 32 位，会溢出报 4095MB',
  entities: ['9060xt', '显存', 'wmi'],
  importance: imp.importance,
  is_axiom: imp.is_axiom,
  createdAt: now,
  hits: 0,
};
writeFileSync(file, JSON.stringify(card) + '\n', 'utf8');
console.log('  卡: ' + card.title);
console.log('  importance=' + card.importance + '  is_axiom=' + card.is_axiom + '  信号=' + JSON.stringify(imp.signals));
check('纠错内容拿到高分', card.importance >= 0.8, String(card.importance));
check('硬件铁律自动成为基石', card.is_axiom === true);
check('标题被清洗过（无 HTML 碎片）', !/[<>]/.test(card.title));

// ═══ ② 检索：一个相关查询 ═══
step('② 检索：相关 vs 无关');
const baseRel = 0.82;
const relHit = applyFourForces(card, baseRel, now);
const irrelHit = applyFourForces(card, 0.004, now);
console.log('  相关查询 (R=0.82) → 分 ' + relHit.score.toFixed(4) + '  gated=' + relHit.gated);
console.log('  无关查询 (R=0.004) → 分 ' + irrelHit.score.toFixed(4) + '  gated=' + irrelHit.gated);
check('相关查询拿高分', relHit.score > 0.7);
check('无关查询杠杆锁死（不虚高）', irrelHit.gated === false && irrelHit.score <= 0.005);

// ═══ ③ 时间推进：30 天后还值多少 ═══
step('③ 时间推进 30 天');
const later = applyFourForces(card, baseRel, now + 30 * D);
console.log('  30 天后 → ' + later.score.toFixed(4) + '（基石应完全不变）');
check('基石卡不衰减', Math.abs(later.score - relHit.score) < 1e-9,
  relHit.score.toFixed(4) + ' → ' + later.score.toFixed(4));

// ═══ ④ 采纳：回复里真用到了 ═══
step('④ 采纳核验');
const reply = '这台是 9060XT，显存实际 16GB。Windows 的 WMI AdapterRAM 是 32 位，会溢出报成 4095MB，别信那个数。';
const adopted = isAdopted(card, reply);
console.log('  判定: ' + JSON.stringify(adopted));
check('真用到 → 判采纳', adopted.used === true);

const res = commitAdoptions({ cards: [card], reply, file, nowTs: now });
console.log('  落盘: bumped=' + res.bumped);
const after = JSON.parse(readFileSync(file, 'utf8').split('\n').filter(Boolean).pop());
console.log('  hits: ' + card.hits + ' → ' + after.hits);
check('hits 真的 +1 且落盘', after.hits === 1);
check('lastHitAt 被记录', !!after.lastHitAt);

// ═══ ⑤ 强度生效：hits 涨了排序有没有变 ═══
step('⑤ 强度对排序的影响（同等相关度）');
// 用"老流水卡"来测 —— 新卡没被罚过，强度无从抵扣
const OLD = 200 * D;
const fresh = { id: 'life-2', importance: 0.25, is_axiom: false, createdAt: now - OLD, hits: 0 };
const used = { id: 'life-3', importance: 0.25, is_axiom: false, createdAt: now - OLD, hits: 20 };
const sFresh = applyFourForces(fresh, 0.6, now).score;
const sUsed = applyFourForces(used, 0.6, now).score;
console.log('  老流水卡 hits=0  → ' + sFresh.toFixed(4));
console.log('  老流水卡 hits=20 → ' + sUsed.toFixed(4));
console.log('  提升 ' + ((sUsed / sFresh - 1) * 100).toFixed(1) + '% ← 这就是「用进废退」');
check('常用的老卡更抗遗忘（强度真生效）', sUsed > sFresh * 1.1,
  sFresh.toFixed(4) + ' → ' + sUsed.toFixed(4));
// 新卡不该被强度抬高（上封 R 本身）
const n1 = applyFourForces({ importance: 0.55, is_axiom: false, createdAt: now, hits: 0 }, 0.6, now).score;
const n2 = applyFourForces({ importance: 0.55, is_axiom: false, createdAt: now, hits: 20 }, 0.6, now).score;
check('新卡不会被强度虚抬（最多等于 R）', Math.abs(n2 - n1) < 1e-9 && n2 <= 0.6 + 1e-9,
  n1.toFixed(4) + ' / ' + n2.toFixed(4));

// ═══ ⑥ 陪跑卡不会被误加分 ═══
step('⑥ 陪跑卡保护（防马太死锁）');
const bystander = { id: 'life-4', title: '图片压缩参数', entities: ['webp'], hits: 0, importance: 0.25, createdAt: now };
writeFileSync(file, readFileSync(file, 'utf8') + JSON.stringify(bystander) + '\n', 'utf8');
const res2 = commitAdoptions({ cards: [card, bystander], reply, file, nowTs: now });
const all = readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const lastCard = all.filter((c) => c.id === 'life-1').pop();
const lastBy = all.filter((c) => c.id === 'life-4').pop();
console.log('  主卡 hits=' + lastCard.hits + '  陪跑卡 hits=' + lastBy.hits);
check('主卡继续加分', lastCard.hits === 2, String(lastCard.hits));
check('陪跑卡一分不加', lastBy.hits === 0, String(lastBy.hits));

try { rmSync(dir, { recursive: true, force: true }); } catch {}
console.log('\n' + (fail === 0 ? '✅ 完整生命周期 10 步全通过' : '❌ ' + fail + ' 项失败'));
process.exit(fail === 0 ? 0 : 1);
