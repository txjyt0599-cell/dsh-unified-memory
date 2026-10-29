/**
 * scripts/ab-four-forces.mjs —— 四股力 A/B 实测（真检索，非模拟）
 * [2026-10-24 by Assistant] 检验「开/关」是否真的改变排序，且改得对。
 */
import { createRetriever } from '../lib/retrieval/retriever.js';

const QUERIES = [
  '9060XT 显存是多大',
  '记忆系统 四股力 打分',
  '日记本 写在哪里',
  '重启 DSH',
  '示例设备A再生 示例单据',
];

const base = {
  l0Enabled: true, l0RecentDays: 30,
  embedding: null,
  sourceWeight: 0.85, topicBoost: 0.15,
  flashbackEnabled: false,
};

function mk(on) {
  const r = createRetriever(Object.assign({}, base, { fourForcesEnabled: on }), null);
  return r;
}

const off = mk(false);
const on = mk(true);
console.log('[ab] warmup...');
await off.warmup(); await on.warmup();
console.log('[ab] ready. health off=', JSON.stringify(off.health().l0 ? 'l0-ok' : 'l0-null'));

const rows = [];
for (const q of QUERIES) {
  const a = await off.search(q, { k: 8 });
  const b = await on.search(q, { k: 8 });
  const idsA = (a.hits || []).map((h) => String(h.id));
  const idsB = (b.hits || []).map((h) => String(h.id));
  const t = (r, id) => { const h = (r.hits || []).find(x => String(x.id) === id); return h ? String(h.title || '').slice(0, 26) : ''; };
  const same = JSON.stringify(idsA) === JSON.stringify(idsB);
  rows.push({ q, same, nA: idsA.length, nB: idsB.length, a: idsA.slice(0, 5), b: idsB.slice(0, 5), ff: b.fourForces });
  console.log('\n▸', q);
  console.log('   关:'); idsA.slice(0, 5).forEach((id, i) => console.log('     ' + (i + 1) + '. ' + t(a, id)));
  console.log('   开:'); idsB.slice(0, 5).forEach((id, i) => console.log('     ' + (i + 1) + '. ' + t(b, id)));
  console.log('   排序是否变化:', same ? '未变' : '已变', '| fourForces:', JSON.stringify(b.fourForces));
}
const changed = rows.filter((r) => !r.same).length;
console.log('\n[ab] 结论：', changed + '/' + rows.length, '条查询的 Top8 排序发生了变化');
process.exit(0);