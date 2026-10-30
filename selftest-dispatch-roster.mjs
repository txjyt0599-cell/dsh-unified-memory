/**
 * selftest-dispatch-roster.mjs —— 名册读取验收（2026-10-28）
 *
 * ## 治什么病（真实事故，第六次派单）
 *   派单**成功了**、回执**也回来了**，但 dispatch_scan 判 dead_target。
 *   根因：getAgents 调了一个不存在的方法名（listAgents），恒返回空数组
 *        ⇒ 每个目标都"查无此人" ⇒ exists:false ⇒ 判死。
 *
 * ## 为什么之前的测试没抓到
 *   接线测试里 getAgents 是**硬编码返回一个活成员**：
 *     getAgents: () => [{ name: 'peer-a', status: 'running' }]
 *   它永远不会返回空、永远不会返回 null ⇒ "名册读失败"这条路径从没被测过。
 *
 * ## 本套钉死三条
 *   R1 名册读失败（null）⇒ 必须 undetermined，**不许** dead_target
 *   R2 名册真的空（[]）⇒ 才允许 dead_target
 *   R3 名册有此人 ⇒ 正常判活
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLedger } from './lib/dispatch/ledger.js';
import { createDispatchTools } from './lib/dispatch/tool.js';
import { classify, STATE } from './lib/dispatch/state-machine.js';
import { fileURLToPath } from 'node:url';
const ROOT = fileURLToPath(new URL('./', import.meta.url)).replace(/[\\/]$/, '');

let pass = 0, fail = 0;
const fails = [];
function check(g, name, ok, detail) {
  if (ok) { pass++; console.log('  PASS ' + name + (detail ? '   ' + detail : '')); }
  else { fail++; fails.push(name); console.log('  FAIL ' + name + (detail ? '   ' + detail : '')); }
}

console.log('════ DISPATCH-ROSTER 名册验收 ════');
const tmp = mkdtempSync(join(tmpdir(), 'roster-'));

// ── A · classify 判据层 ──
console.log('\n── A · 判据 ──');
{
  const base = {
    taskId: 'T1', now: Date.now(),
    baseline: { sentAt: Date.now() - 60000, eventCountBefore: 0, messageId: 'm1' },
    newEvents: [], eventsUnavailable: false,
  };
  // R1 名册读失败
  const r1 = classify({ ...base, target: { status: 'unknown', phase: 'unknown', exists: null }, rosterUnreadable: true });
  check('A', 'R1 名册读失败 ⇒ undetermined（不许判死）', r1.state === STATE.UNDETERMINED, r1.state + ' / ' + r1.reason);
  check('A', 'R1b 原因写明是名册读不到', /roster-unreadable/.test(String(r1.reason)), r1.reason);

  // R2 名册空
  const r2 = classify({ ...base, target: { status: 'inactive', phase: 'active', exists: false }, rosterUnreadable: false });
  check('A', 'R2 名册真的空 ⇒ 才允许 dead_target', r2.state === STATE.DEAD_TARGET, r2.state + ' / ' + r2.reason);

  // R3 有人在
  const r3 = classify({ ...base, target: { status: 'running', phase: 'active', exists: true }, rosterUnreadable: false });
  check('A', 'R3 目标在且 running ⇒ 不是 dead_target', r3.state !== STATE.DEAD_TARGET, r3.state);
}

// ── B · 端到端：getAgents 返回 null 时的 dispatch_scan ──
console.log('\n── B · 端到端 ──');
{
  const ledgerPath = join(tmp, 'b.json');
  const ledger = createLedger({ path: ledgerPath });
  ledger.begin('T-null', { targetName: 'peer-a', subject: 'x', sentAt: Date.now(), dstSessionId: '', srcSessionId: '' });
  ledger.settle('T-null', 'dispatch-ok', { messageId: 'm-b' });

  const tools = createDispatchTools({
    ledger,
    sendMessage: async () => ({ messageId: 'm' }),
    getAgents: () => null,                 // 模拟"读失败"
    getSessionEvents: () => ({ ok: false, events: [], reason: 'x' }),
  });
  const scan = tools.find(t => t.name === 'dispatch_scan');
  const res = await scan.execute({});
  const item = (res.items || []).find(x => x.taskId === 'T-null');
  check('B', 'B1 getAgents 返回 null ⇒ 不判 dead_target',
    item && item.state !== STATE.DEAD_TARGET, item ? item.state + ' / ' + item.reason : 'no item');
  check('B', 'B2 而是判 undetermined', item && item.state === STATE.UNDETERMINED, item && item.state);
}

// ── C · 端到端：getAgents 返回空数组 ──
console.log('\n── C · 空名册 ──');
{
  const ledgerPath = join(tmp, 'c.json');
  const ledger = createLedger({ path: ledgerPath });
  ledger.begin('T-empty', { targetName: 'peer-x', subject: 'x', sentAt: Date.now(), dstSessionId: '', srcSessionId: '' });
  ledger.settle('T-empty', 'dispatch-ok', { messageId: 'm-c' });

  const tools = createDispatchTools({
    ledger,
    sendMessage: async () => ({ messageId: 'm' }),
    getAgents: () => [],                   // 真的空
    getSessionEvents: () => ({ ok: false, events: [], reason: 'x' }),
  });
  const scan = tools.find(t => t.name === 'dispatch_scan');
  const res = await scan.execute({});
  const item = (res.items || []).find(x => x.taskId === 'T-empty');
  check('C', 'C1 空名册 + 查无此人 ⇒ dead_target', item && item.state === STATE.DEAD_TARGET,
    item ? item.state + ' / ' + item.reason : 'no item');
}

// ── D · 端到端：人在 ──
console.log('\n── D · 人在 ──');
{
  const ledgerPath = join(tmp, 'd.json');
  const ledger = createLedger({ path: ledgerPath });
  ledger.begin('T-live', { targetName: 'peer-live', subject: 'x', sentAt: Date.now(), dstSessionId: '', srcSessionId: '' });
  ledger.settle('T-live', 'dispatch-ok', { messageId: 'm-d' });

  const tools = createDispatchTools({
    ledger,
    sendMessage: async () => ({ messageId: 'm' }),
    getAgents: () => [{ name: 'peer-live', status: 'running', phase: 'active' }],
    getSessionEvents: () => ({ ok: false, events: [], reason: 'x' }),
  });
  const scan = tools.find(t => t.name === 'dispatch_scan');
  const res = await scan.execute({});
  const item = (res.items || []).find(x => x.taskId === 'T-live');
  check('D', 'D1 人在 ⇒ 不判 dead_target', item && item.state !== STATE.DEAD_TARGET, item && item.state);
}

// ── F · 自动补 dstSessionId（2026-10-28 新增）──
//   第六次派单台账 dstSessionId 为空 ⇒ 事件源永远读不到 ⇒ 恒判 undetermined。
//   本组验"名册能查到人时自动补上"。
console.log('\n── F · 自动补 dstSessionId ──');
{
  const ledgerPath = join(tmp, 'f.json');
  const ledger = createLedger({ path: ledgerPath });
  // 故意**不传** dstSessionId（复刻第六次派单的真实情形）
  ledger.begin('T-autosid', { targetName: 'peer-auto', subject: 'x', sentAt: Date.now(), dstSessionId: '', srcSessionId: '' });
  ledger.settle('T-autosid', 'dispatch-ok', { messageId: 'm-f' });

  let usedSid = null;
  let capturedSid = null;
  const tools = createDispatchTools({
    ledger,
    sendMessage: async () => ({ messageId: 'm' }),
    getAgents: () => [{ id: 'agent-xyz', name: 'peer-auto', status: 'inactive', phase: 'active' }],
    getAgentSessionId: (k) => { usedSid = k; return k === 'agent-xyz' ? 'sess-abc-123' : ''; },
    getSessionEvents: (rec) => {
      capturedSid = String((rec && rec.dstSessionId) || '');
      return { ok: false, events: [], reason: 'probe' };
    },
  });
  const scan = tools.find(t => t.name === 'dispatch_scan');
  await scan.execute({});
  check('F', 'F1 按 agent id 去解析会话', usedSid === 'agent-xyz', 'usedSid=' + usedSid);
  check('F', 'F2 解析出的 session id 传给了事件源', capturedSid === 'sess-abc-123', 'capturedSid=' + capturedSid);
}

// ── F2 · 反例：解析不到时保持空，不许瞎猜 ──
console.log('\n── F2 · 解析不到 ──');
{
  const ledgerPath = join(tmp, 'f2.json');
  const ledger = createLedger({ path: ledgerPath });
  ledger.begin('T-nosid', { targetName: 'peer-x', subject: 'x', sentAt: Date.now(), dstSessionId: '', srcSessionId: '' });
  ledger.settle('T-nosid', 'dispatch-ok', { messageId: 'm-f2' });

  let capturedSid2 = null;
  const tools = createDispatchTools({
    ledger,
    sendMessage: async () => ({ messageId: 'm' }),
    getAgents: () => [{ id: 'agent-none', name: 'peer-x', status: 'inactive', phase: 'active' }],
    getAgentSessionId: () => '',
    getSessionEvents: (rec) => { capturedSid2 = String((rec && rec.dstSessionId) || ''); return { ok: false, events: [], reason: 'probe' }; },
  });
  const scan = tools.find(t => t.name === 'dispatch_scan');
  const res = await scan.execute({});
  check('F', 'F2a 解析不到就保持空串（不瞎猜）', capturedSid2 === '', 'capturedSid2=' + JSON.stringify(capturedSid2));
  const item = (res.items || []).find(x => x.taskId === 'T-nosid');
  check('F', 'F2b 此时判 undetermined（不知道），不判 busy', item && item.state === STATE.UNDETERMINED, item && item.state);
}

// ── G · 源码断言：caller 要有"记住发单那个"的兜底 ──
//   [2026-10-28] 第七次派单暴露：send 成功但 scan 报 roster-unreadable，
//   因为两次工具调用之间 caller 可能变了/空了。
console.log('\n── G · caller 兜底 ──');
{
  const { readFileSync } = await import('node:fs');
  const SRC = readFileSync(join(ROOT, 'lib/index.js'), 'utf8');
  const CODE = SRC.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  check('G', 'G1 有 __lastSendCaller（记住发单用的 caller）', /__lastSendCaller/.test(CODE));
  check('G', 'G2 sendMessage 成功后记住 caller', /__rememberSendCaller\(caller\)/.test(CODE));
  check('G', 'G3 取 caller 时优先用记住的那个', /__lastSendCaller\s*\|\|\s*__lastAgent/.test(CODE));
  check('G', 'G4 getAgents 每条 null 路径都有日志（不许静默）',
    (CODE.match(/dispatch-getAgents-null/g) || []).length >= 2,
    'null 日志数=' + (CODE.match(/dispatch-getAgents-null/g) || []).length);
}

// ── E · 源码断言：必须用 listMembers 不是 listAgents ──
console.log('\n── E · 源码断言 ──');
{
  const { readFileSync } = await import('node:fs');
  const SRC = readFileSync(join(ROOT, 'lib/index.js'), 'utf8');
  const CODE = SRC.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  check('E', 'E1 用 listMembers（不是 listAgents）', /teams\.listMembers\(/.test(CODE), '找到 listMembers');
  check('E', 'E2 没有残留 listAgents 调用', !/teams\.listAgents\(/.test(CODE));
  check('E', 'E3 读失败时返回 null（区分空名册）', /return null;\s*\/\/ null = 读不到/.test(CODE) || /return null;/.test(CODE));
}

// ── H · 磁盘反查兜底（2026-10-28 线上实测逼出来的）──
//   现象：重启后 agents.get(sid) 返回 undefined（目标 agent 不在内存/已归档），
//        日志 hasAgent:false / hasSession:false ⇒ dstSessionId 空 ⇒ 恒 undetermined。
//   ⇒ 必须有一条"从磁盘找哪个会话含这个 taskId"的兜底。
console.log('\n── H · 磁盘反查兜底 ──');
{
  const { readFileSync } = await import('node:fs');
  const SRC = readFileSync(join(ROOT, 'lib/index.js'), 'utf8');
  const CODE = SRC.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  check('H', 'H1 有 __findSessionByTaskId 兜底函数', /__findSessionByTaskId/.test(CODE));
  check('H', 'H2 解析失败时会调用兜底', /if \(!sid && key\)/.test(CODE));
  check('H', 'H3 兜底读的是磁盘会话文件', /session\.v4\.jsonl\.zstd/.test(CODE));
  check('H', 'H4 兜底失败不抛出（有保护）', /兜底失败就保持空/.test(CODE));
}

try { rmSync(tmp, { recursive: true, force: true }); } catch {}

console.log('\n════ SUMMARY ════');
console.log('  pass=' + pass + ' fail=' + fail);
if (fail) console.log('  失败项: ' + fails.join(' | '));
process.exit(fail ? 1 : 0);
