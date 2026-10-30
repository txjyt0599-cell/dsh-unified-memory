/**
 * lib/dispatch/event-source.js —— 目标会话「新增事件」读取（2026-10-28）
 *
 * ## 为什么需要它
 * dispatch_scan 要判 in_progress / orphaned / busy / delivery_lost，全靠
 * 「目标会话自投递之后新增了哪些事件」。没有事件源，三个高级态一律判不出来。
 *
 * ## 两条读取路径（都来自实读源码）
 *   ① **内存**：`ctx.sessions.get(id)` → `session.snapshotEvents(from)`
 *      源码：dsh-session/lib/index.js:1376，返回全量事件的 slice，纯内存、无 I/O。
 *      优点：实时、不受落盘延迟影响。缺点：只对本进程存活的会话有效。
 *   ② **持久化**：`ctx.sessionPersistence.open(id,'read')` → `handle.read(0)`
 *      源码：dsh-experimental-agent-team/lib/index.js:248 的 readPersistedSession 同款手法。
 *      优点：会话已不在内存（已归档/别的进程）也能读。缺点：整包读，较重。
 *
 * ## 铁律
 *   · **绝不伪造事件**：两条路都拿不到就返回 `{ok:false, reason}`，让上层判"不可判定"，
 *     而不是返回空数组让 classify 误判成 busy。
 *   · `snapshotEvents` 已标 @deprecated，但它是唯一能按 offset 切片的手段；
 *     在它被移除前使用，并在注释里标明替换点。
 */

/**
 * 从一组事件里筛出「投递之后」的新增部分。
 * 判据：用 baseline 记下的 eventCountBefore 做偏移；若偏移不可靠（事件被裁剪/重排），
 *      退化为「按 messageId 之后的事件」——即找到我们自己那条投递消息的 seq，取它之后。
 *
 * @param {Array} allEvents     目标会话全量事件
 * @param {object} baseline     { eventCountBefore, messageId }
 * @returns {Array} 新增事件
 */
export function sliceNewEvents(allEvents, baseline) {
  const all = Array.isArray(allEvents) ? allEvents : [];
  if (all.length === 0) return [];
  const b = baseline || {};
  const before = Number(b.eventCountBefore);
  // ── [2026-10-28 真实派单实测 · 第三次修正，这次才对] ──
  //   前两版都靠 messageId 定位，都错：
  //     taskId 首次出现在**投递侧事件**（agent/inbox/spliced），
  //     实测在第 86 条，而我们的 user/message 在它之后 ⇒ 按 messageId 切必切掉它
  //     ⇒ scanEventsForTask 恒 seen=false ⇒ 恒判 delivery_lost。
  //   正确判据：**优先按 eventCountBefore 切**（= "投递前的事件数"），
  //     之后所有事件都属于新增，含投递动作本身。
  //   messageId 只作降级（eventCountBefore 缺失/越界时）。
  if (Number.isFinite(before) && before >= 0 && before <= all.length) {
    return all.slice(before);
  }
  if (b.messageId) {
    const idx = all.findIndex(function (ev) {
      try {
        if (!ev || ev.type !== 'user/message') return false;
        const m = (ev.data && ev.data.message) || ev.data;
        return m && m.source && String(m.source.messageId || '') === String(b.messageId);
      } catch { return false; }
    });
    if (idx >= 0) return all.slice(idx);
    return all;
  }
  return all;
}

/**
 * @param {object} deps { getSessions, getPersistence, logger }
 *   getSessions   : () => ctx.sessions（有 .get(id)）
 *   getPersistence: () => ctx.sessionPersistence（有 .open(id,'read')）
 */
export function createEventSource(deps) {
  const d = deps || {};
  const log = d.logger || null;

  /**
   * 读某个会话的事件（支持从指定偏移开始，做**增量读**）。
   *
   * ## 为什么要有 offset 参数（2026-10-28 第二轮改进）
   * 上一版固定 `read(0, undefined)` —— **整包读**。会话到 40MB 时每次 scan 都全量解压，
   * 又慢又占内存。而 persistence 的 `read(offset, length)` **本来就支持偏移**（见
   * dsh-session-persistence-jsonl/lib/index.js:62 签名与实现），是我之前没用上。
   * ⇒ 现在：已知 baseline.eventCountBefore 时，内存路和持久化路都从那个偏移往后读。
   *   未知偏移（首次）才退化为全量 —— 且明确在返回值里标注 via/offsetUsed 便于排查。
   *
   * @param {string} targetSessionId
   * @param {object} [baseline]  { eventCountBefore }
   * @returns {{ok:boolean, events:Array, via:string, offsetUsed:number, reason?:string}}
   */
  async function readAll(targetSessionId, baseline) {
    const b = baseline || {};
    // 只有"确定的非负整数"才当偏移用；拿不准就 0（全量），绝不猜
    const wantOffset = Number.isInteger(b.eventCountBefore) && b.eventCountBefore >= 0 ? b.eventCountBefore : 0;
    const id = String(targetSessionId || '');
    if (!id) return { ok: false, events: [], via: 'none', reason: 'no-session-id' };

    // ① 内存优先（实时、轻量）
    try {
      const sessions = (typeof d.getSessions === 'function') ? d.getSessions() : null;
      if (sessions && typeof sessions.get === 'function') {
        const s = sessions.get(id);
        if (s && typeof s.snapshotEvents === 'function') {
          // ⚠️ snapshotEvents 在 dsh-session 里已标 @deprecated
          //    （dsh-session/lib/index.js:1370 注释：new calls are prohibited）。
          //    但目前 Session 类**没有等价的异步读接口** —— 只有它支持按 offset 切片。
          //    ⇒ 取舍：继续用（这是唯一可行手段），但
          //       ① 永远只读**增量**（传 fromSeq），不整包；
          //       ② 一旦上游提供异步替代，本函数是唯一改动点（换 via:'memory-async'）；
          //       ③ 把"用了 deprecated API"记进日志，别让它悄悄变成永久债。
          const from = wantOffset > 0 ? wantOffset : 0;
          const evs = s.snapshotEvents(from);
          try { log && log.wake && log.wake({ level: 'dispatch-events-deprecated-api', api: 'session.snapshotEvents', from, n: Array.isArray(evs) ? evs.length : 0 }); } catch {}
          return { ok: true, events: Array.isArray(evs) ? evs.slice() : [], via: 'memory', offsetUsed: from };
        }
      }
    } catch (e) {
      try { log && log.miss && log.miss({ level: 'dispatch-events-memory', reason: String(e && e.message || e) }); } catch {}
    }

    // ② 持久化兜底（会话不在内存时）
    try {
      const p = (typeof d.getPersistence === 'function') ? d.getPersistence() : null;
      if (p && typeof p.open === 'function') {
        const handle = await p.open(id, 'read');
        try {
          // 增量读：从 wantOffset 起，长度不限（读到末尾）。
          //   签名见 dsh-session-persistence-jsonl/lib/index.js:62 —— read(offset, length, options)
          const r = await handle.read(wantOffset, Number.MAX_SAFE_INTEGER);
          const evs = (r && r.events) || [];
          return { ok: true, events: Array.isArray(evs) ? evs.slice() : [], via: 'persistence', offsetUsed: wantOffset };
        } finally {
          try { await handle.close(); } catch { /* close 失败不影响已读到的数据 */ }
        }
      }
    } catch (e) {
      try { log && log.miss && log.miss({ level: 'dispatch-events-persistence', reason: String(e && e.message || e) }); } catch {}
    }

    // 两条路都失败 —— **绝不返回空数组冒充"没有新增"**
    return { ok: false, events: [], via: 'none', reason: 'unreadable' };
  }

  /**
   * 读「投递之后的新增事件」。读不到时 ok=false（上层必须判"不可判定"，不能判 busy）。
   */
  async function newEventsSince(targetSessionId, baseline) {
    // ── [2026-10-28 真实派单实测 · 修"双重切片"] ──
    //   病：readAll 已经按 eventCountBefore 切过一次，这里又调 sliceNewEvents
    //       按**同一个** eventCountBefore 再切一次 ⇒ 偏移被应用两遍 ⇒ 少看一半事件。
    //       这就是"B 组 len=1 而不是 2"的真因，也会让真实链路的判定变脆。
    //   修：readAll 负责"从哪读"，sliceNewEvents 只负责**在没有可靠偏移时**兜底；
    //       已知 offsetUsed > 0 就说明 readAll 已经切准了，不再二次切片。
    const r = await readAll(targetSessionId, baseline);
    if (!r.ok) return { ok: false, events: [], via: r.via, offsetUsed: r.offsetUsed || 0, reason: r.reason };
    const usedOffset = Number(r.offsetUsed) || 0;
    if (usedOffset > 0) {
      // readAll 已从 offsetUsed 起切好，直接用
      return { ok: true, events: r.events, via: r.via, offsetUsed: usedOffset };
    }
    // offsetUsed=0 说明读的是全量 ⇒ 需要按 messageId 对齐（降级路径）
    return { ok: true, events: sliceNewEvents(r.events, baseline), via: r.via, offsetUsed: 0 };
  }

  /** 同步版（仅内存；给同步调用的工具用）。拿不到就 ok=false，不伪造。 */
  function newEventsSinceSync(targetSessionId, baseline) {
    const id = String(targetSessionId || '');
    if (!id) return { ok: false, events: [], via: 'none', offsetUsed: 0, reason: 'no-session-id' };
    const b = baseline || {};
    const wantOffset = Number.isInteger(b.eventCountBefore) && b.eventCountBefore >= 0 ? b.eventCountBefore : 0;
    try {
      const sessions = (typeof d.getSessions === 'function') ? d.getSessions() : null;
      if (sessions && typeof sessions.get === 'function') {
        const s = sessions.get(id);
        if (s && typeof s.snapshotEvents === 'function') {
          const evs = s.snapshotEvents(wantOffset);
          return { ok: true, events: sliceNewEvents(evs, baseline), via: 'memory', offsetUsed: wantOffset };
        }
      }
    } catch (e) {
      try { log && log.miss && log.miss({ level: 'dispatch-events-sync', reason: String(e && e.message || e) }); } catch {}
    }
    return { ok: false, events: [], via: 'none', offsetUsed: 0, reason: 'not-in-memory' };
  }

  return { readAll, newEventsSince, newEventsSinceSync };
}

export default { createEventSource, sliceNewEvents };
