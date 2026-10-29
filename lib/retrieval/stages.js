/**
 * stages.js —— 三级粗到细检索的纯函数组 + 超图扩展。零 IO（ctx 由 retriever 注入）。
 * 依据：DESIGN §1.5 / §1.5.2b / §3.3 验收 C / §3.7 验收 G。
 *
 * 三条铁律：
 *   ① Stage1 扫**全部活卡**，不许按「有无超边」预过滤（DESIGN §1.5.2b）
 *   ② Stage3 **只加分不准入**；无超边卡 bonus = 0，但保留 Stage1 原始分
 *   ③ expandHypergraph 的 maxPathHops 接受 1|2，>2 才抛错（红队 P0-1 修正）
 */

import { STAGE_GUARD, assertPathHops, assertRelationEdges } from './types.js';
import { searchBm25 } from './bm25.js';

/** 扩展时的衰减：每跳 x0.5（ACT-R / NeuralMemory 惯例） */
const HOP_DECAY = 0.5;

/**
 * Stage1：卡级 BM25 粗筛。
 *
 * ⚠️ 保底铁律：直接把**全部活卡**交给 searchBm25，**不做任何按超边/Episode 的预过滤**。
 *    1,172 张（21.6%）无超边卡就是靠这一步进结果的，一过滤它们就永远消失且不报错。
 *
 * @param {object} ctx
 * @param {string} query
 * @param {number} kT
 * @param {{candidatePool?:number}} [opts]
 */
export function stage1(ctx, query, kT, opts) {
  const pool = (opts && opts.candidatePool) || STAGE_GUARD.candidatePool;
  const raw = searchBm25(ctx.bm25, query, pool);

  // 归一化：除以本轮最高分，让 Stage2/3 的 bonus 权重可比较
  let max = 0;
  for (const p of raw) if (p[1] > max) max = p[1];
  const norm = max > 0 ? raw.map(function (p) { return [p[0], p[1] / max]; }) : raw.map(function (p) { return [p[0], 0]; });

  // Topic 加分信号（可选）：按 projectId 聚合，索引无 topic 记录时为空 Map
  const byTopic = new Map();
  for (const p of norm) {
    const ep = ctx.cardToEpisode.get(p[0]);
    if (ep === undefined) continue;
    const meta = ctx.episodes.get(ep);
    if (!meta || !meta.projectId) continue;
    byTopic.set(meta.projectId, (byTopic.get(meta.projectId) || 0) + p[1]);
  }

  // ========================================================================
  // [2026-10-22 by Assistant · 期6 P0-a] 双池分离 + L3(Topic) 接通
  //
  // 背景（Lead 实测）：
  //   ① engram(5496) 与 tdai(3161) 混在一个 BM25 池（8633 张），字面去重只抓到
  //      0.76%（24 条）—— 同主题在两套里措辞完全不同，指纹对不上。
  //      后果：池子被稀释，且同一件事可能被召回两次。
  //   ② stage1 算出的 byTopic **从来没被消费过**（retriever 里 grep 为 0 次），
  //      L3(Topic) 层事实上是死代码。
  //
  // 做法（两条都可配置、默认不改变行为）：
  //   A. sourceWeight：对 tdai 卡（id 前缀 'tdai:'）乘一个系数。**默认 1.0 = 不降权 = 旧行为**。
  //      要启用双池倾向时设 <1（建议 0.85）：tdai 是「场景叙述」，engram 是「结论卡」，
  //      结论优先但不排除场景。
  //   B. topicBoost：用 byTopic 给「属于高分 Topic 的卡」线性加分（默认 0）。
  //      只加分不准入 —— 与 Stage3 同一铁律，防止 Topic 数据不全时误杀。
  //
  // 边界（诚实标注）：
  //   - 449 个 Topic 里 383 个没有 projectId（85%）⇒ topicBoost 现在只对 15% 生效。
  //     数据补齐前，这一项收益有限，但不做就是 0。
  //   - 两项都读 ctx 上的可选字段，缺省时**逐位等同旧行为**（可用 selftest 钉住）。
  // ========================================================================
  const sourceWeight = (opts && Number.isFinite(Number(opts.sourceWeight)))
    ? Math.max(0, Number(opts.sourceWeight))
    : (ctx && Number.isFinite(Number(ctx.sourceWeight)) ? Number(ctx.sourceWeight) : 1);
  const topicBoost = (opts && Number.isFinite(Number(opts.topicBoost)))
    ? Math.max(0, Number(opts.topicBoost))
    : (ctx && Number.isFinite(Number(ctx.topicBoost)) ? Number(ctx.topicBoost) : 0);

  let sameSourceHit = 0;
  let topicBoosted = 0;
  const rescored = norm.map(function (p) {
    let s = p[1];
    // A. 跨源降权：只作用于 tdai（engram 是主源，权重 1）
    //    ⚠️ 不用 ctx.cards（ctx 里没有这个字段，会静默失效）。
    //    tdai 卡的 id 带 'tdai:' 前缀（见 hypergraph/source.js 的 readTdaiRecords），
    //    这个前缀是硬约定，且已写进 DESIGN，用它判断最稳且零额外内存。
    //    只在真的降权时才计数（sourceWeight===1 时乘 1 等于没变，计数会误报「已降权」）
    if (String(p[0]).indexOf('tdai:') === 0 && sourceWeight !== 1) { s = s * sourceWeight; sameSourceHit++; }
    // B. Topic 加分：卡 → Episode → projectId → byTopic 分数（归一化到本轮最高）
    if (topicBoost > 0) {
      const ep = ctx.cardToEpisode.get(p[0]);
      if (ep !== undefined) {
        const meta = ctx.episodes.get(ep);
        const pid = meta && meta.projectId;
        if (pid && byTopic.size) {
          let maxT = 0;
          for (const v of byTopic.values()) if (v > maxT) maxT = v;
          const tv = byTopic.get(pid) || 0;
          if (maxT > 0 && tv > 0) { s = s + topicBoost * (tv / maxT); topicBoosted++; }
        }
      }
    }
    return [p[0], s];
  });

  return {
    candidates: rescored,
    byTopic,
    topic: { sourceWeight, topicBoost, sameSourceHit, topicBoosted },
    /** 供验收断言：本轮 Stage1 实际扫了多少卡（必须等于全部活卡） */
    scanned: ctx.bm25.N,
  };
}

/**
 * Stage2：卡 → Episode 聚合。
 * epScore(ep) = max_{d ∈ ep} (bm25Norm(d) * weightScale(ep))
 * 用 max 不 sum：sum 会让大 Episode 天然占优（DESIGN §1.5）。
 *
 * @param {object} ctx
 * @param {{candidates:Array<[string,number]>}} s1
 * @param {number} kE
 * @param {{minEpisodeK?:number}} [opts]
 */
export function stage2(ctx, s1, kE, opts) {
  // G1 硬护栏：kE 不许低于 20（实测 kE=10 掉 11pp）
  const minK = Math.max(STAGE_GUARD.minEpisodeK, (opts && opts.minEpisodeK) || 0);
  const k = Math.max(kE || 0, minK);

  const epScore = new Map();
  for (const pair of (s1 && s1.candidates ? s1.candidates : [])) {
    const cardId = pair[0];
    const sc = pair[1];
    const epId = ctx.cardToEpisode.get(cardId);
    if (epId === undefined) continue;
    const meta = ctx.episodes.get(epId);
    const ws = meta && meta.weightScale !== undefined && meta.weightScale !== null ? meta.weightScale : 1;
    const v = sc * ws;
    const prev = epScore.get(epId);
    if (prev === undefined || v > prev) epScore.set(epId, v);
  }

  const topEpisodes = Array.from(epScore.entries())
    .sort(function (a, b) { return b[1] - a[1]; })
    .slice(0, k);

  return { topEpisodes, appliedK: k };
}

/**
 * Stage3：Episode → 成员卡展开，按边内权重加分（**只加分不准入**）。
 * 无 fedge 的 Episode：成员卡 bonus 记 0，靠 Stage1 原始分活下来。
 *
 * @param {object} ctx
 * @param {{topEpisodes:Array<[string,number]>}} s2
 * @param {number} kF
 * @param {{wEdge?:number, maxCandidates?:number}} [opts]
 */
export function stage3(ctx, s2, kF, opts) {
  const maxCand = (opts && opts.maxCandidates) || STAGE_GUARD.maxCandidates;
  const scored = new Map();
  let withEdge = 0;
  let withoutEdge = 0;

  for (const pair of (s2 && s2.topEpisodes ? s2.topEpisodes : [])) {
    const epId = pair[0];
    const eps = ctx.edgesByEpisode.get(epId);
    const meta = ctx.episodes.get(epId);
    const cardIds = meta && meta.cardIds ? meta.cardIds : [];

    if (eps && eps.length) {
      withEdge++;
      for (const edge of eps) {
        for (const m of (edge.members || [])) {
          const w = m && m.weight !== undefined ? m.weight : 0;
          const prev = scored.get(m.nodeId);
          if (prev === undefined || w > prev) scored.set(m.nodeId, w);
        }
      }
    } else {
      withoutEdge++;
    }
    // 无 fedge 的成员卡：bonus = 0（保留 Stage1 原始分，不淘汰）
    for (const cid of cardIds) {
      if (!scored.has(cid)) scored.set(cid, 0);
    }
  }

  const list = Array.from(scored.entries())
    .sort(function (a, b) { return b[1] - a[1]; })
    .slice(0, maxCand);

  return { scored: list, episodesWithEdge: withEdge, episodesWithoutEdge: withoutEdge };
}

/**
 * 超图扩展（红队 P0-1 修正后的定义）。
 *
 * 两轮语义（写死，便于验收复现）：
 *   · pathHops = 1：种子卡 → 所属超边（fedge）→ 同边其他成员；
 *                   若该卡无 fedge，退回「同 Episode 的兄弟卡」。
 *   · pathHops = 2：在 1 步结果之上再扩一轮（新卡再走一次同样规则）。
 *
 * ⚠️ 与「传播轮次」不是一回事：HyperMem 的 propagationRound 是**同超边内聚合**，
 *    不走边；这里走的是图距离。两者不可混称。
 *
 * 护栏：
 *   · maxPathHops 只接受 1 或 2，>2 抛错（>2 才病态，不是「2 不可能」）
 *   · includeRelationEdges=true 抛错（P1：因果边最大出度 105，未实测前不许纳入）
 *
 * @param {object} ctx
 * @param {string[]} seeds
 * @param {{maxPathHops?:1|2, maxNeighbors?:number, minActivation?:number, includeRelationEdges?:boolean}} [opts]
 * @returns {Array<{cardId:string, from:string, pathHops:1|2, activation:number}>}
 */
export function expandHypergraph(ctx, seeds, opts) {
  const hops = assertPathHops(opts ? opts.maxPathHops : undefined);
  assertRelationEdges(opts ? opts.includeRelationEdges : false);

  const maxN = opts && opts.maxNeighbors !== undefined ? opts.maxNeighbors : STAGE_GUARD.maxNeighbors;
  const minAct = opts && opts.minActivation !== undefined ? opts.minActivation : STAGE_GUARD.minActivation;

  const visited = new Set(seeds || []);
  const out = [];
  const seedList = (seeds || []).filter(Boolean);

  /** 单轮：从 from 卡出发，找它的同边成员 / 同 Episode 兄弟卡 */
  function round(fromCards, hop, parentAct, fromLabel) {
    for (const src of fromCards) {
      const epId = ctx.cardToEpisode.get(src);
      if (epId === undefined) continue;

      // 主路：沿 fedge（同边其他成员）
      const edges = ctx.edgesByEpisode.get(epId) || [];
      let produced = 0;
      for (const edge of edges) {
        const members = edge.members || [];
        if (!members.some(function (m) { return m.nodeId === src; })) continue;
        for (const m of members) {
          const id = m.nodeId;
          if (id === src || visited.has(id)) continue;
          const act = parentAct * HOP_DECAY * (m.weight !== undefined ? Math.max(0.1, m.weight) : 1);
          if (act < minAct) continue;
          visited.add(id);
          out.push({ cardId: id, from: fromLabel || src, pathHops: hop, activation: act });
          produced++;
          if (out.length >= maxN) return true;
        }
      }

      // 兜底：该卡无 fedge ⇒ 走「同 Episode 兄弟卡」（保住 21.6% 无超边卡的上下文）
      if (produced === 0) {
        const meta = ctx.episodes.get(epId);
        for (const id of (meta && meta.cardIds ? meta.cardIds : [])) {
          if (id === src || visited.has(id)) continue;
          const act = parentAct * HOP_DECAY * 0.8;
          if (act < minAct) continue;
          visited.add(id);
          out.push({ cardId: id, from: fromLabel || src, pathHops: hop, activation: act });
          produced++;
          if (out.length >= maxN) return true;
        }
      }
    }
    return false;
  }

  // 第 1 步
  const overflow1 = round(seedList, 1, 1.0, null);
  if (!overflow1 && hops >= 2) {
    // 第 2 步：从第 1 步新得的卡再扩一轮
    const layer1 = out.map(function (x) { return x.cardId; });
    round(layer1, 2, HOP_DECAY, null);
  }
  return out;
}

/** 兼容别名（DESIGN §1.5：期内不删，期4 再清）；语义同 expandHypergraph，默认 1 步 */
export const expandOneHop = expandHypergraph;

export default { stage1, stage2, stage3, expandHypergraph, expandOneHop };
