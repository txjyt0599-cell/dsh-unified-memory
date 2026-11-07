/**
 * [2026-10-23 by Assistant · 白队补充1 消费者：L3 refute 扫描器]
 *
 * 背景：浓度引擎在事实覆写时产出 refuteScopes{ factId, oldText }，
 *   但它**只出清单不跨层改**（职责分离）。本模块就是那个消费者：
 *   扫所有 Engram，凡"依据被覆写的那条旧事实"推导出来的结论，
 *   一律 append 一条 status='refuted' 版本行 —— 绝不物理删除（保溯源）。
 *
 * 判据（怎么算"依据旧事实"）：
 *   ① supporting_facts 里含该 factId
 *   ② supersedes / refute_by 引用该 factId
 *   ③ trace / content 文本里出现旧事实原文的关键片段（保守兜底）
 */
import { readFileSync, existsSync } from 'node:fs';

/** 从旧事实文本抽关键词（取数字+核心名次，避免泛词误伤） */
export function scopeKeywords(oldText) {
  const s = String(oldText || '');
  const out = new Set();
  // 数字（含单位前的数）：4GB / 16 / 4095 等
  const nums = s.match(/\d+(?:\.\d+)?\s*(?:GB|MB|G|M|T)?/gi) || [];
  for (const n of nums) out.add(n.replace(/\s+/g, '').toLowerCase());
  // 英文/数字实体名（3 字符以上）
  const ents = s.match(/[A-Za-z][A-Za-z0-9_\-]{2,}/g) || [];
  for (const e of ents) out.add(e.toLowerCase());
  return [...out].filter(x => x.length >= 2);
}

/**
 * 扫描应被作废的 Engram。
 *
 * @param {object[]} engrams     全部 Engram 卡
 * @param {object}   refuteScope { factId, oldText }
 * @returns {object[]} 命中的 Engram
 */
export function findAffectedEngrams(engrams, refuteScope) {
  const cards = Array.isArray(engrams) ? engrams : [];
  const scope = refuteScope || {};
  const factId = String(scope.factId || '');
  const kws = scopeKeywords(scope.oldText);

  const hit = [];
  for (const c of cards) {
    if (!c) continue;
    if (String(c.status || 'active') === 'refuted') continue;   // 已作废不重复处理

    // ① 显式引用
    const sup = Array.isArray(c.supporting_facts) ? c.supporting_facts : [];
    const ref = Array.isArray(c.refute_by) ? c.refute_by : [];
    const keeps = Array.isArray(c.supersedes) ? c.supersedes : [];
    if (factId && (sup.includes(factId) || ref.includes(factId) || keeps.includes(factId))) {
      hit.push({ card: c, why: 'explicit-factid' });
      continue;
    }

    // ② 版本链引用（causes/effects 里带 id）
    const ce = [].concat(Array.isArray(c.causes) ? c.causes : [], Array.isArray(c.effects) ? c.effects : []);
    if (factId && ce.some(x => String(x && (x.id || x)) === factId)) {
      hit.push({ card: c, why: 'causal-chain' });
      continue;
    }

    // ③ 文本兜底：旧事实的关键片段出现在结论里
    if (kws.length) {
      const text = String(c.title || '') + ' ' + String(c.summary || '') + ' ' + String(c.content || '') + ' ' + String(c.trace || '');
      const low = text.toLowerCase();
      const matched = kws.filter(k => low.includes(k));
      // 至少命中 2 个关键词才算（防单泛词误伤）
      if (matched.length >= 2) {
        hit.push({ card: c, why: 'text-match:' + matched.slice(0, 3).join(',') });
      }
    }
  }
  return hit;
}

/**
 * 为命中的 Engram 生成 refuted 版本行（append-only，不物理删除）。
 *
 * @returns {{ lines: string[], count: number, ids: string[] }}
 */
export function buildRefuteLines(engrams, refuteScope, opts) {
  const o = opts || {};
  const nowIso = o.nowIso || new Date().toISOString();
  const reason = String(o.reason || 'upstream-fact-overridden');
  const affected = findAffectedEngrams(engrams, refuteScope);

  const lines = [];
  const ids = [];
  for (const a of affected) {
    const c = a.card;
    const row = Object.assign({}, c, {
      status: 'refuted',
      refutedAt: nowIso,
      refutedReason: reason,
      refute_by: (Array.isArray(c.refute_by) ? c.refute_by.slice() : []).concat([String(refuteScope && refuteScope.factId || '')]).filter(Boolean),
      trace: String(c.trace || '') + ' | L3-REFUTED(' + a.why + ')',
      updatedAt: nowIso,
    });
    lines.push(JSON.stringify(row));
    ids.push(String(c.id || ''));
  }
  return { lines, count: lines.length, ids };
}

export default { scopeKeywords, findAffectedEngrams, buildRefuteLines };
