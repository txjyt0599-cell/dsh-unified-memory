#!/usr/bin/env node
/**
 * e2e-recency-tier.mjs —— 「越近越详细」端到端回归测试
 * [2026-10-24 by Assistant · goal round 8]
 *
 * 这是User的原始需求之一：
 *   「越近的事情印象越深 / 越详细，越远的只留关键词」
 *
 * 本测试锁三件事：
 *   ① 装配出来的卡**全部带 createdAt**（否则 recency 恒 0，分档失效）
 *   ② 标题不是原始 id（pm:/pmi:/tdai: 前缀 = 渲染时没查到卡）
 *   ③ detailTop 里**必须出现 full 档**（最近的那张拿最多字）
 *
 * 2026-10-24 抓到的真 bug：生产 cardMap 漏了 readOwnIngest ⇒
 *   自产卡检索得到但渲染查不到 ⇒ 时间全丢 ⇒ **从未出现 full 档**。
 */
import { readCards, readTdaiRecords, readOwnIngest } from '../lib/hypergraph/source.js';
import { createRetriever } from '../lib/retrieval/retriever.js';
import { createWorkingMemory } from '../lib/working-memory/index.js';

function buildCardMap(includeOwn) {
  const m = new Map();
  for (const c of readCards().alive) m.set(String(c.id), c);
  try { const td = readTdaiRecords(); for (const c of (td.cards || [])) if (!m.has(c.id)) m.set(c.id, c); } catch {}
  if (includeOwn) {
    try { const own = readOwnIngest(); for (const c of (own.cards || [])) if (!m.has(String(c.id))) m.set(String(c.id), c); } catch {}
  }
  return m;
}

const ret = createRetriever({ l0Enabled: false }, null);
await ret.warmup();

let fail = 0;
const check = (name, ok, detail) => {
  console.log((ok ? '  ✅ ' : '  ❌ ') + name + (detail ? '   ' + detail : ''));
  if (!ok) fail++;
};

const Q = '记忆改造 四股力 打分';
const r = await ret.search(Q, {});
const hits = r.hits || [];
console.log('[输入] 检索命中 ' + hits.length + ' 条');

// ── 用**修复后的**组合方式 ──
const map = buildCardMap(true);
const wm = createWorkingMemory({
  enabled: true,
  dir: '~/.dsh/unified-memory/working',
  cards: {
    header: (id) => { const c = map.get(String(id)); if (!c) return null; return { id, title: c.title || '', summary: c.summary || '', layer: c.layer || 'global', createdAt: Number(c.createdAt) || 0 }; },
    get: (id) => map.get(String(id)) || null,
    content: (id) => (map.get(String(id)) || {}).content || null,
  },
});
const adm = wm.assemble({ sessionId: 'e2e-recency', queryText: Q, queryTokens: 20, turn: 1 }, hits);
const cards = adm.cards || [];
console.log('[装配] ' + cards.length + ' 张');

const withAge = cards.filter((c) => c.ageDays != null && Number.isFinite(c.ageDays));
const idTitled = cards.filter((c) => /^(pm|pmi|tdai):/.test(String(c.title)));
const tiers = cards.map((c) => c.tier);
const fullCards = cards.filter((c) => c.tier === 'full');

check('① 所有装配卡都带时间戳', withAge.length === cards.length, withAge.length + '/' + cards.length);
check('② 没有「标题是原始 id」的卡', idTitled.length === 0, idTitled.length + ' 张');
check('③ 出现 full 档（越近越详细真的生效）', fullCards.length > 0, fullCards.length + ' 张 full');
if (fullCards.length) {
  const fc = fullCards[0];
  console.log('     full 档样例: age=' + (fc.ageDays < 1 ? Math.round(fc.ageDays * 24) + 'h' : Math.round(fc.ageDays) + 'd') + '  ' + String(fc.title || '').slice(0, 30));
}
check('④ full 档是最新的那几张', (function () {
  if (!fullCards.length) return false;
  const maxFullAge = Math.max(...fullCards.map((c) => c.ageDays));
  const minOtherAge = Math.min(...cards.filter((c) => c.tier !== 'full').map((c) => c.ageDays).filter((x) => Number.isFinite(x)));
  return !Number.isFinite(minOtherAge) || maxFullAge <= minOtherAge + 0.01;
})(), 'full 档应比其它卡更新');

// ── 反证：缺 ingest 时必须失败（证明这条测试真的能抓到问题）──
const mapBad = buildCardMap(false);
const wmBad = createWorkingMemory({
  enabled: true, dir: '~/.dsh/unified-memory/working',
  cards: {
    header: (id) => { const c = mapBad.get(String(id)); if (!c) return null; return { id, title: c.title || '', summary: c.summary || '', layer: c.layer || 'global', createdAt: Number(c.createdAt) || 0 }; },
    get: (id) => mapBad.get(String(id)) || null,
    content: (id) => (mapBad.get(String(id)) || {}).content || null,
  },
});
const admBad = wmBad.assemble({ sessionId: 'e2e-recency-bad', queryText: Q, queryTokens: 20, turn: 1 }, hits);
const badCards = admBad.cards || [];
const badFull = badCards.filter((c) => c.tier === 'full').length;
const badId = badCards.filter((c) => /^(pm|pmi|tdai):/.test(String(c.title))).length;
console.log('\n[反证] 缺 ingest 时: full=' + badFull + '  id标题=' + badId);
check('⑤ 反证成立（缺 ingest ⇒ 无 full 或有 id 标题）', badFull === 0 || badId > 0, 'full=' + badFull + ' id标题=' + badId);

console.log('\n' + (fail === 0 ? '✅ 全部通过' : '❌ ' + fail + ' 项失败'));
process.exit(fail === 0 ? 0 : 1);
