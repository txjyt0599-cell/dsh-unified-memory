/**
 * working-memory.js —— 四层工作记忆装配器（L0~L3）+ 激活落盘 + 重启恢复。
 * 依据：_team-v2/p4/DESIGN.md §1.3.2 / §1.3.5；与期3 实际对接见 §0.1（expandHypergraph 改名）、§0.2（noEdge 1173 张）。
 *
 * 铁律（逐条对应红队条目）：
 *   ① L0 容量是**相对上限**（computeL0Budget），不许出现 500 token 硬限 —— 红队 B2
 *   ② 扩散 queueCap 与 outputCap 分开 —— 红队 H5
 *   ③ activation.json 原子写 + 文件锁 + α=0.7 EWMA 合并 —— 红队 L1
 *   ④ **无超边卡（noEdge 1173 张 / 21.5%）**：走 Stage1 BM25 原分入 L0，bonus=0，
 *      **不许被 Episode/fedge 过滤掉、不许因「扩散不到」被降权** —— 本期硬要求
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync, renameSync, unlinkSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { estimateTokens } from '../retrieval/types.js';
import { computeL0Budget, renderCardLine, isIntersection } from './budget.js';
import { parseSourceMessageId, lookupRound } from '../hypergraph/source.js';
import { createActivationStore, decayedActivation, DEFAULT_WM_DIR } from './activation-store.js';
import { createSpreader, createGraphAdapter } from './spread.js';
import { planEviction } from './evict.js';
import { resolveConfig, WM_REASON, RENDER_TIER, WM_HARD, WM_DEFAULTS } from './types.js';

export const STATE_PREFIX = 'wm-state-';

/**
 * 创建四层工作记忆。
 *
 * @param {{
 *   cards?: {header:(id:string)=>({id:string,title:string,summary:string,layer:string}|null),
 *            content?:(id:string)=>string|null},
 *   graph?: object,                 // 期3 的 ctx（{cardToEpisode, episodes, edgesByEpisode}）或已包装好的 NeighborProvider
 *   activation?: object,            // 注入现成 ActivationStore（测试用）
 *   dir?: string, logger?: object,
 *   enabled?: boolean,
 *   l0?:object, l1?:object, l2?:object, l3?:object, spread?:object, activationCfg?:object
 * }} [opts]
 */
export function createWorkingMemory(opts) {
  const o = opts || {};
  const cfg = resolveConfig({
    enabled: o.enabled,
    l0: o.l0, l1: o.l1, l2: o.l2, l3: o.l3, spread: o.spread, activation: o.activationCfg,
  });
  cfgGuard(cfg);
  const dir = o.dir || DEFAULT_WM_DIR;
  const logger = o.logger || null;

  const cards = o.cards || null;

  // [2026-10-22 by Assistant · L1→L0 详情] L0 反查索引（可选）。
  //   buildL0Index() 只在 warmup 时建一次（89MB 读盘约 10s）；
  //   渲染时只对**入选的卡**做 Map 查找（O(1)），不再读盘。
  //   开关默认关（WM_DEFAULTS.l0Detail = false），User验证后再开。
  // 懒加载：首次要用时才建（89MB 读盘 ~0.8s），不拖慢 apply
  let _l0Index = o.l0Index || null;
  let _l0Tried = !!o.l0Index;
  function getL0Index() {
    if (_l0Tried) return _l0Index;
    _l0Tried = true;
    try {
      if (typeof o.l0IndexProvider === 'function') _l0Index = o.l0IndexProvider() || null;
    } catch (e) { warn('l0-index-failed', e); _l0Index = null; }
    return _l0Index;
  }
  const l0DetailOn = (function () {
    const v = o.l0Detail;
    if (v === true) return true;
    if (v === false) return false;
    return null;   // null = 跟 cfg 走
  })();
  // [2026-10-21 by Assistant · 期4 扩散接线] graph 支持**惰性**解析。
  //   原因：期3 的 retriever.warmup() 是异步的（不 await，不能卡首字），
  //   建 workingMemory 那一刻 state.ctx 还没就绪。所以传 graphProvider，
  //   等第一次 assemble 真正要用图时再取。
  const graphOpts = o.spread && o.spread.maxNeighbors ? { maxPerNode: o.spread.maxNeighbors } : undefined;
  let graph = o.graph
    ? (typeof o.graph.neighbors === 'function' ? o.graph : createGraphAdapter(o.graph, graphOpts))
    : null;
  let graphResolved = graph !== null;
  function resolveGraph() {
    if (graphResolved) return graph;
    graphResolved = true;
    if (typeof o.graphProvider === 'function') {
      try {
        const g = o.graphProvider();
        if (g) graph = typeof g.neighbors === 'function' ? g : createGraphAdapter(g, graphOpts);
      } catch (e) { warn('graph-provider-failed', e); }
    }
    return graph;
  }

  const store = o.activation || createActivationStore({
    dir: dir,
    alpha: cfg.activation.alpha,
    halfLifeMs: cfg.activation.halfLifeMs,
    maxRecords: cfg.activation.maxRecords,
    lockStaleMs: cfg.activation.lockStaleMs,
    logger: logger,
  });
  // [2026-10-21 by Assistant · bug 修复] spreader 原来用 **createSpreader(graph, ...)** 立即构造，
  //   但惰性图在那时还是 null ⇒ spreader 永久拿不到图，扩散 seeds=5/visited=5 一个都扩不出来。
  //   ⇒ 改成惰性：首次真正要用时按已解析的 graph 建一次。
  let spreader = null;
  function resolveSpreader() {
    if (spreader !== null) return spreader;
    const g = resolveGraph();
    if (g) spreader = createSpreader(g, cfg.spread);
    return spreader;
  }

  /** 会话内四层（L0 每回合重建；L1 会话级） */
  const sessions = new Map();

  function sessionOf(sessionId) {
    const id = String(sessionId || 'anon');
    let s = sessions.get(id);
    if (!s) {
      s = { sessionId: id, cwd: null, turn: 0, l0: [], l1: new Map(), carry: new Set() };
      sessions.set(id, s);
    }
    return s;
  }

  function cardHeader(cardId) {
    if (cards && typeof cards.header === 'function') {
      const h = cards.header(cardId);
      if (h) return h;
    }
    return null;
  }

  /** 邻居是否无超边（degree 0）——用于给 noEdge 卡加标记与验收断言 */
  function isNoEdge(cardId) {
    if (!graph || typeof graph.degree !== 'function') return false;
    try { return graph.degree(cardId) === 0; } catch { return false; }
  }

  /**
   * 回合装配。
   *
   * @param {{sessionId:string, cwd?:string, queryText?:string, queryTokens?:number, turn?:number, retrieval?:object}} input
   * @param {Array<{id?:string, cardId?:string, score:number, via?:string, scoreParts?:object}>} candidates 期3 hits（原样透传，不重算）
   * @returns {{cards:Array, budget:object, spread:object|null, dropped:Array, stats:object}}
   */
  function assemble(input, candidates) {
    const inp = input || {};
    const sess = sessionOf(inp.sessionId);
    if (inp.cwd) sess.cwd = String(inp.cwd);
    if (inp.turn !== undefined) sess.turn = Number(inp.turn) || sess.turn;
    const now = Date.now();

    const t0 = Date.now();
    if (cfg.enabled === false) {
      const budget = computeL0Budget(0, cfg);
      return { cards: [], budget: budget, spread: null, dropped: [], stats: { disabled: true, ms: 0 } };
    }

    // ① 预算：输入 token 优先取上游实测值，缺省用 estimateTokens(queryText)
    const inputTokens = inp.queryTokens !== undefined && inp.queryTokens !== null
      ? Number(inp.queryTokens)
      : estimateTokens(String(inp.queryText || ''));
    const budget = computeL0Budget(inputTokens, cfg);

    // ② 候选归一（期3 hits 可能叫 id 或 cardId）
    const list = [];
    const seen = new Set();
    const raw = Array.isArray(candidates) ? candidates : [];
    const cap = Math.min(raw.length, WM_HARD.MAX_CANDIDATES);
    for (let i = 0; i < cap; i++) {
      const c = raw[i];
      if (!c) continue;
      const id = String(c.cardId || c.id || '');
      if (!id || seen.has(id)) continue;
      seen.add(id);
      list.push({
        cardId: id,
        score: Number(c.score) || 0,
        via: c.via || 'stage1',
        scoreParts: c.scoreParts || null,
        // ★ noEdge 标记：图谱里度为 0 / 无 fedge 且无同 Episode 兄弟
        noEdge: c.noEdge !== undefined ? !!c.noEdge : isNoEdge(id),
      });
    }

    // ③ 激活扩散（种子 = 前 maxSeeds；无图则跳过）
    //   惰性图：首次 assemble 时才向 retriever 要 ctx
    let spreadRes = null;
    const g = resolveGraph();
    const sp2 = resolveSpreader();
    if (g && sp2) {
      const seeds = list.slice(0, cfg.spread.maxSeeds).map(function (c) {
        return { cardId: c.cardId, activation: normalizeSeed(c.score) };
      });
      if (seeds.length > 0) {
        try { spreadRes = sp2.spread(seeds); } catch (e) { spreadRes = null; warn('spread-failed', e); }
      }
    }
    const spreadMap = new Map();
    if (spreadRes) for (const n of spreadRes.nodes) spreadMap.set(n.cardId, n);

    // ④ 合并候选池：期3 候选 + 扩散新卡（扩散只补上下文，不改期3 命中排序）
    const merged = list.map(function (c) {
      const sp = spreadMap.get(c.cardId);
      return Object.assign({}, c, {
        spreadActivation: sp ? sp.activation : 0,
        anchorCount: sp ? sp.anchors.length : (c.via === 'alias' ? 1 : 1),
        fromSpread: false,
      });
    });
    const haveIds = new Set(merged.map(function (x) { return x.cardId; }));
    if (spreadRes) {
      for (const n of spreadRes.nodes) {
        if (haveIds.has(n.cardId)) continue;
        haveIds.add(n.cardId);
        merged.push({
          cardId: n.cardId, score: 0, via: 'spread', scoreParts: null,
          noEdge: isNoEdge(n.cardId),
          spreadActivation: n.activation, anchorCount: n.anchors.length, fromSpread: true,
        });
      }
    }

    // ⑤ 排序：交点整组前置 → 组内按「期3 分 × 扩散加成」，但 **noEdge 卡不提也不降**
    //    核心：noEdge 卡的 finalScore 就是它的 Stage1 原分（spreadActivation=0 ⇒ gain=1）。
    // [2026-10-22 by Assistant · 架构修复] 引入时间新鲜度。
    //   原架构：finalScore = base × gain，**时间完全不参与**；
    //   渲染档位又按 BM25 排名给 ⇒ 「两天前刚发生的」和「两周前的」一样长甚至更短。
    //   现在：recency = 0.5^(ageDays/halfLife) 进 finalScore，
    //   并在下面按 recency 分配渲染档位（越近越详细）。
    const NOW_MS = Date.now();
    const DAY_MS = 86400000;
    const rc = cfg.recency || {};
    const HALF_LIFE = Number(rc.halfLifeDays) || 7;
    const W_RECENCY = rc.weight !== undefined ? Number(rc.weight) : 0.6;

    function recencyOf(cardId) {
      const h = cardHeader(cardId);
      const created = h && h.createdAt ? Number(h.createdAt) : 0;
      if (!created) return { recency: 0, ageDays: Infinity };
      const ageDays = Math.max(0, (NOW_MS - created) / DAY_MS);
      return { recency: Math.pow(0.5, ageDays / HALF_LIFE), ageDays: ageDays };
    }

    const scored = merged.map(function (c) {
      const isInter = isIntersection(c.anchorCount);
      const gain = 1 + cfg.spread.intersectionBonus * clamp01(c.spreadActivation);
      const base = c.score;
      const r = recencyOf(c.cardId);
      return Object.assign({}, c, {
        intersection: isInter,
        recency: r.recency,
        ageDays: r.ageDays,
        finalScore: base * gain * (1 + W_RECENCY * r.recency),
        reason: c.via === 'spread' ? WM_REASON.spread : (isInter ? WM_REASON.intersection : WM_REASON.retrieval),
      });
    });
    // ══════════════════════════════════════════════════════════════════
    // [2026-10-27 by Assistant · 第3步 Episode 语义分簇 + 簇内时间正序]
    //
    // 【为什么】原来纯按 finalScore 堆叠 ⇒ 同一件事的卡被别的高分卡插散，
    //   读起来像翻相册（一张张孤立照片），而不是一条有因果的时间线。
    //
    // 【怎么做】
    //   ① 簇键 = 超图 Episode（天然是「一次完整的事」，现成 1692 个）；
    //      无 Episode 的卡各自成单卡簇（不硬凑）。
    //   ② 簇间按该簇最高 finalScore 降序 —— 保住相关性，最贴题的簇仍在最前。
    //   ③ 簇内按 eventTs（无则 createdAt，再无则 recency 兜底）**升序** ——
    //      顺着「发现问题 → 排查 → 闭环」的自然时间轴流。
    //
    // 【时间口径铁律】优先 eventTs（真实事件时间），绝不默认用 createdAt 蒙混。
    // ══════════════════════════════════════════════════════════════════
    const CLUSTER_ON = cfg.clusterByEpisode !== false;
    function eventTsOf(cardId) {
      const h = cardHeader(cardId);
      const e = h && Number(h.eventTs);
      if (Number.isFinite(e) && e > 0) return e;
      const cre = h && Number(h.createdAt);
      if (Number.isFinite(cre) && cre > 0) return cre;
      return 0;
    }
    function episodeOf(cardId) {
      try {
        const map = graph && graph.cardToEpisode;
        if (map && typeof map.get === 'function') return String(map.get(cardId) || '');
      } catch {}
      return '';
    }

    if (CLUSTER_ON) {
      // 分簇
      const clusterMap = new Map();
      for (const it of scored) {
        const ep = episodeOf(it.cardId);
        const key = ep ? ('ep:' + ep) : ('card:' + it.cardId);
        if (!clusterMap.has(key)) clusterMap.set(key, []);
        clusterMap.get(key).push(it);
      }
      const clusters = [];
      for (const [key, arr] of clusterMap) {
        let best = -Infinity;
        for (const it of arr) if (it.finalScore > best) best = it.finalScore;
        // 簇内：按 eventTs 升序（因果时间线）
        arr.sort(function (a, b) {
          const ta = eventTsOf(a.cardId), tb = eventTsOf(b.cardId);
          if (ta && tb && ta !== tb) return ta - tb;
          if (ta && !tb) return -1;
          if (!ta && tb) return 1;
          return b.finalScore - a.finalScore;
        });
        clusters.push({ key, arr, best });
      }
      // 簇间：最高分降序；同分按簇内最早时间升序
      clusters.sort(function (a, b) {
        if (b.best !== a.best) return b.best - a.best;
        const ta = eventTsOf(a.arr[0].cardId), tb = eventTsOf(b.arr[0].cardId);
        return (ta || 0) - (tb || 0);
      });
      scored.length = 0;
      for (const cl of clusters) for (const it of cl.arr) scored.push(it);
      Object.defineProperty(scored, '_clusters', { value: clusters.length, enumerable: false });
    } else {
      scored.sort(function (a, b) {
        if (a.intersection !== b.intersection) return a.intersection ? -1 : 1;
        return b.finalScore - a.finalScore || (a.cardId < b.cardId ? -1 : 1);
      });
    }

    // ⑥ 塞预算：第1张 full / 2~3 summary / 其余 title；卡边只丢该张不 break（后面有更便宜的）
    const picked = [];
    const dropped = [];
    let used = budget.headerTokens;
    // [2026-10-22 by Assistant · 核心改造：越近越详细]
    //   旧逻辑：第 1 名给 full、2~3 名给 summary、其余 title —— **档位跟着 BM25 排名**。
    //   后果：两天前刚发生的事可能只拿到标题，两周前的老事反而拿 full。
    //   新逻辑：先按 recency 选出「最近 detailTop 条」→ 它们拿 full/summary（详细），
    //   其余一律 title（只给入口）。排序（相关性）不变，只改「给多少字」。
    const DETAIL_TOP = Number(rc.detailTop) || 3;
    const SHOW_AGE = rc.showAge !== false;
    const detailIds = scored
      .filter(function (c) { return c.recency > 0; })
      .slice()
      .sort(function (a, b) { return b.recency - a.recency; })
      .slice(0, DETAIL_TOP)
      .map(function (c) { return c.cardId; });
    const detailRank = new Map();
    detailIds.forEach(function (id, i) { detailRank.set(id, i); });

    for (const c of scored) {
      if (picked.length >= budget.maxCards) { dropped.push({ cardId: c.cardId, costTokens: 0, reason: 'cap' }); continue; }
      const h = cardHeader(c.cardId);
      // 档位由 **recency** 决定，不由 BM25 名次决定
      const rank = detailRank.has(c.cardId) ? detailRank.get(c.cardId) : -1;
      const tier = rank === 0 ? RENDER_TIER.full : (rank > 0 ? RENDER_TIER.summary : RENDER_TIER.title);
      const title = h ? h.title : c.cardId;
      const summary = h ? h.summary : '';
      const layer = h ? h.layer : 'global';
      const ageLabel = (SHOW_AGE && Number.isFinite(c.ageDays))
        ? (c.ageDays < 1 / 24 ? '刚刚'
          : c.ageDays < 1 ? Math.round(c.ageDays * 24) + '小时前'
          : c.ageDays < 30 ? Math.round(c.ageDays) + '天前'
          : Math.round(c.ageDays / 30) + '个月前')
        : '';
      // [L1→L0 详情] 只对 full/summary 档填原话；title 档不填（省预算）
      let l0Detail = null;
 let rawCard = null;
 try { if (cards && typeof cards.get === 'function') rawCard = cards.get(c.cardId); } catch {}
 const wantL0 = rawCard && rawCard._source === 'l0' ? true : (l0DetailOn === null ? cfg.l0Detail === true : l0DetailOn);
      if (wantL0 && tier !== RENDER_TIER.title) {
        const l0Index = getL0Index();
        try {
          // 源 ID 在完整卡对象上（snake_case 是 tdai 原字段），不在 header 里
          if (rawCard && rawCard._source === 'l0' && rawCard.l0User) {
 l0Detail = { user: { content: rawCard.l0User }, assistant: rawCard.l0Assistant ? { content: rawCard.l0Assistant } : null };
 }
 const srcIds = rawCard
            ? (Array.isArray(rawCard.source_message_ids) ? rawCard.source_message_ids
              : (Array.isArray(rawCard.sourceMessageIds) ? rawCard.sourceMessageIds : null))
            : null;
          let parsed = null;
          for (const sid of (srcIds || [])) {
            const ps = parseSourceMessageId ? parseSourceMessageId(sid) : null;
            if (ps) { parsed = ps; break; }
          }
            if (parsed) {
              const round = lookupRound ? lookupRound(l0Index, parsed.sessionKey, parsed.ts, { windowMs: cfg.l0DetailWindowMs || 1000 }) : null;
              if (round) l0Detail = round;
            }
        } catch {}
      }
      // [Round 47-51 红队死结1修复] 必须透传 id，供被动注入渲染 [id: xxx] 瞄准靶心
      const r = renderCardLine(
        { id: c.cardId, title: title, summary: summary, layer: layer, ageLabel: ageLabel, l0Detail: l0Detail,
          // [2026-10-27 · 第2步] 前情脉络透传（来自卡片的 arc_story）
          arcStory: (function () {
            try { const raw = cards && typeof cards.get === 'function' ? cards.get(c.cardId) : null;
                  return raw && raw.arc_story ? String(raw.arc_story) : ''; } catch { return ''; }
          })() },
        tier, null, null,
        { l0Detail: wantL0, l0DetailChars: cfg.l0DetailChars }
      );
      if (used + r.costTokens > budget.l0CapTokens && picked.length > 0) {
        dropped.push({ cardId: c.cardId, costTokens: r.costTokens, reason: 'budget' });
        continue;
      }
      used += r.costTokens;
      picked.push({
        cardId: c.cardId, title: title, level: 'L0', tier: tier,
        costTokens: r.costTokens, activation: c.spreadActivation,
        retrieveScore: c.score, reason: c.reason,
        noEdge: !!c.noEdge, line: r.line,
        recency: c.recency, ageDays: c.ageDays, tier: tier,
      });
      // L1 记账（会话级）
      const rec = store.get(c.cardId);
      sess.l1.set(c.cardId, {
        cardId: c.cardId,
        activation: Math.max(rec ? rec.activation : 0, clamp01(c.spreadActivation || c.score || 0)),
        lastHitAt: now,
      });
    }

    // ⑦ L1 淘汰
    const ev = planEviction(Array.from(sess.l1.values()), 'L1', cfg, now);
    for (const rm of ev.removed) sess.l1.delete(rm.cardId);

    sess.l0 = picked;
    const ms = Date.now() - t0;
    const budgetOut = Object.assign({}, budget, { usedTokens: used, remainingTokens: budget.l0CapTokens - used });

    return {
      cards: picked,
      budget: budgetOut,
      spread: spreadRes ? spreadRes.stats : null,
      dropped: dropped,
      stats: {
        ms: ms,
        candidates: list.length,
        picked: picked.length,
        dropped: dropped.length,
        noEdgeInCandidates: list.filter(function (c) { return c.noEdge; }).length,
        noEdgeInL0: picked.filter(function (c) { return c.noEdge; }).length,
        evictedL1: ev.removed.length,
        l1Size: sess.l1.size,
      },
    };
  }

  /** 渲染注入段（只拼 L0；HEADER 由调用方给，成本已计入预算）。 */
  function render(admission, headerText) {
    const cards = (admission && admission.cards) || [];
    if (cards.length === 0) return '';
    const header = String(headerText || '');
    const lines = cards.map(function (c) { return c.line; });
    return header ? header + '\n' + lines.join('\n') : lines.join('\n');
  }

  /** 回合结束：L0 清空 + 写回激活（EWMA）。 */
  function commitTurn(input, outcome) {
    const inp = input || {};
    const sess = sessionOf(inp.sessionId);
    const now = Date.now();
    const used = (outcome && Array.isArray(outcome.usedCardIds) && outcome.usedCardIds.length)
      ? new Set(outcome.usedCardIds)
      : null;
    const expanded = new Set((outcome && Array.isArray(outcome.expanded)) ? outcome.expanded : []);
    const reinforced = [];
    for (const c of sess.l0) {
      const hit = used === null ? 1 : (used.has(c.cardId) ? 1 : 0.4);
      const boost = expanded.has(c.cardId) ? 1 : 0.8;
      const incoming = clamp01(Math.max(0.1, (c.retrieveScore || c.activation || 0.5)) * hit * boost);
      store.reinforce(c.cardId, incoming, sess.sessionId, now);
      reinforced.push(c.cardId);
    }
    sess.l0 = [];
    return { reinforced: reinforced };
  }

  /** L1 恢复：跨会话/重启把上一份状态的 L1 按时间衰减搬进来。 */
  function restoreL1(snapshot, now) {
    const t = Number(now) || Date.now();
    const snap = snapshot && snapshot.state ? snapshot.state : snapshot;
    if (!snap || !Array.isArray(snap.l1)) return null;
    const sess = sessionOf(snap.sessionId || 'anon');
    // ⑦ F2 修正：基准取「store 记录」与「state 条目」中 **lastUpdate 更新的一方**，
    //    再按半衰期折算。只认 store 会把「7 天前激活、今天才落盘」的卡当成刚激活（不衰减）。
    const entries = snap.l1.map(function (x) {
      const stored = store.get(x.cardId);
      const fromState = { cardId: x.cardId, activation: x.activation, lastUpdate: x.lastHitAt || snap.savedAt || t };
      let base = fromState;
      if (stored) {
        const stAt = Number(stored.lastUpdate) || 0;
        const seAt = Number(fromState.lastUpdate) || 0;
        base = stAt >= seAt ? stored : fromState;
      }
      return {
        cardId: x.cardId,
        activation: decayedActivation(base, t, cfg.activation.halfLifeMs),
        lastHitAt: t,
        baseAt: Number(base.lastUpdate) || 0,
      };
    });
    const ev = planEviction(entries, 'L1', cfg, t);
    for (const id of ev.keptIds) {
      const e = entries.find(function (x) { return x.cardId === id; });
      sess.l1.set(id, { cardId: id, activation: e.activation, lastHitAt: t, carried: true });
      sess.carry.add(id);
    }
    return { level: 'L1', removed: ev.removed, kept: ev.kept, carried: ev.keptIds.slice() };
  }

  /** 落盘：activation.json + wm-state-<session>.json（原子写）。 */
  function persist(now) {
    const t = Number(now) || Date.now();
    mkdirSync(dir, { recursive: true });
    const a = store.flush(t);

    const paths = [];
    let bytes = a.bytes || 0;
    for (const sess of sessions.values()) {
      const state = {
        version: 1,
        sessionId: sess.sessionId,
        cwd: sess.cwd || '',
        turn: sess.turn || 0,
        l1: Array.from(sess.l1.values()).map(function (x) {
          return { cardId: x.cardId, activation: x.activation, lastHitAt: x.lastHitAt || t };
        }),
        savedAt: t,
      };
      const file = join(dir, STATE_PREFIX + safeName(sess.sessionId) + '.json');
      const tmp = file + '.tmp-' + process.pid + '-' + t;
      try {
        writeFileSync(tmp, JSON.stringify(state), 'utf8');
        if (existsSync(file)) { try { unlinkSync(file + '.bak'); } catch {} ; try { renameSync(file, file + '.bak'); } catch {} }
        renameSync(tmp, file);
        paths.push(file);
        bytes += state.l1.length;
      } catch (e) {
        try { unlinkSync(tmp); } catch {}
        warn('persist-state-failed', String(e && e.message || e));
      }
    }
    return { activationPath: a.path, statePaths: paths, bytes: bytes, skipped: a.skipped || null };
  }

  /** 读回某个会话的状态（重启恢复用）。 */
  function loadState(sessionId, pathOverride) {
    const file = pathOverride || join(dir, STATE_PREFIX + safeName(sessionId) + '.json');
    for (const p of [file, file + '.bak']) {
      if (!existsSync(p)) continue;
      try {
        const s = JSON.parse(readFileSync(p, 'utf8'));
        if (s && Array.isArray(s.l1)) return s;
      } catch (e) { warn('load-state-failed', p + ': ' + String(e && e.message || e)); }
    }
    return null;
  }

  /** 列出所有状态文件（诊断用）。 */
  function listStates() {
    try { return readdirSync(dir).filter(function (n) { return n.startsWith(STATE_PREFIX) && n.endsWith('.json'); }); }
    catch { return []; }
  }

  function snapshot(sessionId) {
    const sess = sessionOf(sessionId);
    return {
      sessionId: sess.sessionId,
      l0: sess.l0.slice(),
      l1: Array.from(sess.l1.values()),
      l1Ids: Array.from(sess.l1.keys()),
      carried: Array.from(sess.carry),
      activationSize: store.size(),
    };
  }

  function warn(code, detail) {
    try { logger && logger.miss && logger.miss({ level: 'wm-' + code, reason: String(detail && detail.message || detail) }); } catch {}
  }

  return {
    cfg, dir, store,
    // [2026-10-21 by Assistant] spreader / graph 已惰性化 ⇒ 导出必须用 getter，
    //   否则外部拿到的永远是创建时的 null（p4 的 G7 直接读 wm.spreader，因此崩了）。
    get spreader() { return resolveSpreader(); },
    get graph() { return resolveGraph(); },
    assemble, render, commitTurn, restoreL1, persist, loadState, listStates, snapshot,
    loadActivation: function (now) { return store.load(now); },
    isNoEdge: isNoEdge,
    health: function () {
      return {
        enabled: cfg.enabled !== false,
        graph: graph ? (typeof graph.nodeCount === 'number' ? graph.nodeCount : null) : null,
        activationRecords: store.size(),
        sessions: sessions.size,
        warnings: store.warnings().length,
        caps: { l0: cfg.l0, l1: cfg.l1, l2: cfg.l2, l3: cfg.l3 },
      };
    },
  };
}

function safeName(s) { return String(s || 'anon').replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 80); }
function clamp01(x) { if (!Number.isFinite(x)) return 0; return x < 0 ? 0 : x > 1 ? 1 : x; }
/** 种子激活：期3 的分是归一化后的 0..1 加分，直接 clamp；>1 的按 1 处理。 */
function normalizeSeed(score) { return clamp01(Number(score) || 0); }
function cfgGuard(cfg) { if (!cfg || !cfg.l0) throw new Error('working-memory: 配置缺失'); }

export { DEFAULT_WM_DIR };
export default { createWorkingMemory, STATE_PREFIX, DEFAULT_WM_DIR };
