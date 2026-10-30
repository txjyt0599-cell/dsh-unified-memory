/**
 * 期2 超图基础类型与常量。
 * 铁律：2 元边绝不进超图索引（红队 B1）；超边成员上限 8（p3 实测度 P95 会炸）。
 */

/** Fact 在 Episode 里的角色（对齐 HyperMem structure.py:20-26） */
export const FactRole = Object.freeze({
  core: 'core', context: 'context', detail: 'detail', temporal: 'temporal', causal: 'causal',
});

/** Episode 在 Topic 里的角色（对齐 structure.py:30-39） */
export const EpisodeRole = Object.freeze({
  initiating: 'initiating', developing: 'developing', climax: 'climax', concluding: 'concluding',
  recurring: 'recurring', background: 'background', key_moment: 'key_moment', transition: 'transition',
});

export const HyperEdgeKind = Object.freeze({ fact: 'fact', episode: 'episode' });
export const TopicState = Object.freeze({ initialization: 'initialization', creation: 'creation', update: 'update' });

/** 硬纪律（改这里等于改全仓行为，别乱动） */
export const HARD = Object.freeze({
  MIN_MEMBERS: 3,        // <3 直接抛错，绝不造 2 元边
  MAX_MEMBERS: 8,        // 超边成员上限
  WINDOW_TURNS: 8,       // Episode 切分 turn 窗口
  GAP_MS: 30 * 60 * 1000,
  CAP_CARDS: 24,
  TAU_UPDATE: 0.30,
  TAU_WEAK: 0.22,
  CAP_EPISODES: 20,
  SCAN_WINDOW: 40,
  COMPLETENESS_THRESHOLD: 0.6,
  COMPLETENESS_PENALTY: 0.5,
  EPISODES_PER_SHARD: 100,
  LOCK_STALE_MS: 120_000,
});

/** 造边前统一校验：成员数越界一律抛错（不许静默返回 null） */
export function assertMemberCount(n, where) {
  if (n < HARD.MIN_MEMBERS) {
    throw new Error(where + ': 成员数 ' + n + ' < ' + HARD.MIN_MEMBERS + '，拒绝造超边（2 元边请走普通边表）');
  }
  if (n > HARD.MAX_MEMBERS) {
    throw new Error(where + ': 成员数 ' + n + ' > ' + HARD.MAX_MEMBERS + '，请先 chunkEpisode');
  }
}

/** 权重归一：Σ=1；全 0 时均分 */
export function normalizeWeights(weights) {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum <= 0) return weights.map(() => 1 / weights.length);
  return weights.map(w => w / sum);
}
