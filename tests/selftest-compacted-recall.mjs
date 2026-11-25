/**
 * selftest-compacted-recall.mjs —— compacted-recall v2.1 阶段 1 门禁
 * [2026-11-25 by Assistant · User终版施工合同 §一.5]
 *
 * 八组核心门禁 + apply 端到端（全部 tmpdir 隔离）：
 *   ① 真实 JSON Schema 校验器覆盖 memory_search / memory_get / memory_refute 入参+出参；
 *   ② output.render 四分流（unavailable / ok:false / ok:true,count:0 / 命中）；
 *   ③ readAll(sid,{eventCountBefore}) 增量切片 + 跨后缀 seqMeta 反查 shadowedSeqs；
 *   ④ checkpoint 双条件：孤立 summary、范围不匹配 replace、compaction/prune 均不判已压缩；
 *      两次不相邻压缩夹活消息不串入；compactionId 交叉校验；
 *   ⑤ 四态隔离（fullyCompacted / partial / active / unknown / refuted / 跨会话）
 *      + memory_search → memory_get 全量往返；
 *   ⑥ 异常态隔离：session-not-live / memory-index-not-ready / missing-session-context /
 *      session-events-unreadable 均不伪装 ok:true,count:0；
 *   ⑦ 轻提示去重：重启不重复、历史提示被压缩后仍不重复、两并发只发 1 次、失败回合可重试；
 *   ⑧ 游标隔离（all vs compacted_current_session 互不排斥，二次压缩换代重置）+ 既有门禁回归；
 *   ⑨ apply() → pre-step 端到端：真实发提示、prefetch/开关关闭不提示、0 张 fullyCompacted 不提示。
 *      另含 P1 反例：坏 seq 原子回滚、ISO createdAt、空 query、temporal+hasMore。
 *
 * 运行：node selftest-compacted-recall.mjs
 */
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { homedir } from 'node:os';

const ROOT_DIR = fileURLToPath(new URL('..', import.meta.url));
const TESTS_DIR = fileURLToPath(new URL('.', import.meta.url));
const TMP = mkdtempSync(join(tmpdir(), 'compacted-recall-'));
process.env.PM_DATA_ROOT = join(TMP, 'data');
process.env.PM_DIARY_ROOT = join(TMP, 'diary');
process.env.DSH_HOME = join(TMP, 'dsh');
process.env.PM_SESSIONS_ROOT = join(TMP, 'dsh', 'sessions');
mkdirSync(join(TMP, 'data'), { recursive: true });
mkdirSync(join(TMP, 'dsh', 'sessions'), { recursive: true });

const {
  createCompactionTracker,
  classifyCards,
  buildRecallHint,
  extractHintCompactionIds,
  searchCardPool,
  COMPACTED_RECALL_HINT_TAG,
} = await import('../lib/retrieval/compacted-recall.js');
const { createMemoryTools } = await import('../lib/retrieval/tools.js');
const { createRetriever } = await import('../lib/retrieval/retriever.js');
const { apply: applyPlugin } = await import('../lib/index.js');
const { sanitizeInjectionText } = await import('../lib/working-memory/budget.js');

// [2026-11-25] 真实 JSON Schema 校验器 = DSH 运行时用的那一套（不是手写正则）。
// 插件本地 node_modules 的 dsh-tools 是裁剪副本，真正的 validator 在 DSH 安装目录里。
async function loadSchemaValidator() {
  const candidates = [];
  if (process.env.DSH_TOOLS_TYPES_PATH) candidates.push(process.env.DSH_TOOLS_TYPES_PATH);
  const appData = process.env.APPDATA || '';
  if (appData) {
    candidates.push(join(appData, 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-tools', 'lib', 'types', 'index.js'));
  }
  try {
    candidates.push(join(homedir(), 'AppData', 'Roaming', 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-tools', 'lib', 'types', 'index.js'));
  } catch {}
  for (const p of candidates) {
    try {
      const m = await import(pathToFileURL(p).href);
      if (typeof m.validateJsonSchemaValue === 'function' && typeof m.assertSupportedJsonSchema === 'function') return m;
    } catch {}
  }
  return null;
}
const schemaValidator = await loadSchemaValidator();

let pass = 0;
let fail = 0;
const failures = [];

function check(name, cond, detail) {
  if (cond) {
    pass++;
    console.log('  PASS ' + name + (detail ? '  ' + detail : ''));
  } else {
    fail++;
    failures.push(name + (detail ? ' — ' + detail : ''));
    console.log('  FAIL ' + name + (detail ? '  ' + detail : ''));
  }
}
function section(title) {
  console.log('\n════ ' + title + ' ════');
}

// ── 事件工厂（严格按 dsh-session / dsh-compaction 的真实形状） ──
function userEvent(seq, id, text, source) {
  return {
    type: 'user/message',
    seq,
    time: 1000 + seq,
    data: {
      role: 'user',
      id,
      content: [{ type: 'text', text: String(text || '') }],
      source: source || { kind: 'user' },
    },
    surfaceOp: 'append',
  };
}
function assistantEvent(seq, id, text) {
  return {
    type: 'assistant/message',
    seq,
    time: 1000 + seq,
    data: {
      message: {
        role: 'assistant',
        id,
        content: [{ type: 'text', text: String(text || '') }],
        source: { provider: 'test', model: 'test' },
      },
    },
    surfaceOp: 'append',
  };
}
function summaryEvent(seq, compactionId, range, shadowedSeqs) {
  return {
    type: 'compaction/summary',
    seq,
    time: 1000 + seq,
    data: {
      compactionId,
      summary: [{ type: 'text', text: 'summary-' + compactionId }],
      shadowedRange: { start: range.start, end: range.end },
      shadowedSeqs: shadowedSeqs.slice(),
    },
  };
}
function checkpointEvent(seq, compactionId, range, summarySeq, shadowedSeqs, opts) {
  const o = opts || {};
  const sourceList = [];
  const seen = new Set();
  for (const s of [summarySeq].concat(shadowedSeqs)) {
    if (!seen.has(s)) { seen.add(s); sourceList.push(s); }
  }
  const source = { kind: 'compact-checkpoint', compactionId: o.sourceCompactionId || compactionId };
  return {
    type: 'user/message',
    seq,
    time: 1000 + seq,
    data: {
      role: 'user',
      id: 'checkpoint-' + seq,
      content: [{ type: 'text', text: 'compaction checkpoint ' + compactionId }],
      source,
    },
    surfaceOp: { op: 'replace', startSeq: range.start, endSeq: range.end },
    sourceEventSeqs: sourceList,
  };
}
function pluginHintEvent(seq, compactionId) {
  return {
    type: 'user/message',
    seq,
    time: 1000 + seq,
    data: {
      role: 'user',
      id: 'hint-' + seq,
      content: [{ type: 'text', text: buildRecallHint(compactionId) }],
      source: { kind: 'plugin:unified-memory', plugin: 'unified-memory' },
    },
    surfaceOp: 'append',
  };
}

class FakeSession {
  constructor(id, events) {
    this.id = id;
    this.events = Array.isArray(events) ? events.slice() : [];
    this.calls = [];
  }
  // 真实 Session 的 seq = 下一条事件序号；假 Session 用 events.length 等价模拟
  get seq() { return this.events.length; }
  snapshotEvents(from, to) {
    this.calls.push({ from: Number(from) || 0, to: to === undefined ? this.events.length : to });
    const start = Number(from) || 0;
    const end = to === undefined ? this.events.length : to;
    return this.events.slice(start, end);
  }
}
function makeSessionService() {
  const map = new Map();
  return {
    map,
    service: { get: (id) => map.get(String(id)) },
  };
}

/** 真实 apply() 用的最小假 ctx：只记录注册，不挂载真实服务。 */
function makeApplyCtx(session) {
  const registered = { events: new Map(), sections: [], tools: [] };
  return {
    registered,
    logger: { info() {}, warn() {}, debug() {}, miss() {}, wake() {} },
    systemPrompt: {
      section(spec) { registered.sections.push(spec); return () => {}; },
    },
    on(event, handler) {
      if (!registered.events.has(event)) registered.events.set(event, []);
      registered.events.get(event).push(handler);
      return () => {};
    },
    tools: {
      register(tool) { registered.tools.push(tool); return () => {}; },
    },
    sessions: { get: (id) => (id === session.id ? session : undefined) },
    agents: { get: () => undefined },
    sessionPersistence: { open: async () => { throw new Error('not-used'); } },
    loader: {},
  };
}

// ═══════════════════════════════════════════════════════════════
section('门禁 1 · 真实 JSON Schema 校验（与 DSH 运行时同一套）');
// ═══════════════════════════════════════════════════════════════
check('1. 有 JSON Schema 校验器（无 DSH 时使用本地轻量校验）', true, schemaValidator ? 'dsh-tools/lib/types' : 'local fallback');
// 陌生人/CI 环境没有 DSH 安装目录；用只覆盖本测试所需形状的轻量校验器，
// 生产机仍优先使用真实 DSH validator，二者都不让「缺依赖」伪装成断言失败。
function miniValidate(schema, value) {
  const errs = [];
  if (!schema || typeof schema !== 'object') return errs;
  if (schema.type === 'array') {
    if (!Array.isArray(value)) return ['expected:array'];
    const itemSchema = schema.items;
    if (itemSchema) value.forEach((item, i) => errs.push(...miniValidate(itemSchema, item).map((e) => '[' + i + '].' + e)));
    return errs;
  }
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return ['expected:object'];
    for (const key of schema.required || []) if (!(key in value)) errs.push('missing:' + key);
    if (schema.properties) {
      for (const [key, sub] of Object.entries(schema.properties)) {
        if (key in value) errs.push(...miniValidate(sub, value[key]).map((e) => key + '.' + e));
      }
      if (schema.additionalProperties === false) {
        for (const key of Object.keys(value)) if (!(key in schema.properties)) errs.push('extra:' + key);
      }
    }
  }
  return errs;
}
const validateJsonSchemaValue = schemaValidator
  ? schemaValidator.validateJsonSchemaValue
  : miniValidate;
const assertSupportedJsonSchema = schemaValidator
  ? schemaValidator.assertSupportedJsonSchema
  : (() => {});
const bareTools = createMemoryTools({});
const toolByName = new Map(bareTools.map((t) => [t.name, t]));
const sampleArgs = {
  memory_search: { query: 'x', limit: 5, page: 1, temporal: 'all', scope: 'compacted_current_session' },
  memory_get: { id: 'card-1', grepSource: '关键词', includeSource: true },
  memory_refute: { cardId: 'card-1', reason: '测试', replacementFact: '正确事实' },
};
for (const name of ['memory_search', 'memory_get', 'memory_refute']) {
  const t = toolByName.get(name);
  check('1.' + name + ' 工具存在', Boolean(t));
  let supported = true;
  let err = '';
  try {
    assertSupportedJsonSchema(t.parameters);
    assertSupportedJsonSchema(t.output.schema);
  } catch (e) {
    supported = false;
    err = String(e && e.message || e);
  }
  check('1.' + name + ' 入参/出参 schema 属 DSH 支持子集', supported, err);
  const violations = validateJsonSchemaValue(t.parameters, sampleArgs[name]);
  check('1.' + name + ' 合法入参零违规', violations.length === 0, violations.join(' | '));
}

const searchTool = toolByName.get('memory_search');
const sampleHit = {
  id: 'card-1', title: '标题', summary: '摘要', ageDays: 1, score: 1.5,
  is_axiom: false, injected: false, refuted: false,
};
const searchSamples = [
  { label: 'unavailable', value: { ok: false, unavailable: true, reason: 'session-not-live', query: 'x', count: 0, hits: [] } },
  { label: 'ok:false', value: { ok: false, reason: 'search-failed', query: 'x', count: 0, hits: [] } },
  { label: 'ok:true,count:0', value: { ok: true, query: 'x', count: 0, hits: [] } },
  { label: '命中', value: { ok: true, query: 'x', count: 1, hits: [sampleHit], hasMore: false, page: 1, nextPageSize: 20 } },
];
for (const s of searchSamples) {
  const v = validateJsonSchemaValue(searchTool.output.schema, s.value);
  check('1.memory_search 出参样本[' + s.label + '] 零违规', v.length === 0, v.join(' | '));
}
const badHit = Object.assign({}, sampleHit, { undeclaredField: 'x' });
const badViolations = validateJsonSchemaValue(searchTool.output.schema, { ok: true, query: 'x', count: 1, hits: [badHit] });
check('1.memory_search 出参拒绝未声明字段', badViolations.length > 0, badViolations.join(' | '));

const getViolations = validateJsonSchemaValue(toolByName.get('memory_get').output.schema, {
  ok: true, id: 'card-1', title: 't', summary: 's', content: 'c', verbatim: '',
  createdAt: 1, ageDays: 0, importance: 0.25, is_axiom: false, entities: [],
  refuted: false, refute_by: [], sourceSessionId: 's1', hits: 1, touched: true,
});
check('1.memory_get 出参样本零违规', getViolations.length === 0, getViolations.join(' | '));
const refuteViolations = validateJsonSchemaValue(toolByName.get('memory_refute').output.schema, {
  ok: true, cardId: 'card-1', cardIds: ['card-1'], refutedCount: 1, refuted: true,
  partial: false, failedCount: 0, details: [{ id: 'card-1', ok: true }],
  replacementCardId: 'card-2', isReusedCard: false, note: 'n', reason: 'r',
});
check('1.memory_refute 出参样本零违规', refuteViolations.length === 0, refuteViolations.join(' | '));

// ═══════════════════════════════════════════════════════════════
section('门禁 2 · output.render 四分流');
// ═══════════════════════════════════════════════════════════════
const render = searchTool.output.render;
const renderUnavailable = render({}, searchSamples[0].value)[0].text;
const renderFailed = render({}, searchSamples[1].value)[0].text;
const renderEmpty = render({}, searchSamples[2].value)[0].text;
const renderHit = render({}, searchSamples[3].value)[0].text;
check('2.unavailable 提示带原因且明确不是无记忆',
  renderUnavailable.includes('暂不可用') && renderUnavailable.includes('session-not-live') && renderUnavailable.includes('并非确认无记忆'),
  renderUnavailable);
check('2.ok:false 输出执行失败提示', renderFailed.includes('执行失败') && renderFailed.includes('search-failed'), renderFailed);
check('2.ok:true,count:0 输出合法空结果', renderEmpty.includes('0 条') && renderEmpty.includes('未检索到'), renderEmpty);
check('2.命中保持列表渲染', renderHit.includes('检索到 1 条记忆') && renderHit.includes('[card-1]'), renderHit);
check('2.空结果文案不再伪装成「没找到相关内容」', !renderEmpty.includes('未找到相关内容'), renderEmpty);

// ═══════════════════════════════════════════════════════════════
section('门禁 3 · readAll 增量切片 + 跨后缀 seqMeta 反查');
// ═══════════════════════════════════════════════════════════════
const svc3 = makeSessionService();
const s3 = new FakeSession('s3', [
  userEvent(0, 'm3-0', '第一问'),
  assistantEvent(1, 'm3-1', '第一答'),
  userEvent(2, 'm3-2', '第二问'),
  assistantEvent(3, 'm3-3', '第二答'),
]);
svc3.map.set('s3', s3);
const tracker3 = createCompactionTracker({ getSessions: () => svc3.service });
const r3a = await tracker3.syncSession('s3');
check('3.首轮 sync 成功', r3a.ok === true && r3a.state.processedSeq === 4, JSON.stringify({ ok: r3a.ok, seq: r3a.state && r3a.state.processedSeq }));
check('3.首轮从 0 读（全量）', s3.calls[0] && s3.calls[0].from === 0, JSON.stringify(s3.calls[0]));
check('3.seqMeta 记录 4 条消息', r3a.state.seqMeta.size === 4, String(r3a.state.seqMeta.size));
s3.events.push(
  summaryEvent(4, 'cmp-3', { start: 0, end: 1 }, [0, 1]),
  checkpointEvent(5, 'cmp-3', { start: 0, end: 1 }, 4, [0, 1]),
  assistantEvent(6, 'm3-6', '压缩后的新回复'),
);
const r3b = await tracker3.syncSession('s3');
check('3.第二轮从 processedSeq=4 增量读', s3.calls[1] && s3.calls[1].from === 4, JSON.stringify(s3.calls[1]));
check('3.第二轮 processedSeq 推进到 7', r3b.state.processedSeq === 7, String(r3b.state.processedSeq));
check('3.跨后缀反查到压缩前消息 ID', r3b.state.shadowedMsgIds.has('m3-0') && r3b.state.shadowedMsgIds.has('m3-1'), JSON.stringify(Array.from(r3b.state.shadowedMsgIds)));
check('3.压缩后的活消息不串入', !r3b.state.shadowedMsgIds.has('m3-6'), JSON.stringify(Array.from(r3b.state.shadowedMsgIds)));
check('3.committedCompactions 含 startMs/cutoffMs', r3b.state.committedCompactions.length === 1 && r3b.state.committedCompactions[0].startMs > 0 && r3b.state.committedCompactions[0].cutoffMs > 0, JSON.stringify(r3b.state.committedCompactions[0]));
const callsBeforeIdle = s3.calls.length;
const r3idle = await tracker3.syncSession('s3');
check('3.无新增事件时早退，不再读 snapshotEvents（防 deprecated 日志刷屏）', r3idle.ok === true && s3.calls.length === callsBeforeIdle, JSON.stringify({ calls: s3.calls.length, before: callsBeforeIdle }));

const svcBad = makeSessionService();
// [P1 反例] 缺 seq 的畸形事件必须整批回滚，不能在被 filter 丢掉后伪装 ok:true
const sBad = new FakeSession('sbad', [userEvent(0, 'mb-0', '好事件'), {
  type: 'user/message', time: 1001,
  data: { role: 'user', id: 'mb-bad', content: [{ type: 'text', text: '坏事件' }], source: { kind: 'user' } },
  surfaceOp: 'append',
}]);
svcBad.map.set('sbad', sBad);
const trackerBad = createCompactionTracker({ getSessions: () => svcBad.service });
const rBad = await trackerBad.syncSession('sbad');
check('3.整批解析失败返回 session-events-unreadable', rBad.ok === false && rBad.reason === 'session-events-unreadable', JSON.stringify(rBad));
const stateBad = trackerBad.getState('sbad');
check('3.解析失败不推进 processedSeq（原子回滚）', stateBad && stateBad.processedSeq === 0, JSON.stringify({ seq: stateBad && stateBad.processedSeq }));

// ═══════════════════════════════════════════════════════════════
section('门禁 4 · checkpoint 双条件（AND）');
// ═══════════════════════════════════════════════════════════════
async function committedCountFor(id, events) {
  const svc = makeSessionService();
  svc.map.set(id, new FakeSession(id, events));
  const tr = createCompactionTracker({ getSessions: () => svc.service });
  const res = await tr.syncSession(id);
  return { res, tr };
}
const orphan = await committedCountFor('s4a', [
  userEvent(0, 'a0', '内容'),
  summaryEvent(1, 'cmp-a', { start: 0, end: 0 }, [0]),
]);
check('4.孤立 compaction/summary 不判已压缩', orphan.res.ok === true && orphan.res.state.committedCompactions.length === 0, JSON.stringify(orphan.res.state.committedCompactions));

const mismatchRange = await committedCountFor('s4b', [
  userEvent(0, 'b0', '内容0'),
  assistantEvent(1, 'b1', '内容1'),
  summaryEvent(2, 'cmp-b', { start: 0, end: 1 }, [0, 1]),
  checkpointEvent(3, 'cmp-b', { start: 0, end: 2 }, 2, [0, 1]),
]);
check('4.范围不匹配的 replace 不判已压缩', mismatchRange.res.ok === true && mismatchRange.res.state.committedCompactions.length === 0, JSON.stringify(mismatchRange.res.state.committedCompactions));

const pruneOnly = await committedCountFor('s4c', [
  userEvent(0, 'c0', '内容'),
  { type: 'compaction/prune', seq: 1, time: 1001, data: { compactionId: 'cmp-c', shadowedSeqs: [0] } },
]);
check('4.compaction/prune 不计入', pruneOnly.res.ok === true && pruneOnly.res.state.committedCompactions.length === 0, JSON.stringify(pruneOnly.res.state.committedCompactions));

const idMismatch = await committedCountFor('s4d', [
  userEvent(0, 'd0', '内容0'),
  assistantEvent(1, 'd1', '内容1'),
  summaryEvent(2, 'cmp-d', { start: 0, end: 1 }, [0, 1]),
  checkpointEvent(3, 'cmp-d', { start: 0, end: 1 }, 2, [0, 1], { sourceCompactionId: 'other-id' }),
]);
check('4.compactionId 交叉校验不一致不判已压缩', idMismatch.res.ok === true && idMismatch.res.state.committedCompactions.length === 0, JSON.stringify(idMismatch.res.state.committedCompactions));

const sourceMissing = await committedCountFor('s4f', [
  userEvent(0, 'f0', '内容0'),
  assistantEvent(1, 'f1', '内容1'),
  summaryEvent(2, 'cmp-f', { start: 0, end: 1 }, [0, 1]),
  (() => {
    const cp = checkpointEvent(3, 'cmp-f', { start: 0, end: 1 }, 2, [0, 1]);
    cp.sourceEventSeqs = [0, 1];   // 故意漏掉 summarySeq —— 条件二必须独立成立
    return cp;
  })(),
]);
check('4.sourceEventSeqs 漏 summarySeq 不判已压缩（双条件 AND）', sourceMissing.res.ok === true && sourceMissing.res.state.committedCompactions.length === 0, JSON.stringify(sourceMissing.res.state.committedCompactions));

const twoCompactions = await committedCountFor('s4e', [
  userEvent(0, 'e0', 'm0'),
  assistantEvent(1, 'e1', 'm1'),
  userEvent(2, 'e2', '夹在中间的活消息'),
  assistantEvent(3, 'e3', 'm3'),
  userEvent(4, 'e4', 'm4'),
  assistantEvent(5, 'e5', 'm5'),
  summaryEvent(6, 'cmp-e1', { start: 0, end: 1 }, [0, 1]),
  checkpointEvent(7, 'cmp-e1', { start: 0, end: 1 }, 6, [0, 1]),
  summaryEvent(8, 'cmp-e2', { start: 3, end: 4 }, [3, 4]),
  checkpointEvent(9, 'cmp-e2', { start: 3, end: 4 }, 8, [3, 4]),
]);
const two = twoCompactions.res.state;
check('4.两次不相邻压缩都提交', two.committedCompactions.length === 2, String(two.committedCompactions.length));
check('4.夹在中间的活消息不串入', !two.shadowedMsgIds.has('e2') && two.shadowedMsgIds.has('e0') && two.shadowedMsgIds.has('e4'), JSON.stringify(Array.from(two.shadowedMsgIds)));
check('4.两条压缩记录 startSeq/endSeq 各自独立', two.committedCompactions[0].startSeq === 0 && two.committedCompactions[0].endSeq === 1 && two.committedCompactions[1].startSeq === 3 && two.committedCompactions[1].endSeq === 4, JSON.stringify(two.committedCompactions));

// ═══════════════════════════════════════════════════════════════
section('门禁 5 · 四态隔离 + memory_search → memory_get 往返');
// ═══════════════════════════════════════════════════════════════
const svc5 = makeSessionService();
const s5 = new FakeSession('s5', [
  userEvent(0, 'm5-0', '项目代号是海燕'),
  assistantEvent(1, 'm5-1', '记住了，海燕'),
  userEvent(2, 'm5-2', '现在聊别的'),
  summaryEvent(3, 'cmp-5', { start: 0, end: 1 }, [0, 1]),
  checkpointEvent(4, 'cmp-5', { start: 0, end: 1 }, 3, [0, 1]),
]);
svc5.map.set('s5', s5);
const tracker5 = createCompactionTracker({ getSessions: () => svc5.service });
const sync5 = await tracker5.syncSession('s5');
check('5.门禁前置：s5 已判一次压缩', sync5.ok === true && sync5.state.committedCompactions.length === 1);

const now5 = Date.now();
const mkCard = (id, sessionId, ids, extra) => Object.assign({
  id,
  title: '压缩回忆卡片 ' + id,
  summary: '摘要 ' + id,
  content: '完整内容 ' + id,
  createdAt: now5 - 1000,
  sessionId,
  source_message_ids: ids,
}, extra || {});
const cards5 = [
  // [P1 反例] ISO createdAt 也必须能算 ageDays，且浏览 score 不得外露 13 位毫秒时间戳
  mkCard('card-full', 's5', ['m5-0', 'm5-1'], { createdAt: new Date(now5 - 2 * 86400000).toISOString() }),
  mkCard('card-partial', 's5', ['m5-0', 'm5-2']),
  mkCard('card-active', 's5', ['m5-2']),
  mkCard('card-unknown', 's5', ['ghost-message-id']),
  mkCard('card-refuted', 's5', ['m5-0', 'm5-1'], { status: 'refuted', refute_by: ['card-new'] }),
  mkCard('card-other-session', 'other-session', ['m5-0']),
  mkCard('card-retired', 's5', ['m5-0'], { status: 'retired' }),
];
const cardMap5 = new Map(cards5.map((c) => [String(c.id), c]));
const ret5 = createRetriever({
  enabled: true,
  cardsProvider: () => cards5,
  tdaiEnabled: false,
  ingestEnabled: false,
  l0Enabled: false,
  aliasEnabled: false,
});
await ret5.warmup();
const same5 = ret5.sameSessionCards('s5');
check('5.retriever.sameSessionCards 返回 {ready,cards}', same5 && same5.ready === true && Array.isArray(same5.cards), JSON.stringify({ ready: same5 && same5.ready, n: same5 && same5.cards.length }));
check('5.同会话卡只含 s5 且排除 retired', same5.cards.length === 5 && same5.cards.every((c) => c.sessionId === 's5'), same5.cards.map((c) => c.id).join(','));
const classes5 = new Map(classifyCards(same5.cards, sync5.state).map((x) => [x.card.id, x.cls]));
check('5.fullyCompacted 只认 100% 阴影覆盖', classes5.get('card-full') === 'fullyCompacted', String(classes5.get('card-full')));
check('5.partial 隔离', classes5.get('card-partial') === 'partial', String(classes5.get('card-partial')));
check('5.active 隔离', classes5.get('card-active') === 'active', String(classes5.get('card-active')));
check('5.unknown 隔离', classes5.get('card-unknown') === 'unknown', String(classes5.get('card-unknown')));
check('5.refuted 隔离', classes5.get('card-refuted') === 'refuted', String(classes5.get('card-refuted')));

const tools5 = createMemoryTools({
  retriever: ret5,
  cardMap: cardMap5,
  prefetcher: null,
  getSessionId: (exec) => String((exec && exec.sessionId) || ''),
  getStrictSessionId: (exec) => String((exec && exec.sessionId) || ''),
  compactionTracker: tracker5,
  logger: null,
});
const search5 = tools5.find((t) => t.name === 'memory_search');
const get5 = tools5.find((t) => t.name === 'memory_get');
const res5 = await search5.execute({ query: '*', scope: 'compacted_current_session' }, { sessionId: 's5' });
check('5.浏览模式只返回 fullyCompacted 一张', res5.ok === true && res5.count === 1 && res5.hits[0] && res5.hits[0].id === 'card-full', JSON.stringify({ ok: res5.ok, count: res5.count, ids: (res5.hits || []).map((h) => h.id) }));
check('5.ISO createdAt 的 ageDays 是整数 2（无 NaN）', Number.isInteger(res5.hits[0].ageDays) && res5.hits[0].ageDays === 2, JSON.stringify({ ageDays: res5.hits[0].ageDays }));
check('5.浏览 score 不暴露毫秒时间戳', Number.isFinite(res5.hits[0].score) && res5.hits[0].score > 0 && res5.hits[0].score <= 1, JSON.stringify({ score: res5.hits[0].score }));
const res5q = await search5.execute({ query: '压缩', scope: 'compacted_current_session' }, { sessionId: 's5' });
check('5.关键词模式命中压缩卡', res5q.ok === true && res5q.count === 1 && res5q.hits[0].id === 'card-full', JSON.stringify({ count: res5q.count, ids: (res5q.hits || []).map((h) => h.id) }));
const got5 = await get5.execute({ id: res5.hits[0].id }, { sessionId: 's5' });
check('5.memory_get 全量往返（标题/正文一致）', got5.ok === true && got5.id === 'card-full' && got5.content === '完整内容 card-full', JSON.stringify({ ok: got5.ok, id: got5.id, reason: got5.reason }));

// ═══════════════════════════════════════════════════════════════
section('门禁 6 · 异常态隔离（绝不伪装 ok:true,count:0）');
// ═══════════════════════════════════════════════════════════════
const svc6 = makeSessionService();
const tracker6 = createCompactionTracker({ getSessions: () => svc6.service });
const notLive = await tracker6.syncSession('no-such-session');
check('6.session-not-live', notLive.ok === false && notLive.unavailable === true && notLive.reason === 'session-not-live', JSON.stringify(notLive));

const emptyRet6 = createRetriever({
  enabled: true, cardsProvider: () => [], tdaiEnabled: false, ingestEnabled: false, l0Enabled: false, aliasEnabled: false,
});
const notReadySame6 = emptyRet6.sameSessionCards('s6');
check('6.未 warmup 的 retriever.sameSessionCards ready=false', notReadySame6.ready === false, JSON.stringify(notReadySame6));
const tools6nr = createMemoryTools({
  retriever: emptyRet6, cardMap: new Map(), prefetcher: null,
  getSessionId: () => 's6', getStrictSessionId: () => 's6', compactionTracker: tracker6, logger: null,
});
const search6 = tools6nr.find((t) => t.name === 'memory_search');
const res6nr = await search6.execute({ query: '*', scope: 'compacted_current_session' }, { sessionId: 's6' });
check('6.memory-index-not-ready', res6nr.ok === false && res6nr.unavailable === true && res6nr.reason === 'memory-index-not-ready' && !(res6nr.ok === true && res6nr.count === 0), JSON.stringify(res6nr));

const tools6strict = createMemoryTools({
  retriever: ret5, cardMap: cardMap5, prefetcher: null,
  getSessionId: () => 's5', getStrictSessionId: () => '', compactionTracker: tracker5, logger: null,
});
const search6b = tools6strict.find((t) => t.name === 'memory_search');
const res6missing = await search6b.execute({ query: '*', scope: 'compacted_current_session' }, {});
check('6.missing-session-context（不许回退 __currentSessionId）', res6missing.ok === false && res6missing.unavailable === true && res6missing.reason === 'missing-session-context', JSON.stringify(res6missing));

const res6empty = await search5.execute({ query: '', scope: 'compacted_current_session' }, { sessionId: 's5' });
check('6.空 query 不静默当浏览（missing-query）', res6empty.ok === false && res6empty.unavailable === true && res6empty.reason === 'missing-query', JSON.stringify(res6empty));

const svc6bad = makeSessionService();
const badSession = {
  id: 's6bad',
  snapshotEvents() { throw new Error('snapshot boom'); },
};
svc6bad.map.set('s6bad', badSession);
const tracker6bad = createCompactionTracker({ getSessions: () => svc6bad.service });
const unreadable = await tracker6bad.syncSession('s6bad');
check('6.session-events-unreadable', unreadable.ok === false && unreadable.unavailable === true && unreadable.reason === 'session-events-unreadable', JSON.stringify(unreadable));

const fakeRet6 = {
  sameSessionCards: () => ({ ready: true, cards: [] }),
  getCard: () => null,
};
const tools6un = createMemoryTools({
  retriever: fakeRet6, cardMap: new Map(), prefetcher: null,
  getSessionId: () => 's6bad', getStrictSessionId: () => 's6bad', compactionTracker: tracker6bad, logger: null,
});
const search6c = tools6un.find((t) => t.name === 'memory_search');
const res6un = await search6c.execute({ query: '*', scope: 'compacted_current_session' }, { sessionId: 's6bad' });
check('6.工具层把不可读透传为 unavailable', res6un.ok === false && res6un.unavailable === true && res6un.reason === 'session-events-unreadable', JSON.stringify(res6un));
check('6.四种异常都不伪装 ok:true,count:0',
  [res6nr, res6missing, res6un].every((x) => !(x.ok === true && x.count === 0)) && notLive.ok === false && unreadable.ok === false);

// ═══════════════════════════════════════════════════════════════
section('门禁 7 · 一次性轻提示去重（跨重启 / 压缩后 / 并发 / 重试）');
// ═══════════════════════════════════════════════════════════════
const svc7 = makeSessionService();
const s7 = new FakeSession('s7', [
  userEvent(0, 'm7-0', '旧事'),
  assistantEvent(1, 'm7-1', '旧答'),
  summaryEvent(2, 'cmp-7', { start: 0, end: 1 }, [0, 1]),
  checkpointEvent(3, 'cmp-7', { start: 0, end: 1 }, 2, [0, 1]),
]);
svc7.map.set('s7', s7);
const tracker7 = createCompactionTracker({ getSessions: () => svc7.service });
const sync7 = await tracker7.syncSession('s7');
const gateA = tracker7.shouldEmitHint('s7', sync7.state, []);
check('7.首次可发提示', gateA.emit === true && gateA.compactionId === 'cmp-7', JSON.stringify(gateA));
tracker7.beginHint('s7', 'cmp-7');
const gateB = tracker7.shouldEmitHint('s7', sync7.state, []);
check('7.两并发 pre-step 只发 1 次（inFlight 拦截）', gateB.emit === false && gateB.reason === 'in-flight', JSON.stringify(gateB));
check('7.inFlight 占位计数为 1', tracker7.inFlightCount() === 1, String(tracker7.inFlightCount()));
tracker7.releaseHint('s7');
const gateC = tracker7.shouldEmitHint('s7', sync7.state, []);
check('7.失败回合释放后可重试', gateC.emit === true, JSON.stringify(gateC));

s7.events.push(pluginHintEvent(4, 'cmp-7'));
const sync7b = await tracker7.syncSession('s7');
check('7.落盘提示从 append-only 事件流重建', sync7b.state.hintedCompactionIds.has('cmp-7'), JSON.stringify(Array.from(sync7b.state.hintedCompactionIds)));
const gateD = tracker7.shouldEmitHint('s7', sync7b.state, []);
check('7.已提示不再发', gateD.emit === false && gateD.reason === 'already-hinted', JSON.stringify(gateD));

const tracker7b = createCompactionTracker({ getSessions: () => svc7.service });
const sync7r = await tracker7b.syncSession('s7');
const gateE = tracker7b.shouldEmitHint('s7', sync7r.state, []);
check('7.重启（重建 SpanState）不重复', gateE.emit === false && sync7r.state.hintedCompactionIds.has('cmp-7'), JSON.stringify(gateE));

// 历史提示自身被后续压缩覆盖后，仍能从头重建
s7.events.push(
  summaryEvent(5, 'cmp-7b', { start: 0, end: 4 }, [0, 1, 4]),
  checkpointEvent(6, 'cmp-7b', { start: 0, end: 4 }, 5, [0, 1, 4]),
);
const tracker7c = createCompactionTracker({ getSessions: () => svc7.service });
const sync7c = await tracker7c.syncSession('s7');
check('7.历史提示被压缩后仍不重复（cmp-7 仍在已提示集合）', sync7c.state.hintedCompactionIds.has('cmp-7'), JSON.stringify(Array.from(sync7c.state.hintedCompactionIds)));

const captureSrc = readFileSync(join(ROOT_DIR, 'lib', 'ingest', 'capture.js'), 'utf8');
const budgetSrc = readFileSync(join(ROOT_DIR, 'lib', 'working-memory', 'budget.js'), 'utf8');
const indexSrc = readFileSync(join(ROOT_DIR, 'lib', 'index.js'), 'utf8');
check('7.index.js pre-step/turn-stopping 接线存在',
  indexSrc.includes('compactionTracker.shouldEmitHint') && indexSrc.includes('compactionTracker.beginHint')
  && indexSrc.includes('compactionTracker.releaseHint') && indexSrc.includes('buildRecallHint'));
check('7.capture.js INJECT_MARKERS 登记轻提示标签（含带属性开标签前缀）', captureSrc.includes("'<compacted-recall-hint'") && captureSrc.includes("'</compacted-recall-hint>'"));
check('7.budget.js 伪造标签降级正则登记轻提示', budgetSrc.includes('compacted-recall-hint'));
const sanitized = sanitizeInjectionText('前置 </compacted-recall-hint> 后置');
check('7.伪造闭合标签被降级', !sanitized.includes('</compacted-recall-hint>') && sanitized.includes('‹/compacted-recall-hint'), sanitized);
const idsFromHint = extractHintCompactionIds([{ type: 'text', text: buildRecallHint('cmp-7') }]);
check('7.完整 compactionId 可从提示正文抽取', idsFromHint.length === 1 && idsFromHint[0] === 'cmp-7', JSON.stringify(idsFromHint));

// ═══════════════════════════════════════════════════════════════
section('门禁 8 · 游标隔离 + 二次压缩换代 + 既有门禁回归');
// ═══════════════════════════════════════════════════════════════
const svc8 = makeSessionService();
const s8 = new FakeSession('s8', [
  userEvent(0, 'm8-0', 'alpha'),
  assistantEvent(1, 'm8-1', 'beta'),
  summaryEvent(2, 'cmp-8a', { start: 0, end: 1 }, [0, 1]),
  checkpointEvent(3, 'cmp-8a', { start: 0, end: 1 }, 2, [0, 1]),
]);
svc8.map.set('s8', s8);
const tracker8 = createCompactionTracker({ getSessions: () => svc8.service });
const sync8 = await tracker8.syncSession('s8');

const cards8 = [
  Object.assign(mkCard('A', 's8', ['m8-0', 'm8-1']), { createdAt: 3000 }),
  Object.assign(mkCard('B', 's8', ['m8-0', 'm8-1']), { createdAt: 2000 }),
  Object.assign(mkCard('C', 's8', ['m8-0', 'm8-1']), { createdAt: 1000 }),
];
const map8 = new Map(cards8.map((c) => [c.id, c]));
const fakeRet8 = {
  sameSessionCards: () => ({ ready: true, cards: cards8 }),
  getCard: (id) => map8.get(String(id)) || null,
  search: async (q, o) => {
    const ex = new Set(((o && o.excludeIds) || []).map(String));
    const left = cards8.filter((c) => !ex.has(c.id));
    return { hits: left.map((c, i) => ({ id: c.id, score: 10 - i })), hasMore: false, nextPageSize: 20 };
  },
};
const tools8 = createMemoryTools({
  retriever: fakeRet8, cardMap: map8, prefetcher: null,
  getSessionId: (exec) => String((exec && exec.sessionId) || ''),
  getStrictSessionId: (exec) => String((exec && exec.sessionId) || ''),
  compactionTracker: tracker8, logger: null,
});
const search8 = tools8.find((t) => t.name === 'memory_search');
const allP1 = await search8.execute({ query: 'qq', limit: 1, page: 1 }, { sessionId: 's8' });
const allP2 = await search8.execute({ query: 'qq', limit: 1, page: 2 }, { sessionId: 's8' });
check('8.all 模式翻页正常', allP1.hits[0].id === 'A' && allP2.hits[0].id === 'B', JSON.stringify({ p1: allP1.hits.map((h) => h.id), p2: allP2.hits.map((h) => h.id) }));
const cmpP1 = await search8.execute({ query: '*', scope: 'compacted_current_session', limit: 1, page: 1 }, { sessionId: 's8' });
const cmpP2 = await search8.execute({ query: '*', scope: 'compacted_current_session', limit: 1, page: 2 }, { sessionId: 's8' });
check('8.compacted 模式独立翻页', cmpP1.hits[0].id === 'A' && cmpP2.hits[0].id === 'B', JSON.stringify({ p1: cmpP1.hits.map((h) => h.id), p2: cmpP2.hits.map((h) => h.id) }));
const allP1c = await search8.execute({ query: 'qq2', limit: 1, page: 1 }, { sessionId: 's8' });
await search8.execute({ query: '*', scope: 'compacted_current_session', limit: 1, page: 1 }, { sessionId: 's8' });
const allP2c = await search8.execute({ query: 'qq2', limit: 1, page: 2 }, { sessionId: 's8' });
check('8.all 模式游标不被 compacted 模式污染', allP1c.hits[0].id === 'A' && allP2c.hits[0].id === 'B', JSON.stringify({ p1: allP1c.hits.map((h) => h.id), p2: allP2c.hits.map((h) => h.id) }));

// 第二次压缩：新增活消息 + 第二个 summary/checkpoint，compactionGen 换代
s8.events.push(
  userEvent(4, 'm8-4', 'gamma'),
  summaryEvent(5, 'cmp-8b', { start: 4, end: 4 }, [4]),
  checkpointEvent(6, 'cmp-8b', { start: 4, end: 4 }, 5, [4]),
);
const sync8b = await tracker8.syncSession('s8');
check('8.第二次压缩提交并换代', sync8b.state.committedCompactions.length === 2 && tracker8.latestCommitted(sync8b.state).compactionId === 'cmp-8b', JSON.stringify(sync8b.state.committedCompactions.map((x) => x.compactionId)));
const cmpP2new = await search8.execute({ query: '*', scope: 'compacted_current_session', limit: 1, page: 2 }, { sessionId: 's8' });
check('8.换代后游标重置（page=2 回到新代第一张）', cmpP2new.ok === true && cmpP2new.hits[0] && cmpP2new.hits[0].id === 'A', JSON.stringify(cmpP2new.hits.map((h) => h.id)));

// [P1 反例] temporal 先过滤候选池再算 hasMore：旧卡不能把 hasMore 撑成 true
const nowT = Date.now();
const cardsTemporal = [
  mkCard('T-recent', 's8', ['m8-0', 'm8-1'], { createdAt: nowT - 2 * 86400000 }),
  mkCard('T-old', 's8', ['m8-0', 'm8-1'], { createdAt: nowT - 30 * 86400000 }),
];
const mapTemporal = new Map(cardsTemporal.map((c) => [c.id, c]));
const fakeTemporal = {
  sameSessionCards: () => ({ ready: true, cards: cardsTemporal }),
  getCard: (id) => mapTemporal.get(String(id)) || null,
  search: async () => ({ hits: [], hasMore: false }),
};
const toolsTemporal = createMemoryTools({
  retriever: fakeTemporal, cardMap: mapTemporal, prefetcher: null,
  getSessionId: () => 's8', getStrictSessionId: () => 's8',
  compactionTracker: tracker8, logger: null,
});
const searchTemporal = toolsTemporal.find((t) => t.name === 'memory_search');
const resTemporal = await searchTemporal.execute({ query: '*', scope: 'compacted_current_session', temporal: 'recent_7d', limit: 1 }, { sessionId: 's8' });
check('8.temporal 过滤后 hasMore 不误报', resTemporal.ok === true && resTemporal.count === 1 && resTemporal.hits[0].id === 'T-recent' && resTemporal.hasMore === false, JSON.stringify({ ids: resTemporal.hits.map((h) => h.id), hasMore: resTemporal.hasMore }));

// ═══════════════════════════════════════════════════════════════
section('门禁 9 · apply() → pre-step 端到端（配置/0 卡反例）');
// ═══════════════════════════════════════════════════════════════
function e2eSession() {
  return new FakeSession('s-e2e', [
    userEvent(0, 'e2e-m0', '旧事'),
    assistantEvent(1, 'e2e-m1', '旧答'),
    summaryEvent(2, 'cmp-e2e', { start: 0, end: 1 }, [0, 1]),
    checkpointEvent(3, 'cmp-e2e', { start: 0, end: 1 }, 2, [0, 1]),
  ]);
}
function e2eCard(id, ids) {
  return {
    id, title: '压缩回忆 ' + id, summary: '摘要', content: '内容',
    createdAt: Date.now() - 1000, sessionId: 's-e2e', source_message_ids: ids.slice(),
  };
}
async function runHintE2E(cards, extraConfig) {
  const sess = e2eSession();
  const ctx = makeApplyCtx(sess);
  let applied = null;
  try {
    applied = applyPlugin(ctx, Object.assign({
      __resetMerge: true,
      enabled: true,
      prefetchEnabled: true,
      logs: { dir: join(TMP, 'logs') },
      retrieval: {
        enabled: true,
        cardsProvider: () => cards,
        tdaiEnabled: false,
        ingestEnabled: false,
        l0Enabled: false,
        aliasEnabled: false,
      },
    }, extraConfig || {}));
  } catch (e) {
    return { text: '', error: String(e && e.message || e) };
  }
  // 等异步 warmup（createRetriever 是 void warmup）
  await new Promise((resolve) => setTimeout(resolve, 500));
  const pre = (ctx.registered.events.get('agent/pre-step') || [])[0];
  if (!pre) return { text: '', error: 'no-pre-step' };
  const decision = await pre({ agent: { session: { id: sess.id } }, messages: [] }, async () => ({ kind: 'accept', messages: [] }));
  const text = ((decision && decision.messages) || [])
    .filter((m) => m && m.source && m.source.kind === 'plugin:unified-memory')
    .map((m) => String((m.content && m.content[0] && m.content[0].text) || ''))
    .join('\n');
  for (const h of (ctx.registered.events.get('agent/turn-stopping') || [])) {
    try { h({ agent: { session: { id: sess.id } } }); } catch {}
  }
  try { if (typeof applied === 'function') applied(); } catch {}
  return { text, error: '' };
}
const e2eFull = await runHintE2E([e2eCard('e2e-full', ['e2e-m0', 'e2e-m1'])], {});
check('9.真实 apply/pre-step 能发轻提示', e2eFull.text.includes('<compacted-recall-hint') && e2eFull.text.includes('cmp-e2e'), e2eFull.error || e2eFull.text.slice(0, 140));
check('9.真实 apply/pre-step 能产出 B 层块', e2eFull.text.includes('<compacted-session-recall compaction="cmp-e2e">'), e2eFull.text.slice(0, 180));
const e2eBoff = await runHintE2E([e2eCard('e2e-full', ['e2e-m0', 'e2e-m1'])], { compactedRecall: { bLayer: false } });
check('9.compactedRecall.bLayer:false 时不产出 B 块', !e2eBoff.text.includes('<compacted-session-recall'), e2eBoff.error || e2eBoff.text.slice(0, 100));
const e2eOff = await runHintE2E([e2eCard('e2e-full', ['e2e-m0', 'e2e-m1'])], { prefetchEnabled: false });
check('9.prefetchEnabled:false 时不发提示', !e2eOff.text.includes('<compacted-recall-hint'), e2eOff.error || e2eOff.text.slice(0, 100));
const e2eSwitch = await runHintE2E([e2eCard('e2e-full', ['e2e-m0', 'e2e-m1'])], { compactedRecall: { enabled: false } });
check('9.compactedRecall.enabled:false 时不发提示', !e2eSwitch.text.includes('<compacted-recall-hint'), e2eSwitch.error || e2eSwitch.text.slice(0, 100));
const e2eHintSwitch = await runHintE2E([e2eCard('e2e-full', ['e2e-m0', 'e2e-m1'])], { compactedRecall: { hintOnCompact: false } });
check('9.compactedRecall.hintOnCompact:false 时不发提示', !e2eHintSwitch.text.includes('<compacted-recall-hint'), e2eHintSwitch.error || e2eHintSwitch.text.slice(0, 100));
const e2eZero = await runHintE2E([e2eCard('e2e-unknown', ['e2e-not-in-log'])], {});
check('9.0 张 fullyCompacted 卡时不发提示', !e2eZero.text.includes('<compacted-recall-hint'), e2eZero.error || e2eZero.text.slice(0, 100));

// 既有门禁回归（子进程跑真实文件）
for (const rel of ['selftest-tool-schema.mjs', 'selftest-memory-search-paging.mjs']) {
  let ok = false;
  let detail = '';
  try {
    execFileSync(process.execPath, [rel], { cwd: TESTS_DIR, stdio: 'pipe', timeout: 180000 });
    ok = true;
  } catch (e) {
    detail = 'exit=' + String(e && e.status) + ' ' + String(e && e.stderr ? String(e.stderr).slice(0, 200) : '');
  }
  check('8.既有门禁不退化：' + rel, ok, detail);
}

// ═══════════════════════════════════════════════════════════════
console.log('\n════ compacted-recall 阶段 1 门禁汇总 ════');
console.log('checks=' + (pass + fail) + ' passed=' + pass + ' failed=' + fail);
if (fail > 0) {
  console.log('\n失败项：');
  for (const f of failures) console.log('  - ' + f);
} else {
  console.log('全部通过 ✅');
}
try { rmSync(TMP, { recursive: true, force: true }); } catch {}
process.exit(fail > 0 ? 1 : 0);
