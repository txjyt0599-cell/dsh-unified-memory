/**
 * selftest-prefetch-hot.mjs —— 热度直通区排序 + 跨段排重 回归测试（2026-11-07）
 *
 * 病根（实测）：
 *   ① buildHotBuffer 先拼「近期轮次(3)」再拼「近期卡(5)」，两段各自有序 ⇒
 *      整体不是时间倒序（17:53,17:52,16:08,17:54,...）。
 *   ② buildCrossSessionPulse 与 hot 卡段同源（同函数/同窗口，limit 4 vs 5）
 *      ⇒ pulse 必然是 hot 的子集，不排重就同一事件说两遍。
 */
import { createPrefetcher } from './lib/prefetch.js';

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log('  PASS ' + name + (detail ? '  ' + detail : '')); }
  else { fail++; console.log('  FAIL ' + name + '  ' + (detail || '')); }
}

const now = Date.now();
const rounds = [
  { id: 'r1', t: now - 1 * 60000, sid: 'session-a-111111', user: 'q1', answer: 'a1' },
  { id: 'r2', t: now - 2 * 60000, sid: 'session-a-111111', user: 'q2', answer: 'a2' },
  { id: 'r3', t: now - 107 * 60000, sid: 'session-b-222222', user: 'q3', answer: 'a3' },
];
const cards = [
  { id: 'c1', t: now - 0 * 60000, sid: 'session-c-333333', title: 'card-newest', snippet: 's1' },
  { id: 'c2', t: now - 65 * 60000, sid: 'session-c-333333', title: 'card-mid', snippet: 's2' },
  { id: 'c3', t: now - 95 * 60000, sid: 'session-c-333333', title: 'card-old', snippet: 's3' },
];
const retriever = { recentRounds: () => rounds, recentCrossSession: () => cards };
const orchestrator = { recall: async () => ({ hits: [], level: 'fixed' }) };

console.log('════ PREFETCH-HOT · 热度直通排序/排重 ════');
const p = createPrefetcher({ orchestrator, retriever, enabled: true });
const entry = await p.prefetchFor({ sessionId: 'sess-test', messages: [{ role: 'user', content: '测试查询内容' }] });
const text = entry && entry.text ? entry.text : String(entry);
const hot = text.includes('<hot-memory>') ? text.split('<hot-memory>')[1].split('</hot-memory>')[0] : '';
const lines = hot.split('\n').filter((l) => l.startsWith('- '));
const times = lines.map((l) => (l.match(/\[(\d\d):(\d\d)\]/) || [])[0]).filter(Boolean);

check('H1 hot 块存在且有内容', lines.length >= 5, 'lines=' + lines.length);
const sorted = [...times].sort().reverse();
check('H2 hot 整体严格时间倒序（两段合并后重排）', JSON.stringify(times) === JSON.stringify(sorted), times.join(' '));
check('H3 最新卡排在最前（修复前会被轮次挤到第 4 位）', lines.length > 0 && lines[0].indexOf('card-newest') >= 0, lines[0] ? lines[0].slice(0, 40) : '');
check('H4 pulse 与 hot 同源时不再重复（全被排重后 pulse 为空）', !text.includes('<cross-session-pulse>'), 'pulse=' + text.includes('<cross-session-pulse>'));

console.log('');
console.log('PREFETCH-HOT-DONE checks=' + (pass + fail) + ' passed=' + pass + ' failed=' + fail);
if (fail > 0) process.exit(1);