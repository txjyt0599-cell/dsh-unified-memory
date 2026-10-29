/**
 * spread.js —— 激活扩散（spreading activation）。零 IO。
 * 依据：_team-v2/p4/DESIGN.md §1.3.1；红队 H5（★队列上限 ≠ 输出上限）。
 *
 * 四个必须写死的点：
 *   ① 用**二叉堆优先队列**（按 activation 降序），不是先入先出；
 *   ② **queueCap（保险丝，默认 5000）** 与 **outputCap（真输出，默认 50）** 分开计；
 *      实测本图 3 跳峰值 335 / 5 跳 571 ⇒ queueCap 永远打不满，但必须留着；
 *   ③ minActivation 剪枝：出队时 act < 阈值直接 break（堆有序 ⇒ 后面全更小）；
 *   ④ 多锚点交集：anchors.length>=2 的节点排序时整组前置（不是把 bonus 混进单一分数）。
 *
 * 无超边卡（noEdge，期3 实测 1173 张 / 21.5%）：
 *   它们没有 fedge 邻居 ⇒ **activation 恒等于种子分**，hop=0，绝不因「扩散不到」被降权。
 *   本模块对「无邻居」只做一件事：原样保留它在 best 里的种子值（见 spread() 第 0 步）。
 */

import { WM_DEFAULTS, WM_HARD } from './types.js';

/** 最大堆（按 score 降序）。零依赖，数组手写，~40 行。 */
class MaxHeap {
  constructor() { this.a = []; }
  get size() { return this.a.length; }
  push(item) {
    const a = this.a;
    a.push(item);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p].score >= a[i].score) break;
      const t = a[p]; a[p] = a[i]; a[i] = t;
      i = p;
    }
  }
  pop() {
    const a = this.a;
    if (a.length === 0) return undefined;
    const top = a[0];
    const last = a.pop();
    if (a.length > 0) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1, r = l + 1;
        let big = i;
        if (l < a.length && a[l].score > a[big].score) big = l;
        if (r < a.length && a[r].score > a[big].score) big = r;
        if (big === i) break;
        const t = a[big]; a[big] = a[i]; a[i] = t;
        i = big;
      }
    }
    return top;
  }
  peek() { return this.a[0]; }
}

/**
 * 从期3 的检索 ctx 造一个邻接提供者。
 *
 * 邻居语义与 expandHypergraph 对齐（1 步：同 fedge 其他成员；无 fedge 退化到同 Episode 兄弟卡），
 * 但**只读、不建索引残留**，且 maxPerNode 默认 24（与期3 STAGE_GUARD.maxNeighbors 同值）。
 *
 * @param {object} ctx 期3 retriever 的 ctx：{ cardToEpisode, episodes, edgesByEpisode }
 * @param {{maxPerNode?:number, noEdgeMode?:'episode'|'none'}} [opts]
 */
export function createGraphAdapter(ctx, opts) {
  const o = opts || {};
  const maxPerNode = num(o.maxPerNode, 24);
  /** 'episode'（默认）= 无 fedge 时连同 Episode 兄弟卡；'none' = 无 fedge 就是孤立点 */
  const noEdgeMode = o.noEdgeMode === 'none' ? 'none' : 'episode';

  const cache = new Map();

  function neighborsOf(cardId) {
    if (cache.has(cardId)) return cache.get(cardId);
    const out = [];
    const epId = ctx && ctx.cardToEpisode ? ctx.cardToEpisode.get(cardId) : undefined;
    let produced = 0;

    if (epId !== undefined) {
      const edges = (ctx.edgesByEpisode && ctx.edgesByEpisode.get(epId)) || [];
      for (const edge of edges) {
        const members = edge.members || [];
        const mine = members.find(function (m) { return m.nodeId === cardId; });
        if (!mine) continue;
        for (const m of members) {
          if (m.nodeId === cardId) continue;
          const w = m.weight !== undefined && m.weight !== null ? Math.max(0.1, m.weight) : 1;
          out.push({ cardId: m.nodeId, weight: w });
          if (++produced >= maxPerNode) break;
        }
        if (produced >= maxPerNode) break;
      }

      if (produced === 0 && noEdgeMode === 'episode') {
        const meta = ctx.episodes && ctx.episodes.get(epId);
        for (const id of (meta && meta.cardIds ? meta.cardIds : [])) {
          if (id === cardId) continue;
          out.push({ cardId: id, weight: 0.8 });
          if (++produced >= maxPerNode) break;
        }
      }
    }

    cache.set(cardId, out);
    return out;
  }

  return {
    neighbors: neighborsOf,
    degree: function (cardId) { return neighborsOf(cardId).length; },
    get nodeCount() { return ctx && ctx.cardToEpisode ? ctx.cardToEpisode.size : 0; },
    /** 清缓存（图谱变更后调用） */
    clear: function () { cache.clear(); },
  };
}

/**
 * 激活扩散主类。
 *
 * @param {{neighbors:(id:string)=>Iterable<{cardId:string,weight:number}>, degree?:(id:string)=>number, nodeCount?:number}} graph
 * @param {object} [cfg] spread 配置（缺省取 WM_DEFAULTS.spread）
 */
export function createSpreader(graph, cfg) {
  const c = Object.assign({}, WM_DEFAULTS.spread, cfg || {});
  const decay = num(c.decay, 0.5);
  const maxHops = Math.max(0, Math.floor(num(c.maxHops, 3)));
  const minAct = num(c.minActivation, 0.01);
  const queueCap = Math.max(1, Math.floor(num(c.queueCap, 5000)));
  const outputCap = Math.max(1, Math.floor(num(c.outputCap, 50)));
  const maxSeeds = Math.max(1, Math.floor(num(c.maxSeeds, 5)));
  const bonus = num(c.intersectionBonus, 0.6);

  /**
   * 多锚点扩散。
   * @param {Array<{cardId:string, activation:number}>} seeds 种子（按上游分数降序，取前 maxSeeds）
   * @returns {{nodes:Array<{cardId:string,activation:number,hop:number,anchors:string[]}>, stats:object}}
   */
  function spread(seeds) {
    const t0 = Date.now();
    const heap = new MaxHeap();
    /** cardId -> { act, hop, anchors:Set } */
    const best = new Map();
    const seedList = (seeds || []).filter(function (s) { return s && s.cardId; }).slice(0, maxSeeds);

    // 第 0 步：种子自身入池（hop=0）。★ 无超边卡在这里拿到「种子分」，
    // 后面无论有没有邻居，都不会低于它 —— 这是「不许因扩散不到被降权」的实现点。
    for (const s of seedList) {
      const act = clamp01(num(s.activation, 0));
      const prev = best.get(s.cardId);
      if (prev === undefined) {
        const rec = { act: act, hop: 0, anchors: new Set([s.cardId]) };
        best.set(s.cardId, rec);
        heap.push({ cardId: s.cardId, score: act });
      } else {
        prev.anchors.add(s.cardId);
      }
    }

    let queuePeak = heap.size;
    let popped = 0;
    let truncatedByQueue = false;

    while (heap.size > 0) {
      if (popped >= queueCap) { truncatedByQueue = true; break; }   // ★ 队列上限（保险丝）
      const cur = heap.pop();
      popped++;
      const rec = best.get(cur.cardId);
      if (!rec) continue;
      // 剪枝：堆有序 ⇒ 当前最小分都低于阈值，后面更小
      if (rec.act < minAct) break;
      if (rec.hop >= maxHops) continue;

      const nbs = graph && typeof graph.neighbors === 'function' ? graph.neighbors(cur.cardId) : [];
      for (const nb of nbs) {
        if (!nb || !nb.cardId) continue;
        const next = rec.act * decay * Math.max(0.1, num(nb.weight, 1));
        if (next < minAct) continue;
        const prev = best.get(nb.cardId);
        if (prev === undefined) {
          const nr = { act: next, hop: rec.hop + 1, anchors: new Set(rec.anchors) };
          best.set(nb.cardId, nr);
          heap.push({ cardId: nb.cardId, score: next });
        } else {
          // 只累加锚点（交点检测），不改更好的 act
          let grew = false;
          for (const a of rec.anchors) if (!prev.anchors.has(a)) { prev.anchors.add(a); grew = true; }
          if (next > prev.act + WM_HARD.EPSILON) {
            prev.act = next;
            prev.hop = Math.min(prev.hop, rec.hop + 1);
            heap.push({ cardId: nb.cardId, score: next });
          } else if (grew) {
            // 交点信息变了，但分数不变 ⇒ 只重排一次（用原分），保证交点能被优先取出
            heap.push({ cardId: nb.cardId, score: prev.act });
          }
        }
        if (heap.size > queuePeak) queuePeak = heap.size;
      }
    }

    // 输出：先把交点整组前置，组内按 act 降序；再拼非交点。
    const all = [];
    for (const [cardId, rec] of best) {
      const anchors = Array.from(rec.anchors);
      const inter = anchors.length >= 2;
      all.push({
        cardId: cardId,
        activation: rec.act,
        hop: rec.hop,
        anchors: anchors,
        intersection: inter,
        rank: rec.act * (inter ? 1 + bonus : 1),
      });
    }
    all.sort(function (a, b) {
      if (a.intersection !== b.intersection) return a.intersection ? -1 : 1;
      return b.rank - a.rank || (a.cardId < b.cardId ? -1 : 1);
    });

    const truncatedByOutput = all.length > outputCap;
    const nodes = all.slice(0, outputCap).map(function (x) {
      return { cardId: x.cardId, activation: x.activation, hop: x.hop, anchors: x.anchors, intersection: x.intersection };
    });

    return {
      nodes: nodes,
      stats: {
        seeds: seedList.length,
        visited: best.size,
        popped: popped,
        queuePeak: queuePeak,
        queueCap: queueCap,
        outputCap: outputCap,
        truncatedByQueue: truncatedByQueue,
        truncatedByOutput: truncatedByOutput,
        intersections: all.filter(function (x) { return x.intersection; }).length,
        elapsedMs: Date.now() - t0,
        decay: decay, maxHops: maxHops, minActivation: minAct,
      },
    };
  }

  /** 只算统计（压测用，复用同一实现，防两套逻辑）。 */
  function probe(seeds) {
    const r = spread(seeds);
    return r.stats;
  }

  return { spread, probe, config: { decay, maxHops, minActivation: minAct, queueCap, outputCap, maxSeeds, intersectionBonus: bonus } };
}

function num(v, d) { const n = Number(v); return Number.isFinite(n) ? n : d; }
function clamp01(x) { if (!Number.isFinite(x)) return 0; return x < 0 ? 0 : x > 1 ? 1 : x; }

export { MaxHeap };
export default { createGraphAdapter, createSpreader, MaxHeap };
