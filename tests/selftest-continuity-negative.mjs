#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createPrefetcher } from '../lib/prefetch.js';

const now = Date.now();
const cards = new Map();
cards.set('main-1', { id:'main-1', sid:'s-main', title:'主命中', summary:'主摘要', layer:'session', createdAt:now-1000 });
cards.set('hot-1', { id:'hot-1', sid:'s-hot', title:'热卡', summary:'热摘要', layer:'session', createdAt:now-2000 });
let recallCalls = [];
const baseRetriever = {
  recentCrossSession() { return [{id:'hot-1',sid:'s-hot',t:now-2000,title:'热卡',snippet:'热摘要'}]; },
  recentRounds() { return []; },
};

// 正：legacy topN 必须仍把 hotIds 传给 recall.excludeIds
{
  const pf = createPrefetcher({
    orchestrator: { async recall(q, opts) { recallCalls.push(opts); return { hits:[{id:'main-1',score:1}], level:'fixed' }; } },
    retriever: baseRetriever, cardsProvider: ()=>cards, maxChars:8000, hotCardMode:'topN',
  });
  await pf.prefetchFor({agent:{session:{id:'s-legacy'}},messages:[{role:'user',content:'查插件'}]});
  assert.ok(recallCalls[0] && Array.isArray(recallCalls[0].excludeIds) && recallCalls[0].excludeIds.includes('hot-1'), 'legacy excludeIds');
}

// 反 1：continuity 下 search 抛错不能拖垮主 L0
{
  const pf = createPrefetcher({
    orchestrator: { async recall() { return { hits:[{id:'main-1',score:1}], level:'fixed' }; } },
    retriever: {
      ...baseRetriever,
      recentCardRefs() { return [{id:'c1-1',sid:'s-a',t:now-1000,title:'近期卡',summary:'近期摘要'}]; },
      async search() { throw new Error('boom-search'); },
    },
    cardsProvider: ()=>cards, maxChars:8000, hotCardMode:'continuity',
  });
  const e = await pf.prefetchFor({agent:{session:{id:'s-fail-search'}},messages:[{role:'user',content:'查插件'}]});
  assert.ok(e && e.text.includes('主命中'), 'main L0 survives search error');
  assert.ok(e.text.includes('<hot-memory>'), 'fallback hot block');
}

// 反 2：无 recentCardRefs 时 continuity 不能崩，且不产生 C1
{
  const pf = createPrefetcher({
    orchestrator: { async recall() { return { hits:[{id:'main-1',score:1}], level:'fixed' }; } },
    retriever: baseRetriever, cardsProvider: ()=>cards, maxChars:8000, hotCardMode:'continuity',
  });
  const e = await pf.prefetchFor({agent:{session:{id:'s-no-refs'}},messages:[{role:'user',content:'查插件'}]});
  assert.ok(e && e.text.includes('主命中'), 'no refs does not crash');
  assert.ok(!e.text.includes('[id: c1-1]'), 'no C1 when refs missing');
}

// 反 3：主 recall 抛错必须返回 null，不写缓存
{
  const pf = createPrefetcher({
    orchestrator: { async recall() { throw new Error('boom-recall'); } },
    retriever: baseRetriever, cardsProvider: ()=>cards, maxChars:8000, hotCardMode:'continuity',
  });
  const e = await pf.prefetchFor({agent:{session:{id:'s-fail-recall'}},messages:[{role:'user',content:'查插件'}]});
  assert.equal(e, null, 'recall error returns null');
  assert.equal(pf.read('s-fail-recall'), null, 'no cache on recall error');
}
console.log('CONTINUITY-NEGATIVE-DONE checks=7 passed=7 failed=0');
