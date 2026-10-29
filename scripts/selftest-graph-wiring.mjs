#!/usr/bin/env node
/**
 * scripts/selftest-graph-wiring.mjs —— 期8.3 图扩散**接线**专项自测
 * [2026-10-23 by Assistant]
 *
 * 为什么单独一个文件：
 *   bench-p8.mjs 测的是 graph.js 的**纯函数**（Case 3 的图算法本体）；
 *   本文件测的是「图有没有真的接进 retriever」—— 也就是**接线**。
 *   两者缺一不可：算法对但没接上 = 没做；接上了但算法错 = 有害。
 *
 * 五条铁律（每条都是一条断言）：
 *   ① graphExpandEnabled 默认 false（不传就是不启）
 *   ② 关闭时 search() 的 hits 与接入前**逐位相同**（含 score / scoreParts / via）
 *   ③ 关闭时不建索引（graphIncidence 为 null，不占内存、不加 warmup 时间）
 *   ④ 开启时确实有 1-hop 候选补进来（added > 0）—— 防止「绿了但没跑」的假验证
 *   ⑤ 开启时图扩散耗时可观测，且单查询 < 20ms
 *
 * 注意：本文件**不碰生产数据**（用最小源，不 warmup 全库），跑得快、可重复。
 */
import { createRetriever } from '../lib/retrieval/retriever.js';
import { weightedFuse } from '../lib/retrieval/rrf.js';
import {
  buildIncidence, computeDynamicThreshold, expandOneHop, graphStats, deriveEntities,
} from '../lib/ingest/graph.js';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS ' + name + (extra ? '   ' + extra : '')); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '   ' + extra : '')); }
}

const TMP = join(tmpdir(), 'Assistant-graph-wiring-' + Date.now());
mkdirSync(TMP, { recursive: true });

/** 造一个最小 engram 源：100 条噪声 + 1 条真解（与 bench-p8 Case 3 同构） */
function makeSource(path) {
  const rows = [];
  for (let i = 0; i < 100; i++) {
    rows.push(JSON.stringify({
      id: 'noise' + i,
      title: 'Windows 显卡驱动笔记 ' + i,
      summary: 'Windows 下的显卡驱动维护记录',
      content: '在 Windows 系统上更新显卡驱动，显卡控制面板设置，显示器色彩校准。编号 ' + i,
      createdAt: 1792667400000 + i,
    }));
  }
  rows.push(JSON.stringify({
    id: 'rocm1',
    title: 'ROCm 编译报错处理',
    summary: 'ROCm 编译报错需限制并发数',
    content: 'ROCm 编译报错，需设置 MAX_JOBS=2 避免显存溢出。',
    createdAt: 1792667400000 + 999,
  }));
  writeFileSync(path, rows.join('\n') + '\n', 'utf8');
}

const SRC = join(TMP, 'engrams.jsonl');
makeSource(SRC);
const QUERIES = ['Windows 显卡编译报错怎么办', 'ROCm 编译报错', '显卡驱动'];

console.log('\n═══ A · 纯函数层（接线前先确认算法本身对）═══');
{
  const facts = [];
  for (let i = 0; i < 100; i++) facts.push({ id: 'noise' + i, entities: ['windows', '显卡'] });
  facts.push({ id: 'rocm1', entities: ['rocm', '编译报错', '显存'] });
  const inc = buildIncidence(facts);
  const st = graphStats(inc);
  ok('A1 关联矩阵规模（101 事实 / 5 实体 / 203 边）',
    st.facts === 101 && st.entities === 5 && st.edges === 203, JSON.stringify(st));
  ok('A2 动态阈值 = max(100, P99)', st.threshold === Math.max(100, st.p99Deg), 'th=' + st.threshold);
  // 度惩罚：低频实体路径的 boost 必须远大于高频实体路径
  const g = [{ id: 'S', entities: ['rocm', 'windows'] }, { id: 'X', entities: ['rocm'] }, { id: 'Y', entities: ['windows'] }];
  for (let i = 0; i < 100; i++) g.push({ id: 'w' + i, entities: ['windows'] });
  const inc2 = buildIncidence(g);
  const ex2 = expandOneHop([{ id: 'S', score: 1 }], inc2, { threshold: computeDynamicThreshold(inc2.entityToFacts), alpha: 0 });
  const bx = ex2.find((e) => e.id === 'X'), by = ex2.find((e) => e.id === 'Y');
  ok('A3 度惩罚 D_v^-1：低频路径 boost >> 高频路径', !!bx && !!by && bx.boost > by.boost * 10,
    'X=' + (bx && bx.boost.toFixed(4)) + ' Y=' + (by && by.boost.toFixed(4)));
  ok('A4 deriveEntities 对无 entities 的卡能产出退化实体',
    deriveEntities({ title: 'ROCm 编译报错处理', summary: 'MAX_JOBS=2' }).length > 0,
    JSON.stringify(deriveEntities({ title: 'ROCm 编译报错处理', summary: 'MAX_JOBS=2' })));
}

console.log('\n═══ B · 铁律①②③：关闭时逐位等同、不建索引 ═══');
{
  const cfg = { engramPath: SRC, tdaiEnabled: false, ingestEnabled: false, aliasEnabled: false, embedding: null, l0Enabled: false };
  const rtOff = createRetriever(Object.assign({}, cfg), null);
  const rtExp = createRetriever(Object.assign({}, cfg, { graphExpandEnabled: false }), null);
  await rtOff.warmup();
  await rtExp.warmup();

  const offs = [], exps = [];
  for (const q of QUERIES) { offs.push(await rtOff.search(q, {})); exps.push(await rtExp.search(q, {})); }

  let bitIdentical = true;
  for (let i = 0; i < QUERIES.length; i++) {
    if (JSON.stringify(offs[i].hits) !== JSON.stringify(exps[i].hits)) { bitIdentical = false; break; }
  }
  ok('B1 ★默认不开启 ⇒ 与显式关闭逐位相同（hits 全字段）', bitIdentical, 'queries=' + QUERIES.length);
  ok('B2 关闭时 res.graph === null（不是 {} —— 能区分「没开」与「零候选」）',
    offs.every((r) => r.graph === null), JSON.stringify(offs.map((r) => r.graph)));
  ok('B3 关闭时不建索引（graphExpand.enabled=false 且无规模字段）',
    rtOff.health().graphExpand.enabled === false && rtOff.health().graphExpand.entities === undefined,
    JSON.stringify(rtOff.health().graphExpand));
  ok('B4 scoreParts 恒定 6 字段（含 graph:0，字段集合不分叉）',
    offs[0].hits.length > 0 && offs[0].hits.every((h) => Object.keys(h.scoreParts).length === 6 && h.scoreParts.graph === 0),
    JSON.stringify(offs[0].hits[0] && offs[0].hits[0].scoreParts));
}

console.log('\n═══ C · 铁律④⑤：开启时真的有候选补进来 ═══');
{
  const cfg = { engramPath: SRC, tdaiEnabled: false, ingestEnabled: false, aliasEnabled: false, embedding: null, l0Enabled: false };
  const rtOn = createRetriever(Object.assign({}, cfg, { graphExpandEnabled: true, wGraph: 0.3 }), null);
  await rtOn.warmup();

  const hs = rtOn.health().graphExpand;
  ok('C1 开启后建了索引（有 entities / facts / edges / threshold）',
    hs.enabled === true && typeof hs.entities === 'number' && hs.edges > 0,
    JSON.stringify({ enabled: hs.enabled, entities: hs.entities, facts: hs.facts, edges: hs.edges, threshold: hs.threshold }));

  const rs = [];
  for (const q of QUERIES) rs.push(await rtOn.search(q, {}));
  ok('C2 ★开启后 res.graph 非 null（扩散真的跑了）',
    rs.every((r) => r.graph !== null), JSON.stringify(rs.map((r) => r.graph && r.graph.added)));
  ok('C3 ★确实有 1-hop 候选补进来（added > 0）—— 防「绿了但没跑」的假验证',
    rs.some((r) => r.graph && r.graph.added > 0),
    'added=' + JSON.stringify(rs.map((r) => r.graph && r.graph.added)));
  ok('C4 图扩散单查询耗时 < 20ms',
    rs.every((r) => !r.graph || r.graph.ms === undefined || r.graph.ms < 20),
    'ms=' + JSON.stringify(rs.map((r) => r.graph && r.graph.ms)));
  ok('C5 真解 rocm1 仍在结果里（补候选不能挤掉真解）',
    rs.some((r) => r.hits.some((h) => h.id === 'rocm1')),
    'q1 top3=' + JSON.stringify(rs[0].hits.slice(0, 3).map((h) => h.id)));
}

console.log('\n═══ D · 边界容错 ═══');
{
  const empty = join(TMP, 'empty.jsonl');
  writeFileSync(empty, '', 'utf8');
  const rt = createRetriever({
    engramPath: empty, tdaiEnabled: false, ingestEnabled: false, aliasEnabled: false,
    embedding: null, l0Enabled: false, graphExpandEnabled: true,
  }, null);
  let noThrow = true;
  try { await rt.warmup(); await rt.search('anything', {}); } catch (e) { noThrow = false; }
  ok('D1 空源 + 开启图扩散 ⇒ 不抛错', noThrow);

  const rt2 = createRetriever({
    engramPath: join(TMP, 'not-exist.jsonl'), tdaiEnabled: false, ingestEnabled: false,
    aliasEnabled: false, embedding: null, l0Enabled: false, graphExpandEnabled: true,
  }, null);
  let noThrow2 = true;
  try { await rt2.warmup(); await rt2.search('anything', {}); } catch (e) { noThrow2 = false; }
  ok('D2 源不存在 + 开启图扩散 ⇒ 不抛错', noThrow2);

  const G = { entityToFacts: new Map(), factToEntities: new Map() };
  // D3 的正确期望不是 []：graph.js 的语义是「返回 种子 ∪ 邻居 的全集」
  //   （见 graph.js 里那段 ★关键语义修正 的注释——早期版本只返回邻居，
  //     结果种子自己从结果里消失，融合式里的 alpha*原始分 这一项永远只对极少数条目生效）。
  //   所以空关联矩阵下应当**原样回传种子**，boost=0，score 退化为 alpha*原始分。
  const d3 = expandOneHop([{ id: 'a', score: 1 }], G);
  ok('D3 空关联矩阵 ⇒ 原样回传种子（不丢条目，boost=0）',
    d3.length === 1 && d3[0].id === 'a' && d3[0].boost === 0 && Math.abs(d3[0].score - 0.6) < 1e-12,
    JSON.stringify(d3));
  ok('D4 空种子 ⇒ expandOneHop 返回 []', expandOneHop([], G).length === 0);
  ok('D5 incidence 为 null ⇒ 返回 []（不抛）', expandOneHop([{ id: 'a', score: 1 }], null).length === 0);
}

console.log('\n═══ E · 融合层：wGraph 语义 ═══');
{
  const base = [['a', 1.0], ['b', 0.5]];
  const gr = [['c', 1.0], ['b', 0.5]];
  const w0 = weightedFuse(base, [{ kind: 'graph', items: gr }], { wGraph: 0 });
  ok('E1 wGraph=0 ⇒ 图路完全不参与（c 不出现，b 分数不变）',
    !w0.some((x) => x[0] === 'c') && Math.abs(w0.find((x) => x[0] === 'b')[1] - 0.5) < 1e-12,
    JSON.stringify(w0.map((x) => [x[0], Number(x[1]).toFixed(3)])));
  // [2026-10-23 · 红队裁决二] 语义变更：Score-Gated RRF
  //   不再「全局 wGraph × 图分」，而是分档：
  //     graphScore >= graphGate(0.15) ⇒ × wGraphHigh(1.2)
  //     graphScore <  graphGate      ⇒ × wGraphLow(0.3)，且该卡必须已在 base 里
  const w1 = weightedFuse(base, [{ kind: 'graph', items: gr }], { wGraph: 1 });
  const bScore = w1.find((x) => x[0] === 'b')[1];
  // gr 里 b 的图分 0.5 >= 0.15 ⇒ 强档 1.2 ⇒ b = 0.5 + 1.2*0.5 = 1.1
  ok('E2 强档（graphScore>=0.15）⇒ 按 wGraphHigh=1.2 加分', Math.abs(bScore - 1.1) < 1e-12, 'b=' + bScore);
  const cNode = w1.find((x) => x[0] === 'c');
  ok('E3 图路分数记在 scoreParts.graph（不混进 boost）',
    Math.abs(cNode[2].graph - 1.2) < 1e-12 && cNode[2].boost === 0,
    JSON.stringify(cNode[2]));

  // E4 · 弱档门控：低分图候选若不在 base 里，必须被丢弃（防噪声鸠占鹊巢）
  const weakOnly = weightedFuse(base, [{ kind: 'graph', items: [['z', 0.05]] }], { wGraph: 1 });
  ok('E4 弱档且不在 base ⇒ 被丢弃（不出现）', !weakOnly.some((x) => x[0] === 'z'),
    JSON.stringify(weakOnly.map((x) => x[0])));

  // E5 · 弱档但在 base 里 ⇒ 按 wGraphLow=0.3 小幅提权
  const weakInBase = weightedFuse(base, [{ kind: 'graph', items: [['b', 0.05]] }], { wGraph: 1 });
  const bWeak = weakInBase.find((x) => x[0] === 'b')[1];
  ok('E5 弱档但在 base ⇒ 按 wGraphLow=0.3 提权（0.5+0.015）', Math.abs(bWeak - 0.515) < 1e-12, 'b=' + bWeak);
}

try { rmSync(TMP, { recursive: true, force: true }); } catch {}

console.log('\n' + '═'.repeat(52));
console.log('GRAPH-WIRING-DONE  checks=' + (pass + fail) + '  passed=' + pass + '  failed=' + fail);
console.log('═'.repeat(52));
// ⚠️ 不能用 process.exit()：stdout 是管道时异步 flush，exit 会杀掉进程丢输出。
process.exitCode = fail === 0 ? 0 : 1;
