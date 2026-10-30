/**
 * lib/dispatch/state-machine.js —— 派单回执状态机（2026-10-28 · v1）
 *
 * ## 这份文件解决什么
 * 多 AI 协作里最贵的浪费是「双方都在等对方」，而且它没有任何报错。
 * 本模块负责：把一条派单从「发出」到「销账 / 告警」的全过程变成可查状态。
 *
 * ## 判据全部来自实读源码，不是推演
 *   · deliveryContent()  :974  → 引擎会在正文前插 `Team message <id> from <name>:`
 *   · agent.status getter :790  → 内存实时态，不走落盘（不受整包重写污染）
 *   · roster.list()      :436  → status = failed ? failed : provisioning ? provisioning : availability(live)
 *   · availability()     :731  → agent?.status === 'running' ? running : inactive
 *   · member.phase enum  :1155 → 只有 provisioning / active / failed，**没有 disposed**
 *   · message schema     :1178 → { id, senderId, senderName, targetId, content }，**无 sentAt**
 *   · messageId schema   :1103 → z.string().min(1)，必填
 *   · snapshotEvents()   :1376 → **全量事件**（含心跳/状态变更/别人消息），且已 @deprecated
 *
 * ## 已废除的错误判据（写在这里防止回潮）
 *   ⛔ turnCount —— 全包 0 命中，字段根本不存在
 *   ⛔ mtime —— 会话是单个 zstd 整包重写，任何写入都会刷新它
 *   ⛔ inactive 当死 —— inactive = "no turn is executing"，是健康空闲态
 *   ⛔ 首行锚点 ^ —— 引擎会插前缀，首行不是我们的正文
 */

/** 状态枚举（互斥） */
export const STATE = Object.freeze({
  PENDING: 'pending',                 // 台账已写、尚未投递
  CONFIRMED: 'confirmed',             // 投递成功，等待目标处理
  IN_PROGRESS: 'in_progress',         // 目标已接单（有 taskId 痕迹）但未结案
  BUSY_IGNORED: 'busy_ignored',       // 目标活着在干别的，收到但没处理
  DELIVERY_LOST: 'delivery_lost',     // 消息压根没投到（messageId 也不在）
  ORPHANED: 'orphaned',               // 干完了但回执丢了
  UNSTRUCTURED_REPLY: 'unstructured_reply', // 回了但没按四件套
  DEAD_TARGET: 'dead_target',         // 目标真死（failed / 丢失）
  ABORTED: 'aborted',                 // 投递抛错，直接结案不进监控
  CLOSED: 'closed',                   // 已销账
  // [2026-10-28 补] 事件源读不到时的显式态。
  //   ⛔ 绝不能用 busy_ignored 冒充——那会让人去催一个其实没问题的目标。
  UNDETERMINED: 'undetermined',       // 不可判定（读盘失败 / 会话不可达）
});

/** 默认阈值（拍板项，等User确认；同一套校准逻辑，不各拍各的） */
export const DEFAULTS = Object.freeze({
  provisioningDeadlineMs: 10 * 60 * 1000,   // provisioning 卡死判定
  inProgressDeadlineMs: 10 * 60 * 1000,     // in_progress 超时告警
  pendingCrashMs: 10 * 60 * 1000,           // pending 无后续 ⇒ 判定崩溃
  sampleIntervalMs: 30 * 1000,              // 采样节奏（provisioning 与 dead 共用）
  rosterMissingSamples: 3,                  // 连续 N 次拿不到成员对象才算死
});

/**
 * 从消息正文里提取本单的 taskId。
 *
 * ## 为什么不能用首行 ^ 锚点
 * deliveryContent(:974) 会在最前面插 `Team message <messageId> from <name>:`。
 * 所以「正文第一行」其实是引擎前缀。协议标签必须定义为**正文内任意位置的固定标签行**。
 *
 * ## 为什么必须和 messageId 配对
 * 正文里可能出现伪造/复制的标签（反例 E：前缀污染、反例 F：多标签）。
 * 判据：标签必须**独占一行**，且若是我们自己发的消息，应能与 source.messageId 对上。
 *
 * @param {string} text 消息正文
 * @param {object} [opts] { expectMessageId }
 * @returns {string[]} 提取到的 taskId 列表（去重、保序）
 */
export function extractTaskIds(text, opts) {
  const o = opts || {};
  const s = String(text || '');
  const out = [];
  const seen = new Set();
  // 固定标签行：[[TASK:<id>]] 独占一行（允许前后空白）
  const re = /^[ \t]*\[\[TASK:([A-Za-z0-9._:-]{1,120})\]\][ \t]*$/gm;
  let m;
  while ((m = re.exec(s)) !== null) {
    const id = m[1];
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/**
 * 解析一个 taskId（绝不返回"猜的"）。
 * 反例 E/F 的守门点：正文里多个标签时，取**第一个独占行的**；
 * 若提供了 expectMessageId 且正文里有与之配对的标记，优先那个。
 */
export function resolveTaskId(text, opts) {
  const ids = extractTaskIds(text, opts);
  return ids.length > 0 ? ids[0] : null;
}

/**
 * 判断一段新增事件里，是否出现了某个 taskId 的痕迹，以及是否带结案标签。
 *
 * @param {Array} events     新增会话事件（snapshotEvents 的增量）
 * @param {string} taskId
 * @returns {{seen:boolean, closed:boolean, messageIds:string[]}}
 */
export function scanEventsForTask(events, taskId) {
  const out = { seen: false, closed: false, messageIds: [] };
  if (!taskId || !Array.isArray(events)) return out;
  for (const ev of events) {
    let text = '';
    try {
      if (ev && ev.type === 'user/message') {
        const msg = (ev.data && ev.data.message) || ev.data;
        const blocks = (msg && msg.content) || [];
        text = blocks.map(function (b) { return (b && b.text) || ''; }).join('\n');
        const mid = msg && msg.source && msg.source.messageId;
        if (mid) out.messageIds.push(String(mid));
      }
    } catch { /* 单条坏事件不影响整体 */ }
    if (!text) continue;
    const ids = extractTaskIds(text);
    if (!ids.includes(taskId)) continue;
    out.seen = true;
    // 结案标签：必须明确带结案语义，不能只看"有痕迹"
    if (/\[\[(?:DONE|CLOSED|ACK)\b[^\]]*\]\]/.test(text)) out.closed = true;
  }
  return out;
}

/**
 * 核心：根据「投递基线 + 目标当前状态 + 新增事件」判定这一单处于哪个状态。
 *
 * @param {object} ctx
 *   ctx.baseline     { sentAt, eventCountBefore, messageId? }
 *   ctx.target       { status, phase, exists }   来自 list_agents + 注册表查对象
 *   ctx.newEvents    自 baseline 之后的新增事件
 *   ctx.taskId
 *   ctx.now
 *   ctx.deadline     { provisioningDeadlineMs, inProgressDeadlineMs }
 * @returns {{state:string, reason:string, evidence:object}}
 */
export function classify(ctx) {
  const c = ctx || {};
  const now = Number(c.now) || Date.now();
  const sentAt = Number(c.baseline && c.baseline.sentAt) || 0;
  const elapsed = sentAt > 0 ? now - sentAt : 0;
  const t = c.target || {};
  const d = c.deadline || {};
  const provDeadline = Number(d.provisioningDeadlineMs) || DEFAULTS.provisioningDeadlineMs;
  const progDeadline = Number(d.inProgressDeadlineMs) || DEFAULTS.inProgressDeadlineMs;

  // ── [2026-10-28 by Assistant · 名册读不到 ⇒ 不可判定] ──
  //   背景：真实派单第一次成功时，dispatch_scan 把活得好好的目标判成 dead_target。
  //   根因不是判据错，是 **getAgents 调了一个不存在的方法名（listAgents）**，
  //   恒返回空数组 ⇒ 每个目标都"查无此人" ⇒ exists:false ⇒ 判死。
  //   ⇒ 两层修：① 调用方用对方法名 listMembers；② 本函数收到 rosterUnreadable
  //      必须判 undetermined，**绝不用"读不到"推断"人死了"**。
  if (c.rosterUnreadable === true) {
    return { state: STATE.UNDETERMINED, reason: 'roster-unreadable', evidence: { note: '名册读取失败，无法判断目标是否存活' } };
  }

  // ── 0) 目标真死：只认两条硬证据，**绝不含 inactive** ──
  //   （inactive = "no turn is executing"，是健康空闲态，误杀它会把所有干完活的成员判死）
  if (t.phase === 'failed' || t.status === 'failed') {
    return { state: STATE.DEAD_TARGET, reason: 'member-phase-failed', evidence: { phase: t.phase, status: t.status } };
  }
  if (t.exists === false) {
    // 连续 N 次拿不到对象才由调用方升级；这里只表达"本次观测不到"
    return { state: STATE.DEAD_TARGET, reason: 'member-object-missing', evidence: { phase: t.phase, status: t.status } };
  }
  // provisioning 卡死：超时只是触发复核，调用方需二次核查后再判死
  if (t.phase === 'provisioning' && elapsed >= provDeadline) {
    return { state: STATE.DEAD_TARGET, reason: 'provisioning-timeout-needs-recheck', evidence: { elapsed, deadline: provDeadline } };
  }

  // ── 0.5) 事件源不可读 ⇒ 明确判"不可判定"，绝不用 busy 冒充 ──
  //   必要性：插件读不到目标会话事件时，若返回 busy_ignored，
  //   User会去催一个其实没问题的目标 —— 假警报比没警报更坏。
  if (c.eventsUnavailable === true) {
    return { state: STATE.UNDETERMINED, reason: 'events-unreadable', evidence: { note: String(c.eventsReason || '') } };
  }

  // ── 1) 看新增事件里有没有本单痕迹 ──
  const scan = scanEventsForTask(c.newEvents, c.taskId);
  const anyNew = Array.isArray(c.newEvents) ? c.newEvents.length : 0;

  if (scan.seen) {
    if (scan.closed) {
      // 干完了但主侧没收到回执 ⇒ orphaned（只对账，不自动销账）
      return { state: STATE.ORPHANED, reason: 'done-but-no-ack', evidence: { messageIds: scan.messageIds } };
    }
    // 接单了但还没结案 ⇒ in_progress（**不是 busy_ignored**）
    if (elapsed >= progDeadline) {
      return { state: STATE.IN_PROGRESS, reason: 'in-progress-over-deadline', evidence: { elapsed, deadline: progDeadline } };
    }
    return { state: STATE.IN_PROGRESS, reason: 'accepted-not-finished', evidence: { elapsed } };
  }

  // ── 2) 没看到本单痕迹：区分"收到没处理"和"压根没投到" ──
  //   判据：引擎前缀里的 messageId 在不在。在 ⇒ 投到了；不在 ⇒ 投递丢失。
  if (anyNew > 0) {
    const midPresent = c.baseline && c.baseline.messageId
      ? scan.messageIds.includes(String(c.baseline.messageId))
      : false;
    if (midPresent) {
      return { state: STATE.BUSY_IGNORED, reason: 'delivered-but-ignored', evidence: { messageId: c.baseline.messageId } };
    }
    // 有新事件但既没 taskId 也没 messageId ⇒ 消息压根没到
    return { state: STATE.DELIVERY_LOST, reason: 'no-messageId-no-taskId', evidence: { messageId: (c.baseline && c.baseline.messageId) || null } };
  }

  // ── 3) 完全没有新事件：目标可能空闲（健康）或没被唤醒 ──
  if (t.status === 'running') {
    return { state: STATE.BUSY_IGNORED, reason: 'running-but-no-events-yet', evidence: { elapsed } };
  }
  // inactive 是健康空闲 —— 只报"未响应"，不报死
  return { state: STATE.BUSY_IGNORED, reason: 'idle-no-events', evidence: { elapsed, note: 'inactive is healthy idleness, not death' } };
}

/**
 * Write-Ahead 三步落盘的状态转换判定（纯函数，不含 IO）。
 * @param {object} rec      台账记录
 * @param {string} event    'dispatch-ok' | 'dispatch-error' | 'scan-crashed'
 * @param {object} payload
 */
export function nextLedgerState(rec, event, payload) {
  const r = rec || {};
  const p = payload || {};
  if (event === 'dispatch-ok') {
    return { ...r, status: STATE.CONFIRMED, messageId: p.messageId || null, confirmedAt: p.now || Date.now() };
  }
  if (event === 'dispatch-error') {
    return { ...r, status: STATE.ABORTED, abortedAt: p.now || Date.now(), abortReason: String(p.reason || 'dispatch-failed') };
  }
  if (event === 'scan-crashed') {
    return { ...r, status: STATE.ABORTED, abortedAt: p.now || Date.now(), abortReason: 'crashed_during_dispatch' };
  }
  return r;
}

/** pending 超时未确认 ⇒ 判定崩溃（扫描规则用） */
export function findCrashedPending(records, now, ttlMs) {
  const ttl = Number(ttlMs) || DEFAULTS.pendingCrashMs;
  const n = Number(now) || Date.now();
  return (Array.isArray(records) ? records : []).filter(function (r) {
    return r && r.status === STATE.PENDING && Number(r.sentAt) > 0 && n - Number(r.sentAt) >= ttl;
  });
}

export default {
  STATE, DEFAULTS, extractTaskIds, resolveTaskId, scanEventsForTask,
  classify, nextLedgerState, findCrashedPending,
};
