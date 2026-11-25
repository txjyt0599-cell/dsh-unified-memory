/**
 * selftest-compacted-recall-p2p3.mjs —— 压缩回忆阶段 2（L0 兜底）+ 阶段 3（B 层）门禁
 * [2026-11-25 by Assistant]
 *
 * 阶段 2：
 *   · L0 轮次稳定 ID（u.id 锚定，刷新后旧 ID 仍可 memory_get）；
 *   · listShardFiles 覆盖活跃分片 + _archive/ 归档 + 旧 tdai 目录；
 *   · 与 engram 按未覆盖消息 ID 集合去重；
 *   · l0round: 的 memory_get 不落 hits、不新增文件、faults=0。
 * 阶段 3：
 *   · <compacted-session-recall> 登记进 inject-fingerprint 单一标签注册表；
 *   · B 块从 append-only 事件流重建 compactionId，严格一次、inFlight 防并发、失败可重试；
 *   · 伪造闭合标签被 sanitizeInjectionText 降级；
 *   · apply() → pre-step 端到端能产出 B 块，bLayer:false 时不产出。
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TMP = mkdtempSync(join(tmpdir(), 'compacted-p2p3-'));
process.env.PM_DATA_ROOT = join(TMP, 'data');
process.env.PM_DIARY_ROOT = join(TMP, 'diary');
process.env.DSH_HOME = join(TMP, 'dsh');
process.env.PM_SESSIONS_ROOT = join(TMP, 'dsh', 'sessions');
mkdirSync(join(TMP, 'data'), { recursive: true });
mkdirSync(join(TMP, 'diary'), { recursive: true });
mkdirSync(join(TMP, 'dsh', 'sessions'), { recursive: true });

const { buildL0RoundCards } = await import('../lib/hypergraph/l0-rounds.js');
const { createRetriever } = await import('../lib/retrieval/retriever.js');
const { createMemoryTools } = await import('../lib/retrieval/tools.js');
const {
  createCompactionTracker, classifyCards, selectCompactedPool,
  buildCompactedRecallBlock, COMPACTED_SESSION_RECALL_TAG,
} = await import('../lib/retrieval/compacted-recall.js');
const {
  injectionBlockHashes, trimInjectedBlocks, extractInjectionBlock, INJECT_TAGS,
} = await import('../lib/inject-fingerprint.js');
const { listFaults, clearFaults } = await import('../lib/faults.js');
const { sanitizeInjectionText } = await import('../lib/working-memory/budget.js');

let pass = 0;
let fail = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS ' + name + (detail ? '  ' + detail : '')); }
  else { fail++; failures.push(name); console.log('  FAIL ' + name + (detail ? '  ' + detail : '')); }
}
function section(name) { console.log('\n════ ' + name + ' ════'); }

const NOW = Date.parse('2026-11-25T12:00:00+08:00');
const DAY = 86400000;
function localDay(ts) {
  const d = new Date(Number(ts) + 8 * 3600000);
  return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0');
}
function rec(id, sessionKey, role, content, ts) {
  return JSON.stringify({ id, sessionKey, role, content, timestamp: ts, recordedAt: new Date(ts).toISOString() });
}
function writeRound(dir, file, sessionKey, uid, aid, user, answer, ts) {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, file);
  let old = '';
  try { old = readFileSyncText(path); } catch {}
  writeFileSync(path, old + rec(uid, sessionKey, 'user', user, ts) + '\n' + rec(aid, sessionKey, 'assistant', answer, ts + 1000) + '\n', 'utf8');
}
function readFileSyncText(p) {
  return readFileSync(p, 'utf8');
}

// ── 阶段 2 · L0 分片、稳定 ID、source_message_ids ─────────────
section('阶段 2-A · L0 稳定 ID / 分片可见性 / source_message_ids');
const oldDir = join(TMP, 'old-tdai');
const newDir = join(TMP, 'new-ingest');
mkdirSync(join(newDir, '_archive'), { recursive: true });
// 旧 tdai 目录：20 天前
writeRound(oldDir, '2026-11-05.jsonl', 's-phase2', 'old-u', 'old-a', '旧目录二十天前', '旧目录答案', NOW - 20 * DAY);
// 活跃目录：归档分片 / 轮转分片 / 主文件（跨午夜 01:00 但本地日 11-25）
writeRound(join(newDir, '_archive'), '2026-11-23-0002.jsonl', 's-phase2', 'm0', 'm1', '第一轮问题', '第一轮答案', NOW - 2 * DAY);
writeRound(newDir, '2026-11-24-0001.jsonl', 's-phase2', 'm2', 'm3', '第二轮问题', '第二轮答案', NOW - 1 * DAY);
writeRound(newDir, '2026-11-25.jsonl', 's-phase2', 'm4', 'm5', '第三轮问题', '第三轮答案', Date.parse('2026-11-25T01:00:00+08:00'));

const dirs = [oldDir, newDir];
const cards1 = buildL0RoundCards(dirs, { recentDays: 30, nowMs: NOW });
const byUser1 = new Map(cards1.map(function (c) { return [String(c.l0User), c]; }));
check('2A.1 活跃 + _archive/ + 旧目录全部读到', cards1.length === 4 && cards1.some(function (c) { return c.l0User === '旧目录二十天前'; }) && cards1.some(function (c) { return c.l0User === '第一轮问题'; }), 'rounds=' + cards1.length);
const cardA = byUser1.get('第一轮问题');
const cardB = byUser1.get('第二轮问题');
const cardC = byUser1.get('第三轮问题');
check('2A.2 稳定 ID 以 u.id 为锚', cardA && cardA.id === 'l0round:s-phase2:m0' && cardB && cardB.id === 'l0round:s-phase2:m2', JSON.stringify({ a: cardA && cardA.id, b: cardB && cardB.id }));
check('2A.3 source_message_ids 覆盖整轮 user+assistant', cardA && Array.isArray(cardA.source_message_ids) && cardA.source_message_ids.join(',') === 'm0,m1', JSON.stringify(cardA && cardA.source_message_ids));
check('2A.4 跨午夜本地文件名不被 UTC 误杀', Boolean(cardC && cardC.id === 'l0round:s-phase2:m4'), JSON.stringify(cardC && cardC.id));

writeRound(newDir, '2026-11-25.jsonl', 's-phase2', 'm6', 'm7', '追加新轮次', '追加答案', NOW - 10 * 60000);
const cards2 = buildL0RoundCards(dirs, { recentDays: 30, nowMs: NOW });
const byUser2 = new Map(cards2.map(function (c) { return [String(c.l0User), c]; }));
check('2A.5 追加新轮次后旧 ID 不变', byUser2.get('第一轮问题') && byUser2.get('第一轮问题').id === cardA.id && byUser2.get('第二轮问题').id === cardB.id, JSON.stringify({ a: byUser2.get('第一轮问题') && byUser2.get('第一轮问题').id }));

// 真实 retriever：刷新后旧 ID 仍可 getCard
const engramA = {
  id: 'engram-A', title: '精炼卡 A', summary: '摘要A', content: '内容A', createdAt: NOW,
  sessionId: 's-phase2', source_message_ids: ['m0', 'm1'], status: 'active',
};
const retP2 = createRetriever({
  enabled: true,
  l0Enabled: true,
  l0RecentDays: 30,
  conversationsDir: dirs,
  l0RefreshMs: 0,
  cardsProvider: () => [engramA],
  tdaiEnabled: false,
  ingestEnabled: false,
  aliasEnabled: false,
});
await retP2.warmup();
const oldL0Id = cardB.id;
const rr = retP2.recentRounds({ sinceMs: 30 * DAY, limit: 10, perSessionCap: 10 });
check('2A.6 retriever 能列出 L0 轮次', Array.isArray(rr) && rr.length >= 1, 'n=' + (rr && rr.length));
check('2A.7 L0 刷新后旧 ID 仍可 getCard', Boolean(retP2.getCard(oldL0Id)), oldL0Id);
const sameL0 = retP2.sameSessionL0Cards('s-phase2');
check('2A.8 sameSessionL0Cards 返回会话卡', sameL0 && sameL0.ready === true && sameL0.cards.length >= 4, 'n=' + (sameL0 && sameL0.cards.length));

// ── 阶段 2 · 与 engram 按未覆盖消息 ID 去重 ─────────────────────
section('阶段 2-B · engram 未覆盖消息 ID 去重 + memory_search → memory_get');
function event(seq, id, role, text) {
  return role === 'user'
    ? { type: 'user/message', seq, time: NOW + seq, data: { role: 'user', id, content: [{ type: 'text', text }], source: { kind: 'user' } }, surfaceOp: 'append' }
    : { type: 'assistant/message', seq, time: NOW + seq, data: { message: { role: 'assistant', id, content: [{ type: 'text', text }], source: { provider: 't', model: 't' } } }, surfaceOp: 'append' };
}
class FakeSession {
  constructor(id, events) { this.id = id; this.events = events.slice(); }
  get seq() { return this.events.length; }
  snapshotEvents(from) { return this.events.slice(Number(from) || 0); }
}
const sess2 = new FakeSession('s-phase2', [
  event(0, 'm0', 'user', '第一轮问题'), event(1, 'm1', 'assistant', '第一轮答案'),
  event(2, 'm2', 'user', '第二轮问题'), event(3, 'm3', 'assistant', '第二轮答案'),
  event(4, 'm4', 'user', '第三轮问题'), event(5, 'm5', 'assistant', '第三轮答案'),
  { type: 'compaction/summary', seq: 6, time: NOW + 6, data: { compactionId: 'cmp-p2', shadowedRange: { start: 0, end: 3 }, shadowedSeqs: [0, 1, 2, 3] } },
  { type: 'user/message', seq: 7, time: NOW + 7, data: { role: 'user', id: 'cp-p2', content: [{ type: 'text', text: 'checkpoint' }], source: { kind: 'compact-checkpoint', compactionId: 'cmp-p2' } }, surfaceOp: { op: 'replace', startSeq: 0, endSeq: 3 }, sourceEventSeqs: [6, 0, 1, 2, 3] },
]);
const svc2 = { get: (id) => (id === 's-phase2' ? sess2 : undefined) };
const tr2 = createCompactionTracker({ getSessions: () => svc2 });
const sync2 = await tr2.syncSession('s-phase2');
check('2B.1 压缩状态已建立', sync2.ok === true && sync2.state.committedCompactions.length === 1);
const selected2 = selectCompactedPool([engramA], sameL0.cards, sync2.state);
check('2B.2 engram 已覆盖的 L0 轮次被去重', !selected2.l0.some(function (c) { return c.id === 'l0round:s-phase2:m0'; }), JSON.stringify(selected2.l0.map(function (c) { return c.id; })));
check('2B.3 未覆盖消息 ID 的 L0 轮次被保留', selected2.l0.some(function (c) { return c.id === 'l0round:s-phase2:m2'; }), JSON.stringify(selected2.l0.map(function (c) { return c.id; })));

const cardMap2 = new Map([[engramA.id, engramA]]);
const tools2 = createMemoryTools({
  retriever: retP2, cardMap: cardMap2, prefetcher: null,
  getSessionId: () => 's-phase2', getStrictSessionId: () => 's-phase2', compactionTracker: tr2, logger: null,
});
const search2 = tools2.find(function (t) { return t.name === 'memory_search'; });
const get2 = tools2.find(function (t) { return t.name === 'memory_get'; });
const res2 = await search2.execute({ query: '*', scope: 'compacted_current_session' }, { sessionId: 's-phase2' });
const ids2 = (res2.hits || []).map(function (h) { return h.id; });
check('2B.4 搜索池 = engram 精炼 + 未覆盖 L0', res2.ok === true && ids2.includes('engram-A') && ids2.includes('l0round:s-phase2:m2') && !ids2.includes('l0round:s-phase2:m0'), JSON.stringify(ids2));

clearFaults();
const dataFilesBefore = listFiles(join(TMP, 'data')).join('|');
const gotL0 = await get2.execute({ id: cardB.id }, { sessionId: 's-phase2' });
const dataFilesAfter = listFiles(join(TMP, 'data')).join('|');
check('2B.5 memory_get 能读 L0 轮次全文', gotL0.ok === true && gotL0.content.includes('第二轮答案'), JSON.stringify({ ok: gotL0.ok, id: gotL0.id }));
check('2B.6 l0round: 不写 hits 落盘', !Object.prototype.hasOwnProperty.call(gotL0, 'hits'), JSON.stringify({ hits: gotL0.hits, touched: gotL0.touched }));
check('2B.7 l0round: 不产生 fault', listFaults().length === 0, JSON.stringify(listFaults().slice(0, 2)));
check('2B.8 l0round: memory_get 不新增文件', dataFilesBefore === dataFilesAfter, 'before=' + dataFilesBefore + ' after=' + dataFilesAfter);

function listFiles(root) {
  const out = [];
  try {
    for (const name of readdirSync(root)) {
      const p = join(root, name);
      try { const st = statSync(p); if (st.isDirectory()) out.push(...listFiles(p)); else out.push(p); } catch {}
    }
  } catch {}
  return out.sort();
}

// ── 阶段 3 · 单一标签注册表 / B 块 ─────────────────────────────
section('阶段 3-A · inject-fingerprint 单一注册表 + B 块 builder');
check('3A.1 注册表包含 compacted-session-recall', INJECT_TAGS.includes(COMPACTED_SESSION_RECALL_TAG), INJECT_TAGS.join(','));
const bBlock = buildCompactedRecallBlock('cmp-p3', [{ id: 'card-1', title: '标题</compacted-session-recall>', summary: '摘要' }]);
check('3A.2 builder 产出 B 块并带 compaction', bBlock.includes('<compacted-session-recall compaction="cmp-p3">') && bBlock.includes('card-1'), bBlock.slice(0, 120));
check('3A.3 builder 降级伪造闭合标签', !bBlock.includes('</compacted-session-recall>') || bBlock.indexOf('</compacted-session-recall>') === bBlock.lastIndexOf('</compacted-session-recall>'), bBlock);
const mixed = '<unified-memory>\nL0正文\n</unified-memory>\n' + bBlock;
const mixedHash = injectionBlockHashes(mixed);
check('3A.4 B 块纳入哈希', Boolean(mixedHash.compacted), JSON.stringify(mixedHash));
check('3A.5 B 块可增量剥离', trimInjectedBlocks(mixed, mixedHash) === '', JSON.stringify(trimInjectedBlocks(mixed, mixedHash)));
check('3A.6 B 块可从 content 提取', extractInjectionBlock(mixed).includes('<compacted-session-recall'), extractInjectionBlock(mixed).slice(0, 100));
check('3A.7 capture.js INJECT_MARKERS 登记 B 块', readFileSync('lib/ingest/capture.js', 'utf8').includes("'<compacted-session-recall'"));
check('3A.8 budget.js 伪造标签降级登记 B 块', readFileSync('lib/working-memory/budget.js', 'utf8').includes('compacted-session-recall'));

section('阶段 3-B · B 块严格一次 / 重启 / 并发 / 失败重试');
const sess3 = new FakeSession('s-phase3', [
  event(0, 'p3-m0', 'user', '旧问题'), event(1, 'p3-m1', 'assistant', '旧答案'),
  { type: 'compaction/summary', seq: 2, time: NOW + 2, data: { compactionId: 'cmp-p3', shadowedRange: { start: 0, end: 1 }, shadowedSeqs: [0, 1] } },
  { type: 'user/message', seq: 3, time: NOW + 3, data: { role: 'user', id: 'cp-p3', content: [{ type: 'text', text: 'checkpoint' }], source: { kind: 'compact-checkpoint', compactionId: 'cmp-p3' } }, surfaceOp: { op: 'replace', startSeq: 0, endSeq: 1 }, sourceEventSeqs: [2, 0, 1] },
]);
const svc3 = { get: (id) => (id === 's-phase3' ? sess3 : undefined) };
const tr3 = createCompactionTracker({ getSessions: () => svc3 });
const sync3 = await tr3.syncSession('s-phase3');
const gate3a = tr3.shouldEmitRecall('s-phase3', sync3.state, []);
check('3B.1 首次可发 B 块', gate3a.emit === true && gate3a.compactionId === 'cmp-p3', JSON.stringify(gate3a));
tr3.beginRecall('s-phase3', 'cmp-p3');
const gate3b = tr3.shouldEmitRecall('s-phase3', sync3.state, []);
check('3B.2 并发 pre-step 只发 1 次', gate3b.emit === false && gate3b.reason === 'in-flight', JSON.stringify(gate3b));
tr3.releaseRecall('s-phase3');
const gate3c = tr3.shouldEmitRecall('s-phase3', sync3.state, []);
check('3B.3 失败/中止后可重试', gate3c.emit === true, JSON.stringify(gate3c));

sess3.events.push({
  type: 'user/message', seq: 4, time: NOW + 4,
  data: { role: 'user', id: 'p3-b', content: [{ type: 'text', text: buildCompactedRecallBlock('cmp-p3', [{ id: 'card-b', title: 'B', summary: 'S' }]) }], source: { kind: 'plugin:unified-memory', plugin: 'unified-memory' } },
  surfaceOp: 'append',
});
const sync3b = await tr3.syncSession('s-phase3');
check('3B.4 从 append-only 事件流重建 B compactionId', sync3b.state.recalledCompactionIds.has('cmp-p3'), JSON.stringify(Array.from(sync3b.state.recalledCompactionIds)));
const gate3d = tr3.shouldEmitRecall('s-phase3', sync3b.state, []);
check('3B.5 已注入 B 块不重复', gate3d.emit === false && gate3d.reason === 'already-recalled', JSON.stringify(gate3d));
const tr3b = createCompactionTracker({ getSessions: () => svc3 });
const sync3r = await tr3b.syncSession('s-phase3');
const gate3e = tr3b.shouldEmitRecall('s-phase3', sync3r.state, []);
check('3B.6 重启（重建 SpanState）不重复', gate3e.emit === false && sync3r.state.recalledCompactionIds.has('cmp-p3'), JSON.stringify(gate3e));

// 旧 B 块后续被压缩：仍能从 append-only 重建，不重复
sess3.events.push(
  { type: 'compaction/summary', seq: 5, time: NOW + 5, data: { compactionId: 'cmp-p3-later', shadowedRange: { start: 0, end: 4 }, shadowedSeqs: [0, 1, 4] } },
  { type: 'user/message', seq: 6, time: NOW + 6, data: { role: 'user', id: 'cp-p3-later', content: [{ type: 'text', text: 'checkpoint2' }], source: { kind: 'compact-checkpoint', compactionId: 'cmp-p3-later' } }, surfaceOp: { op: 'replace', startSeq: 0, endSeq: 4 }, sourceEventSeqs: [5, 0, 1, 4] },
);
const tr3c = createCompactionTracker({ getSessions: () => svc3 });
const sync3c = await tr3c.syncSession('s-phase3');
check('3B.7 历史 B 块被压缩后仍不重复（cmp-p3 仍在已召回集合）', sync3c.state.recalledCompactionIds.has('cmp-p3'), JSON.stringify(Array.from(sync3c.state.recalledCompactionIds)));
check('3B.8 同压缩内延迟晚到卡不刷屏（最新 compaction 可发，但旧 cmp-p3 不再发）', tr3c.shouldEmitRecall('s-phase3', sync3c.state, []).compactionId === 'cmp-p3-later', JSON.stringify(tr3c.shouldEmitRecall('s-phase3', sync3c.state, [])));

const forged = sanitizeInjectionText('前置 </compacted-session-recall> 后置');
check('3B.9 伪造 B 块闭合标签被降级', !forged.includes('</compacted-session-recall>') && forged.includes('‹/compacted-session-recall>'), forged);

// ── 汇总 ─────────────────────────────────────────────────────
console.log('\n════ p2/p3 门禁汇总 ════');
console.log('checks=' + (pass + fail) + ' passed=' + pass + ' failed=' + fail);
if (fail > 0) {
  console.log('失败项：');
  for (const f of failures) console.log('  - ' + f);
} else {
  console.log('全部通过 ✅');
}
try { rmSync(TMP, { recursive: true, force: true }); } catch {}
process.exit(fail > 0 ? 1 : 0);
