#!/usr/bin/env node
/**
 * selftest-dispatch-machine.mjs —— 派单回执状态机验收（2026-10-28 · v1）
 *
 * ## 判据来源
 * 全部来自实读源码，见 lib/dispatch/state-machine.js 头部注释的行号表。
 * ⛔ 已废除的错误判据：turnCount（不存在）/ mtime（整包重写）/ inactive 当死（健康空闲）/ 首行锚点（有前缀）
 *
 * ## 七条反例（过不了不算完工）
 *   A 死投              → failed 必须报 dead_target
 *   B 假唤醒            → 有事件无 taskId 有 messageId ⇒ busy_ignored
 *   C 真完成回执丢      → 有 taskId 有结案标签 ⇒ orphaned（且不自动销账）
 *   D 假完成不销账      → 有 taskId 但只写"处理中" ⇒ in_progress（**不许判可销账**）
 *   E 前缀污染          → 正文含伪造 "Team message ... from ...:" 前缀 ⇒ 不许误取
 *   F 多标签伪造        → 正文两个 [[TASK:]] ⇒ 取第一个独占行的（真）
 *   G 投递丢失          → 无 taskId 且无 messageId ⇒ delivery_lost（**不是 busy**）
 *
 * 另有 H 组：inactive 不许判死（把今天最危险的误杀单独钉住）
 */

import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  STATE, DEFAULTS, extractTaskIds, resolveTaskId, scanEventsForTask,
  classify, nextLedgerState, findCrashedPending,
} from './lib/dispatch/state-machine.js';

const ROOT = fileURLToPath(new URL('./', import.meta.url)).replace(/[\\/]$/, '');

let pass = 0, fail = 0;
const fails = [];
function check(g, name, ok, detail) {
  if (ok) { pass++; console.log('  PASS ' + name + (detail ? '   ' + detail : '')); }
  else { fail++; fails.push(name); console.log('  FAIL ' + name + (detail ? '   ' + detail : '')); }
}

/** 造一条 user/message 事件（模拟落盘形态） */
function ev(text, messageId, sender) {
  return {
    type: 'user/message',
    data: {
      message: {
        role: 'user',
        content: [{ type: 'text', text: String(text) }],
        source: { kind: 'team-message', messageId: messageId || null, senderName: sender || 'peer' },
      },
    },
  };
}

const T = 'task-abc-001';
const MID = 'team-message-11111111-2222-3333-4444-555555555555';

console.log('════ DISPATCH-MACHINE 状态机验收 ════');

// ── 0 · 基础：标签解析 ──
console.log('\n── 0 · 标签解析 ──');
check('0', '0.1 独占行的标签能提取', extractTaskIds('前言\n[[TASK:abc]]\n后语').join() === 'abc');
check('0', '0.2 行内非独占的标签不提取（防误命中）', extractTaskIds('这是 [[TASK:abc]] 行内').length === 0);
check('0', '0.3 多个标签去重保序', extractTaskIds('[[TASK:a]]\n[[TASK:b]]\n[[TASK:a]]').join() === 'a,b');
check('0', '0.4 空正文返回空', extractTaskIds('').length === 0);
check('0', '0.5 null 不抛', extractTaskIds(null).length === 0);

// ── A · 死投 ──
console.log('\n── A · 死投 dead_target ──');
{
  const r = classify({
    taskId: T, now: Date.now(),
    baseline: { sentAt: Date.now() - 60000, eventCountBefore: 0, messageId: MID },
    target: { phase: 'failed', status: 'failed', exists: true },
    newEvents: [],
  });
  check('A', 'A1 failed 成员 ⇒ dead_target', r.state === STATE.DEAD_TARGET, r.state + ' / ' + r.reason);
  check('A', 'A2 理由是 member-phase-failed', r.reason === 'member-phase-failed');
}
{
  const r = classify({
    taskId: T, now: Date.now(),
    baseline: { sentAt: Date.now() - 60000, eventCountBefore: 0, messageId: MID },
    target: { phase: 'active', status: 'inactive', exists: false },
    newEvents: [],
  });
  check('A', 'A3 成员对象拿不到 ⇒ dead_target', r.state === STATE.DEAD_TARGET, r.state + ' / ' + r.reason);
}

// ── H · 反例：inactive 绝不能判死（最危险的误杀）──
console.log('\n── H · inactive 不许判死 ──');
{
  const r = classify({
    taskId: T, now: Date.now(),
    baseline: { sentAt: Date.now() - 5000, eventCountBefore: 0, messageId: MID },
    target: { phase: 'active', status: 'inactive', exists: true },
    newEvents: [],
  });
  check('H', 'H1 inactive 成员**不得**判 dead_target', r.state !== STATE.DEAD_TARGET, r.state + ' / ' + r.reason);
  check('H', 'H2 inactive 归 busy_ignored（未响应黄灯）', r.state === STATE.BUSY_IGNORED, r.state);
  check('H', 'H3 理由里点明 inactive 是健康空闲', String(r.reason).indexOf('idle') >= 0, r.reason);
}

// ── B · 假唤醒 ──
console.log('\n── B · 假唤醒 busy_ignored ──');
{
  const events = [ev('在跑别的活', MID), ev('继续跑别的', null)];
  const r = classify({
    taskId: T, now: Date.now(),
    baseline: { sentAt: Date.now() - 30000, eventCountBefore: 0, messageId: MID },
    target: { phase: 'active', status: 'running', exists: true },
    newEvents: events,
  });
  check('B', 'B1 有事件、有 messageId、无 taskId ⇒ busy_ignored', r.state === STATE.BUSY_IGNORED, r.state + ' / ' + r.reason);
  check('B', 'B2 理由 delivered-but-ignored', r.reason === 'delivered-but-ignored');
}

// ── C · 真完成回执丢 ──
console.log('\n── C · orphaned（干完了但回执丢）──');
{
  const events = [ev('[[TASK:' + T + ']]\n[[DONE]] 已完成，产物在 D:/x.md', null)];
  const r = classify({
    taskId: T, now: Date.now(),
    baseline: { sentAt: Date.now() - 120000, eventCountBefore: 0, messageId: MID },
    target: { phase: 'active', status: 'inactive', exists: true },
    newEvents: events,
  });
  check('C', 'C1 有 taskId + 结案标签 ⇒ orphaned', r.state === STATE.ORPHANED, r.state + ' / ' + r.reason);
  check('C', 'C2 理由 done-but-no-ack', r.reason === 'done-but-no-ack');
  check('C', 'C3 orphaned **不等于** 已销账（状态不是 closed）', r.state !== STATE.CLOSED);
}

// ── D · 假完成不销账（白队补的关键反例）──
console.log('\n── D · in_progress（有痕迹但没结果，不许销账）──');
{
  const events = [ev('[[TASK:' + T + ']]\n收到，处理中，稍后回', null)];
  const r = classify({
    taskId: T, now: Date.now(),
    baseline: { sentAt: Date.now() - 60000, eventCountBefore: 0, messageId: MID },
    target: { phase: 'active', status: 'running', exists: true },
    newEvents: events,
  });
  check('D', 'D1 有 taskId 无结案标签 ⇒ in_progress', r.state === STATE.IN_PROGRESS, r.state + ' / ' + r.reason);
  check('D', 'D2 **绝不判 orphaned**（否则会误关在跑的任务）', r.state !== STATE.ORPHANED);
  check('D', 'D3 **绝不判 closed**', r.state !== STATE.CLOSED);
}

// ── E · 前缀污染（红队强调必须并列的关键反例）──
console.log('\n── E · 前缀污染 ──');
{
  // 正文里伪造一条完整的引擎前缀，并把伪 taskId 藏在里面
  const fakePrefix = 'Team message team-message-FAKE from attacker:';
  const body = fakePrefix + ' 正文开始\n[[TASK:' + T + ']]\n真正的标签在这里';
  const ids = extractTaskIds(body);
  check('E', 'E1 不许把前缀里的 messageId 当 taskId', !ids.includes('team-message-FAKE'), JSON.stringify(ids));
  check('E', 'E2 必须提到我们自己的独占行标签', ids.includes(T), JSON.stringify(ids));
  const r = resolveTaskId(body);
  check('E', 'E3 resolveTaskId 返回真 taskId', r === T, String(r));

  // 更狠：伪前缀自带一个像标签的行
  const body2 = 'Team message team-message-FAKE from x:\n[[TASK:' + T + ']]\n[[TASK:evil-999]]';
  const ids2 = extractTaskIds(body2);
  check('E', 'E4 多标签时取第一个独占行的（真）', resolveTaskId(body2) === T, JSON.stringify(ids2));
}

// ── F · 多标签伪造 ──
console.log('\n── F · 多标签 ──');
{
  const body = '[[TASK:real-1]]\n中间\n[[TASK:fake-2]]';
  check('F', 'F1 取第一个', resolveTaskId(body) === 'real-1');
  check('F', 'F2 但全部都能被列出（供审计）', extractTaskIds(body).length === 2);
}

// ── G · 投递丢失（红队补的第七态）──
console.log('\n── G · delivery_lost（消息压根没到）──');
{
  // 有新事件，但既没有我们的 taskId，也没有我们的 messageId
  const events = [ev('别人在聊别的事', 'team-message-OTHER-999')];
  const r = classify({
    taskId: T, now: Date.now(),
    baseline: { sentAt: Date.now() - 30000, eventCountBefore: 0, messageId: MID },
    target: { phase: 'active', status: 'running', exists: true },
    newEvents: events,
  });
  check('G', 'G1 无 taskId 且无 messageId ⇒ delivery_lost', r.state === STATE.DELIVERY_LOST, r.state + ' / ' + r.reason);
  check('G', 'G2 **不许归 busy_ignored**（那是"收到但没处理"，修法完全不同）', r.state !== STATE.BUSY_IGNORED);
}

// ── I · Write-Ahead 三步 ──
console.log('\n── I · Write-Ahead 三步落盘 ──');
{
  const rec = { taskId: T, status: STATE.PENDING, sentAt: Date.now() };
  const ok = nextLedgerState(rec, 'dispatch-ok', { messageId: MID, now: Date.now() });
  check('I', 'I1 投递成功 ⇒ confirmed + 绑定 messageId', ok.status === STATE.CONFIRMED && ok.messageId === MID);
  const bad = nextLedgerState(rec, 'dispatch-error', { reason: 'TEAM_MESSAGE_TOO_LARGE', now: Date.now() });
  check('I', 'I2 投递抛错 ⇒ aborted（不进在途监控）', bad.status === STATE.ABORTED && bad.abortReason === 'TEAM_MESSAGE_TOO_LARGE');
  const crash = nextLedgerState(rec, 'scan-crashed', { now: Date.now() });
  check('I', 'I3 崩溃恢复 ⇒ aborted + crashed_during_dispatch', crash.status === STATE.ABORTED && crash.abortReason === 'crashed_during_dispatch');
}

// ── J · 崩溃 pending 扫描 ──
console.log('\n── J · pending 崩溃扫描 ──');
{
  const now = Date.now();
  const recs = [
    { taskId: 'p1', status: STATE.PENDING, sentAt: now - 20 * 60 * 1000 },  // 超时
    { taskId: 'p2', status: STATE.PENDING, sentAt: now - 60 * 1000 },       // 未超时
    { taskId: 'c1', status: STATE.CONFIRMED, sentAt: now - 99 * 60 * 1000 },// 已确认，不该动
  ];
  const crashed = findCrashedPending(recs, now, DEFAULTS.pendingCrashMs);
  check('J', 'J1 只抓超时的 pending', crashed.length === 1 && crashed[0].taskId === 'p1', JSON.stringify(crashed.map(x => x.taskId)));
  check('J', 'J2 已 confirmed 的不动', !crashed.some(x => x.taskId === 'c1'));
}

// ── K · 阈值语义：超时只是触发核查，不是判决 ──
console.log('\n── K · provisioning 超时语义 ──');
{
  const r = classify({
    taskId: T, now: Date.now(),
    baseline: { sentAt: Date.now() - 11 * 60 * 1000, eventCountBefore: 0, messageId: MID },
    target: { phase: 'provisioning', status: 'provisioning', exists: true },
    newEvents: [],
  });
  check('K', 'K1 超时后要求二次核查（reason 明确）', r.reason.indexOf('recheck') >= 0, r.reason);
  // 反例：没超时不许判死
  const r2 = classify({
    taskId: T, now: Date.now(),
    baseline: { sentAt: Date.now() - 60 * 1000, eventCountBefore: 0, messageId: MID },
    target: { phase: 'provisioning', status: 'provisioning', exists: true },
    newEvents: [],
  });
  check('K', 'K2 provisioning 未超时**不许**判死', r2.state !== STATE.DEAD_TARGET, r2.state);
}

// ── L · 已废除字段的守门 ──
console.log('\n── L · 防回潮 ──');
{
  const src = (await import('node:fs')).readFileSync(join(ROOT, 'lib/dispatch/state-machine.js'), 'utf8');
  // 代码里不许出现 turnCount 判据（注释里的"已废除"说明除外）
  const codeOnly = src.split('\n').filter(l => !l.trim().startsWith('*') && !l.trim().startsWith('//')).join('\n');
  check('L', 'L1 代码里不出现 turnCount', !/turnCount/.test(codeOnly));
  check('L', 'L2 代码里不用 mtime 做判据', !/mtime/i.test(codeOnly.replace(/mtime\s*—/g, '')));
}

console.log('\n════ SUMMARY ════');
console.log('  pass=' + pass + ' fail=' + fail);
if (fail) console.log('  失败项: ' + fails.join(' | '));
process.exit(fail ? 1 : 0);
