import { HARD, FactRole, EpisodeRole, HyperEdgeKind, assertMemberCount, normalizeWeights } from './types.js';

/**
 * 唯二造边出口：buildFactEdge / buildEpisodeEdge。
 * 全仓 grep "kind: 'fact'" 只能出现在本文件。
 */

/** 把 >maxMembers 的数组切成 k=⌈n/max⌉ 块，均衡分（不产生 2 元碎块） */
export function chunkEpisode(members, maxMembers = HARD.MAX_MEMBERS, minMembers = HARD.MIN_MEMBERS) {
  const n = members.length;
  if (n <= maxMembers) return n >= minMembers ? [members.slice()] : [];
  const k = Math.ceil(n / maxMembers);
  const base = Math.floor(n / k), rem = n % k;
  const out = [];
  let off = 0;
  for (let i = 0; i < k; i++) {
    const sz = base + (i < rem ? 1 : 0);
    const piece = members.slice(off, off + sz);
    off += sz;
    if (piece.length >= minMembers) out.push(piece);
  }
  return out;
}

/** Fact 角色分配（规则版，不调 LLM） */
export function assignFactRole(card, idx, total) {
  if (idx === 0) return FactRole.core;
  if (idx === total - 1) return FactRole.detail;
  const title = String(card.title || '');
  if (/^\d{4}-\d{2}-\d{2}/.test(title) || /时间|日期|次日|上午|下午/.test(title)) return FactRole.temporal;
  if (card.causes && card.causes.length) return FactRole.causal;
  if (idx === 1) return FactRole.context;
  return FactRole.detail;
}

/** 权重：importance 为主，位置微调 */
export function assignWeights(cards) {
  return normalizeWeights(cards.map((c, i) => {
    const imp = Math.max(0.05, Math.min(1, Number(c.importance ?? 0.5)));
    const pos = i === 0 ? 1.2 : i === cards.length - 1 ? 1.1 : 1.0;
    return imp * pos;
  }));
}

/**
 * 从「同一 Episode 的 ≥3 张卡」造 Fact 超边。
 * >8 卡时会自动 chunk（返回多条）；<3 返回 []（绝不造 2 元边）。
 */
export function buildFactEdge(episode, cardsById, opts = {}) {
  const maxMembers = opts.maxMembers ?? HARD.MAX_MEMBERS;
  const minMembers = opts.minMembers ?? HARD.MIN_MEMBERS;
  if (minMembers < HARD.MIN_MEMBERS) throw new Error('buildFactEdge: minMembers 不得 < 3（2 元边请走普通边表）');

  const cards = episode.cardIds.map(id => cardsById.get(id)).filter(Boolean);
  if (cards.length < minMembers) return [];

  const pieces = chunkEpisode(cards, maxMembers, minMembers);
  return pieces.map((piece, ord) => {
    assertMemberCount(piece.length, 'buildFactEdge');
    const weights = assignWeights(piece);
    const members = piece.map((c, i) => ({
      nodeId: c.id,
      role: assignFactRole(c, i, piece.length),
      weight: weights[i],
    }));
    return {
      id: 'fh:' + episode.id + ':' + ord,
      kind: HyperEdgeKind.fact,
      anchorId: episode.id,
      ordinal: ord,
      members,
      relation: Object.fromEntries(members.map(m => [m.nodeId, m.role])),
      weights: Object.fromEntries(members.map(m => [m.nodeId, m.weight])),
      extractionConfidence: 1,
      weightScale: episode.weightScale ?? 1,
    };
  });
}

/** Episode 角色分配（按时间序 + 首尾） */
export function assignEpisodeRole(idx, total) {
  if (total === 1) return EpisodeRole.key_moment;
  if (idx === 0) return EpisodeRole.initiating;
  if (idx === total - 1) return EpisodeRole.concluding;
  if (idx === 1 && total >= 4) return EpisodeRole.developing;
  return EpisodeRole.developing;
}

/** 从「同一 Topic 的 ≥3 个 Episode」造 Episode 超边 */
export function buildEpisodeEdge(topic, episodesById, opts = {}) {
  const maxMembers = opts.maxMembers ?? HARD.MAX_MEMBERS;
  const minMembers = opts.minMembers ?? HARD.MIN_MEMBERS;
  if (minMembers < HARD.MIN_MEMBERS) throw new Error('buildEpisodeEdge: minMembers 不得 < 3');

  const seen = new Set();
  const eps = [];
  for (const id of (topic.members || [])) {
    if (seen.has(id)) continue;   // 双保险：重复成员会让 Σ权重 ≠ 1
    seen.add(id);
    const ep = episodesById.get(id);
    if (ep) eps.push(ep);
  }
  if (eps.length < minMembers) return [];

  const pieces = chunkEpisode(eps, maxMembers, minMembers);
  return pieces.map((piece, ord) => {
    assertMemberCount(piece.length, 'buildEpisodeEdge');
    const weights = normalizeWeights(piece.map(e => 1));
    const members = piece.map((e, i) => ({
      nodeId: e.id,
      role: assignEpisodeRole(i, piece.length),
      weight: weights[i],
    }));
    return {
      id: 'eh:' + topic.id + ':' + ord,
      kind: HyperEdgeKind.episode,
      anchorId: topic.id,
      ordinal: ord,
      members,
      relation: Object.fromEntries(members.map(m => [m.nodeId, m.role])),
      weights: Object.fromEntries(members.map(m => [m.nodeId, m.weight])),
      coherenceScore: 1,
      weightScale: 1,
    };
  });
}

/**
 * 完整性惩罚：score < 0.6 ⇒ 该超边权重整体 ×0.5（**乘在归一之后**，Σ 变 0.5 是预期）。
 * 红队 H1：不是「重算归一」，就是降权 —— 见坑 3。
 */
export function applyCompletenessPenalty(edges, scores, opts = {}) {
  const threshold = opts.threshold ?? HARD.COMPLETENESS_THRESHOLD;
  const penalty = opts.penalty ?? HARD.COMPLETENESS_PENALTY;
  let penalized = 0;
  for (const e of edges) {
    const s = scores.get(e.anchorId);
    if (s === undefined || s === null) continue;
    if (s < threshold) { e.weightScale = penalty; penalized++; }
  }
  return { penalizedEdges: penalized };
}
