#!/usr/bin/env node
/**
 * selftest-continuity-fallback.mjs —— P0-3/T19/T22 预算失败完整回退 topN
 *
 * 钉死：
 *   F1 预算不可闭合 ⇒ 走 topN（recall 第二次、带 excludeIds）；
 *   F2 preview 不提交、回退只 assemble 一次、commitPreview 0 次（无双提交）；
 *   F3 失败原因有日志（continuity-budget-fallback / continuity-fallback-topn）；
 *   F4 最终仍产出可注入文本（不空窗）。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorkingMemory } from '../lib/working-memory/working-memory.js';
import { createPrefetcher } from '../lib/prefetch.js';

let pass = 0, fail = 0;
const fails = [];
function check(name, fn) {
  try { fn(); pass++; console.log('  PASS ' + name); }
  catch (e) { fail++; fails.push(name); console.log('  FAIL ' + name + '  ' + (e && e.message || e)); }
}

const now = Date.now();
const cards = new Map();
function add(id, sid, title, t) { cards.set(id, { id, sid, title, summary: '摘要' + id, layer: 'session', createdAt: t }); }
add('main-1', 's-main', '主命中卡', now - 1000);
add('c1-1', 's-a', '相似任务卡', now - 2000);
add('c2-1', 's-b', '工作流一', now - 3000);
const reader = {
  header(id) { const c = cards.get(String(id)); return c ? { id: c.id, title: c.title, summary: c.summary, layer: c.layer } : null; },
  content(id) { const c = cards.get(String(id)); return c ? String(c.summary || '') : null; },
};
const dir = mkdtempSync(join(tmpdir(), 'cont-fb-'));
const wm = createWorkingMemory({ dir, cards: reader, enabled: true });
let assembleCalls = 0, commitCalls = 0;
const origAssemble = wm.assemble.bind(wm);
wm.assemble = function (...args) { assembleCalls++; return origAssemble(...args); };
const origCommit = wm.commitPreview.bind(wm);
wm.commitPreview = function (...args) { commitCalls++; return origCommit(...args); };

const logs = [];
const logger = { wake(e) { logs.push(e); }, miss(e) { logs.push(e); } };
const calls = { recall: [] };
const orchestrator = { async recall(q, opts) { calls.recall.push(opts); return { hits: [{ id: 'main-1', score: 1, via: 'stage1' }, { id: 'c1-1', score: 0.2, via: 'stage1' }], level: 'fixed' }; } };
const retriever = {
  getCard(id) { return cards.get(String(id)) || null; },
  recentCardRefs({ sinceMs }) { return [...cards.values()].filter(c => c.id !== 'main-1' && c.createdAt >= now - sinceMs).map(c => ({ id: c.id, sid: c.sid, t: c.createdAt, title: c.title, summary: c.summary })); },
  recentRounds() { return []; },
  async search() { return { hits: [{ id: 'c1-1', score: 9 }] }; },
};
const pf = createPrefetcher({ orchestrator, workingMemory: wm, retriever, cardsProvider: () => cards, maxChars: 8000, hotCardMode: 'continuity', approvedTokenCap: 1, approvedCharCap: 1, continuityMaxChars: 2200, logger });
const entry = await pf.prefetchFor({ agent: { session: { id: 's-fb' } }, messages: [{ role: 'user', content: '测试预算失败' }] });

check('F1 预算失败走第二次 recall 且带 excludeIds', () => {
  assert.equal(calls.recall.length, 2, 'recall=' + calls.recall.length);
  assert.ok(Array.isArray(calls.recall[1].excludeIds), 'no excludeIds on fallback');
});
check('F2 preview 不提交，回退只 assemble 一次、commit 0 次', () => {
  assert.equal(assembleCalls, 1, 'assemble=' + assembleCalls);
  assert.equal(commitCalls, 0, 'commit=' + commitCalls);
});
check('F3 预算失败有日志', () => {
  assert.ok(logs.some(x => x.level === 'continuity-budget-fallback'));
  assert.ok(logs.some(x => x.level === 'continuity-fallback-topn'));
});
check('F4 最终文本非空', () => assert.ok(entry && entry.text && entry.text.includes('<unified-memory>')));

rmSync(dir, { recursive: true, force: true });
console.log('');
console.log('CONTINUITY-FALLBACK-DONE checks=' + (pass + fail) + ' passed=' + pass + ' failed=' + fail);
if (fail > 0) { console.log('失败项: ' + fails.join(', ')); process.exit(1); }
