import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { readCards, DEFAULT_ENGRAM_PATH } from './source.js';
import { buildHypergraph, verifyInvariants } from './build.js';
import { planShards, computeShardSourceHash, computeParamsHash, planRebuild } from './index-shard.js';
import { writeShard, writeManifest, readManifest, writeGlobal, GLOBAL_FILES } from './store.js';
import { acquireLock } from './lock.js';
import { HARD } from './types.js';
import { dataPath } from '../paths.js';

// [2026-10-22 by Assistant · 路径统一] 期5 已把记忆数据根迁到云盘 live。
// 这里若留 C: 旧值，一旦 config 丢失就会「写 C:、读 D:」——索引与数据分家（最阴的一类坑）。
export const DEFAULT_INDEX_ROOT = dataPath('hypergraph');

/**
 * 全量/增量建图并落盘。返回 BuildReport。
 * force=true 强制全量。
 */
export function buildAndPersist(opts = {}) {
  const t0 = Date.now();
  const root = opts.root || DEFAULT_INDEX_ROOT;
  const source = opts.source || DEFAULT_ENGRAM_PATH;
  mkdirSync(root, { recursive: true });

  const lock = acquireLock(join(root, '.lock'), opts);
  try {
    const tRead = Date.now();
    const { alive, bytes, lines } = readCards(source);
    const msRead = Date.now() - tRead;

    const tSplit = Date.now();
    const g = buildHypergraph(alive, opts);
    const msBuild = Date.now() - tSplit;

    const inv = verifyInvariants(g);
    if (inv.I1violations || inv.I2violations || inv.I3violations || inv.I6violations) {
      throw new Error('不变量失败，拒绝落盘: ' + JSON.stringify(inv.details.slice(0, 3)));
    }

    // 分片计划（按 ≥3 卡的 Episode 分片）
    const shards = planShards(g.episodes, opts);
    const paramsHash = computeParamsHash(opts);
    const oldManifest = readManifest(root);

    // 计算每片指纹
    const hashes = {};
    const factByAnchor = new Map();
    for (const e of g.factEdges) {
      if (!factByAnchor.has(e.anchorId)) factByAnchor.set(e.anchorId, []);
      factByAnchor.get(e.anchorId).push(e);
    }
    for (const s of shards) hashes[s.index] = computeShardSourceHash(s.episodes, g.cardsById);

    const plan = planRebuild(shards, oldManifest, hashes, { paramsHash, episodesPerShard: opts.episodesPerShard ?? HARD.EPISODES_PER_SHARD });

    const tWrite = Date.now();
    let written = 0, bytesOut = 0;
    let globalCounts = { topic: 0, eedge: 0, oedge: 0 };
    for (const s of shards) {
      if (!plan.full && !plan.dirty.includes(s.index)) continue;
      const payload = [];
      const seenEdge = new Set();
      for (const ep of s.episodes) {
        payload.push({ type: 'episode', ...ep });
        for (const fe of (factByAnchor.get(ep.id) || [])) {
          if (seenEdge.has(fe.id)) continue;   // 同一条边只写一次
          seenEdge.add(fe.id);
          payload.push({ type: 'fedge', ...fe });
        }
      }
      const r = writeShard(root, s.index, payload);
      written++; bytesOut += r.bytes;
    }

    // ---- 期2 补修（P0）：eedge / topic / oedge 是【全局】记录，不属于任何 episode 分片 ----
    // 选「单独文件」而不是「塞最后一片」，理由见 DESIGN 补修说明：
    //   ① 三者与分片正交，塞进某一片会让「片」不再是纯 Episode 语义；
    //   ② 增量重建只写脏片，若把全局记录塞最后一片，该片不脏时就不会重写 ⇒ 数据变陈旧；
    //   ③ 期3 Stage1 要单读 Topic，独立文件可一次 readFile 拿到，不必扫 17 片。
    // 注意：每次 rebuild 都【无条件】重写这三份（它们由全量内存图派生，代价 ~30ms，换回永不过期）。
    const globalBytes = {};
    {
      const topicRecs = g.topics.map(tp => ({ type: 'topic', ...serializeTopic(tp) }));
      const eedgeRecs = g.episodeEdges.map(ee => ({ type: 'eedge', ...ee }));
      const oedgeRecs = g.ordinaryEdges.map(oe => ({ type: 'oedge', ...oe }));
      globalBytes[GLOBAL_FILES.topics] = writeGlobal(root, GLOBAL_FILES.topics, topicRecs).bytes;
      globalBytes[GLOBAL_FILES.eedges] = writeGlobal(root, GLOBAL_FILES.eedges, eedgeRecs).bytes;
      globalBytes[GLOBAL_FILES.ordinary] = writeGlobal(root, GLOBAL_FILES.ordinary, oedgeRecs).bytes;
      for (const k of Object.keys(globalBytes)) bytesOut += globalBytes[k];
      globalCounts = { topic: topicRecs.length, eedge: eedgeRecs.length, oedge: oedgeRecs.length };
    }

    const msWrite = Date.now() - tWrite;

    const manifest = {
      schemaVersion: 1,
      paramsHash,
      builtAt: new Date().toISOString(),
      sourceStat: { path: source, bytes, lines, alive: alive.length },
      counts: {
        episodes: g.episodes.length,
        factEdges: g.factEdges.length,
        episodeEdges: g.episodeEdges.length,
        ordinaryEdges: g.ordinaryEdges.length,
        topics: g.topics.length,
      },
      globals: {
        topics: { file: GLOBAL_FILES.topics, records: globalCounts.topic, bytes: globalBytes[GLOBAL_FILES.topics] },
        eedges: { file: GLOBAL_FILES.eedges, records: globalCounts.eedge, bytes: globalBytes[GLOBAL_FILES.eedges] },
        ordinary: { file: GLOBAL_FILES.ordinary, records: globalCounts.oedge, bytes: globalBytes[GLOBAL_FILES.ordinary] },
      },
      shards: shards.map(s => ({ index: s.index, episodes: s.episodes.length, sourceHash: hashes[s.index] })),
    };
    writeManifest(root, manifest);

    return {
      ok: true,
      root,
      ms: Date.now() - t0,
      msRead, msBuild, msWrite,
      full: plan.full,
      reason: plan.reason,
      dirty: plan.dirty,
      shards: shards.length,
      written,
      bytesOut,
      globalCounts,
      globalBytes,
      invariants: inv,
      manifest,
    };
  } finally {
    try { lock.release(); } catch {}
  }
}

/**
 * Topic 序列化：terms 是 Set，JSON.stringify 会得到 {} —— 必须先转数组。
 * 同时把 members（episodeId[]）显式保留，供期3 Stage2 沿 Episode 超边展开。
 */
function serializeTopic(tp) {
  return {
    ...tp,
    terms: tp.terms instanceof Set ? [...tp.terms] : (Array.isArray(tp.terms) ? tp.terms : []),
    termsCount: tp.terms instanceof Set ? tp.terms.size : (tp.terms || []).length,
  };
}
