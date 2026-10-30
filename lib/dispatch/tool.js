/**
 * lib/dispatch/tool.js —— 派单三手柄（dispatch_send / dispatch_scan / dispatch_close）
 * [2026-10-28 · 派单回执状态机 v1 接线]
 *
 * ## 为什么是三个工具而不是一个大工具
 *   发单、对账、销账是三件**在不同时刻发生**的事。合成一个会变成
 *   「调用一次就要等很久」或「一次调用做了三件事但说不清哪件失败」。
 *
 * ## 铁律（写在工具描述里，让模型也看得到）
 *   ① 协议标签必须**独占行**：`[[TASK:<id>]]`，不能行内匹配（反例 E/F）
 *   ② orphaned 只对账，**绝不自动销账**（有痕迹 ≠ 已完成）
 *   ③ inactive 是健康空闲，**不是死**
 */

import { STATE, DEFAULTS, extractTaskIds, classify } from './state-machine.js';

/** 生成一个可读的 taskId */
export function newTaskId() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return 'T' + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) +
    '-' + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds()) +
    '-' + Math.random().toString(36).slice(2, 6);
}

/** 组装带协议标签的消息体（标签独占行） */
export function frameMessage(taskId, body) {
  return '[[TASK:' + taskId + ']]\n' + String(body || '');
}

// ── [2026-10-28 by Assistant · 修一个"日志说成功、实际全失败"的真事故] ──
//   线上（src:"dsh" pid:18940）三个工具**全部注册失败**：
//     tool "dispatch_send" must declare output { schema, render, presentationMeta? }
//   而同一行 probe 仍打出 `dispatch-tools-registered n=3` ——
//   因为那个 n 数的是"循环遍历了几个"，不是"成功注册了几个"。
//   ⇒ 又一次「日志说成功 ≠ 真的成功」。今天第三次同类。
//   修法：① 三工具补 output { schema, render }
//         ② index.js 的注册计数改成**成功数**，失败单独记。
const SEND_OUTPUT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean' },
    taskId: { type: 'string' },
    // [2026-10-28 by Assistant · 线上实测报错修正]
    //   原写 type: ['string','null']，被 DSH schema 校验器拒绝：
    //     unsupported JSON schema: ... type must be a single type string
    //   ⇒ 联合类型不支持；改用单类型，空值用空串表达（render 里已按 falsy 处理）。
    messageId: { type: 'string' },
    status: { type: 'string' },
    error: { type: 'string' },
    note: { type: 'string' },
  },
  required: ['ok'],
};
const SCAN_OUTPUT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean' },
    count: { type: 'integer' },
    items: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          taskId: { type: 'string' },
          state: { type: 'string' },
          reason: { type: 'string' },
          target: { type: 'string' },
          ageMs: { type: 'number' },
        },
      },
    },
  },
  required: ['ok', 'count'],
};
const CLOSE_OUTPUT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean' },
    error: { type: 'string' },
    taskId: { type: 'string' },
    closed: { type: 'object', additionalProperties: true },
  },
  required: ['ok'],
};

function renderSend(_a, v) {
  if (!v || v.ok !== true) return [{ type: 'text', text: '派单失败：' + String((v && v.error) || '未知原因') }];
  return [{ type: 'text', text: '已投递 taskId=' + v.taskId + '（status=' + v.status + '，messageId=' + (v.messageId || 'null') + '）。用 dispatch_scan 查进展。' }];
}
function renderScan(_a, v) {
  const items = (v && v.items) || [];
  if (!items.length) return [{ type: 'text', text: '当前没有在途派单。' }];
  return [{ type: 'text', text: '在途 ' + items.length + ' 条：' + items.map(function (x) { return x.taskId + '=' + x.state + '(' + x.reason + ')'; }).join('；') }];
}
function renderClose(_a, v) {
  if (!v || v.ok !== true) return [{ type: 'text', text: '销账失败：' + String((v && v.error) || '未知原因') }];
  return [{ type: 'text', text: '已销账 ' + ((v.closed && v.closed.taskId) || v.taskId) + '。' }];
}

/**
 * @param {object} deps { ledger, sendMessage, getAgents, getSessionEvents, logger }
 */
export function createDispatchTools(deps) {
  const d = deps || {};
  const ledger = d.ledger;
  const log = d.logger || null;
  if (!ledger) throw new Error('createDispatchTools: ledger required');

  // ── 工具 1：dispatch_send ──
  const sendTool = {
    name: 'dispatch_send',
    output: { schema: SEND_OUTPUT, render: renderSend },
    description: [
      '派一条活给团队某个成员，并纳入回执台账监控。',
      '',
      '用法：target 是成员名（如 "redteam-p7"），body 是派单正文。',
      '正文请按四件套写：【现象】【照哪做/边界】【怎么验】【回执口径】。',
      '本工具会自动在正文最前面加一行独占标签 [[TASK:<id>]]，不要自己加。',
      '',
      '返回 taskId，后续用 dispatch_scan 查状态、dispatch_close 销账。',
      '',
      '⛔ 提醒：回执丢了不代表没做完。dispatch_scan 检出的 orphaned 只表示"要你去对账"，不表示已结案。',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        target: { type: 'string', description: '目标成员名（team roster 里的 name）' },
        body: { type: 'string', description: '派单正文（四件套）' },
        subject: { type: 'string', description: '一句话主题，便于台账检索' },
      },
      required: ['target', 'body'],
    },
    // ── [2026-10-28 by Assistant · 第五次真实派单修正] ──
    //   报错：signals[0] is not of type AbortSignal
    //   根因：mailbox.send 里是 AbortSignal.any([request.signal, lifecycle.signal])，
    //        request.signal **必须是真正的 AbortSignal**，缺省就崩。
    //   官方工具从 execute(args, exec) 的**第二参**拿 exec.signal；
    //   我原来只签了 (args) ⇒ exec 永远 undefined ⇒ 没有 signal。
    //   ⇒ 改签名接收 exec，并把 exec.signal / exec.agent 一路传下去。
    async execute(args, exec) {
      const a = args || {};
      const signal = (exec && exec.signal) || null;
      const execAgent = (exec && exec.agent) || null;
      const taskId = newTaskId();
      // ① Write-Ahead：先落 pending
      const rec = ledger.begin(taskId, {
        targetName: String(a.target || ''),
        subject: String(a.subject || a.body || '').slice(0, 200),
        sentAt: Date.now(),
        // 五元组跳转键：记下目标会话 id（src 由 --src 传或留空）
        dstSessionId: String(a.targetSessionId || ''),
        srcSessionId: String(a.srcSessionId || ''),
      });
      try {
        const text = frameMessage(taskId, a.body);
        // [2026-10-28 by Assistant · 修正真实签名]
        //   agentTeams.sendMessage(caller, request) 是**两个参数**。
        //   deps.sendMessage 保持同构（caller, request），由 index.js 提供真实 caller。
        //   ⛔ 绝不合并成一个 args 对象 —— 那样会把"参数缺失"藏起来（今天真吃了这个亏：
        //      运行时报 Cannot read properties of undefined (reading 'signal')，
        //      而所有用假函数的测试都是绿的）。
        const res = await d.sendMessage(d.caller || execAgent, {
          target: a.target,
          content: [{ type: 'text', text }],
          signal,
        });
        // ② 成功 ⇒ confirmed + 绑定 messageId
        ledger.settle(taskId, 'dispatch-ok', { messageId: res && res.messageId, now: Date.now() });
        try { log && log.wake && log.wake({ level: 'dispatch-sent', taskId, target: a.target, messageId: res && res.messageId }); } catch {}
        return {
          ok: true,
          taskId,
          // schema 已声明为 string，null 会过不了输出校验 ⇒ 用空串表达"没有"
          messageId: String((res && res.messageId) || ''),
          status: STATE.CONFIRMED,
          note: '已投递并纳入监控。用 dispatch_scan 查进展。',
        };
      } catch (e) {
        // ③ 抛错 ⇒ aborted（不进在途监控）
        const reason = String(e && e.message || e).slice(0, 200);
        ledger.settle(taskId, 'dispatch-error', { reason, now: Date.now() });
        try { log && log.miss && log.miss({ level: 'dispatch-send-failed', taskId, reason }); } catch {}
        return { ok: false, taskId, status: STATE.ABORTED, error: reason, note: '投递失败，已直接结案，不会误报在途。' };
      }
    },
  };

  // ── 工具 2：dispatch_scan ──
  const scanTool = {
    name: 'dispatch_scan',
    output: { schema: SCAN_OUTPUT, render: renderScan },
    description: [
      '对账：检查在途派单的真实状态。',
      '',
      '返回每条单的 state 与 reason。可能的状态：',
      '  in_progress      对方接单在处理（正常）',
      '  busy_ignored     消息投到了但对方没处理（催一下）',
      '  delivery_lost    消息压根没投到（修管道，不是催对方）',
      '  orphaned         对方做完了但回执丢了（去对账，⚠️ 不要直接销账）',
      '  dead_target      目标真死（failed / 对象消失）',
      '  unstructured_reply  回了但没按四件套',
      '',
      '⛔ inactive 是健康空闲态，本工具不会把它判成 dead。',
    ].join('\n'),
    parameters: { type: 'object', properties: { taskId: { type: 'string', description: '可选：只查这一条' } } },
    async execute(args) {
      const a = args || {};
      const recs = a.taskId ? [ledger.find(a.taskId)].filter(Boolean) : ledger.list();
      // ── [2026-10-28 by Assistant · 区分"空名册"与"读失败"] ──
      //   getAgents 返回 null 表示**读失败**（服务缺失/caller 拿不到/抛错），
      //   返回 [] 表示**名册真的空**。两者对状态机的含义完全不同：
      //     null ⇒ 判 undetermined（不知道人还在不在，别慌）
      //     []   ⇒ 才可能是 dead_target
      //   ⛔ 合并成一个空数组会导致"读失败也报死人" —— 就是今天那次误报的形态。
      const agentsRaw = (typeof d.getAgents === 'function') ? d.getAgents() : null;
      const agentsUnreadable = (agentsRaw === null || agentsRaw === undefined);
      const agents = Array.isArray(agentsRaw) ? agentsRaw : [];
      const byName = new Map(agents.map(function (m) { return [String(m.name || m.target || ''), m]; }));
      const out = [];
      for (const rec of recs) {
        if (rec.status === STATE.ABORTED || rec.status === STATE.PENDING) {
          out.push({ taskId: rec.taskId, state: rec.status, reason: 'not-in-flight' });
          continue;
        }
        const ag = byName.get(rec.targetName) || null;
        // [2026-10-28] 名册读失败 ⇒ 不设定 exists:false（那是"人不在了"的断言），
        //   而是交给 classify 判 undetermined。只有**确实读到名册且查无此人**才 exists:false。
        const target = ag
          ? { status: String(ag.status || ''), phase: String(ag.phase || ag.status || ''), exists: true }
          : (agentsUnreadable
            ? { status: 'unknown', phase: 'unknown', exists: null }
            : { status: 'inactive', phase: 'active', exists: false });
        const rosterUnreadable = agentsUnreadable;
        // ── [2026-10-28 by Assistant · 自动补 dstSessionId] ──
        //   第六次派单的教训：发单时没传 targetSessionId ⇒ 台账里 dstSessionId 为空
        //   ⇒ 事件源拿不到会话 ⇒ 恒判 undetermined（"读不到就说不知道"行为正确，但没用）。
        //   名册成员的 id 就是 agent id，从它能取到 agent.session.id。
        //   ⇒ 这里按需补一次（只在 dstSessionId 为空且名册能查到人时）。
        //      ⚠️ 不改台账（那是审计事实），只在本次扫描的判定上下文里用。
        let dstSidUsed = String(rec.dstSessionId || '');
        if (!dstSidUsed && ag && typeof d.getAgentSessionId === 'function') {
          try {
            const resolved = await d.getAgentSessionId(ag.id || rec.targetName);
            if (resolved) dstSidUsed = String(resolved);
          } catch { /* 补不上就保持空，下游会判 undetermined */ }
        }
        // [2026-10-28 诊断] 记录本次解析结果，便于线上排查"为什么读不到"
        try {
          log && log.wake && log.wake({
            level: 'dispatch-scan-sid',
            taskId: rec.taskId,
            ledgerSid: String(rec.dstSessionId || ''),
            usedSid: dstSidUsed,
            hasAg: !!ag,
            agId: ag ? String(ag.id || '') : '',
          });
        } catch {}
        // 新增事件：由宿主注入（无法在此独立取，交由 deps 提供）
        // ── [2026-10-28 by Assistant · 接事件源] 真读目标会话的新增事件 ──
        //   原来这里恒返回 []，导致 in_progress / orphaned / delivery_lost 全判不出来。
        //   现在走 deps.getSessionEvents，它内部有「内存 → 持久化」两条路。
        //   ⛔ 读不到时**必须**传 eventsUnavailable，让 classify 判 undetermined，
        //      绝不用空数组冒充"没有新增"（那会误判成 busy，让人去催没问题的目标）。
        let newEvents = [];
        let eventsUnavailable = false;
        let eventsReason = '';
        try {
          if (typeof d.getSessionEvents === 'function') {
            // 用本次解析出的 dstSessionId（可能由名册自动补全）
            const got = await d.getSessionEvents({ ...rec, dstSessionId: dstSidUsed });
            if (got && typeof got === 'object' && Array.isArray(got.events)) {
              newEvents = got.events;
              eventsUnavailable = got.ok === false;
              eventsReason = String(got.reason || '');
            } else if (Array.isArray(got)) {
              // 兼容旧签名：直接返回数组 ⇒ 视为可读
              newEvents = got;
            } else {
              eventsUnavailable = true;
              eventsReason = 'bad-return-shape';
            }
          } else {
            eventsUnavailable = true;
            eventsReason = 'no-event-source';
          }
        } catch (e) {
          eventsUnavailable = true;
          eventsReason = String(e && e.message || e).slice(0, 120);
        }
        const r = classify({
          taskId: rec.taskId,
          baseline: { sentAt: rec.sentAt, eventCountBefore: rec.eventCountBefore, messageId: rec.messageId },
          target, newEvents, now: Date.now(),
          eventsUnavailable, eventsReason,
          // [2026-10-28] 名册读失败 ⇒ 上层判 undetermined（"不知道"而不是"死了"）
          //   这条不传的话，exists:null 会走到默认分支变成"目标不存在"，又成误报。
          rosterUnreadable,
        });
        if (r.state !== rec.status) {
          rec.status = r.state;
          rec.note = r.reason;
          ledger.flush();
        }
        out.push({ taskId: rec.taskId, state: r.state, reason: r.reason, target: rec.targetName, ageMs: Date.now() - rec.sentAt });
      }
      return { ok: true, count: out.length, items: out };
    },
  };

  // ── 工具 3：dispatch_close ──
  const closeTool = {
    name: 'dispatch_close',
    output: { schema: CLOSE_OUTPUT, render: renderClose },
    description: [
      '销账：把一条派单从在途移入已结案，保留五元组跳转键供日后复盘。',
      '',
      '⚠️ 只在**确认对方真的做完**时用。orphaned 状态不等于已完成，必须先对账拿到明确回执。',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: '要销账的 taskId' },
        verdict: { type: 'string', description: '一句话结论（结论+证据+落盘路径）' },
        ackMsgId: { type: 'string', description: '可选：对方的回执消息 id' },
      },
      required: ['taskId'],
    },
    async execute(args) {
      const a = args || {};
      const rec = ledger.close(a.taskId, { verdict: a.verdict, ackMsgId: a.ackMsgId });
      if (!rec) return { ok: false, error: 'task-not-found', taskId: a.taskId };
      return { ok: true, closed: rec };
    },
  };

  return [sendTool, scanTool, closeTool];
}

export default { createDispatchTools, newTaskId, frameMessage };
