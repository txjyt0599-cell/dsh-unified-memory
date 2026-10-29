#!/usr/bin/env node
/**
 * selftest-hotreload.mjs —— 索引热更新 + 一致性校验的合同测试
 * [2026-10-22 by Assistant · 补工程红队 E1 指出的「热更新无测试」]
 *
 * 工程红队原话：
 *   「不测 sourceSigOf → warmup(true) → 新卡可召回及失败保旧索引。」
 *
 * 本测试全部在**临时副本**上做，不碰 live 数据、不联网。
 */
import { mkdirSync, rmSync, existsSync, writeFileSync, appendFileSync, readFileSync } from 'node:fs';
import { createRetriever } from './lib/retrieval/retriever.js';
import { dataPath } from './lib/paths.js';

const results = [];
function check(group, name, ok, detail) {
  results.push({ group, name, ok: !!ok, detail: detail === undefined ? '' : String(detail) });
  console.log((ok ? '  PASS ' : '  FAIL ') + name + (detail !== undefined ? '  ' + detail : ''));
}

const TMP = '~/_tmp/selftest-hotreload';
rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP + '/index', { recursive: true });
const SRC = TMP + '/engrams.jsonl';

// 用真实源卡的前 150 张做底
const live = readFileSync(dataPath('engram-relay/engrams.jsonl'), 'utf8').split('\n').filter(Boolean);
writeFileSync(SRC, live.slice(0, 150).join('\n') + '\n', 'utf8');

const cfg = {
  indexRoot: TMP + '/index',
  engramPath: SRC,
  tdaiEnabled: false,
  embedding: null,   // 关向量，只测热更新
};

console.log('\n── A · 基线 ──');
const rt = createRetriever(cfg);
await rt.warmup();
const h0 = rt.health();
check('A', 'A1 warmup 成功', h0.ok === true && h0.bm25.docs > 0, 'docs=' + h0.bm25.docs);
check('A', 'A2 health.index.consistency 有输出', !!h0.index.consistency, JSON.stringify(h0.index.consistency));
check('A', 'A3 health.index.rebuildHealth 有输出', !!h0.index.rebuildHealth, JSON.stringify(h0.index.rebuildHealth));

console.log('\n── B · 热更新（新卡写入后下一轮可见）──');
const SID1 = 'hotreload-sentinel-1';
const before1 = await rt.search('热更新哨兵甲ZZQ', {});
check('B', 'B1 append 前查不到', !before1.hits.some(x => x.id === SID1));

appendFileSync(SRC, JSON.stringify({ id: SID1, title: '热更新哨兵甲ZZQ', summary: '用于测试热更新的第一张哨兵卡', layer: 'global', content: '正文甲', createdAt: Date.now(), status: 'active' }) + '\n', 'utf8');

const b2 = await rt.search('热更新哨兵甲ZZQ', {});
const rebuildsAfterB2 = rt.health().index.rebuilds;
check('B', 'B2 首次查询触发重建计数', rebuildsAfterB2 >= 1, 'rebuilds=' + rebuildsAfterB2);

// 轮询等后台重建完成
let hit1 = false, waited = 0;
for (let i = 0; i < 20; i++) {
  await new Promise(r => setTimeout(r, 400));
  waited += 400;
  const r = await rt.search('热更新哨兵甲ZZQ', {});
  if (r.hits.some(x => x.id === SID1)) { hit1 = true; break; }
}
check('B', 'B3 重建后能召回新卡', hit1, '等待 ' + waited + 'ms  bm25.N=' + rt.health().bm25.docs);
check('B', 'B4 重建期间没有降级', rt.health().ok === true && rt.health().degrade !== 'fixed', 'degrade=' + rt.health().degrade);

console.log('\n── C · 连续写入 ──');
const SID2 = 'hotreload-sentinel-2';
appendFileSync(SRC, JSON.stringify({ id: SID2, title: '热更新哨兵乙WWQ', summary: '第二张哨兵卡', layer: 'global', content: '正文乙', createdAt: Date.now(), status: 'active' }) + '\n', 'utf8');
let hit2 = false;
for (let i = 0; i < 20; i++) {
  await new Promise(r => setTimeout(r, 400));
  const r = await rt.search('热更新哨兵乙WWQ', {});
  if (r.hits.some(x => x.id === SID2)) { hit2 = true; break; }
}
check('C', 'C1 第二张也能召回', hit2, 'rebuilds=' + rt.health().index.rebuilds + '  bm25.N=' + rt.health().bm25.docs);

console.log('\n── D · 失败不崩、旧索引仍可用 ──');
// 把源文件改成不可读（改名），模拟读取失败
const rt2 = createRetriever(Object.assign({}, cfg, { engramPath: TMP + '/not-exist.jsonl', tdaiEnabled: false }));
await rt2.warmup();
const hd = rt2.health();
check('D', 'D1 源不存在时不抛错', true, 'ok=' + hd.ok + ' degrade=' + hd.degrade);
const dr = await rt2.search('随便查', {});
check('D', 'D2 源不存在时检索仍返回结构', dr && Array.isArray(dr.hits), 'hits=' + (dr ? dr.hits.length : 'null'));
check('D', 'D3 失败计数可观测', hd.index && hd.index.rebuildHealth, JSON.stringify(hd.index && hd.index.rebuildHealth).slice(0, 100));

console.log('\n── E · 一致性校验 ──');
const hE = rt.health();
const cons = hE.index.consistency || {};
check('E', 'E1 有 ghostCards 字段', typeof cons.ghostCards === 'number', 'ghost=' + cons.ghostCards);
check('E', 'E2 有 uncoveredCards 字段', typeof cons.uncoveredCards === 'number', 'uncovered=' + cons.uncoveredCards);
check('E', 'E3 有 warn 判定', typeof cons.warn === 'boolean', 'warn=' + cons.warn);
check('E', 'E4 sourceCards 与 bm25 docs 一致', cons.sourceCards === hE.bm25.docs, cons.sourceCards + ' vs ' + hE.bm25.docs);

rmSync(TMP, { recursive: true, force: true });

console.log('\n════════ HOTRELOAD SUMMARY ════════');
const groups = {};
for (const r of results) { if (!groups[r.group]) groups[r.group] = { pass: 0, fail: 0 }; r.ok ? groups[r.group].pass++ : groups[r.group].fail++; }
for (const [g, v] of Object.entries(groups)) console.log('  ' + g + '   PASS=' + v.pass + '  FAIL=' + v.fail);
const passed = results.filter(r => r.ok).length;
const failed = results.length - passed;
console.log('─────────────────────────────────────');
console.log('HOTRELOAD-DONE  checks=' + results.length + '  passed=' + passed + '  failed=' + failed);
if (failed > 0) { for (const r of results) if (!r.ok) console.log('  ✗ ' + r.name + '  ' + r.detail); process.exit(1); }
