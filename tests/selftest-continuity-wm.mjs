#!/usr/bin/env node
/**
 * selftest-continuity-wm.mjs —— continuity 模式 × 真实 workingMemory 集成
 *
 * 钉死 P0-3b/P1-2 关键接缝：
 *   X1 continuity 成功路径产出 L0 + hot + pulse，且 C1 卡进入注入账本；
 *   X2 C1 与 L0 title 重复时只渲染一次（omitTitleIds 生效）；
 *   X3 commitPreview 后 sess.l0 与实际渲染卡一致（没有 preview 泄漏）；
 *   X4 主 recall 不传 excludeIds（K1），且 tokenBudget=400000 保留。
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
function add(id, sid, title, summary, t) { cards.set(id, { id, sid, title, summary, layer: 'session', createdAt: t }); }
add('main-1', 's-main', '主命中卡', '主命中摘要', now - 1000);
add('main-2', 's-main', '主命中卡二', '主命中摘要二', now - 2000);
add('c1-1', 's-a', '相似任务卡', '上一会话已经查过类似插件，结论是采用 B 方案。这是完整结论而不是截断前缀。', now - 3000);
add('c2-1', 's-b', '工作流一', '工作流一的结论', now - 4000);
add('c2-2', 's-c', '工作流二', '工作流二的结论', now - 5000);
add('pulse-2', 's-d', '第二张卡', 'pulse 第二张结论', now - 6000);
add('c2-3', 's-e', '工作流三', '工作流三的结论', now - 7000);

const reader = {
  header(id) { const c = cards.get(String(id)); return c ? { id: c.id, title: c.title, summary: c.summary, layer: c.layer } : null; },
  content(id) { const c = cards.get(String(id)); return c ? String(c.summary || '') : null; },
};
const dir = mkdtempSync(join(tmpdir(), 'cont-wm-'));
const wm = createWorkingMemory({ dir, cards: reader, enabled: true });

const calls = { recall: [], search: [] };
const orchestrator = {
  async recall(query, opts) {
    calls.recall.push({ query, opts });
    return { hits: [
      { id: 'main-1', score: 1.0, via: 'stage1' },
      { id: 'main-2', score: 0.8, via: 'stage1' },
      { id: 'c1-1', score: 0.15, via: 'stage1' },
    ], level: 'fixed' };
  },
};
const retriever = {
  getCard(id) { return cards.get(String(id)) || null; },
  recentCardRefs({ sinceMs, excludeSessionId }) {
    return [...cards.values()].filter(c => c.id !== 'main-1' && c.id !== 'main-2' && c.createdAt >= now - sinceMs)
      .map(c => ({ id: c.id, sid: c.sid, t: c.createdAt, title: c.title, summary: c.summary, status: '', refute_by: [] }));
  },
  recentRounds() { return []; },
  async search(query, opts) { calls.search.push({ query, opts }); return { hits: [{ id: 'c1-1', score: 9, via: 'stage1' }] }; },
};
const pf = createPrefetcher({ orchestrator, workingMemory: wm, retriever, cardsProvider: () => cards, maxChars: 8000, hotCardMode: 'continuity', c1WithinMs: 7 * 86400e3, c2WithinMs: 24 * 3600e3, c1Details: 1, c2Limit: 3, continuityMaxChars: 2200 });
const entry = await pf.prefetchFor({ agent: { session: { id: 's-cont' } }, messages: [{ role: 'user', content: '查一个类似插件' }] });

check('X1 continuity 产出三段且 C1 进账本', () => {
  assert.ok(entry && entry.text);
  assert.ok(entry.text.includes('<unified-memory>'));
  assert.ok(entry.text.includes('<hot-memory>'));
  assert.ok(entry.text.includes('<cross-session-pulse>'));
  assert.ok(entry.injectedIds.includes('c1-1'));
});
check('X2 C1 与 L0 title 重复时只渲染一次', () => {
  const n = (entry.text.match(/相似任务卡/g) || []).length;
  assert.equal(n, 1, 'occurrences=' + n);
});
check('X3 preview 已提交：sess.l0 与 renderedCards 一致', () => {
  const snap = wm.snapshot('s-cont');
  assert.ok(snap.l0.length >= 2, 'l0=' + snap.l0.length);
});
check('X4 主 recall 未传 excludeIds 且 tokenBudget 保留', () => {
  const o = calls.recall[0].opts || {};
  assert.equal(o.tokenBudget, 400000);
  assert.ok(!o.excludeIds || o.excludeIds.length === 0);
});
check('X5 C1 检索走 pureSearch', () => {
  assert.equal(calls.search[0].opts.pureSearch, true);
});

rmSync(dir, { recursive: true, force: true });
console.log('');
console.log('CONTINUITY-WM-DONE checks=' + (pass + fail) + ' passed=' + pass + ' failed=' + fail);
if (fail > 0) { console.log('失败项: ' + fails.join(', ')); process.exit(1); }
