/**
 * ingest/consolidate.js —— 会话冷却期（Consolidation Window）
 * [2026-10-23 by Assistant · 期8.2]
 *
 * 要解决的病灶（Gemini 盲区 B / 白队 Case 2）：
 *   同一次排错里「放弃 A → 打个补丁还能救 → 彻底废弃」三次横跳，
 *   若逐条立即落盘，会生成三条互斥 engram + 循环 refute，检索端看见「救」和「废弃」并存震荡。
 *
 * 白队终裁（2026-10-23 §9.3）：**抛弃纯时间阈值**，改双重判定：
 *   ① 当前 Session 被关闭
 *   ② 30 分钟无新消息
 *   ③ 用户显式说「那就这么定了」之类的收敛词
 *
 * 铁律：
 *   · 会话进行中**不落盘任何推翻**，只改内存 pending。
 *   · 同 key 后写覆盖前写（这是唯一允许的 LWW —— 且在内存里，不是文件上）。
 *   · 归档只写**最终态一条**，中间横跳折叠成 trace 字符串。
 */

import { STATUS, judgeConflict, normalizeEngramV2 } from './belief.js';

/** 白队裁定：30 分钟，不是 5 分钟。 */
export const IDLE_CONSOLIDATE_MS = 30 * 60 * 1000;

/** 用户显式收敛的措辞（命中即立刻落盘）。 */
const CONVERGE_PATTERNS = [
  /就这么定/,
  /就这么办/,
  /定了/,
  /确认无误/,
  /没问题了/,
  /按这个来/,
  /最终就用/,
];

/**
 * 创建一个会话级的冷却期管理器。
 *
 * @param {{now?:()=>number, idleMs?:number, onCommit?:(engram:object)=>void}} opts
 *   now     —— 注入时钟（便于确定性测试，默认 Date.now）
 *   idleMs  —— 闲置阈值（默认 30 分钟）
 *   onCommit—— 落盘回调（归档时对每条最终态调用一次）
 */
export function createConsolidation(opts) {
  const o = opts || {};
  const now = typeof o.now === 'function' ? o.now : () => Date.now();
  const idleMs = Number.isFinite(Number(o.idleMs)) ? Number(o.idleMs) : IDLE_CONSOLIDATE_MS;
  const onCommit = typeof o.onCommit === 'function' ? o.onCommit : () => {};

  // sessionId -> { byKey: Map<key, {engram, history:string[], lastAt:number}>, lastAt:number }
  const sessions = new Map();
  const stats = { staged: 0, committed: 0, overwritten: 0, sessionsArchived: 0, commitFailed: 0 };

  function slotOf(sessionId) {
    const sid = String(sessionId || 'anon');
    let s = sessions.get(sid);
    if (!s) {
      s = { byKey: new Map(), lastAt: now() };
      sessions.set(sid, s);
    }
    return s;
  }

  /**
   * [2026-10-23 · 阻断2] 「是不是同一个话题」的判据。
   *
   * 原来 archive() 只用 keyOf(x) === key 找旧卡 —— 而 keyOf 对**显式 engram_key 优先**：
   * 暂存卡带 engram_key:'MTP' ⇒ key='MTP'，而库里同标题老卡没有 engram_key
   * ⇒ key='t:MTP可用' ⇒ **永远匹配不上** ⇒ refute 判决一次都没触发过
   * （AA17 探针实测 refutedOldIds=[]）。这比「不改旧卡」更隐蔽：是根本找不到旧卡。
   *
   * 现在：keyOf 相等**或**归一化标题相等，都算同一个话题。
   * 归一化口径与 keyOf 一致（去空白 + 小写），并同时看 claim（蒸馏卡常 title 不同但 claim 同主题）。
   */
  function normTopic(e) {
    const s = String((e && (e.title || e.claim)) || '').replace(/\s+/g, '').toLowerCase();
    return s ? 't:' + s.slice(0, 60) : '';
  }

  function sameTopic(a, b) {
    if (!a || !b) return false;
    if (keyOf(a) === keyOf(b)) return true;
    const ta = normTopic(a); const tb = normTopic(b);
    return !!ta && ta === tb;
  }

  /** 生成去重 key：优先用显式 key，否则用标题归一化。 */
  function keyOf(engram) {
    const e = engram || {};
    if (e.engram_key) return String(e.engram_key);
    if (e.key) return String(e.key);
    const t = String(e.title || '').replace(/\s+/g, '');
    return t ? 't:' + t.slice(0, 60) : 'id:' + String(e.id || 'anon');
  }

  /**
   * 暂存一条候选结论（**不落盘**）。
   * 同 key 后写覆盖前写；被覆盖的旧值记进 history（用于折叠 trace）。
   */
  function stage(sessionId, candidate) {
    try {
      const s = slotOf(sessionId);
      const t = now();
      s.lastAt = t;
      const key = keyOf(candidate);
      // [2026-10-23 · 期8.2 接线] 暂存卡必须带 id，否则归档落盘会产出
      //   `"id": undefined` 行 —— 读方 readOwnEngrams 的 byId 键会变成字符串 'undefined'，
      //   多条无 id 卡互相覆盖（last-write-wins 退化成一锅粥）。
      //   这里补一个与 distill 同格式（pmi_<time36>_<rand5>）的 id；
      //   已有 id 的原样保留（distill 的正常路径都带 id）。
      let cid = candidate && (candidate.id || candidate.engram_id);
      if (!cid) {
        cid = 'pmi_' + t.toString(36) + '_' + Math.random().toString(36).slice(2, 7);
      }
      const norm = normalizeEngramV2(Object.assign({}, candidate, {
        id: String(cid),
        is_tentative: true,
        updatedAt: candidate && candidate.updatedAt ? candidate.updatedAt : t,
      }));

      const prev = s.byKey.get(key);
      if (prev) {
        const line = String(prev.engram.claim || prev.engram.title || '').slice(0, 80);
        if (line) prev.history.push(line);
        // 覆盖时把前一次的 history 也接过来，保证 trace 完整
        norm._carryHistory = prev.history.slice();
        stats.overwritten++;
      }
      s.byKey.set(key, { engram: norm, history: norm._carryHistory || [], lastAt: t });
      delete norm._carryHistory;
      stats.staged++;
      return { ok: true, key, pending: s.byKey.size };
    } catch (e) {
      return { ok: false, error: String(e && e.message || e) };
    }
  }

  /** 判断用户这句话是否喊了「收敛」。 */
  function isConvergeUtterance(text) {
    const t = String(text || '');
    return CONVERGE_PATTERNS.some((re) => re.test(t));
  }

  /**
   * 归档一个会话：把 pending 收敛成**最终态**并逐条 commit。
   *
   * 收敛规则：
   *   · 同 key 只留最后一条（覆盖已完成）
   *   · trace = 中间横跳折叠成「放弃A → 还能救 → 彻底废弃」的单行串
   *   · is_tentative 置 false
   *   · 与**已落盘的旧卡**做一次 judgeConflict，决定新旧状态
   *
   * [2026-10-23 · 红队 B-2 阻断] refute 判决**必须回写旧卡**。
   *   原实现只把 `verdict.newStatus` 写进 `final`（新卡），被推翻的旧卡一个字段都没动，
   *   旧结论仍以 active 留在检索池里 ⇒「推翻」形同虚设（探针 C1 实测：
   *   refute 后 filterEngrams(default) 仍把 old+new 一起放出来）。
   *   现在返回值带 `refutedOldIds`（被推翻的旧卡 id 列表），
   *   并提供 `refuteOldCards()` 把旧卡 status 改成 refuted（append-only 版本行）。
   *
   * @param {string} sessionId
   * @param {{existing?:object[], reason?:string, refuteOld?:(old:object)=>void}} ctx
   *        existing —— 已有的 engram 列表（用于冲突判决；可选）
   *        refuteOld—— 回写旧卡的回调（可选）。给了就由调用方落盘；
   *                     没给则用本模块的 refuteOldCards() 内部生成版本行。
   */
  function archive(sessionId, ctx) {
    const sid = String(sessionId || 'anon');
    const s = sessions.get(sid);
    const c = ctx || {};
    const existing = Array.isArray(c.existing) ? c.existing : [];
    if (!s) return { ok: true, committed: 0, reason: 'no-pending' };

    const committedList = [];
    // [阻断2] 被本批推翻的旧卡 id（跨条目去重）
    const refutedOldIds = [];
    const refutedOldCards = [];
    // [阻断4] 单条 onCommit 失败只跳过那一条并计数，**不中断整批**；
    //   sessions.delete 移到 finally，保证 pending 一定被清理、重试不重复落盘。
    let failed = 0;
    try {
      for (const [key, slot] of s.byKey) {
        const final = Object.assign({}, slot.engram, { is_tentative: false });
        // 折叠 trace
        const chain = slot.history.concat([String(final.claim || final.title || '').slice(0, 80)]).filter(Boolean);
        final.trace = chain.length > 1 ? chain.join(' → ') : String(final.trace || '');

        // 与已有卡做冲突判决（同一话题：key 相等或归一化标题相等）
        const same = existing.find((x) => sameTopic(x, slot.engram));
        if (same) {
          const verdict = judgeConflict(final, normalizeEngramV2(same));
          final._verdict = verdict;
          final.status = verdict.newStatus;
          if (verdict.action === 'refute') {
            const oldId = same.id || same.engram_id || null;
            final.refute_by = (final.refute_by || []).concat([oldId]).filter(Boolean);
            final.supersedes = (final.supersedes || []).concat([oldId]).filter(Boolean);
            // [阻断2] 记下被推翻的旧卡 —— 这是旧实现漏掉的一半
            if (oldId && !refutedOldIds.includes(oldId)) {
              refutedOldIds.push(oldId);
              refutedOldCards.push(Object.assign({}, same, { id: oldId, engram_id: same.engram_id || oldId }));
            }
          }
        } else if (!final.status) {
          final.status = STATUS.ACTIVE;
        }

        final.updatedAt = now();
        committedList.push(final);
        // [阻断4] 单条失败不炸整批：跳过 + 计数，剩下的 pending 继续 commit
        try {
          onCommit(final);
          stats.committed++;
        } catch (e) {
          failed++;
          stats.commitFailed = (stats.commitFailed || 0) + 1;
        }
      }

      // [阻断2] 回写旧卡状态（append-only 版本行，手法同 distill.js retireLines）
      for (const old of refutedOldCards) {
        try {
          if (typeof c.refuteOld === 'function') {
            c.refuteOld(old);
          } else {
            refuteOldCards(old);
          }
        } catch (e) {
          failed++;
          stats.commitFailed = (stats.commitFailed || 0) + 1;
        }
      }

      return {
        ok: failed === 0,
        committed: committedList.length,
        commitFailed: failed,
        list: committedList,
        refutedOldIds,
        refutedOldCards,
        reason: c.reason || 'archived',
      };
    } catch (e) {
      return {
        ok: false,
        error: String(e && e.message || e),
        committed: committedList.length,
        commitFailed: failed,
        refutedOldIds,
        refutedOldCards,
      };
    } finally {
      // [阻断4] 无论成败都要清掉这个 session —— 否则 pending 原样留在内存，
      //   下次 archive 会把同一条再 commit 一次（append-only  ⇒ 重复落盘）。
      sessions.delete(sid);
      if (refutedOldIds.length > 0 || committedList.length > 0) stats.sessionsArchived++;
    }
  }

  /**
   * [2026-10-23 · 阻断2] 把「被推翻的旧卡」写成 append-only 的 refuted 版本行。
   *
   * 手法照抄 distill.js 的 retireLines：engrams.jsonl 是追加式日志，读方按 id
   * 取最后一条（last-write-wins），所以「改状态」= 追加一条带新 status 的版本行，
   * **原行不动**。这样既保留历史，又让 filterEngrams 立刻不再召回它。
   *
   * @param {object} old 被推翻的旧卡（原对象不被修改，返回新行）
   * @returns {object} 待落盘的新版本行
   */
  function refuteOldCards(old) {
    const o = old || {};
    const id = o.id || o.engram_id;
    if (!id) return null;
    return Object.assign({}, o, {
      id,
      status: STATUS.REFUTED,
      refuted_at: now(),
      updatedAt: now(),
      _refutedBy: 'consolidate.archive',
    });
  }

  /**
   * 巡检：把闲置超阈值的会话自动归档。
   * 由 session/flush / 心跳调用，不需要常驻定时器。
   *
   * [2026-10-23 · 阻断2] 把 pending 列表里的旧卡一起交给判决层：
   *   调用方传 ctx.existing（已落盘卡），archive 才能判 refute 并回写旧卡。
   */
  function sweepIdle(ctx) {
    const t = now();
    const c = ctx || {};
    const due = [];
    for (const [sid, s] of sessions) {
      if (t - s.lastAt >= idleMs) due.push(sid);
    }
    const out = [];
    for (const sid of due) {
      out.push(Object.assign({ sessionId: sid }, archive(sid, {
        reason: 'idle-timeout',
        existing: Array.isArray(c.existing) ? c.existing : [],
        refuteOld: c.refuteOld,
      })));
    }
    return { ok: true, archived: due.length, results: out };
  }

  /** 当前所有有待暂存的 session id（供 dispose / 运维巡检用）。 */
  function sessionIds() {
    return Array.from(sessions.keys());
  }

  function pendingCount(sessionId) {
    const s = sessions.get(String(sessionId || 'anon'));
    return s ? s.byKey.size : 0;
  }

  function snapshot() {
    return {
      sessions: sessions.size,
      pending: Array.from(sessions.values()).reduce((a, s) => a + s.byKey.size, 0),
      stats: Object.assign({}, stats),
      idleMs,
    };
  }

  /** 测试/紧急用：丢弃所有 pending，不落盘。 */
  function discardAll() {
    const n = Array.from(sessions.values()).reduce((a, s) => a + s.byKey.size, 0);
    sessions.clear();
    return { discarded: n };
  }

  return { stage, archive, sweepIdle, isConvergeUtterance, pendingCount, snapshot, sessionIds, discardAll, keyOf, refuteOldCards, sameTopic };
}
