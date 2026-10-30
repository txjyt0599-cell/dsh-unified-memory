import { HARD, TopicState, EpisodeRole } from './types.js';

/**
 * Topic 聚类 + 三态决策（红队第 3 条）。
 * 现实约束（p3 实测）：projectId 只有 3 个值 ⇒ 不能按 projectId 建 Topic（会得到 3 个黑洞）。
 * 对策：**双锚** —— 会话锚（同 sessionId 的 Episode 归一个 Topic）+ 内容锚（词面相似度聚类）。
 */

/** 改进的 Jaccard：词面重合 / min(|a|,|b|) —— 短集不被长集稀释 */
export function inclusionSim(a, b) {
  if (!a || !b || a.size === 0 || b.size === 0) return 0;
  let hit = 0;
  for (const x of a) if (b.has(x)) hit++;
  return hit / Math.min(a.size, b.size);
}

/** 抽词：CJK 2-gram + 拉丁单词（零依赖，够用） */
export function termsOf(text, maxTerms = 400) {
  const s = String(text || '').toLowerCase();
  const out = new Set();
  const cjk = s.replace(/[^\u4e00-\u9fff]+/g, ' ');
  for (const seg of cjk.split(/\s+/)) {
    for (let i = 0; i + 2 <= seg.length; i++) out.add(seg.slice(i, i + 2));
  }
  for (const w of s.split(/[^a-z0-9_]+/)) if (w.length >= 3) out.add(w);
  return new Set([...out].slice(0, maxTerms));
}

/**
 * 三态决策：给定候选 Episode 与现有 Topic 列表，返回该并入哪个 / 新建 / 初始化。
 * tauUpdate 0.30 / tauWeak 0.22 / capEpisodes 20 / scanWindow 40
 */
export function decideTopicState(candidate, topics, opts = {}) {
  const tauUpdate = opts.tauUpdate ?? HARD.TAU_UPDATE;
  const tauWeak = opts.tauWeak ?? HARD.TAU_WEAK;
  const cap = opts.capEpisodes ?? HARD.CAP_EPISODES;
  const scan = opts.scanWindow ?? HARD.SCAN_WINDOW;

  if (!topics.length) return { state: TopicState.initialization, targetTopicId: null, score: 0 };

  // 只跟最近 scan 个 Topic 比（O(N·M) 可控化）
  const recent = topics.slice(-scan);
  let best = null, bestScore = -1;
  for (const t of recent) {
    if (t.members && t.members.length >= cap) continue;   // 满了不并
    const score = inclusionSim(candidate.terms, t.terms);
    if (score > bestScore) { bestScore = score; best = t; }
  }

  if (best && bestScore >= tauUpdate) return { state: TopicState.update, targetTopicId: best.id, score: bestScore };
  if (best && bestScore >= tauWeak) return { state: TopicState.creation, targetTopicId: null, score: bestScore };
  return { state: TopicState.creation, targetTopicId: null, score: bestScore < 0 ? 0 : bestScore };
}

/**
 * 双锚聚类：会话锚（同 sessionId）+ 内容锚（词面相似度）。
 * 返回 TopicNode[]（每个含 members: episodeId[] 与 terms: Set）
 */
export function buildTopics(episodes, cardsById, opts = {}) {
  const tauUpdate = opts.tauUpdate ?? HARD.TAU_UPDATE;
  const topics = [];
  const bySession = new Map();

  // 会话锚：同 sessionId 的 Episode 归一个 Topic（若同会话 Episode ≥3）
  for (const ep of episodes) {
    const s = ep.sessionId || '';
    if (!s) continue;
    if (!bySession.has(s)) bySession.set(s, []);
    bySession.get(s).push(ep);
  }
  for (const [s, eps] of bySession) {
    if (eps.length < HARD.MIN_MEMBERS) continue;
    const terms = new Set();
    for (const ep of eps) for (const t of termsOfOf(ep, cardsById)) terms.add(t);
    topics.push({
      id: 'tp:s:' + s,
      anchor: 'session',
      sessionId: s,
      members: eps.map(e => e.id),
      terms,
    });
  }

  // 内容锚：把未进会话锚的 Episode 按词面相似度聚（弱匹配也算）
  const used = new Set(topics.flatMap(t => t.members));
  for (const ep of episodes) {
    if (used.has(ep.id)) continue;
    const terms = termsOfOf(ep, cardsById);
    const d = decideTopicState({ id: ep.id, terms }, topics, opts);
    if (d.state === TopicState.update && d.targetTopicId) {
      const t = topics.find(x => x.id === d.targetTopicId);
      if (t && t.members.length < HARD.CAP_EPISODES) { t.members.push(ep.id); used.add(ep.id); continue; }
    }
    const nt = { id: 'tp:c:' + ep.id, anchor: 'content', sessionId: ep.sessionId || '', members: [ep.id], terms };
    topics.push(nt); used.add(ep.id);
  }

  // 出口统一去重（会话锚与内容锚可能重复收同一个 Episode）
  for (const t of topics) t.members = [...new Set(t.members)];
  return topics;
}

function termsOfOf(ep, cardsById) {
  const out = new Set();
  for (const cid of ep.cardIds) {
    const c = cardsById.get(cid);
    if (!c) continue;
    for (const t of termsOf((c.title || '') + ' ' + (c.summary || ''))) out.add(t);
  }
  return out;
}

/** 给 Episode 在 Topic 里分配角色（按时间序 + 首尾判据） */
export function assignEpisodeRoles(episodesInTopic) {
  const n = episodesInTopic.length;
  return episodesInTopic.map((ep, i) => {
    let role;
    if (n === 1) role = EpisodeRole.key_moment;
    else if (i === 0) role = EpisodeRole.initiating;
    else if (i === n - 1) role = EpisodeRole.concluding;
    else if (i === 1 && n >= 4) role = EpisodeRole.developing;
    else role = EpisodeRole.developing;
    return { episodeId: typeof ep === 'string' ? ep : ep.id, role };
  });
}
