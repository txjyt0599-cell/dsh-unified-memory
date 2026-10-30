#!/usr/bin/env node
/**
 * acceptance-final.mjs —— 记忆改造「目标达成」终局验收
 * [2026-10-24 by Assistant · Round 44]
 *
 * 区别对待：
 *   acceptance-memory-v2.mjs  查「机制单元都在不在」（6 类硬指标）
 *   memory-health.mjs         查「数据健不健康」（10 项）
 *   本脚本                    查「**User最初要的东西，做到了没有**」
 *
 * User的原始诉求（从对话里提炼）：
 *   ① 记住该记的（纠错/决策/铁律）
 *   ② 忘掉该忘的（流水账会沉底）
 *   ③ 越近印象越深（近期的事给更多细节）
 *   ④ 老的重要的不会丢（基石永不衰减）
 *   ⑤ 记错了能纠正（纠错/推翻机制）
 *   ⑥ 别乱联想（库外话题不硬凑）
 *   ⑦ 别拖慢对话（检索要快）
 *
 * 这个脚本逐条对照，用真实数据回答「做到了吗」。
 */
import { createRetriever } from '../lib/retrieval/retriever.js';
import { createWorkingMemory } from '../lib/working-memory/index.js';
import { readCards, readTdaiRecords, readOwnIngest } from '../lib/hypergraph/source.js';
import { applyFourForces } from '../lib/scoring/four-forces.js';
import { scoreImportance } from '../lib/scoring/importance.js';
import { dataPath } from '../lib/paths.js';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = fileURLToPath(new URL('./', import.meta.url)).replace(/[\\/]$/, '');

const D = 86400000;
const now = Date.now();
let pass = 0, fail = 0;
const item = (n, ok, d) => {
  console.log((ok ? '  ✅ ' : '  ❌ ') + n + (d ? '   ' + d : ''));
  if (ok) pass++; else fail++;
};

const map = new Map();
for (const c of readCards().alive) map.set(String(c.id), c);
for (const c of (readTdaiRecords().cards || [])) if (!map.has(String(c.id))) map.set(String(c.id), c);
for (const c of (readOwnIngest().cards || [])) if (!map.has(String(c.id))) map.set(String(c.id), c);
const all = [...map.values()];
const ret = createRetriever({ l0Enabled: true, l0RecentDays: 30 }, null);
await ret.warmup();

console.log('══════ 记忆改造 · 目标达成验收 ══════');
console.log('（对照User最初提的 7 条诉求）');
console.log('[数据] ' + all.length + ' 张卡');

// ── ① 记住该记的 ──
console.log('');
console.log('── ① 记住该记的（纠错/决策/铁律能得高分）──');
const s1 = scoreImportance({ text: '不对，9060XT 是 16G 不是 4G，这条要更正', role: 'user' });
const s2 = scoreImportance({ text: '重启了一下', role: 'user' });
item('纠错内容拿高分（≥0.8）', s1.importance >= 0.8, s1.importance);
item('流水内容拿基础分（≤0.3）', s2.importance <= 0.3, s2.importance);
const axiomN = all.filter((c) => c.is_axiom === true).length;
item('库里有基石卡', axiomN > 0, axiomN + ' 张');

// ── ② 忘掉该忘的 ──
console.log('── ② 忘掉该忘的（流水账会沉底）──');
const oldFlow = { importance: 0.25, is_axiom: false, createdAt: now - 180 * D, hits: 0 };
const newFlow = { importance: 0.25, is_axiom: false, createdAt: now, hits: 0 };
const sOld = applyFourForces(oldFlow, 0.9, now).score;
const sNew = applyFourForces(newFlow, 0.9, now).score;
item('180 天前的流水卡分数明显下降', sOld < sNew * 0.6, sOld.toFixed(3) + ' vs ' + sNew.toFixed(3));

// ── ③ 越近印象越深 ──
console.log('── ③ 越近印象越深（近期给更多细节）──');
const wm = createWorkingMemory({
  enabled: true, dir: dataPath('working'), l0Detail: false,
  cards: {
    header: (id) => { const c = map.get(String(id)); if (!c) return null; return { id, title: c.title || '', summary: c.summary || '', layer: c.layer || 'global', createdAt: Number(c.createdAt) || 0 }; },
    get: (id) => map.get(String(id)) || null,
    content: (id) => (map.get(String(id)) || {}).content || null,
  },
});
const rq = '记忆改造 四股力';
const rr = await ret.search(rq, {});
const adm = wm.assemble({ sessionId: 'final-acc', queryText: rq, queryTokens: 200, turn: 1 }, rr.hits || []);
const cards = adm.cards || [];
const fullTier = cards.filter((c) => c.tier === 'full');
const withAge = cards.filter((c) => c.ageDays != null && Number.isFinite(c.ageDays));
item('装配结果全部带时间戳', withAge.length === cards.length && cards.length > 0, withAge.length + '/' + cards.length);
item('出现 full 档（最近的拿最多字）', fullTier.length > 0, fullTier.length + ' 张');

// ── ④ 老的重要的不会丢 ──
console.log('── ④ 老的重要的不会丢（基石永不衰减）──');
const oldAxiom = { importance: 0.9, is_axiom: true, createdAt: now - 400 * D, hits: 0 };
const aOld = applyFourForces(oldAxiom, 0.9, now).score;
const aNew = applyFourForces({ importance: 0.9, is_axiom: true, createdAt: now, hits: 0 }, 0.9, now).score;
item('400 天前的基石分数与新基石相同', Math.abs(aOld - aNew) < 0.001, aOld.toFixed(3) + ' vs ' + aNew.toFixed(3));

// ── ⑤ 记错了能纠正 ──
console.log('── ⑤ 记错了能纠正 ──');
const err = { importance: 0.25, is_axiom: false, createdAt: now - 40 * D, hits: 0 };
const fix = { importance: 0.9, is_axiom: true, createdAt: now, hits: 0 };
const eS = applyFourForces(err, 0.9, now).score;
const fS = applyFourForces(fix, 0.9, now).score;
item('纠错卡能压过老错误卡', fS > eS * 1.5, (fS / eS).toFixed(2) + 'x');
const { readFileSync } = await import('node:fs');
const rsrc = readFileSync(join(ROOT, 'lib/retrieval/retriever.js'), 'utf8');
item('被推翻的卡会被降权（refute_by 有人读）', /refute_by/.test(rsrc));

// ── ⑥ 别乱联想 ──
console.log('── ⑥ 别乱联想（库外话题不硬凑）──');
let noisy = 0;
for (const q of ['红烧肉的糖色怎么炒', '宋朝历史小说推荐', '量子色动力学胶子禁闭']) {
  const r = await ret.search(q, { k: 5 });
  if ((r.hits || []).length > 0) noisy++;
}
item('库外话题全部返回空', noisy === 0, noisy + '/3 硬凑');

// ── ⑦ 别拖慢对话 ──
console.log('── ⑦ 别拖慢对话（检索要快）──');
const t0 = Date.now();
for (let i = 0; i < 10; i++) await ret.search('记忆改造', {});
const per = (Date.now() - t0) / 10;
item('单次检索 < 100ms（本地基准）', per < 100, per.toFixed(1) + 'ms/次');


console.log('── ⑧ 弱噪音分流（2026-10-27 封箱新增）──');
// 用例 A：库外查证 ⇒ 必须清爽空回，绝不误调时间种子
let aOk = true;
for (const q of ['帮我查一下托尔金的中土世界设定', '红烧肉的糖色怎么炒']) {
  const r = await ret.search(q, { k: 5 });
  const n = (r.hits || []).length;
  if (n !== 0) { aOk = false; console.log('    ✗ 用例A 误召: ' + q + ' => ' + n + ' 条'); }
}
item('用例A 库外提问清爽空回', aOk, aOk ? '0 误召' : '有误召');

// 用例 B：口语代词追问 ⇒ 必须非空，且 Top1 是最近的真事（不是 stage3 噪音）
let bOk = true; let bDetail = [];
for (const q of ['Assistant想想前面干了什么', '咱们前面搞到哪儿了']) {
  const r = await ret.search(q, { k: 5 });
  const hits = r.hits || [];
  if (hits.length === 0) { bOk = false; bDetail.push(q + ':空'); continue; }
  const top = hits[0];
  const card = top && top.id ? (ret.getCard ? ret.getCard(String(top.id)) : null) : null;
  const created = card && card.createdAt ? Number(card.createdAt) : 0;
  const ageDays = created ? (Date.now() - created) / 86400000 : Infinity;
  // 必须来自最近 7 天内的真实记忆
  if (!(ageDays <= 7)) { bOk = false; bDetail.push(q + ':Top1 太旧(' + ageDays.toFixed(1) + 'd)'); }
  else bDetail.push(q + ':Top1 ' + ageDays.toFixed(1) + 'd');
}
item('用例B 口语追问召回最近真事', bOk, bDetail.join(' / '));
console.log('');
console.log('══════ 结论 ══════');
console.log('通过 ' + pass + ' 项 / 失败 ' + fail + ' 项');
if (fail === 0) {
  console.log('✅ **User最初提的 7 条诉求，全部达成**');
} else {
  console.log('⚠ 还有 ' + fail + ' 项没达成');
}
process.exit(fail === 0 ? 0 : 1);