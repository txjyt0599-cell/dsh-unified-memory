#!/usr/bin/env node
/**
 * 期2 验收自测（六组 A~H 精选）。**独立进程运行，不依赖 DSH 加载**。
 * 用法: node selftest-p2.mjs            # 只跑内存态（不落盘）
 *       node selftest-p2.mjs --build    # 额外跑落盘 + 增量
 * 退出码: 0 全绿 / 1 有 FAIL
 */
import { readCards } from './lib/hypergraph/source.js';
import { splitEpisodes, eligibleEpisodes } from './lib/hypergraph/episode.js';
import { buildHypergraph, verifyInvariants } from './lib/hypergraph/build.js';
import { chunkEpisode, buildFactEdge, buildEpisodeEdge } from './lib/hypergraph/edge.js';
import { decideTopicState, inclusionSim, termsOf } from './lib/hypergraph/topic.js';
import { computeShardSourceHash, computeParamsHash, planRebuild, planShards } from './lib/hypergraph/index-shard.js';
import { acquireLock, releaseLock } from './lib/hypergraph/lock.js';
import { writeShard, readShards, writeManifest, readManifest, readAllRecords, readGlobals, GLOBAL_FILES, globalBytes } from './lib/hypergraph/store.js';
import { propagateEmbeddings, holdoutSplit } from './lib/hypergraph/propagate.js';
import { HARD } from './lib/hypergraph/types.js';
import { existsSync, rmSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir as osTmpdir } from 'node:os';
import { dataPath } from './lib/paths.js';

// [2026-10-30 · 开源版] 本套要读真实卡库；新装没有 engram 文件 ⇒ 明确跳过而不是抛 ENOENT。
if (!existsSync(dataPath('engram-relay/engrams.jsonl'))) {
  console.log('⚠️ 跳过：本机还没有卡库（新装即如此），本套需要已积累的 engram 数据');
  console.log('SKIPPED（无数据）');
  process.exit(0);
}

const results = [];
const ok = (g, n, pass, detail = '') => results.push({ g, n, pass, detail });
const TMP = join(osTmpdir(), 'p2/_selftest-p2-tmp');

// ---------- A 结构纪律 ----------
{
  ok('A', 'A1 MIN_MEMBERS=3 / MAX_MEMBERS=8', HARD.MIN_MEMBERS === 3 && HARD.MAX_MEMBERS === 8);
  let threw = false;
  try { buildFactEdge({ id: 'e', cardIds: ['a','b'] }, new Map([['a',{id:'a'}],['b',{id:'b'}]])); } catch { threw = true; }
  ok('A', 'A2 2 张卡不抛错但返回空（不造 2 元边）', !threw);
  const r2 = buildFactEdge({ id: 'e', cardIds: ['a','b'] }, new Map([['a',{id:'a'}],['b',{id:'b'}]]));
  ok('A', 'A3 2 元组返回空数组', Array.isArray(r2) && r2.length === 0);
  let threw2 = false;
  try { buildFactEdge({ id: 'e', cardIds: ['a','b','c'] }, new Map([['a',{id:'a'}],['b',{id:'b'}],['c',{id:'c'}]]), { minMembers: 2 }); } catch { threw2 = true; }
  ok('A', 'A4 minMembers<3 直接抛错', threw2);
}

// ---------- B 切分 / 造边 / 不变量 ----------
{
  const { alive } = readCards();
  const g = buildHypergraph(alive);
  const inv = verifyInvariants(g);
  ok('B', 'B1 不变量 I1/I2/I3/I4/I5/I6 全 0',
    inv.I1violations + inv.I2violations + inv.I3violations + inv.I4violations + inv.I5violations + inv.I6violations === 0,
    JSON.stringify({ I1: inv.I1violations, I2: inv.I2violations, I3: inv.I3violations, I6: inv.I6violations }));
  ok('B', 'B2 factEdges ≥ 800', inv.factEdges >= 800, '实际 ' + inv.factEdges);
  ok('B', 'B3 episodeEdges ≥ 40', inv.episodeEdges >= 40, '实际 ' + inv.episodeEdges);
  ok('B', 'B4 2 元边都在普通边表（≥700）', inv.ordinaryEdges >= 700, '实际 ' + inv.ordinaryEdges);
  ok('B', 'B5 所有超边成员 3~8', [...g.factEdges, ...g.episodeEdges].every(e => e.members.length >= 3 && e.members.length <= 8));
  ok('B', 'B6 每个 Episode 只被切一次（卡不丢）', g.factEdges.reduce((a, e) => a + e.members.length, 0) > 4000);

  // ---- 期2 补修（P0）：四类记录【内存态】都必须非空 ----
  // 背景：pipeline.js 曾只 push {episode, fedge}，于是 topics/episodeEdges/ordinaryEdges
  // 只活在内存里、一条都没落盘。这四条断言的兄弟版在 H 组断「落盘后读回」。
  ok('B', 'B7 topic > 0（Topic 层非空）', g.topics.length > 0, '实际 ' + g.topics.length);
  ok('B', 'B8 eedge > 0（Episode 超边非空）', g.episodeEdges.length > 0, '实际 ' + g.episodeEdges.length);
  ok('B', 'B9 oedge > 0（普通边表非空）', g.ordinaryEdges.length > 0, '实际 ' + g.ordinaryEdges.length);
  ok('B', 'B10 四类记录全部非空（episode/fedge/topic/eedge/oedge）',
    g.episodes.length > 0 && g.factEdges.length > 0 && g.topics.length > 0 && g.episodeEdges.length > 0 && g.ordinaryEdges.length > 0,
    JSON.stringify({ episode: g.episodes.length, fedge: g.factEdges.length, topic: g.topics.length, eedge: g.episodeEdges.length, oedge: g.ordinaryEdges.length }));
  // topic 的 terms 是 Set —— 落盘前必须能无损转数组（坑：JSON.stringify(Set) = {}）
  ok('B', 'B11 topic.terms 可序列化为非空数组', (() => {
    const t = g.topics.find(x => x.terms instanceof Set && x.terms.size > 0);
    if (!t) return false;
    const arr = JSON.parse(JSON.stringify([...t.terms]));
    return Array.isArray(arr) && arr.length > 0 && typeof arr[0] === 'string';
  })(), '第一个 topic.terms.size=' + (g.topics[0]?.terms?.size ?? 'n/a'));

  globalThis.__G = g;
}

// ---------- C chunkEpisode 数学 ----------
{
  ok('C', 'C1 n=9,max=8 → 2 块且都 ≥3', (() => { const p = chunkEpisode([1,2,3,4,5,6,7,8,9], 8, 3); return p.length === 2 && p.every(x => x.length >= 3); })());
  ok('C', 'C2 n=18,max=8 → 3 块均衡', (() => { const p = chunkEpisode(Array.from({length:18},(_,i)=>i), 8, 3); return p.length === 3 && p.every(x => x.length === 6); })());
  ok('C', 'C3 n=2 → 空（不产碎块）', chunkEpisode([1,2], 8, 3).length === 0);
  ok('C', 'C4 任何输出块长都 ≥3', Array.from({length:30},(_,n)=>n+1).every(n => chunkEpisode(Array.from({length:n},(_,i)=>i), 8, 3).every(b => b.length >= 3)));
}

// ---------- D Topic 三态 ----------
{
  ok('D', 'D1 空 topics → initialization', decideTopicState({ id: 'x', terms: new Set(['a']) }, []).state === 'initialization');
  const t = [{ id: 't1', members: ['e1'], terms: new Set(['记忆','系统','超图']) }];
  ok('D', 'D2 完全重合 → update', decideTopicState({ id: 'x', terms: new Set(['记忆','系统','超图']) }, t).state === 'update');
  ok('D', 'D3 无重合 → creation', decideTopicState({ id: 'x', terms: new Set(['zzz','yyy']) }, t).state === 'creation');
  ok('D', 'D4 inclusionSim 对称且有界', (() => { const a = new Set(['a','b']), b = new Set(['a','b','c']); const s = inclusionSim(a, b); return s >= 0 && s <= 1; })());
  ok('D', 'D5 capEpisodes 满了不并', decideTopicState({ id: 'x', terms: new Set(['记忆']) }, [{ id: 't1', members: new Array(20).fill('e'), terms: new Set(['记忆']) }]).state !== 'update');
}

// ---------- E 增量索引 ----------
{
  const eps = [{ id: 'e1', cardIds: ['c1','c2','c3'] }, { id: 'e2', cardIds: ['c4','c5'] }];
  const cards = new Map([['c1',{id:'c1',createdAt:1,status:'confirmed'}],['c2',{id:'c2',createdAt:2,status:'confirmed'}],['c3',{id:'c3',createdAt:3,status:'confirmed'}],['c4',{id:'c4',createdAt:4,status:'confirmed'}],['c5',{id:'c5',createdAt:5,status:'confirmed'}]]);
  const h1 = computeShardSourceHash(eps, cards);
  const h2 = computeShardSourceHash(eps, cards);
  ok('E', 'E1 同输入指纹一致', h1 === h2);
  cards.set('c1', { id: 'c1', createdAt: 999, status: 'confirmed' });
  ok('E', 'E2 卡变了指纹变', computeShardSourceHash(eps, cards) !== h1);
  const ph1 = computeParamsHash({});
  ok('E', 'E3 paramsHash 稳定', ph1 === computeParamsHash({}));
  ok('E', 'E4 改窗口 ⇒ paramsHash 变', ph1 !== computeParamsHash({ windowTurns: 5 }));
  const shards = planShards(Array.from({length: 250}, (_,i)=>({id:'e'+i,cardIds:[]})), { episodesPerShard: 100 });
  ok('E', 'E5 250 集 → 3 片', shards.length === 3);
  const p1 = planRebuild(shards, null, {}, {});
  ok('E', 'E6 无 manifest ⇒ 全量', p1.full === true && p1.reason === 'no-manifest');
}

// ---------- F 文件锁 ----------
{
  const lockPath = TMP + '/.lock';
  if (existsSync(TMP)) rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
  const a = acquireLock(lockPath);
  ok('F', 'F1 第一次能拿到锁', !!a);
  let blocked = false;
  try { acquireLock(lockPath); } catch (e) { blocked = e.code === 'LockTimeout'; }
  ok('F', 'F2 第二次被阻塞（LockTimeout）', blocked);
  releaseLock(lockPath);
  ok('F', 'F3 释放后锁文件消失', !existsSync(lockPath));
  const b = acquireLock(lockPath);
  ok('F', 'F4 释放后能再拿', !!b);
  releaseLock(lockPath);
}

// ---------- G 传播（留出法 + λ=0 恒等）----------
{
  const vecs = new Map([
    ['a', Float32Array.from([1,0,0])],
    ['b', Float32Array.from([0.9,0.1,0])],
    ['c', Float32Array.from([0,1,0])],
  ]);
  const edges = [{ id: 'e1', members: [{nodeId:'a',weight:0.5},{nodeId:'b',weight:0.5}] }];
  const v0 = propagateEmbeddings(vecs, edges, { lambda: 0 });
  ok('G', 'G1 λ=0 原样返回（不传播）', v0.get('a')[0] === 1 && v0.get('a')[1] === 0);
  const v5 = propagateEmbeddings(vecs, edges, { lambda: 0.5 });
  ok('G', 'G2 λ=0.5 向量被改（与 a 不同）', v5.get('a')[0] !== 1 || v5.get('a')[1] !== 0);
  const { train, test } = holdoutSplit(edges, 0.2, 99);
  ok('G', 'G3 留出集不重叠且合起来等于全集', train.length + test.length === edges.length);
  ok('G', 'G4 holdoutSplit 可复现（同 seed）', (() => { const x = holdoutSplit(edges,0.2,99), y = holdoutSplit(edges,0.2,99); return x.test.length === y.test.length; })());
}

// ---------- H 落盘（--build 才跑）----------
if (process.argv.includes('--build')) {
  const { buildAndPersist } = await import('./lib/hypergraph/pipeline.js');
  const rep = buildAndPersist({ root: TMP + '/index' });
  ok('H', 'H1 建图成功', rep.ok === true);
  ok('H', 'H2 全量落盘 < 5s', rep.ms < 5000, '实际 ' + rep.ms + 'ms');
  ok('H', 'H3 分片数 ≥ 10', rep.shards >= 10, '实际 ' + rep.shards);
  ok('H', 'H4 manifest 可读回', !!readManifest(TMP + '/index'));
  const back = readShards(TMP + '/index', rep.shards);
  ok('H', 'H5 读回记录数 > 1000', back.length > 1000, '实际 ' + back.length);

  // ---- 期2 补修（P0）：落盘后四类记录都要能从磁盘读回 ----
  const all = readAllRecords(TMP + '/index', rep.shards);
  ok('H', 'H5a 分片里只有 episode+fedge 两类（分片职责单一）',
    back.every(r => r.type === 'episode' || r.type === 'fedge'),
    '实际 type 集合 ' + JSON.stringify([...new Set(back.map(r => r.type))]));
  ok('H', 'H5b 落盘 topic 条数 > 0 且等于 manifest.counts.topics',
    all.byType.topic > 0 && all.byType.topic === rep.manifest.counts.topics,
    'readBack ' + all.byType.topic + ' vs manifest ' + rep.manifest.counts.topics);
  ok('H', 'H5c 落盘 eedge 条数 > 0 且等于 manifest.counts.episodeEdges',
    all.byType.eedge > 0 && all.byType.eedge === rep.manifest.counts.episodeEdges,
    'readBack ' + all.byType.eedge + ' vs manifest ' + rep.manifest.counts.episodeEdges);
  ok('H', 'H5d 落盘 oedge 条数 > 0 且等于 manifest.counts.ordinaryEdges',
    all.byType.oedge > 0 && all.byType.oedge === rep.manifest.counts.ordinaryEdges,
    'readBack ' + all.byType.oedge + ' vs manifest ' + rep.manifest.counts.ordinaryEdges);
  ok('H', 'H5e 四类记录落盘读回全部 > 0',
    all.byType.episode > 0 && all.byType.fedge > 0 && all.byType.topic > 0 && all.byType.eedge > 0 && all.byType.oedge > 0,
    JSON.stringify(all.byType));
  ok('H', 'H5f topic.terms 落盘后是数组（不是 {}）',
    all.topics.every(t => Array.isArray(t.terms)) && all.topics.some(t => t.terms.length > 0),
    '首条 terms 长度 ' + (all.topics[0]?.terms?.length ?? 'n/a'));
  ok('H', 'H5g eedge 成员全部落在 episode 集合内（不悬空）', (() => {
    const epIds = new Set(all.episodes.map(e => e.id));
    return all.episodeEdges.every(ee => ee.members.every(m => epIds.has(m.nodeId)));
  })());
  ok('H', 'H5h oedge 全是二元（from≠to，无自环）',
    all.ordinaryEdges.every(o => o.from && o.to && o.from !== o.to),
    '自环数 ' + all.ordinaryEdges.filter(o => o.from === o.to).length);
  ok('H', 'H5i manifest.globals 三份都有字节数 > 0', (() => {
    const gl = rep.manifest.globals || {};
    return ['topics', 'eedges', 'ordinary'].every(k => gl[k] && gl[k].bytes > 0 && gl[k].records > 0);
  })(), JSON.stringify(rep.manifest.globals));
  const rep2 = buildAndPersist({ root: TMP + '/index' });
  ok('H', 'H6 二次建图不脏（clean）', rep2.reason === 'clean', 'reason=' + rep2.reason);
  const rep3 = buildAndPersist({ root: TMP + '/index', windowTurns: 6 });
  ok('H', 'H7 改参数 ⇒ 全量重建', rep3.full === true && rep3.reason === 'params-changed', 'reason=' + rep3.reason);
}

// ---------- 汇总 ----------
const pass = results.filter(r => r.pass).length;
const fail = results.length - pass;
console.log('');
for (const g of ['A','B','C','D','E','F','G','H']) {
  const rows = results.filter(r => r.g === g);
  if (!rows.length) continue;
  const p = rows.filter(r => r.pass).length;
  console.log(`[${g}] ${p}/${rows.length}`);
  for (const r of rows) if (!r.pass) console.log('   ✗ ' + r.n + '  ' + (r.detail || ''));
}
console.log('');
console.log(`合计 ${pass}/${results.length} 通过，${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
