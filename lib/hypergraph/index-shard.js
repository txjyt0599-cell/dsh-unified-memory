import { createHash } from 'node:crypto';
import { HARD } from './types.js';

/** 片内源的指纹：episodeIds + 卡 id + createdAt + status 拼接后 sha256 前 16 位 */
export function computeShardSourceHash(episodes, cardsById) {
  const parts = [];
  for (const ep of episodes) {
    parts.push(ep.id);
    for (const cid of ep.cardIds) {
      const c = cardsById.get(cid);
      parts.push(cid + ':' + (c?.createdAt ?? 0) + ':' + (c?.status ?? '?'));
    }
  }
  return createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 16);
}

/** 参数指纹：影响建图结果的常量全进哈希 */
export function computeParamsHash(opts = {}) {
  const p = {
    w: opts.windowTurns ?? HARD.WINDOW_TURNS,
    g: opts.gapMs ?? HARD.GAP_MS,
    c: opts.capCards ?? HARD.CAP_CARDS,
    mn: HARD.MIN_MEMBERS, mx: HARD.MAX_MEMBERS,
    tu: opts.tauUpdate ?? HARD.TAU_UPDATE,
    tw: opts.tauWeak ?? HARD.TAU_WEAK,
    ce: opts.capEpisodes ?? HARD.CAP_EPISODES,
    ps: opts.episodesPerShard ?? HARD.EPISODES_PER_SHARD,
  };
  return createHash('sha256').update(JSON.stringify(p)).digest('hex').slice(0, 16);
}

/**
 * 规划重建：返回 { reason, full, dirty: number[] }
 * 全量三条触发：① paramsHash 变 ② manifest 缺失/schemaVersion 不符 ③ 脏片 > 50%
 */
export function planRebuild(shards, manifest, currentHashes, opts = {}) {
  const schemaVersion = opts.schemaVersion ?? 1;
  const paramsHash = opts.paramsHash ?? computeParamsHash(opts);
  const N = shards.length;

  if (!manifest) return { reason: 'no-manifest', full: true, dirty: allIdx(N), paramsHash };
  if (manifest.schemaVersion !== schemaVersion) return { reason: 'schema-mismatch', full: true, dirty: allIdx(N), paramsHash };
  if (manifest.paramsHash !== paramsHash) return { reason: 'params-changed', full: true, dirty: allIdx(N), paramsHash };

  const old = new Map((manifest.shards || []).map(s => [s.index, s.sourceHash]));
  const dirty = [];
  for (const s of shards) {
    if (old.get(s.index) !== currentHashes[s.index]) dirty.push(s.index);
  }
  if (dirty.length > N * 0.5) return { reason: 'too-many-dirty', full: true, dirty: allIdx(N), paramsHash };
  // clean ⇒ 不重建任何片；full 只在三条触发条件时才是 true
  return { reason: dirty.length ? 'hash-mismatch' : 'clean', full: false, dirty, paramsHash };
}

function allIdx(n) { return Array.from({ length: n }, (_, i) => i); }

/** 把 episodes 按每片 N 个切成片计划 */
export function planShards(episodes, opts = {}) {
  const per = opts.episodesPerShard ?? HARD.EPISODES_PER_SHARD;
  const shards = [];
  for (let i = 0; i < episodes.length; i += per) {
    shards.push({ index: shards.length, episodes: episodes.slice(i, i + per) });
  }
  return shards;
}
