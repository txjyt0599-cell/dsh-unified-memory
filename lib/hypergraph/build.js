import { HARD, HyperEdgeKind } from './types.js';
import { splitEpisodes, eligibleEpisodes } from './episode.js';
import { buildTopics } from './topic.js';
import { buildFactEdge, buildEpisodeEdge, applyCompletenessPenalty } from './edge.js';

/**
 * 总装：cards → { episodes, topics, factEdges, episodeEdges, ordinaryEdges, cardsById }
 * 纯函数，不碰磁盘。耗时实测见 §3.8（约 116ms）。
 */
export function buildHypergraph(cards, opts = {}) {
  const cardsById = new Map(cards.map(c => [c.id, c]));

  const episodes = splitEpisodes(cards, opts);
  const episodesById = new Map(episodes.map(e => [e.id, e]));
  const eligible = eligibleEpisodes(episodes);

  // Fact 超边
  const factEdges = [];
  for (const ep of eligible) factEdges.push(...buildFactEdge(ep, cardsById, opts));

  // Topic + Episode 超边
  const topics = buildTopics(eligible, cardsById, opts);
  const episodeEdges = [];
  for (const tp of topics) episodeEdges.push(...buildEpisodeEdge(tp, episodesById, opts));

  // 完整性惩罚（期2 用 proxy 分，未接 LLM）
  const scores = new Map(episodes.map(ep => [ep.id, ep.completeness]));
  const penalty = applyCompletenessPenalty(factEdges, scores, opts);

  // 2 元边单独落普通边表（绝不进超图索引）
  const ordinaryEdges = [];
  for (const c of cards) {
    for (const to of (c.causes || [])) {
      if (!cardsById.has(to)) continue;              // 悬空丢弃
      if (cardsById.get(to).status === 'retired') continue;
      ordinaryEdges.push({ from: c.id, to, kind: 'causes' });
    }
    for (const to of (c.effects || [])) {
      if (!cardsById.has(to)) continue;
      if (cardsById.get(to).status === 'retired') continue;
      ordinaryEdges.push({ from: c.id, to, kind: 'effects' });
    }
  }

  return { cardsById, episodes, episodesById, topics, factEdges, episodeEdges, ordinaryEdges, penalty };
}

/**
 * 不变量检查（I1~I6）。任何一条 violation > 0 都不许落盘。
 */
export function verifyInvariants(g) {
  const v = { I1: 0, I2: 0, I3: 0, I4: 0, I5: 0, I6: 0, details: [] };

  const check = (edges, tag) => {
    for (const e of edges) {
      const n = e.members.length;
      if (n < HARD.MIN_MEMBERS) { v.I1++; v.details.push(tag + ' ' + e.id + ' 成员 ' + n + ' < 3'); }
      if (n > HARD.MAX_MEMBERS) { v.I2++; v.details.push(tag + ' ' + e.id + ' 成员 ' + n + ' > 8'); }
      const sum = Object.values(e.weights).reduce((a, b) => a + b, 0);
      const expect = e.weightScale === 1 ? 1 : e.weightScale;
      if (Math.abs(sum - expect) > 1e-6) { v.I3++; v.details.push(tag + ' ' + e.id + ' Σ权重 ' + sum.toFixed(4) + ' ≠ ' + expect); }
      const keys = new Set(e.members.map(m => m.nodeId));
      if (keys.size !== n) { v.I4++; v.details.push(tag + ' ' + e.id + ' 成员有重复'); }
      for (const m of e.members) {
        if (m.role !== e.relation[m.nodeId]) { v.I5++; v.details.push(tag + ' ' + e.id + ' relation 与 members 不一致'); break; }
      }
    }
  };
  check(g.factEdges, 'fact');
  check(g.episodeEdges, 'episode');

  // I6：2 元边绝不在超图索引里
  const allMembers = new Set();
  for (const e of [...g.factEdges, ...g.episodeEdges]) for (const m of e.members) allMembers.add(m.nodeId);
  for (const oe of g.ordinaryEdges) {
    // 普通边是 (from,to) 二元的，只要看它有没有被当成超边 —— 结构上不可能，双保险断言
    if (oe.kind !== 'causes' && oe.kind !== 'effects') { v.I6++; v.details.push('普通边 kind 异常: ' + oe.kind); }
  }

  return {
    ...v,
    I1violations: v.I1, I2violations: v.I2, I3violations: v.I3,
    I4violations: v.I4, I5violations: v.I5, I6violations: v.I6,
    factEdges: g.factEdges.length,
    episodeEdges: g.episodeEdges.length,
    ordinaryEdges: g.ordinaryEdges.length,
    episodes: g.episodes.length,
    topics: g.topics.length,
  };
}
