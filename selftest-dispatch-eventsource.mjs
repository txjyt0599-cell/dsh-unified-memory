/**
 * selftest-dispatch-eventsource.mjs —— 事件源接入验收（2026-10-28）
 *
 * ## 治什么病
 * 事件源未接时，dispatch_scan 恒返回空数组 ⇒ in_progress / orphaned / delivery_lost 全判不出来，
 * 而且**更糟**：空数组合法地让 classify 判成 busy_ignored —— 让人去催一个没问题的目标。
 * 本套验的就是「真能读到事件」+「读不到时必须说不可判定」。
 *
 * ## 反例（过不了不算完工）
 *   N1 两条路都读不到 ⇒ 必须 undetermined，**不许** busy_ignored
 *   N2 内存路可读 ⇒ 必须能判出 in_progress（事件里有 taskId 无结案标签）
 *   N3 内存路可读 + 结案标签 ⇒ 必须判 orphaned
 *   N4 sliceNewEvents 按 messageId 定位，不漏不错
 */
import { sliceNewEvents, createEventSource } from './lib/dispatch/event-source.js';
// [2026-10-28] 补 scanEventsForTask：N7 组要用它直接验切片结果，
//   漏了这个导入 ⇒ ReferenceError ⇒ 测试进程静默崩溃、退出码 0（今天第 N 次同类）。
import { classify, STATE, extractTaskIds, scanEventsForTask } from './lib/dispatch/state-machine.js';

let pass = 0, fail = 0;
const fails = [];
function check(g, name, ok, detail) {
  if (ok) { pass++; console.log('  PASS ' + name + (detail ? '   ' + detail : '')); }
  else { fail++; fails.push(name); console.log('  FAIL ' + name + (detail ? '   ' + detail : '')); }
}

function ev(text, messageId, seq) {
  return {
    seq: seq === undefined ? Math.random() : seq,
    type: 'user/message',
    data: { message: { role: 'user', content: [{ type: 'text', text: String(text) }], source: { kind: 'team-message', messageId: messageId || null } } },
  };
}

const T = 'task-ev-001';
const MID = 'team-message-mine-001';

console.log('════ DISPATCH-EVENTSOURCE 验收 ════');

// ── A · sliceNewEvents ──
console.log('\n── A · 切片 ──');
{
  const all = [ev('旧事件1', 'm0'), ev('旧事件2', 'm1'), ev('我们投的', MID), ev('新事件A', 'm2'), ev('新事件B', 'm3')];
  // ── [2026-10-28 语义修正 · 真实派单实测逼出来的] ──
  //   A1/A2 原来断言"按 messageId 定位、只取之后、不含自己那条"。
  //   **那个行为本身就是 bug**：投递痕迹比 user/message 更早，
  //   切掉自己那条 = 可能连投递痕迹一起切掉 ⇒ scan 恒 seen=false ⇒ 恒判 delivery_lost。
  //   ⇒ 正确语义：**优先按 eventCountBefore 切**（投递前事件数），
  //      messageId 只作降级，且降级时也**含**本条（宁多看一条不漏痕迹）。
  const byCount = sliceNewEvents(all, { eventCountBefore: 3 });
  check('A', 'A1a 优先按 eventCountBefore 切（取投递后的全部）', byCount.length === 2, 'len=' + byCount.length);
  const byMid = sliceNewEvents(all, { messageId: MID });   // 无 eventCountBefore ⇒ 降级
  check('A', 'A1b 降级按 messageId 时**含**自己那条（不漏投递痕迹）', byMid.length === 3, 'len=' + byMid.length);
  check('A', 'A2 降级切片里能看见自己的投递消息', byMid.some(e => (e.data.message.source.messageId) === MID));

  const got2 = sliceNewEvents(all, { eventCountBefore: 3 });
  check('A', 'A3 按偏移切片也对', got2.length === 2);
  check('A', 'A4 空数组安全', sliceNewEvents([], { messageId: MID }).length === 0);
  check('A', 'A5 null 安全', sliceNewEvents(null, {}).length === 0);
}

// ── B · 事件源：内存路 ──
console.log('\n── B · 内存路 ──');
{
  // events: [0]旧  [1]我们投的  [2]带 taskId 的接单回执
  // eventCountBefore=1 ⇒ 从 index 1 切 ⇒ 2 条（我们投的 + 接单）
  const events = [ev('旧', 'm0'), ev('我们投的', MID), ev('[[TASK:' + T + ']]\n收到，处理中', 'm2')];
  const fakeSessions = {
    get(id) {
      if (id !== 'sess-peer') return undefined;
      return { snapshotEvents: (from) => (from === 0 ? events.slice() : events.slice(from)) };
    },
  };
  const src = createEventSource({ getSessions: () => fakeSessions, getPersistence: () => null });
  // [2026-10-28 语义修正] 带 eventCountBefore（真实调用就这么传）⇒ 从投递前切
  const r = await src.newEventsSince('sess-peer', { eventCountBefore: 1, messageId: MID });
  check('B', 'B1 内存路读到了', r.ok === true && r.via === 'memory', JSON.stringify({ ok: r.ok, via: r.via }));
  check('B', 'B2 返回投递后的全部（含自己那条 + 后续）', r.events.length === 2, 'len=' + r.events.length);
  check('B', 'B3 新增里能解析出 taskId',
    r.events.some(e => extractTaskIds((((e.data || {}).message || {}).content || []).map(x => x.text).join('')).includes(T)));
}

// ── C · 事件源：持久化兜底 ──
console.log('\n── C · 持久化兜底 ──');
{
  const events = [ev('旧', 'm0'), ev('我们投的', MID), ev('新', 'm2')];
  const fakePersist = {
    async open(id, mode) {
      return {
        header: { id },
        // [2026-10-28] 修正：真实 read(offset) 会按 offset 切；假实现也要同构，
        //   否则测不出"持久化路是否真的按偏移读"。
        async read(from, to) { return { events: events.slice(Number(from) || 0) }; },
        async close() {},
      };
    },
  };
  const src = createEventSource({ getSessions: () => null, getPersistence: () => fakePersist });
  const r = await src.newEventsSince('sess-archived', { eventCountBefore: 1, messageId: MID });
  check('C', 'C1 内存不可用时走持久化', r.ok === true && r.via === 'persistence', JSON.stringify({ ok: r.ok, via: r.via }));
  check('C', 'C2 拿到的数据可用（投递后 2 条）', r.events.length === 2, 'len=' + r.events.length);
}

// ── N1 · 反例：两条路都读不到 ⇒ undetermined（不许 busy）──
console.log('\n── N1 · 反例：读不到 ⇒ undetermined ──');
{
  const src = createEventSource({ getSessions: () => null, getPersistence: () => null });
  const r = await src.newEventsSince('sess-ghost', { messageId: MID });
  check('N1', 'N1a 读取明确失败', r.ok === false, JSON.stringify(r));
  check('N1', 'N1b 失败原因是 unreadable', r.reason === 'unreadable');

  const cls = classify({
    taskId: T, now: Date.now(),
    baseline: { sentAt: Date.now() - 60000, eventCountBefore: 0, messageId: MID },
    target: { phase: 'active', status: 'running', exists: true },
    newEvents: r.events,
    eventsUnavailable: true,
    eventsReason: r.reason,
  });
  check('N1', 'N1c **判 undetermined，不是 busy_ignored**', cls.state === STATE.UNDETERMINED, cls.state);
  check('N1', 'N1d **不是 dead_target**', cls.state !== STATE.DEAD_TARGET);
}

// ── N2 · 能判 in_progress ──
console.log('\n── N2 · in_progress 真能判出来吗 ──');
{
  const events = [ev('我们投的', MID), ev('[[TASK:' + T + ']]\n收到，处理中', 'm2')];
  const fakeSessions = { get: () => ({ snapshotEvents: () => events.slice() }) };
  const src = createEventSource({ getSessions: () => fakeSessions });
  const r = await src.newEventsSince('x', { messageId: MID });
  const cls = classify({
    taskId: T, now: Date.now(),
    baseline: { sentAt: Date.now() - 60000, eventCountBefore: 0, messageId: MID },
    target: { phase: 'active', status: 'running', exists: true },
    newEvents: r.events,
    eventsUnavailable: !r.ok,
  });
  check('N2', 'N2a 接上事件源后能判 in_progress', cls.state === STATE.IN_PROGRESS, cls.state + ' / ' + cls.reason);
  check('N2', 'N2b **不再误判 busy**', cls.state !== STATE.BUSY_IGNORED);
}

// ── N3 · 能判 orphaned ──
console.log('\n── N3 · orphaned 真能判出来吗 ──');
{
  const events = [ev('我们投的', MID), ev('[[TASK:' + T + ']]\n[[DONE]] 已完成', 'm2')];
  const fakeSessions = { get: () => ({ snapshotEvents: () => events.slice() }) };
  const src = createEventSource({ getSessions: () => fakeSessions });
  const r = await src.newEventsSince('x', { messageId: MID });
  const cls = classify({
    taskId: T, now: Date.now(),
    baseline: { sentAt: Date.now() - 60000, eventCountBefore: 0, messageId: MID },
    target: { phase: 'active', status: 'inactive', exists: true },
    newEvents: r.events,
    eventsUnavailable: !r.ok,
  });
  check('N3', 'N3a 能判 orphaned', cls.state === STATE.ORPHANED, cls.state + ' / ' + cls.reason);
  check('N3', 'N3b orphaned 仍不等于 closed', cls.state !== STATE.CLOSED);
}

// ── N4 · delivery_lost 真能判 ──
console.log('\n── N4 · delivery_lost ──');
{
  // 投递后目标有新事件，但既无我们的 messageId 也无 taskId
  const events = [ev('旧', 'm0'), ev('别人在聊别的', 'other-msg'), ev('继续别的', 'other-2')];
  const fakeSessions = { get: () => ({ snapshotEvents: () => events.slice() }) };
  const src = createEventSource({ getSessions: () => fakeSessions });
  const r = await src.newEventsSince('x', { messageId: MID });
  const cls = classify({
    taskId: T, now: Date.now(),
    baseline: { sentAt: Date.now() - 60000, eventCountBefore: 0, messageId: MID },
    target: { phase: 'active', status: 'running', exists: true },
    newEvents: r.events,
    eventsUnavailable: !r.ok,
  });
  check('N4', 'N4a 能判 delivery_lost', cls.state === STATE.DELIVERY_LOST, cls.state + ' / ' + cls.reason);
}

// ── N5 · 异常隔离 ──
console.log('\n── N5 · 异常隔离 ──');
{
  const src = createEventSource({ getSessions: () => { throw new Error('boom'); }, getPersistence: () => { throw new Error('boom2'); } });
  let threw = false;
  let r;
  try { r = await src.newEventsSince('x', { messageId: MID }); } catch { threw = true; }
  check('N5', 'N5a 服务抛错时不向外抛', threw === false);
  check('N5', 'N5b 而是返回 ok=false', r && r.ok === false, JSON.stringify(r));
}

// ── N6 · 增量读（2026-10-28 第二轮改进的验收）──
//   上一版固定 read(0, undefined) 整包读；会话 40MB 时每次 scan 全量解压。
//   现在必须：① 内存路从 eventCountBefore 起读（不是 0）
//             ② 持久化路把 offset 传给 read(offset, length)
//             ③ 读不到时仍 ok=false（不许因为改了读法就放松）
console.log('\n── N6 · 增量读 ──');
{
  // 内存路：记录被调用的 fromSeq
  let memFromSeq = null;
  const all = Array.from({ length: 100 }, function (_, i) { return ev('事件' + i, 'm' + i, i); });
  const fakeSessions = {
    get: () => ({ snapshotEvents: (from) => { memFromSeq = from; return all.slice(from); } }),
  };
  const src = createEventSource({ getSessions: () => fakeSessions });
  const r = await src.newEventsSince('x', { eventCountBefore: 90 });
  check('N6', 'N6a 内存路从 baseline 偏移读，不是 0', memFromSeq === 90, 'from=' + memFromSeq);
  check('N6', 'N6b 返回条数 = 总数 - 偏移', r.events.length === 10, 'len=' + r.events.length);
  check('N6', 'N6c 返回值带 offsetUsed', r.offsetUsed === 90, 'offsetUsed=' + r.offsetUsed);

  // 持久化路：记录 read 的 offset 参数
  let readOffset = null, readLength = null;
  const fakePersist = {
    async open() {
      return {
        async read(off, len) { readOffset = off; readLength = len; return { events: all.slice(off) }; },
        async close() {},
      };
    },
  };
  const src2 = createEventSource({ getSessions: () => null, getPersistence: () => fakePersist });
  const r2 = await src2.newEventsSince('archived', { eventCountBefore: 95 });
  check('N6', 'N6d 持久化路把 offset 传进 read()', readOffset === 95, 'offset=' + readOffset);
  check('N6', 'N6e 持久化路同样返回正确条数', r2.events.length === 5, 'len=' + r2.events.length);

  // 反例：偏移非法（负数/小数/非数字）必须退化为 0，不许瞎传
  let badOffsetUsed = null;
  const fakeSessions2 = { get: () => ({ snapshotEvents: (from) => { badOffsetUsed = from; return all.slice(from); } }) };
  const src3 = createEventSource({ getSessions: () => fakeSessions2 });
  await src3.newEventsSince('x', { eventCountBefore: -5 });
  check('N6', 'N6f 负偏移退化为 0（不瞎传）', badOffsetUsed === 0, 'from=' + badOffsetUsed);
  await src3.newEventsSince('x', { eventCountBefore: 1.5 });
  check('N6', 'N6g 小数偏移退化为 0', badOffsetUsed === 0, 'from=' + badOffsetUsed);

  // 反例：没有 baseline 时读全量，且不报错
  const r4 = await src3.newEventsSince('x', {});
  check('N6', 'N6h 无 baseline 时读全量（100 条）', r4.events.length === 100, 'len=' + r4.events.length);
}

// ── N7 · 切片起点必须含"我们那条消息"（2026-10-28 真实派单抓到的 bug）──
//   病：sliceNewEvents 原来从 idx+1 切 ⇒ 跳过我们自己的 user/message。
//       但 taskId 首次出现在**投递侧事件**（agent/inbox/spliced），比 user/message 更早，
//       被切掉 ⇒ scanEventsForTask 永远 seen=false ⇒ 恒判 delivery_lost。
//   实测：修前 delivery_lost、修后 in_progress。
console.log('\n── N7 · 切片含投递痕迹 ──');
{
  const TASK = 'T-test-N7';
  const MID = 'team-message-n7';

  // 构造真实形态：投递痕迹在**我们消息之前**
  const events = [
    { type: 'agent/inbox/spliced', data: { text: '投递中 [[TASK:' + TASK + ']]' } },
    { type: 'user/message', data: { message: { role: 'user', content: [{ type: 'text', text: '[[TASK:' + TASK + ']]\n干活' }], source: { kind: 'team-message', messageId: MID } } } },
    { type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'text', text: '收到' }] } } },
  ];

  // [2026-10-28] 关键：真实调用会同时带 eventCountBefore（投递前事件数）。
  //   第一版测试只传 messageId ⇒ 走降级路径 ⇒ 期望值写错了。
  //   真实链条：dispatch_send 记 eventCountBefore，scan 时一起传进去。
  const sliced = sliceNewEvents(events, { eventCountBefore: 0, messageId: MID });
  check('N7', 'N7a 从 eventCountBefore 切 ⇒ 包含投递侧事件（3 条全在）', sliced.length === 3, 'len=' + sliced.length);

  // [2026-10-28 补 · 这条才真正钉住优先级]
  //   实测真实数据：taskId 在**两个地方**出现 ——
  //     第 86 条 agent/inbox/spliced（data.inserted 里，scan 不扫它）
  //     第 91 条 user/message（scan 只扫这里）
  //   ⇒ 只要 user/message 不被切掉，就能看到。
  //   "按 messageId 定位"会从 user/message 之后切 ⇒ 恰好把它自己切掉 ⇒ seen=false。
  //   所以：构造 [投递痕迹, user/message(带taskId+MID), assistant]，
  //   若实现优先 messageId ⇒ 从第 3 条切 ⇒ seen=false；
  //   若优先 eventCountBefore ⇒ 从第 1 条切 ⇒ seen=true。
  const tricky = [
    { type: 'agent/inbox/spliced', data: { target: 'x', inserted: [{ text: '[[TASK:' + TASK + ']]' }] } },
    { type: 'user/message', data: { message: { role: 'user', content: [{ type: 'text', text: '[[TASK:' + TASK + ']]\n干活' }], source: { kind: 'team-message', messageId: MID } } } },
    { type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'text', text: '收到' }] } } },
  ];
  const s2 = sliceNewEvents(tricky, { eventCountBefore: 0, messageId: MID });
  const scan2 = scanEventsForTask(s2, TASK);
  check('N7', 'N7b eventCountBefore 优先于 messageId（不许被 messageId 切掉任务消息）',
    s2.length === 3 && scan2.seen === true, 'len=' + s2.length + ' seen=' + scan2.seen);

  const scan = scanEventsForTask(sliced, TASK);
  check('N7', 'N7b 切片后能看到本单 taskId', scan.seen === true, JSON.stringify(scan));

  // 端到端：应判 in_progress，不是 delivery_lost
  const cls = classify({
    taskId: TASK, now: Date.now(),
    baseline: { sentAt: Date.now() - 60000, eventCountBefore: 0, messageId: MID },
    target: { status: 'inactive', phase: 'active', exists: true },
    newEvents: sliced, eventsUnavailable: false,
  });
  check('N7', 'N7c 判 in_progress（不是 delivery_lost）', cls.state === STATE.IN_PROGRESS, cls.state + ' / ' + cls.reason);
}

console.log('\n════ SUMMARY ════');
console.log('  pass=' + pass + ' fail=' + fail);
if (fail) console.log('  失败项: ' + fails.join(' | '));
process.exit(fail ? 1 : 0);
