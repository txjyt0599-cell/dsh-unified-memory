#!/usr/bin/env node
/**
 * selftest-wm-preview.mjs —— workingMemory preview/commit 事务（P0-3b / T22 基础件）
 *
 * 钉死：
 *   W1 assemblePreview 不写 sess.l0 / sess.l1（preview 只读）；
 *   W2 render(omitTitleIds) 扣减 usedTokens 并记录 renderedCards；
 *   W3 commitPreview 只把实际渲染卡拉进 sess.l0，且只提交一次；
 *   W4 preview 后 commit 前 snapshot 仍为空，证明没有提前污染状态。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorkingMemory } from '../lib/working-memory/working-memory.js';

let pass = 0, fail = 0;
const fails = [];
function check(name, fn) {
  try { fn(); pass++; console.log('  PASS ' + name); }
  catch (e) { fail++; fails.push(name); console.log('  FAIL ' + name + '  ' + (e && e.message || e)); }
}

const now = Date.now();
const cards = new Map();
for (let i = 1; i <= 6; i++) {
  cards.set('card-' + i, { id: 'card-' + i, title: '测试卡' + i, summary: '测试摘要' + i + '，包含足够长度用于档位测量。', layer: 'session', createdAt: now - i * 1000 });
}
const reader = {
  header(id) { const c = cards.get(String(id)); return c ? { id: c.id, title: c.title, summary: c.summary, layer: c.layer } : null; },
  content(id) { const c = cards.get(String(id)); return c ? String(c.summary || '') : null; },
};
const dir = mkdtempSync(join(tmpdir(), 'wm-preview-'));
const wm = createWorkingMemory({ dir, cards: reader, enabled: true });
const hits = ['card-1','card-2','card-3','card-4'].map((id, i) => ({ id, score: 1 - i * 0.1, via: 'stage1' }));

const before = wm.snapshot('s1');
const adm = wm.assemblePreview({ sessionId: 's1', queryText: '测试查询', turn: 1 }, hits);
const afterPreview = wm.snapshot('s1');

check('W1 assemblePreview 返回 admission 且打 preview 标', () => {
  assert.ok(adm && Array.isArray(adm.cards) && adm.preview === true);
});
check('W2 preview 不写 sess.l0 / sess.l1', () => {
  assert.equal(afterPreview.l0.length, before.l0.length);
  assert.equal(afterPreview.l1Ids.length, 0);
});
check('W3 render 的 omitTitleIds 会扣减 usedTokens 并记录 renderedCards', () => {
  const all = wm.render(adm, '');
  assert.ok(all.length > 0);
  const titleCard = (adm.cards || []).find(c => String(c.tier) === 'title');
  assert.ok(titleCard, 'no title-tier card; tiers=' + JSON.stringify((adm.cards || []).map(c => c.tier)));
  const usedBefore = adm.budget.usedTokens;
  wm.render(adm, '', { omitTitleIds: [titleCard.cardId] });
  assert.ok(adm.budget.usedTokens < usedBefore, 'usedTokens not reduced: ' + usedBefore);
  assert.ok(!adm.renderedCards.some(c => String(c.cardId) === String(titleCard.cardId)), 'omitted card still in renderedCards');
});
check('W5 render(omitTitleIds) 幂等：连续两次 usedTokens 不连减', () => {
  const titleCard = (adm.cards || []).find(c => String(c.tier) === 'title');
  const usedAfterFirst = adm.budget.usedTokens;
  wm.render(adm, '', { omitTitleIds: [titleCard.cardId] });
  assert.equal(adm.budget.usedTokens, usedAfterFirst, 'usedTokens drifted: ' + usedAfterFirst + ' -> ' + adm.budget.usedTokens);
});
check('W4 commitPreview 只提交实际渲染卡，snapshot 与 renderedCards 一致', () => {
  const rendered = adm.renderedCards.map(c => String(c.cardId));
  wm.commitPreview('s1', adm);
  const snap = wm.snapshot('s1');
  assert.deepEqual(snap.l0.map(c => String(c.cardId)), rendered);
  for (const id of rendered) assert.ok(snap.l1Ids.includes(id), 'missing L1 ' + id);
});

rmSync(dir, { recursive: true, force: true });
console.log('');
console.log('WM-PREVIEW-DONE checks=' + (pass + fail) + ' passed=' + pass + ' failed=' + fail);
if (fail > 0) { console.log('失败项: ' + fails.join(', ')); process.exit(1); }
