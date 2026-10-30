/**
 * 端到端：用真实会话做一条"假想派单"，验证状态机能沿真实事件流判出状态。
 * 只读——不改任何会话数据。
 */
import fs from 'node:fs';
import { zstdDecompressSync } from 'node:zlib';
import { sliceNewEvents } from '../lib/dispatch/event-source.js';
import { classify, scanEventsForTask, STATE, extractTaskIds } from '../lib/dispatch/state-machine.js';
import { dshHome } from '../lib/paths.js';
import { join } from 'node:path';

const P = join(dshHome(), 'sessions/--D-Assistant~0020Studio--/session-00000000-0000-0000-8157-fb7ded6e48a1/session.v4.jsonl.zstd');
const raw = zstdDecompressSync(fs.readFileSync(P)).toString('utf8');
const evs = [];
for (const L of raw.split('\n')) { if (!L.trim()) continue; try { evs.push(JSON.parse(L)); } catch {} }

const T = 'task-realtime-proof-001';
// 取最近 20 条作为"投递之后的新增"
const cut = Math.max(0, evs.length - 20);
const newEvents = sliceNewEvents(evs, { eventCountBefore: cut });

console.log('真实新增事件:', newEvents.length, '条');

// 情况 1：真实事件里没有我们的 taskId ⇒ 应判 busy_ignored（如果没 messageId 则 delivery_lost）
const r1 = classify({
  taskId: T,
  baseline: { sentAt: Date.now() - 30000, eventCountBefore: cut, messageId: 'team-message-not-exist-999' },
  target: { phase: 'active', status: 'running', exists: true },
  newEvents,
  eventsUnavailable: false,
  now: Date.now(),
});
console.log('\n[情况1] 真实事件无 taskId、messageId 也不在:');
console.log('  →', r1.state, '/', r1.reason);
console.log('  预期 delivery_lost'); console.log('  判定:', r1.state === STATE.DELIVERY_LOST ? '✅' : '❌');

// 情况 2：往真实事件里注入 taskId（模拟目标接单）⇒ 应判 in_progress
const injected = JSON.parse(JSON.stringify(newEvents));
injected.push({
  type: 'user/message',
  data: { message: { role: 'user', content: [{ type: 'text', text: '[[TASK:' + T + ']]\n收到，正在处理，稍后给结论' }], source: { kind: 'team-message', messageId: 'team-message-mock-1' } } },
});
const scan2 = scanEventsForTask(injected, T);
console.log('\n[情况2] 注入"接单处理中":');
console.log('  scan:', JSON.stringify(scan2));
const r2 = classify({
  taskId: T,
  baseline: { sentAt: Date.now() - 30000, eventCountBefore: cut, messageId: 'team-message-not-exist-999' },
  target: { phase: 'active', status: 'running', exists: true },
  newEvents: injected, eventsUnavailable: false, now: Date.now(),
});
console.log('  →', r2.state, '/', r2.reason);
console.log('  预期 in_progress'); console.log('  判定:', r2.state === STATE.IN_PROGRESS ? '✅' : '❌');

// 情况 3：注入结案标签 ⇒ orphaned
const injected3 = JSON.parse(JSON.stringify(injected));
injected3[injected3.length - 1].data.message.content = [{ type: 'text', text: '[[TASK:' + T + ']]\n[[DONE]] 已完成，产物 D:/x.md' }];
const r3 = classify({
  taskId: T,
  baseline: { sentAt: Date.now() - 30000, eventCountBefore: cut, messageId: 'team-message-not-exist-999' },
  target: { phase: 'active', status: 'inactive', exists: true },
  newEvents: injected3, eventsUnavailable: false, now: Date.now(),
});
console.log('\n[情况3] 注入"已完成":');
console.log('  →', r3.state, '/', r3.reason);
console.log('  预期 orphaned'); console.log('  判定:', r3.state === STATE.ORPHANED ? '✅' : '❌');
