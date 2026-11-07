/**
 * selftest-memory-search-paging.mjs —— memory_search 翻页游标回归（2026-11-07）
 *
 * 病根：旧实现 `seen = (page-1) * 30` 写死偏移。
 *   第一页用 limit:5 只给 5 条，第二页 limit:30 却从第 31 条切 ⇒ 第 6~30 条被整段跳过（断层）。
 * 修法：按 session+query 记已发放 id，翻页用 excludeIds 精确续读，取本组条数即可。
 */
import { createMemoryTools } from './lib/retrieval/tools.js';

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log('  PASS ' + name + (detail ? '  ' + detail : '')); }
  else { fail++; console.log('  FAIL ' + name + '  ' + (detail || '')); }
}

const pool = Array.from({ length: 60 }, (_, i) => ({
  id: 'c' + String(i + 1).padStart(2, '0'),
  title: 'T' + (i + 1),
  score: 1000 - i,
}));
const cardMap = new Map(pool.map((h) => [h.id, { id: h.id, title: h.title, summary: 's', createdAt: Date.now() }]));
const retriever = {
  search: async (q, o) => {
    const opt = o || {};
    const ex = new Set((opt.excludeIds || []).map(String));
    const left = pool.filter((h) => !ex.has(h.id));
    const want = Math.min(Number(opt.k) || 20, left.length);
    const hits = left.slice(0, want).map((h) => ({ ...h }));
    return { hits, hasMore: left.length > hits.length, nextPageSize: 20 };
  },
  getCard: (id) => cardMap.get(id),
};
const tools = createMemoryTools({ retriever, cardMap, prefetcher: null, getSessionId: () => 'sess-paging', logger: null });
const search = tools.find((t) => t.name === 'memory_search');

console.log('════ MEMORY-SEARCH-PAGING · 翻页不得断层 ════');
const p1 = await search.execute({ query: '变更链', limit: 5, page: 1 });
const ids1 = p1.hits.map((h) => h.id);
check('P1 第一页给 5 条', ids1.length === 5, ids1.join(','));
check('P2 第一页从 c01 起', ids1[0] === 'c01', ids1[0]);
check('P3 第一页 hasMore', p1.hasMore === true, String(p1.hasMore));

const p2 = await search.execute({ query: '变更链', limit: 30, page: 2 });
const ids2 = p2.hits.map((h) => h.id);
check('P4 第二页从 c06 续（不是 c31）', ids2[0] === 'c06', ids2[0]);
check('P5 第二页给 30 条', ids2.length === 30, String(ids2.length));
const overlap12 = ids1.filter((x) => ids2.includes(x));
check('P6 两页无重复', overlap12.length === 0, overlap12.join(','));

const p3 = await search.execute({ query: '变更链', limit: 10, page: 3 });
const ids3 = p3.hits.map((h) => h.id);
check('P7 第三页从 c36 续', ids3[0] === 'c36', ids3[0]);
const all = [...ids1, ...ids2, ...ids3];
const uniq = new Set(all);
check('P8 三页合并 45 条且无洞无重', all.length === 45 && uniq.size === 45, 'total=' + all.length + ' uniq=' + uniq.size);
const expect = Array.from({ length: 45 }, (_, i) => 'c' + String(i + 1).padStart(2, '0'));
check('P9 覆盖 c01~c45 连续', JSON.stringify(all) === JSON.stringify(expect), all[0] + '→' + all[all.length - 1]);

console.log('');
console.log('MEMORY-SEARCH-PAGING-DONE checks=' + (pass + fail) + ' passed=' + pass + ' failed=' + fail);
if (fail > 0) process.exit(1);