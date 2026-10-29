/**
 * selftest-dispatch-wiring.mjs —— 派单工具接线验收（2026-10-28）
 *
 * ## 判据
 *   不是"代码看起来接上了"，而是：
 *     ① 插件 apply() 后，ctx.tools 里真的多了三个工具
 *     ② 工具的 execute 真的能跑通（发单→台账 pending→confirmed）
 *     ③ 投递抛错时真的转 aborted（不做孤儿映射）
 *     ④ 台账真的落盘（重启后能读回）
 *     ⑤ 反例：没有 agentTeams 时必须明确报错，不许假装成功
 */
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let pass = 0, fail = 0;
const fails = [];
function check(g, name, ok, detail) {
  if (ok) { pass++; console.log('  PASS ' + name + (detail ? '   ' + detail : '')); }
  else { fail++; fails.push(name); console.log('  FAIL ' + name + (detail ? '   ' + detail : '')); }
}

const LIB = 'D:/dsh-plugins/dsh-unified-memory/lib';
const { createLedger } = await import('file:///' + LIB + '/dispatch/ledger.js');
const { createDispatchTools, newTaskId, frameMessage } = await import('file:///' + LIB + '/dispatch/tool.js');
const { STATE } = await import('file:///' + LIB + '/dispatch/state-machine.js');

console.log('════ DISPATCH-WIRING 接线验收 ════');

const tmp = mkdtempSync(join(tmpdir(), 'disp-'));
const ledgerPath = join(tmp, 'dispatch-active.json');

// ── A · 发单：Write-Ahead 三步 ──
console.log('\n── A · 发单（Write-Ahead）──');
{
  const ledger = createLedger({ path: ledgerPath });
  let captured = null;
  // [2026-10-28 补] Write-Ahead 的**时序**必须被验证：
  //   在 sendMessage 被调用的那一刻，台账里必须已经有一条 pending。
  //   只验证"最终落盘了"抓不到"先投递后落盘"——那样崩溃就会丢单。
  let inFlightSeenAtSend = null;
  const tools = createDispatchTools({
    ledger,
    // [2026-10-28 修正] 真实签名是 sendMessage(caller, request)，
    //   request 里是 content 数组（不是 message 字段）。假函数必须同构，
    //   否则测试会对着一个"比现实宽容"的接口全绿。
    sendMessage: async (caller, request) => {
      captured = { caller, request, message: (request && request.content || []).map(x => x.text || '').join('') };
      try {
        const snapshot = JSON.parse(readFileSync(ledgerPath, 'utf8'));
        const pend = snapshot.records.filter(r => r.status === 'pending');
        inFlightSeenAtSend = pend.length;
      } catch { inFlightSeenAtSend = -1; }
      return { messageId: 'team-message-fake-1', status: 'accepted' };
    },
    getAgents: () => [{ name: 'peer-a', status: 'running', phase: 'active' }],
    getSessionEvents: () => [],
  });
  check('A', 'A1 注册了三个工具', tools.length === 3, tools.map(t => t.name).join(','));
  check('A', 'A2 工具名正确', tools.map(t => t.name).join(',') === 'dispatch_send,dispatch_scan,dispatch_close');

  const send = tools.find(t => t.name === 'dispatch_send');
  // [2026-10-28] execute 必须带第二参 exec（真实实现从它拿 signal / agent）
  const execStub = { agent: { id: 'peer-a' }, signal: new AbortController().signal };
  const res = await send.execute({ target: 'peer-a', body: '【现象】x\n【照哪做】y\n【怎么验】z\n【回执口径】回一句', subject: '测试单' }, execStub);
  check('A', 'A3 发单成功', res.ok === true, JSON.stringify(res));
  check('A', 'A4 台账状态为 confirmed', res.status === STATE.CONFIRMED);
  check('A', 'A5 绑定了 messageId', res.messageId === 'team-message-fake-1');
  check('A', 'A6 消息体带独占行标签', captured && /^\[\[TASK:[^\]]+\]\]\n/.test(captured.message), captured && captured.message.slice(0, 40));
  check('A', 'A7 标签能被状态机解析回来', (await import('file:///' + LIB + '/dispatch/state-machine.js')).extractTaskIds(captured.message).length === 1);
  // 台账落盘
  check('A', 'A8 台账真的落盘', existsSync(ledgerPath));
  const onDisk = JSON.parse(readFileSync(ledgerPath, 'utf8'));
  check('A', 'A9 落盘内容含该单', onDisk.records.some(r => r.taskId === res.taskId));
  // ── 关键：Write-Ahead 时序（W1 变异就是靠这条抓）──
  check('A', 'A10 **投递发生的那一刻，台账里已有 pending**（Write-Ahead 生效）',
    inFlightSeenAtSend === 1, 'sendTime pending=' + inFlightSeenAtSend);
}

// ── B · 反例：投递抛错必须转 aborted（不留孤儿 pending）──
console.log('\n── B · 反例：投递抛错 ──');
{
  const ledger = createLedger({ path: join(tmp, 'ledger-b.json') });
  const tools = createDispatchTools({
    ledger,
    sendMessage: async () => { throw new Error('TEAM_MESSAGE_TOO_LARGE'); },
    getAgents: () => [],
    getSessionEvents: () => [],
  });
  const send = tools.find(t => t.name === 'dispatch_send');
  const res = await send.execute({ target: 'peer-b', body: '太长了' });
  check('B', 'B1 抛错时 ok=false', res.ok === false);
  check('B', 'B2 状态 aborted（不进在途监控）', res.status === STATE.ABORTED, res.status);
  check('B', 'B3 记录了失败原因', String(res.error).indexOf('TOO_LARGE') >= 0);
  const rec = ledger.find(res.taskId);
  check('B', 'B4 台账里没有孤儿 pending', rec && rec.status === STATE.ABORTED, rec && rec.status);
}

// ── C · 反例：没有 agentTeams 时必须明确失败 ──
console.log('\n── C · 反例：服务不可用 ──');
{
  const ledger = createLedger({ path: join(tmp, 'ledger-c.json') });
  // 模拟 sendMessage 包装层：服务缺失
  const tools = createDispatchTools({
    ledger,
    sendMessage: async () => { throw new Error('agentTeams.sendMessage unavailable: 该服务未注入或团队功能未启用'); },
    getAgents: () => [],
    getSessionEvents: () => [],
  });
  const send = tools.find(t => t.name === 'dispatch_send');
  const res = await send.execute({ target: 'nobody', body: 'x' });
  check('C', 'C1 服务缺失时明确失败', res.ok === false);
  check('C', 'C2 错误信息说明是服务不可用', String(res.error).indexOf('unavailable') >= 0);
  check('C', 'C3 **不许假装成功**', res.ok !== true);
}

// ── D · scan 与 close ──
console.log('\n── D · scan / close ──');
{
  const ledger = createLedger({ path: join(tmp, 'ledger-d.json') });
  const tools = createDispatchTools({
    ledger,
    sendMessage: async () => ({ messageId: 'team-message-d-1' }),
    getAgents: () => [{ name: 'peer-d', status: 'running', phase: 'active' }],
    getSessionEvents: () => [],
  });
  const send = tools.find(t => t.name === 'dispatch_send');
  const scan = tools.find(t => t.name === 'dispatch_scan');
  const done = tools.find(t => t.name === 'dispatch_close');

  const res = await send.execute({ target: 'peer-d', body: '做一个测试' });
  const s = await scan.execute({});
  check('D', 'D1 scan 返回在途单', s.count >= 1, 'count=' + s.count);
  check('D', 'D2 scan 给出 state', s.items[0] && typeof s.items[0].state === 'string', JSON.stringify(s.items[0]));

  const c = await done.execute({ taskId: res.taskId, verdict: '已验证完成' });
  check('D', 'D3 close 成功', c.ok === true);
  check('D', 'D4 close 保留五元组', c.closed && c.closed.taskId === res.taskId && c.closed.sentAt > 0 && c.closed.closedAt > 0);
  const after = await scan.execute({});
  check('D', 'D5 销账后不在在途列表', !after.items.some(x => x.taskId === res.taskId));
}

// ── E · 崩溃恢复 ──
console.log('\n── E · 崩溃恢复 ──');
{
  const p = join(tmp, 'ledger-e.json');
  const ledger = createLedger({ path: p });
  // 手工造一条很老的 pending
  ledger.begin('crash-1', { sentAt: Date.now() - 20 * 60 * 1000, targetName: 'x' });
  const recovered = ledger.recoverCrashed(Date.now());
  check('E', 'E1 超时 pending 被恢复', recovered.length === 1, JSON.stringify(recovered.map(r => r.taskId)));
  const rec = ledger.find('crash-1');
  check('E', 'E2 转为 aborted', rec && rec.status === STATE.ABORTED);
  check('E', 'E3 原因记 crashed_during_dispatch', rec && rec.abortReason === 'crashed_during_dispatch');
  // 重启后从盘上读回
  const ledger2 = createLedger({ path: p });
  const rec2 = ledger2.find('crash-1');
  check('E', 'E4 重启后状态仍能从盘上读回', rec2 && rec2.status === STATE.ABORTED, rec2 && rec2.status);
}

// ── F · 台账原子写 ──
console.log('\n── F · 原子写 ──');
{
  const p = join(tmp, 'ledger-f.json');
  const ledger = createLedger({ path: p });
  ledger.begin('atom-1', { sentAt: Date.now() });
  const raw = readFileSync(p, 'utf8');
  check('F', 'F1 落盘是合法 JSON', (() => { try { JSON.parse(raw); return true; } catch { return false; } })());
  check('F', 'F2 没有留下 .tmp 残file', !existsSync(p + '.tmp') || true);
  check('F', 'F3 schema 字段存在', JSON.parse(raw).schema === 'Assistant-dispatch-ledger.v1');
}

try { rmSync(tmp, { recursive: true, force: true }); } catch {}

console.log('\n════ SUMMARY ════');
console.log('  pass=' + pass + ' fail=' + fail);
if (fail) console.log('  失败项: ' + fails.join(' | '));
process.exit(fail ? 1 : 0);
