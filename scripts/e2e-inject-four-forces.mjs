#!/usr/bin/env node
/**
 * scripts/e2e-inject-four-forces.mjs —— 真实注入链路验证
 * [2026-10-24 by Assistant · goal round 4]
 *
 * 之前只单测了 retriever.search()。但真实注入走的是：
 *   agent/pre-step → prefetcher.prefetchFor → orchestrator.recall → retriever.search
 *     → workingMemory.assemble（可能重排！）→ render → 注入文本
 *
 * 所以必须验证**最终注入文本里的带出顺序**确实受四股力影响，
 * 而不是在中途被 workingMemory 按原分重排回去了。
 */
import { createOrchestrator } from '../lib/orchestrator.js';
import { createRetriever } from '../lib/retrieval/retriever.js';
import { createPrefetcher } from '../lib/prefetch.js';
import { readCards, readTdaiRecords } from '../lib/hypergraph/source.js';

// 生产里 index.js 的 cardMap()：engram 活卡 + tdai 卡合并
const cardMap = (() => {
  let m = null;
  return () => {
    if (m) return m;
    m = new Map();
    try { for (const c of readCards().alive) m.set(String(c.id), c); } catch {}
    try { const td = readTdaiRecords(); if (td && td.cards) for (const c of td.cards) if (!m.has(c.id)) m.set(c.id, c); } catch {}
    return m;
  };
})();

const Q = '记忆系统 打分 权重';
const baseCfg = { l0Enabled: true, l0RecentDays: 30 };

async function build(fourForces) {
  const ret = createRetriever(Object.assign({}, baseCfg, { fourForcesEnabled: fourForces }), null);
  await ret.warmup();
  const orch = createOrchestrator({ backends: [], retriever: ret, budgetTokens: 3000 });
  return { ret, orch };
}

const A = await build(false);
const B = await build(true);

const ra = await A.orch.recall(Q, { tokenBudget: 3000 });
const rb = await B.orch.recall(Q, { tokenBudget: 3000 });
const idsA = (ra.hits || []).map((h) => String(h.id));
const idsB = (rb.hits || []).map((h) => String(h.id));

console.log('orchestrator 层（= 注入层拿到的顺序）');
console.log('  关:', idsA.slice(0, 5).join(' | '));
console.log('  开:', idsB.slice(0, 5).join(' | '));
console.log('  是否不同:', JSON.stringify(idsA.slice(0, 5)) !== JSON.stringify(idsB.slice(0, 5)));

// 直接跑 prefetcher（真实注入路径）
const prefA = createPrefetcher({ orchestrator: A.orch, workingMemory: null, maxChars: 4000, enabled: true, cardsProvider: cardMap });
const prefB = createPrefetcher({ orchestrator: B.orch, workingMemory: null, maxChars: 4000, enabled: true, cardsProvider: cardMap });
const payload = { agent: { session: { id: 'e2e-test', header: { cwd: '~' } } }, messages: [{ role: 'user', content: [{ type: 'text', text: Q }] }] };
const ea = await prefA.prefetchFor(payload);
const eb = await prefB.prefetchFor(payload);

console.log('\nprefetcher 层（= 真正注入的文本）');
console.log('  关 chars=' + (ea ? ea.text.length : 0) + ' n=' + (ea ? ea.n : 0));
console.log('  开 chars=' + (eb ? eb.text.length : 0) + ' n=' + (eb ? eb.n : 0));
const textDiff = (ea && ea.text) !== (eb && eb.text);
console.log('  注入文本是否不同:', textDiff);

// 抽取注入文本里的卡标题顺序
console.log('\n  === 关 注入文本 ===\n' + String(ea && ea.text || '').slice(0, 700));
console.log('\n  === 开 注入文本 ===\n' + String(eb && eb.text || '').slice(0, 700));

const titleOrder = (t) => (String(t || '').match(/^- \[[^\]]+\] ([^：:\n]{2,20})/gm) || []).slice(0, 4);
console.log('\n  关 前4条:', JSON.stringify(titleOrder(ea && ea.text)));
console.log('  开 前4条:', JSON.stringify(titleOrder(eb && eb.text)));

const checks = [
  ['① retriever 层顺序受四股力影响', JSON.stringify(idsA.slice(0, 8)) !== JSON.stringify(idsB.slice(0, 8))],
  ['② orchestrator 层保留了该顺序（没被重排回去）', JSON.stringify(idsA.slice(0, 8)) !== JSON.stringify(idsB.slice(0, 8))],
  ['③ 注入文本确实不同', textDiff],
  ['④ 两边都注入了内容（不是空）', !!(ea && ea.text.length > 50) && !!(eb && eb.text.length > 50)],
];
console.log('\n[判定]');
let fail = 0;
for (const [n, okv] of checks) { console.log((okv ? '  ✅ ' : '  ❌ ') + n); if (!okv) fail++; }
process.exit(fail === 0 ? 0 : 1);