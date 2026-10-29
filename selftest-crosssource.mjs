#!/usr/bin/env node
/**
 * selftest-crosssource.mjs — 跨源检索（tdai + engram 合并）
 * [2026-10-22 by Assistant]
 *
 * 背景：记忆有两个源——tdai（2026-08-15 起，从 OpenClaw 移植）与 engram（2026-09-09 起，自研）。
 * 期3 只读了 engram，导致 8 月的记忆（比如「最早的桌宠」）永远检索不到。
 * 本测试锁住跨源后的关键合同，防止回退。
 */
import { createRetriever } from './lib/retrieval/retriever.js';
import { readTdaiRecords, DEFAULT_TDAI_DIR } from './lib/hypergraph/source.js';
import { classifyTemporal, classifyQuery } from './lib/retrieval/rrf.js';
import { existsSync } from 'node:fs';
import { dataPath } from './lib/paths.js';

const R = [];
function check(group, name, ok, detail) {
  R.push({ group, name, ok: !!ok, detail: detail || '' });
}
const f2 = (n) => (Math.round(n * 100) / 100).toFixed(2);

// ── A · tdai 读取 ──
console.log('── A · tdai 记录读取 ──');
const td = readTdaiRecords();
check('A', 'A1 tdai 目录可读', td && td.files > 0, 'files=' + (td && td.files));
check('A', 'A2 解析出记录', td && td.cards.length > 1000, 'cards=' + (td && td.cards.length));
check('A', 'A3 id 带 tdai: 前缀', td.cards.every((c) => c.id.startsWith('tdai:')), '样例=' + (td.cards[0] && td.cards[0].id));
check('A', 'A4 每条有 createdAt', td.cards.every((c) => Number.isFinite(c.createdAt)));
check('A', 'A5 覆盖 2026-08', (() => {
  const aug = td.cards.filter((c) => new Date(c.createdAt).toISOString().slice(0, 7) === '2026-08');
  return aug.length > 0;
})(), '8月条数=' + td.cards.filter((c) => new Date(c.createdAt).toISOString().slice(0, 7) === '2026-08').length);


// ── D · 标签语义统一（2026-10-22 立）──
//   问题：同一个标签位置混进三套不可比的值 ——
//     engram 放 layer（global/project/session）、
//     tdai 没有 layer 被兜底成假的 'global'、
//     旧代码还放过分层档位（L3）。
//   合同：所有卡的 label 必须落在**同一个域** global|project|session 内。
console.log('── D · 标签语义统一 ──');
{
  const { KIND_TO_LAYER } = await import('./lib/hypergraph/source.js');
  const ALLOWED = new Set(['global', 'project', 'session']);

  check('D', 'D1 tdai 卡全部带 layer', td.cards.every((c) => c.layer !== undefined), '无 layer 的=' + td.cards.filter((c) => c.layer === undefined).length);
  check('D', 'D2 tdai layer 全在允许域内', td.cards.every((c) => ALLOWED.has(c.layer)), '越界=' + td.cards.filter((c) => !ALLOWED.has(c.layer)).length);
  check('D', 'D3 persona → global', td.cards.filter((c) => c._kind === 'persona').every((c) => c.layer === 'global'));
  check('D', 'D4 instruction → global', td.cards.filter((c) => c._kind === 'instruction').every((c) => c.layer === 'global'));
  check('D', 'D5 episodic → project', td.cards.filter((c) => c._kind === 'episodic').every((c) => c.layer === 'project'));
  check('D', 'D6 保留 _kind 原始值', td.cards.every((c) => typeof c._kind === 'string' && c._kind.length > 0));
  check('D', 'D7 映射表覆盖所有 kind', Object.keys(KIND_TO_LAYER).length >= 3 && Object.values(KIND_TO_LAYER).every((v) => ALLOWED.has(v)), JSON.stringify(KIND_TO_LAYER));
}

// ── B · 时间方向判定 ──
console.log('── B · 时间方向判定 ──');
const T = [
  ['最早的桌宠', 'earliest'], ['最久以前的记忆', 'earliest'], ['第一次做桌宠', 'earliest'],
  ['什么时候做的桌宠', 'earliest'], ['桌宠是哪天开始的', 'earliest'],
  ['前两天我们干什么', 'latest'], ['昨天做了什么', 'latest'], ['最近在忙什么', 'latest'],
  ['桌宠圣域面板', null],
];
for (const [q, want] of T) {
  check('B', 'B1 "' + q + '" → ' + (want === null ? 'null' : want), classifyTemporal(q) === want, '实际=' + classifyTemporal(q));
}
check('B', 'B2 含时间词的判 temporal', classifyQuery('最早的桌宠') === 'temporal', classifyQuery('最早的桌宠'));

// ── C · 跨源检索 ──
console.log('── C · 跨源检索 ──');
const rt = createRetriever({
  indexRoot: dataPath('hypergraph'),
  engramPath: dataPath('engram-relay/engrams.jsonl'),
  tdaiEnabled: true,
});
const t0 = Date.now();
await rt.warmup();
const h = rt.health();
const warmMs = Date.now() - t0;

check('C', 'C1 tdai 已并入', h.tdai && h.tdai.added > 1000, 'added=' + (h.tdai && h.tdai.added));
check('C', 'C2 bm25.docs 含两源', h.bm25.docs > 6000, 'docs=' + h.bm25.docs);
check('C', 'C3 warmup < 3000ms', warmMs < 3000, warmMs + 'ms');

const res = await rt.search('最早的桌宠', {});
check('C', 'C4 temporal 生效', res.temporal && res.temporal.dir === 'earliest', JSON.stringify(res.temporal));
check('C', 'C5 结果含 tdai 卡', res.hits.some((x) => String(x.id).startsWith('tdai:')), 'tdai 命中数=' + res.hits.filter((x) => String(x.id).startsWith('tdai:')).length);

// 单调性（temporal 查询必须按时间单调）
const tdById = new Map(td.cards.map((c) => [c.id, c]));
const tsOf = async (id) => {
  if (String(id).startsWith('tdai:')) { const c = tdById.get(id); return c ? c.createdAt : 0; }
  return 0;   // engram 卡的时间此处不查，只验 tdai 段内部单调
};
const tdHits = res.hits.filter((x) => String(x.id).startsWith('tdai:'));
let mono = true;
for (let i = 1; i < tdHits.length; i++) {
  const a = tdById.get(tdHits[i - 1].id), b = tdById.get(tdHits[i].id);
  if (a && b && b.createdAt < a.createdAt) mono = false;
}
check('C', 'C6 tdai 段内时间单调（不降）', mono, 'tdai 命中 ' + tdHits.length + ' 条');

// 关掉跨源后，8 月记录应该消失了
const rtOff = createRetriever({
  indexRoot: dataPath('hypergraph'),
  engramPath: dataPath('engram-relay/engrams.jsonl'),
  tdaiEnabled: false,
});
await rtOff.warmup();
const off = await rtOff.search('最早的桌宠', {});
check('C', 'C7 关跨源后无 tdai 卡', !off.hits.some((x) => String(x.id).startsWith('tdai:')), 'hits=' + off.hits.length);
check('C', 'C8 关跨源后 docs 更小', rtOff.health().bm25.docs < h.bm25.docs, rtOff.health().bm25.docs + ' < ' + h.bm25.docs);

// ── N · 归属会话字段口径（2026-10-26 立）──
//   事故：写卡侧只写 sessionId / sessionKey / source_session_id 三个同值字段，
//   **sourceSessionId 只是 memory_get 的输出派生名，落盘文件里没有这个键**；
//   而消费方各自手写回退链 ⇒ 红队补丁读 c.sessionId、Assistant排查读 c.sourceSessionId 都拿到空值。
//   ⇒ 统一收口到 lib/card-session.js 的 sessionIdOf()，本节把这条判据钉死。
console.log('── N · 归属会话字段口径 ──');
{
  const { sessionIdOf, SESSION_FIELDS } = await import('./lib/card-session.js');
  check('N', 'N1 四种字段名都能取到', SESSION_FIELDS.every((f) => sessionIdOf({ [f]: 'session-x' }) === 'session-x'), JSON.stringify(SESSION_FIELDS));
  check('N', 'N2 全缺时返回空串（不是 undefined/null）', sessionIdOf({}) === '' && typeof sessionIdOf({}) === 'string');
  check('N', 'N3 非对象输入安全', sessionIdOf(null) === '' && sessionIdOf(undefined) === '' && sessionIdOf('x') === '');
  check('N', 'N4 前后空白被裁掉', sessionIdOf({ sessionId: '  session-a  ' }) === 'session-a');
  check('N', 'N5 空字符串会跳到下一个字段', sessionIdOf({ sessionId: '   ', source_session_id: 'session-b' }) === 'session-b');
  // 真实落盘卡：从主库取一条，确认它带的是哪个字段
  const { readFileSync } = await import('node:fs');
  const raw = readFileSync(dataPath('engram-relay/engrams.jsonl'), 'utf8').split('\n').filter(Boolean).slice(-200);
  let withSid = 0, total = 0, viaDerivedOnly = 0;
  for (const line of raw) {
    let o; try { o = JSON.parse(line); } catch { continue; }
    total++;
    if (!sessionIdOf(o)) continue;
    withSid++;
    if (!o.sessionId && !o.sessionKey && !o.source_session_id && o.sourceSessionId) viaDerivedOnly++;
  }
  check('N', 'N6 真实卡里能被 sessionIdOf 取到归属', withSid > 0, withSid + '/' + total + ' 张有归属');
  check('N', 'N7 真实卡不依赖派生名 sourceSessionId', viaDerivedOnly === 0, '仅靠派生名的=' + viaDerivedOnly);
  // 消费侧必须真的用了统一判据（源码级断言，防止以后又被手写回退链绕开）
  const consumers = [
    ['lib/retrieval/source-tracer.js', 'resolveSourceRef'],
    ['lib/retrieval/retriever.js', 'recentCrossSession'],
    ['lib/ingest/distill.js', 'readRecentL0ForSession'],
  ];
  for (const [file, what] of consumers) {
    const src = readFileSync(file, 'utf8');
    const uses = src.includes('sessionIdOf(');
    const handRolled = /card\.sessionId \|\|| c\.sessionId \|\|| m\.sessionKey \|\| m\.sessionId/.test(src);
    check('N', 'N8 ' + what + ' 走统一判据（无手写回退链）', uses && !handRolled, uses ? (handRolled ? '仍残留手写回退链' : 'ok') : '未调用 sessionIdOf');
  }
}

// ── F · 故障登记簿（Phase 3）──
//   契约：绝不抛、环形封顶、定位到真实调用点、摘要可聚合、核心路径无裸 catch。
console.log('── F · 故障登记簿 ──');
{
  const { recordFault, listFaults, recentFaults, faultSummary, clearFaults } = await import('./lib/faults.js');
  clearFaults();
  check('F', 'F1 新登记簿为空', listFaults().length === 0);
  check('F', 'F2 记录 Error 对象', recordFault('retriever', 'zstd', new Error('解压失败')) === true);
  check('F', 'F3 记录非 Error 值不抛', recordFault('distill', 'append', 'plain-string') === true);
  check('F', 'F4 记录 undefined 不抛', recordFault(null, null, undefined) === true);
  const l = listFaults();
  check('F', 'F5 最新在前', l.length === 3 && l[0].module === '?' , 'head=' + l[0].module);
  check('F', 'F6 保留错误消息', l.some((f) => f.message.indexOf('解压失败') >= 0));
  check('F', 'F7 定位到真实调用点（非 faults.js 自身）', l.every((f) => String(f.where).indexOf('faults.js') < 0), JSON.stringify(l.map((f) => String(f.where).slice(0, 36))));
  const sum = faultSummary();
  check('F', 'F8 摘要按模块聚合', sum.retriever === 1 && sum.distill === 1, JSON.stringify(sum));
  check('F', 'F9 recentFaults 能取到', recentFaults(3600 * 1000).length === 3);
  for (let i = 0; i < 40; i++) recordFault('flood', 'x' + i, 'e');
  check('F', 'F10 环形封顶 20 条', listFaults().length === 20, 'len=' + listFaults().length);
  const { readFileSync: rf2 } = await import('node:fs');
  for (const file of ['lib/retrieval/retriever.js', 'lib/ingest/distill.js']) {
    const bare = (rf2(file, 'utf8').match(/catch\s*\{\s*\}/g) || []).length;
    check('F', 'F11 ' + file.split('/').pop() + ' 无裸 catch{}', bare === 0, '残留=' + bare);
  }
  clearFaults();
}

// ── 汇总 ──
const pass = R.filter((x) => x.ok).length;
const fail = R.length - pass;
console.log('');
for (const r of R) if (!r.ok) console.log('  FAIL ' + r.name + '  ' + r.detail);
console.log('');
console.log('════ CROSSSOURCE SUMMARY ════');
console.log('  checks=' + R.length + '  passed=' + pass + '  failed=' + fail);
console.log(fail === 0 ? 'CROSSSOURCE-DONE' : 'CROSSSOURCE-FAILED');
process.exit(fail === 0 ? 0 : 1);
