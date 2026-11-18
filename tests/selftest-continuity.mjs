#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createPrefetcher } from '../lib/prefetch.js';

const now = Date.now();
const cards = new Map();
function add(id, sid, title, summary, t) { cards.set(id, { id, sid, title, summary, layer: 'session', createdAt: t }); }
add('main-1','s-main','主命中卡','主命中摘要', now-1000);
add('c1-1','s-a','相似任务卡','上一会话已经查过类似插件，结论是采用 B 方案。', now-2000);
for (let i=1;i<=9;i++) add('c2-'+i, 's-'+String.fromCharCode(96+i), '工作流'+i, '结论'+i, now-3000-i*10);
add('pulse-2','s-b','第二张卡','pulse 第二张结论', now-5000);

const calls = { recall: [], search: [] };
const orchestrator = { async recall(query, opts) { calls.recall.push({query, opts}); return { hits: [{id:'main-1', score:1, via:'stage1'}], level:'fixed' }; } };
const retriever = {
  getCard(id) { return cards.get(String(id)) || null; },
  recentCardRefs({sinceMs, excludeSessionId}) { return [...cards.values()].filter(c=>c.id!=='main-1' && c.createdAt >= now-sinceMs).map(c=>({id:c.id,sid:c.sid,t:c.createdAt,title:c.title,summary:c.summary})); },
  recentRounds() { return [{id:'r1',sid:'s-a',t:now-1000,user:'之前问',answer:'【最终答复】之前结论'}]; },
  async search(query, opts) { calls.search.push({query,opts}); return { hits: [{id:'c1-1', score:9, via:'stage1'}, {id:'orphan-hit', score:8, via:'stage1'}] }; },
};
const pf = createPrefetcher({ orchestrator, retriever, cardsProvider: ()=>cards, maxChars:8000, hotCardMode:'continuity', c1WithinMs:7*86400e3, c2WithinMs:24*3600e3, c1Details:2, c2Limit:9 });
const entry = await pf.prefetchFor({agent:{session:{id:'s-cont'}}, messages:[{role:'user', content:'查一个类似插件'}]});
assert.ok(entry && entry.text, 'entry');
const t = entry.text;
assert.ok(t.includes('<unified-memory>'), 'L0 block');
assert.ok(t.includes('<hot-memory>'), 'hot block');
assert.ok(t.includes('[id: c1-1]'), 'C1 id');
assert.ok(t.includes('相似任务卡'), 'C1 title');
assert.ok(t.includes('上一会话已经查过类似插件'), 'C1 summary');
assert.ok(t.includes('<cross-session-pulse>'), 'pulse block');
assert.ok(t.includes('[id: pulse-2]'), 'pulse second card');
assert.ok(!calls.recall[0].opts || !calls.recall[0].opts.excludeIds, 'continuity must not exclude hot ids');
assert.ok(calls.recall[0].query === '查一个类似插件', 'query');
assert.ok(entry.injectedIds.includes('c1-1'), 'injected ledger C1');
assert.ok(entry.injectedIds.includes('pulse-2'), 'injected ledger pulse');
assert.equal(pf.tierOf('s-cont','c1-1'), 'summary', 'effective tier C1');
console.log('CONTINUITY-TEST-DONE checks=12 passed=12 failed=0');
