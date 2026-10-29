/**
 * evict.js —— 淘汰判定的纯函数。零 IO。
 * 依据：_team-v2/p4/DESIGN.md §1.2 ⑨ / §5 坑5（L2 是假层，必须按激活淘汰）。
 */

import { decayedActivation } from './activation-store.js';
import { WM_DEFAULTS } from './types.js';

/**
 * 规划淘汰：把「谁该出池」与「怎么删」解耦，纯函数可单测。
 *
 * 规则（按优先级）：
 *   ① activation（按半衰期折算后）< level 的 minActivation ⇒ reason='activation'
 *   ② lastHitAt 距今 > l1.idleDropMs（仅 L1）⇒ reason='idle'
 *   ③ 仍超 maxCards ⇒ 按折算激活降序保留，其余 reason='cap'
 *
 * ⚠️ L2 的 300 张**按激活度淘汰**：实测 projectId 只有 2 个值（project 层占 54%），
 *    按 cwd 全量倒进去等于 L2≈L3，没有区分度。
 *
 * @param {Array<{cardId:string,activation:number,lastHitAt:number}>} entries
 * @param {'L1'|'L2'|'L3'} level
 * @param {object} cfg 完整 wm 配置（用 cfg.l1 / cfg.l2 / cfg.activation.halfLifeMs）
 * @param {number} now epoch ms
 */
export function planEviction(entries, level, cfg, now) {
  const c = cfg || {};
  const halfLifeMs = (c.activation && c.activation.halfLifeMs) || WM_DEFAULTS.activation.halfLifeMs;
  const key = level === 'L2' ? 'l2' : level === 'L1' ? 'l1' : 'l3';
  const lv = c[key] || WM_DEFAULTS[key.toLowerCase()] || {};
  const minAct = lv.minActivation !== undefined ? lv.minActivation : 0;
  const maxCards = lv.maxCards !== undefined ? lv.maxCards : Infinity;
  const idleDropMs = key === 'l1' ? (lv.idleDropMs !== undefined ? lv.idleDropMs : WM_DEFAULTS.l1.idleDropMs) : null;
  const t = Number(now) || Date.now();

  const removed = [];
  const alive = [];
  for (const e of (entries || [])) {
    if (!e || !e.cardId) continue;
    const eff = decayedActivation({ activation: e.activation, lastUpdate: e.lastHitAt || t }, t, halfLifeMs);
    const item = { cardId: e.cardId, activation: e.activation, eff: eff, lastHitAt: Number(e.lastHitAt) || 0 };
    if (eff < minAct) { removed.push({ cardId: e.cardId, reason: 'activation' }); continue; }
    if (idleDropMs !== null && item.lastHitAt > 0 && t - item.lastHitAt > idleDropMs) {
      removed.push({ cardId: e.cardId, reason: 'idle' }); continue;
    }
    alive.push(item);
  }

  alive.sort(function (a, b) { return b.eff - a.eff || (a.cardId < b.cardId ? -1 : 1); });
  let kept = alive;
  if (alive.length > maxCards) {
    for (const x of alive.slice(maxCards)) removed.push({ cardId: x.cardId, reason: 'cap' });
    kept = alive.slice(0, maxCards);
  }

  return {
    level: level,
    removed: removed,
    kept: kept.length,
    keptIds: kept.map(function (x) { return x.cardId; }),
  };
}

export default { planEviction };
