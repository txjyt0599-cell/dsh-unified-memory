#!/usr/bin/env node
/**
 * selftest-pure-search.mjs —— C1 纯相关性通道（P1-3）
 *
 * 钉死：
 *   P1 pureSearch 不跑时间窗（timeWindow=null）；
 *   P2 pureSearch 不写 state.lastResult（explain 保持原样）；
 *   P3 同一查询非 pureSearch 仍会走时间窗（证明不是时间窗坏了）。
 */
import assert from 'node:assert/strict';
import { createRetriever } from '../lib/retrieval/retriever.js';

let pass = 0, fail = 0;
const fails = [];
function check(name, fn) {
  try { fn(); pass++; console.log('  PASS ' + name); }
  catch (e) { fail++; fails.push(name); console.log('  FAIL ' + name + '  ' + (e && e.message || e)); }
}

const rt = createRetriever({ temporalWindowEnabled: true, l0Enabled: true }, null);
await rt.warmup();
const cards = typeof rt.recentCardRefs === 'function' ? rt.recentCardRefs({ sinceMs: 365 * 24 * 3600 * 1000, limit: 1 }) : [];
if (!cards.length) { console.log('PURE-SEARCH-SKIPPED (no data in stranger environment)'); process.exit(0); }
const before = rt.explain();
const pure = await rt.search('昨天我们干了什么', { pureSearch: true });
check('P1 pureSearch 跳过时间窗', () => assert.equal(pure.timeWindow, null));
check('P2 pureSearch 不覆写 lastResult', () => assert.equal(rt.explain(), before));
const normal = await rt.search('昨天我们干了什么', {});
check('P3 普通 search 仍走时间窗（对照）', () => assert.ok(normal.timeWindow && normal.timeWindow.label, 'timeWindow=' + JSON.stringify(normal.timeWindow)));

console.log('');
console.log('PURE-SEARCH-DONE checks=' + (pass + fail) + ' passed=' + pass + ' failed=' + fail);
if (fail > 0) { console.log('失败项: ' + fails.join(', ')); process.exit(1); }
