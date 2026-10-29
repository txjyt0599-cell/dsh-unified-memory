#!/usr/bin/env node
/**
 * e2e-full-chain.mjs —— 记忆完整链路总演练（真数据、真流程）
 * [2026-10-24 by Assistant · Round 37]
 *
 * 前 36 轮都是**分项**验证：四股力、门控、采纳、冷宫、标题、实体…
 * 但没有一条测试把「真实的 9533 张卡 + 真实查询」串成完整链路跑一遍。
 *
 * 这个脚本模拟一个真实回合的完整生命周期：
 *   ① 用户提问 → 检索
 *   ② 门控判定（库外应拦、库内应过）
 *   ③ 四股力重排（基石不该被时间压下去）
 *   ④ 分层装配（越近越详细）
 *   ⑤ 采纳核验（回复真用到才加分）
 *   ⑥ 加分后 hits 真的写了（按来源分流）
 *   ⑦ 冷宫归档判定（重要/用过的不能被搬走）
 *
 * 全程用**真数据 + 临时文件**，不污染生产。
 */
import { writeFileSync, readFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRetriever } from '../lib/retrieval/retriever.js';
import { createWorkingMemory } from '../lib/working-memory/index.js';
import { readCards, readTdaiRecords, readOwnIngest } from '../lib/hypergraph/source.js';
import { applyFourForces } from '../lib/scoring/four-forces.js';
import { isAdopted, commitAdoptions } from '../lib/scoring/adoption.js';
import { shouldArchive } from '../lib/scoring/cold-archive.mjs';

const D = 86400000;
const now = Date.now();
let fail = 0;
const step = (n) => console.log('\n── ' + n + ' ──');
const check = (n, ok, d) => { console.log((ok ? '  ✅ ' : '  ❌ ') + n + (d ? '   ' + d : '')); if (!ok) fail++; };

// ── 准备：真实卡库 ──
const map = new Map();
for (const c of readCards().alive) map.set(String(c.id), c);
for (const c of (readTdaiRecords().cards || [])) if (!map.has(String(c.id))) map.set(String(c.id), c);
for (const c of (readOwnIngest().cards || [])) if (!map.has(String(c.id))) map.set(String(c.id), c);
const ret = createRetriever({ l0Enabled: true, l0RecentDays: 30 }, null);
await ret.warmup();
const wm = createWorkingMemory({
  enabled: true, dir: '~/.dsh/unified-memory/working', l0Detail: true,
  cards: {
    header: (id) => { const c = map.get(String(id)); if (!c) return null; return { id, title: c.title || '', summary: c.summary || '', layer: c.layer || 'global', createdAt: Number(c.createdAt) || 0 }; },
    get: (id) => map.get(String(id)) || null,
    content: (id) => (map.get(String(id)) || {}).content || null,
  },
});
console.log('[真实卡库] ' + map.size + ' 张');

// ══ ① 库内查询：全链路走通 ══
step('① 库内查询（显卡显存）');
const q = '我显卡显存多大';
const r1 = await ret.search(q, {});
check('检索有结果', (r1.hits || []).length > 0, (r1.hits || []).length + ' 条');
const text1 = (r1.hits || []).slice(0, 8).map((h) => String(h.title || '') + String(h.summary || '')).join(' ');
check('能给出答案要素（16G/9060）', /16G|16GB|9060/i.test(text1));

// ══ ② 库外查询：必须拦住 ══
step('② 库外查询（红烧肉）');
const r2 = await ret.search('红烧肉的糖色怎么炒', {});
check('库外话题返回空', (r2.hits || []).length === 0, (r2.hits || []).length + ' 条');

// ══ ③ 四股力：基石 vs 流水 ══
step('③ 四股力（基石不该被时间压下去）');
const axiom = map.get([...map.keys()].find((k) => map.get(k).is_axiom === true));
const flow = { importance: 0.25, is_axiom: false, createdAt: now - 400 * D, hits: 0 };
if (axiom) {
  const old = Object.assign({}, axiom, { createdAt: now - 400 * D });
  const sA = applyFourForces(old, 0.8, now).score;
  const sF = applyFourForces(flow, 0.8, now).score;
  check('同等相关度下 老基石 > 老流水', sA > sF, sA.toFixed(3) + ' vs ' + sF.toFixed(3));
} else {
  check('找到基石卡样本', false, '没找到 is_axiom 卡');
}

// ══ ④ 分层装配：越近越详细 ══
step('④ 分层装配（越近越详细）');
const adm = wm.assemble({ sessionId: 'fullchain', queryText: q, queryTokens: 200, turn: 1 }, r1.hits || []);
const cards = adm.cards || [];
const full = cards.filter((c) => c.tier === 'full');
const withAge = cards.filter((c) => c.ageDays != null && Number.isFinite(c.ageDays));
check('装配出卡片', cards.length > 0, cards.length + ' 张');
check('全部带时间戳', withAge.length === cards.length, withAge.length + '/' + cards.length);
check('出现 full 档（最近的那张拿最多字）', full.length > 0, full.length + ' 张');

// ══ ⑤ 采纳核验 ══
step('⑤ 采纳核验（真用到才加分）');
const target = map.get(String((r1.hits || [])[0].id));
if (target) {
  const replyUse = '这台 9060XT 的显存是 16GB，不是 4G。';
  const replyNo = '今天天气不错，我们去散步吧。';
  const a1 = isAdopted(target, replyUse);
  const a2 = isAdopted(target, replyNo);
  check('回复真用到 → 判采纳', a1.used === true, a1.why);
  check('回复无关 → 不采纳（防马太死锁）', a2.used === false, a2.why);

  // ══ ⑥ 加分写盘 ══
  step('⑥ 加分写盘（临时文件，不碰生产）');
  const dir = mkdtempSync(join(tmpdir(), 'fullchain-'));
  const f = join(dir, 'cards.jsonl');
  const testCard = Object.assign({}, target, { hits: 0 });
  writeFileSync(f, JSON.stringify(testCard) + '\n', 'utf8');
  const res = commitAdoptions({ cards: [testCard], reply: replyUse, file: f });
  const after = JSON.parse(readFileSync(f, 'utf8').split('\n').filter(Boolean).pop());
  check('bumped=1', res.bumped === 1);
  check('hits 真的 +1', after.hits === 1, 'hits=' + after.hits);
  // 连续两次必须变成 2（防 RMW 竞态）
  const res2 = commitAdoptions({ cards: [testCard], reply: replyUse, file: f });
  const after2 = JSON.parse(readFileSync(f, 'utf8').split('\n').filter(Boolean).pop());
  check('连续两次 → hits=2（无竞态）', after2.hits === 2, 'hits=' + after2.hits);
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
}

// ══ ⑦ 冷宫判定 ══
step('⑦ 冷宫判定（重要/用过的不能被搬走）');
const usedCard = Object.assign({}, target || {}, { hits: 5, createdAt: now - 200 * D, importance: 0.9, is_axiom: true });
const d1 = shouldArchive(usedCard, now);
check('基石+用过的 不搬', d1.archive === false, JSON.stringify(d1).slice(0, 80));
const oldFlow = { id: 'x', importance: 0.2, is_axiom: false, createdAt: now - 200 * D, hits: 0 };
const d2 = shouldArchive(oldFlow, now);
check('老的流水卡 该搬', d2.archive === true, JSON.stringify(d2).slice(0, 80));

console.log('\n' + (fail === 0 ? '✅ 完整链路 12 步全部走通' : '❌ ' + fail + ' 项失败'));
process.exit(fail === 0 ? 0 : 1);
