import { join } from 'node:path';
import { existsSync, statSync } from 'node:fs';
import { readManifest, readShards, readAllRecords, globalBytes as globalBytesOf } from './store.js';
import { buildAndPersist, DEFAULT_INDEX_ROOT } from './pipeline.js';

/**
 * 超图后端（期2）。
 * 契约对齐期1 的 MemoryBackend：id / readOnly / recallImplemented / health() / recall()。
 * 期2 只做到「能建图 + 能读回」，**检索留给期3** ⇒ recallImplemented=false。
 */
export function createHypergraphBackend(opts = {}, logger = null) {
  const root = opts?.indexRoot || DEFAULT_INDEX_ROOT;
  const enabled = opts?.enabled === true;   // 默认关：不建图、不占启动时间

  return {
    id: 'hypergraph',
    readOnly: true,          // 对源数据只读
    recallImplemented: false, // 期2 不提供检索（期3 才做）

    health(opts = {}) {
      try {
        const man = readManifest(root);
        if (!man) return { ok: false, reason: 'no-manifest', root, enabled };
        const shardCount = (man.shards || []).length;

        // 分片体积
        let shardBytes = 0;
        for (let i = 0; i < shardCount; i++) {
          const f = join(root, 'episodes', String(i).padStart(4, '0') + '.jsonl');
          if (existsSync(f)) shardBytes += statSync(f).size;
        }
        const gBytes = globalBytesOf(root);
        const globalTotal = Object.values(gBytes).reduce((a, b) => a + b, 0);

        // ---- 四类记录【实测】条数（不是抄 manifest 的 counts！）----
        // P0 教训：manifest.counts 曾写着 episodeEdges/topics/ordinaryEdges 都非 0，
        // 但落盘记录里只有 episode+fedge 两类。所以这里必须真读文件数。
        const rec = readAllRecords(root, shardCount);
        const byType = rec.byType;

        // ---- 三覆盖口径（期3 Stage3 只走 fedge，剩下的要靠 BM25 保底）----
        const alive = man?.sourceStat?.alive ?? 0;
        const epCovered = new Set();
        for (const ep of rec.episodes) for (const id of (ep.cardIds || [])) epCovered.add(id);
        const edgeCovered = new Set();
        for (const fe of rec.factEdges) for (const m of (fe.members || [])) {
          edgeCovered.add(typeof m === 'string' ? m : m.nodeId);
        }
        const noEdge = [];
        for (const ep of rec.episodes) {
          for (const id of (ep.cardIds || [])) if (!edgeCovered.has(id)) noEdge.push(id);
        }
        const pct = (n) => alive ? Number((n / alive * 100).toFixed(2)) : 0;
        const bm25Fallback = {
          alive,
          episodeCovered: epCovered.size,   episodeCoveredPct: pct(epCovered.size),
          edgeCovered: edgeCovered.size,    edgeCoveredPct: pct(edgeCovered.size),
          noEdge: noEdge.length,            noEdgePct: pct(noEdge.length),
          /** 进入 Episode 但没进任何 fedge 的卡（必须靠 BM25/普通边保底） */
          inEpisodeButNoEdge: noEdge.length,
        };

        // ---- 一致性断言：manifest.counts vs 实际落盘条数 ----
        const declared = man.counts || {};
        const mismatch = [];
        const cmp = (name, declaredN, actualN) => {
          if (typeof declaredN === 'number' && declaredN !== actualN) mismatch.push({ name, declared: declaredN, actual: actualN });
        };
        cmp('episodes', declared.episodes, byType.episode);
        cmp('factEdges', declared.factEdges, byType.fedge);
        cmp('episodeEdges', declared.episodeEdges, byType.eedge);
        cmp('topics', declared.topics, byType.topic);
        cmp('ordinaryEdges', declared.ordinaryEdges, byType.oedge);

        const allFourPresent = byType.eedge > 0 && byType.topic > 0 && byType.oedge > 0 && byType.fedge > 0;

        return {
          ok: shardCount > 0 && allFourPresent && mismatch.length === 0,
          root, enabled, shardCount,
          bytes: shardBytes + globalTotal,
          bytesBreakdown: { shards: shardBytes, globals: globalTotal, ...gBytes },
          counts: man.counts,
          /** 四类记录实测条数（health 的唯一权威口径） */
          recordCounts: byType,
          allFourPresent,
          countMismatch: mismatch,
          bm25Fallback,
          builtAt: man.builtAt,
        };
      } catch (e) {
        return { ok: false, reason: String(e?.message || e), root };
      }
    },

    /** 显式建图（不在启动时自动跑，防拖慢启动） */
    rebuild(buildOpts = {}) {
      const rep = buildAndPersist({ root, ...buildOpts });
      try { logger?.wake({ level: 'hypergraph-rebuild', ms: rep.ms, shards: rep.shards, reason: rep.reason }); } catch {}
      return rep;
    },

    /** 只读载入全部记录（期3 检索用）：四类一起给 */
    loadAll() {
      const man = readManifest(root);
      if (!man) return { episodes: [], factEdges: [], episodeEdges: [], topics: [], ordinaryEdges: [], byType: {} };
      return readAllRecords(root, (man.shards || []).length);
    },

    recall() { throw new Error('hypergraph: not-implemented in phase 2 (检索留期3)'); },
  };
}
