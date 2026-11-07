/**
 * lib/ingest/persona-drift.js —— 人格漂移检测（防劫持）
 * [2026-11-03 by Assistant · 抄自「大肥鱼」防劫持机制，但换成我们能算的量]
 * [2026-11-07 P2-2 红队修复]
 *
 * ⚠️⚠️ 当前状态：**仅算法原型，未接生产** ⚠️⚠️
 *   全仓 grep 确认：生产代码里**没有任何地方调用 detectPersonaDrift**，
 *   仅 selftest-persona-drift.mjs 引用它。因此它现在**不能**被宣传为
 *   「已完成的人格保护能力」—— 只是把算法与判据先固化下来，
 *   待确认接线点（在哪一步 ingest、用哪批事件、降权如何落盘）后才算数。
 *
 * ## 它要防什么
 * 外部输入（网页/文章/别人的 agent）试图把Assistant的观点「全量搬到对方那边」。
 * 表现不是单条错误，而是**一段时间内所有立场都朝同一方向移动**。
 *
 * ## 判据（三条同时成立才算漂移）
 *   1. 样本量够      >= MIN_SAMPLES  —— **只数方向明确（direction!==0）的同主题事件**
 *   2. 方向一致      同一方向的占比 >= DIRECTION_RATIO
 *   3. 外来占比高    外来来源（model_inference / user_speculation）权重占比 >= FOREIGN_SHARE
 *
 * ## P2-2 修掉的三个坑（红队只读复现）
 *   ① 零方向样本凑数：原来 samples = 全部事件数，5 条 direction=0 也能帮过 MIN_SAMPLES。
 *      ⇒ 现在 samples 只数**方向明确的同主题事件**，零方向事件不参与门槛样本。
 *   ② 降权集合误伤：原来把该主题所有 model_inference（含反向/同向）全降权。
 *      ⇒ 现在 demoteIds **只包含支持主导方向**的证据。
 *   ③ 未知来源混入：原来未知 source 也按 0.5 权重参与方向统计，却不计入 foreignShare。
 *      ⇒ 现在未知来源**先隔离**（既不参与方向统计也不参与 foreignShare），单独计数上报。
 *
 * ## 为什么全部是「可观测计数」而不是 LLM 打分
 *   判据本身必须能被复核，否则就是"用一个黑箱审另一个黑箱"。
 */

import { SOURCE_WEIGHTS } from './belief.js';

/** 判据参数（先给保守值，跑出分布后再校准） */
export const DRIFT_RULES = Object.freeze({
  MIN_SAMPLES: 6,        // 少于 6 条**方向明确**的事件不下结论
  DIRECTION_RATIO: 0.80, // 同向占比 >= 80%
  FOREIGN_SHARE: 0.50,   // 外来来源权重占比 >= 50%
  DEMOTE_FACTOR: 0.15,   // 触发后降权到 15%（即"降 85%"，沿用他的比例）
});

const KNOWN_SOURCES = new Set(Object.keys(SOURCE_WEIGHTS));

/** 取事件的主题键（没有就归到同一默认主题） */
function topicOf(e) {
  const t = (e && (e.topic || e.thread || e.topicKey));
  return t === undefined || t === null ? '__default__' : String(t);
}

/**
 * 判断一批「观点事件」是否呈现人格漂移。
 *
 * @param {Array<{direction:number, source:string, weight?:number, id?:string, text?:string, topic?:string}>} events
 *   direction: -1 / 0 / +1，表示这条观点相对既有立场的偏移方向
 *   source:    'user_correction' | 'user_observed' | 'user_speculation' | 'model_inference'
 *   topic:     可选，同一主题分组；缺省视为同一主题
 * @param {object} [rules]
 * @returns {{drift:boolean, reason:string, metrics:object, demoteIds:string[]}}
 */
export function detectPersonaDrift(events, rules) {
  const R = Object.assign({}, DRIFT_RULES, rules || {});
  const list = Array.isArray(events) ? events.filter(Boolean) : [];

  const metrics = {
    totalEvents: list.length,
    samples: 0,                          // 方向明确 + 同主题 + 已知来源
    dirCount: { neg: 0, zero: 0, pos: 0 },
    dominantDir: 0,
    dominantRatio: 0,
    dominantTopic: null,
    foreignWeight: 0,
    totalWeight: 0,
    foreignShare: 0,
    zeroDirectionIgnored: 0,
    unknownSourceIsolated: 0,
  };

  if (list.length === 0) {
    return { drift: false, reason: 'no-events', metrics, demoteIds: [] };
  }

  const w = (e) => {
    if (typeof e.weight === 'number' && isFinite(e.weight)) return e.weight;
    return SOURCE_WEIGHTS[e.source] !== undefined ? SOURCE_WEIGHTS[e.source] : 0.5;
  };

  // ① 未知来源先隔离（不参与方向统计、不参与 foreignShare）
  const known = [];
  for (const e of list) {
    if (!KNOWN_SOURCES.has(String(e.source || ''))) {
      metrics.unknownSourceIsolated += 1;
      continue;
    }
    known.push(e);
  }

  // ② 只保留方向明确的事件（零方向只记数，不进门槛样本）
  const directional = [];
  for (const e of known) {
    const d = Number(e.direction) || 0;
    if (d === 0) { metrics.dirCount.zero += 1; metrics.zeroDirectionIgnored += 1; continue; }
    directional.push(e);
  }

  if (directional.length === 0) {
    return { drift: false, reason: 'no-directional-events', metrics, demoteIds: [] };
  }

  // ③ 同主题分组：取方向明确事件最多的主题，判据只在这个主题内算
  const groups = new Map();
  for (const e of directional) {
    const k = topicOf(e);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(e);
  }
  let topic = '__default__';
  let group = [];
  for (const [k, arr] of groups) {
    if (arr.length > group.length) { topic = k; group = arr; }
  }
  metrics.dominantTopic = topic;
  metrics.samples = group.length;        // ★ 只数方向明确的同主题事件

  for (const e of group) {
    const d = Number(e.direction) || 0;
    if (d < 0) metrics.dirCount.neg++;
    else if (d > 0) metrics.dirCount.pos++;
    const ww = w(e);
    metrics.totalWeight += ww;
    if (e.source === 'model_inference' || e.source === 'user_speculation') {
      metrics.foreignWeight += ww;
    }
  }

  const nonZero = metrics.dirCount.neg + metrics.dirCount.pos;
  if (nonZero === 0) {
    return { drift: false, reason: 'no-directional-events', metrics, demoteIds: [] };
  }

  metrics.dominantDir = metrics.dirCount.pos >= metrics.dirCount.neg ? 1 : -1;
  metrics.dominantRatio = Number((Math.max(metrics.dirCount.pos, metrics.dirCount.neg) / nonZero).toFixed(3));
  metrics.foreignShare = metrics.totalWeight > 0
    ? Number((metrics.foreignWeight / metrics.totalWeight).toFixed(3))
    : 0;

  // 三闸全过才判漂移
  const fail = [];
  if (metrics.samples < R.MIN_SAMPLES) fail.push('samples<' + R.MIN_SAMPLES);
  if (metrics.dominantRatio < R.DIRECTION_RATIO) fail.push('direction<' + R.DIRECTION_RATIO);
  if (metrics.foreignShare < R.FOREIGN_SHARE) fail.push('foreign<' + R.FOREIGN_SHARE);

  if (fail.length) {
    return { drift: false, reason: 'below-threshold: ' + fail.join(' '), metrics, demoteIds: [] };
  }

  // 触发：只降 **model_inference**，且**只降支持主导方向的那部分证据**。
  // [安全边界 · 2026-11-03] User的推测(user_speculation)**不降权** ——
  //   哪怕是User的误判，也应该由User自己纠正，不能由系统替User判定"他说错了"。
  // [P2-2 · 2026-11-07] 反向证据不得被一起降权（原来会误伤无关/反向事件）。
  const demoteIds = group
    .filter((e) => e.source === 'model_inference' && (Number(e.direction) || 0) === metrics.dominantDir)
    .map((e) => e.id)
    .filter(Boolean);

  return {
    drift: true,
    reason: 'drift-detected: ' + metrics.samples + ' 条 ' + (metrics.dominantRatio * 100).toFixed(0)
      + '% 同向(' + (metrics.dominantDir > 0 ? '正' : '负') + ')，外来权重占 '
      + (metrics.foreignShare * 100).toFixed(0) + '%',
    metrics,
    demoteIds,
  };
}

/** 触发后要写的降权系数（供调用方落盘时乘） */
export function demoteFactor(rules) {
  const R = Object.assign({}, DRIFT_RULES, rules || {});
  return R.DEMOTE_FACTOR;
}

export default { DRIFT_RULES, detectPersonaDrift, demoteFactor };
