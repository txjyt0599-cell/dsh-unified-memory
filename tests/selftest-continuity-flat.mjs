#!/usr/bin/env node
/**
 * selftest-continuity-flat.mjs —— 平铺模式（无 workingMemory）预算与档位
 * 对应红队 R2：平铺 l0Tokens/Chars 恒 0、hits=0 清档位账本。
 */
import assert from 'node:assert/strict';
import { createPrefetcher } from '../lib/prefetch.js';

let pass = 0, fail = 0;
const fails = [];
function check(name, fn) {
  try { fn(); pass++; console.log('  PASS ' + name); }
  catch (e) { fail++; fails.push(name); console.log('  FAIL ' + name + '  ' + (e && e.message || e)); }
}
const now = Date.now();
function makeRetriever(refs) {
  return {
    getCard(id) { return refs.find(r => String(r.id) === String(id)) || null; },
    recentCardRefs({ sinceMs }) { return refs.filter(r => now - r.t <= Number(sinceMs)).map(r => ({ id: r.id, sid: r.sid, t: r.t, title: r.title, summary: r.summary })); },
    recentRounds() { return []; },
    async search() { return { hits: [] }; },
  };
}
const refs = [];
for (let i = 1; i <= 5; i++) refs.push({ id: 'f-' + i, sid: 'fs-' + i, t: now - i * 1000, title: '平铺工作流' + i, summary: '平铺工作流的结论' + i });

// F1：平铺模式必须把 renderHits 的实际 L0 文本计入预算
{
  const logs = [];
  const logger = { wake(e) { logs.push(e); }, miss(e) { logs.push(e); } };
  // 主召回 8 张卡（renderHits 会渲染成 ~800 字符），而 C2 只有 2 张（hot ~200 字符）：
  //   旧代码 l0Chars=0 ⇒ budgetClosed=true；新代码把 renderHits 计入 ⇒ 超 500 触发回退。
  const cardsMap = new Map();
  const hits = [];
  for (let i = 1; i <= 8; i++) {
    const id = 'main-' + i;
    cardsMap.set(id, { id, title: '主命中卡' + i, summary: '主命中摘要内容' + i });
    hits.push({ id, score: 1 - i * 0.01, via: 'stage1' });
  }
  const orchestrator = { async recall() { return { hits, level: 'fixed' }; } };
  const pf = createPrefetcher({
    orchestrator, retriever: makeRetriever(refs.slice(0, 2)), cardsProvider: () => cardsMap,
    maxChars: 4000, hotCardMode: 'continuity', approvedCharCap: 500, approvedTokenCap: 100000,
    continuityMaxChars: 2200, logger,
  });
  await pf.prefetchFor({ agent: { session: { id: 's-flat-budget' } }, messages: [{ role: 'user', content: '平铺预算' }] });
  check('F1 平铺模式 L0 文本计入 approvedCharCap（超限触发 budget-fallback）', () => {
    assert.ok(logs.some(x => x.level === 'continuity-budget-fallback'), 'no continuity-budget-fallback log');
  });
}

// F2：主召回 0 命中但 C1/C2/pulse 有注入时，档位账本不能清空
{
  const orchestrator = { async recall() { return { hits: [], level: 'fixed' }; } };
  const pf = createPrefetcher({
    orchestrator, retriever: makeRetriever(refs), cardsProvider: () => new Map(),
    maxChars: 8000, hotCardMode: 'continuity', approvedCharCap: 100000, approvedTokenCap: 100000,
    continuityMaxChars: 2200,
  });
  const entry = await pf.prefetchFor({ agent: { session: { id: 's-flat-empty' } }, messages: [{ role: 'user', content: '空主召回' }] });
  check('F2 空主召回仍保留 C2 档位（title）', () => {
    assert.ok(entry && entry.injectedIds.includes('f-1'), 'f-1 not injected');
    assert.equal(pf.tierOf('s-flat-empty', 'f-1'), 'title');
  });
}

console.log('');
console.log('CONTINUITY-FLAT-DONE checks=' + (pass + fail) + ' passed=' + pass + ' failed=' + fail);
if (fail > 0) { console.log('失败项: ' + fails.join(', ')); process.exit(1); }
