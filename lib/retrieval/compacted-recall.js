/**
 * lib/retrieval/compacted-recall.js —— 压缩后回忆（compacted recall）阶段 1 的
 * 事件状态机、四态分类与一次性轻提示门。
 * [2026-11-25 by Assistant · compacted-recall v2.1 阶段 1 施工合同]
 *
 * 本文件只做「契约里写明的那几件事」，不扩展：
 *   ① 仅从 live Session（ctx.sessions.get(sid)）增量读事件，不拿持久化文件冒充；
 *   ② SpanState 绑定 WeakMap<Session, SpanState>，processedSeq 仅在整批解析成功后原子推进；
 *   ③ checkpoint 双条件（surfaceOp.replace 范围一致 AND sourceEventSeqs 含 summarySeq）
 *      + 可选 compactionId 交叉校验，三条同时满足才算 committed；compaction/prune 不计；
 *   ④ 四态分类：fullyCompacted / partial / active / unknown（refuted 单独排除）；
 *   ⑤ <compacted-recall-hint> 一次性提示：从 append-only 事件流重建完整 compactionId，
 *      跨重启去重；进程内 inFlight 防并发双发，失败回合可重试。
 *
 * 铁律：
 *   · 读不到 = 不可用（unavailable），绝不返回空数组冒充「没有压缩」；
 *   · 解析不完整 = 整批回滚（processedSeq 不推进），绝不半推半就；
 *   · 判据只此一份：会话归属一律走 sessionIdOf()，消息 ID 一律取 message.id。
 */
import { createEventSource } from '../dispatch/event-source.js';
import { contentTextOf } from '../inject-fingerprint.js';
import { createBm25Index, searchBm25 } from './bm25.js';
import { createTokenizer } from './tokenize.js';
import { sanitizeInjectionText } from '../working-memory/budget.js';

export const COMPACTED_RECALL_HINT_TAG = 'compacted-recall-hint';
export const COMPACTED_SESSION_RECALL_TAG = 'compacted-session-recall';

/** 新建一份空的 SpanState（每个 live Session 一份）。 */
export function createSpanState() {
  return {
    // 只在整批事件解析成功后推进到 lastEvent.seq + 1
    processedSeq: 0,
    // seq -> { messageId, time, type }（user/message 与 assistant/message）
    seqMeta: new Map(),
    // summarySeq -> { compactionId, shadowedSeqs, shadowedRange }
    pendingSummaries: new Map(),
    // 已确认的压缩记录（按提交顺序）
    committedCompactions: [],
    // 所有已提交压缩遮蔽过的消息 ID
    shadowedMsgIds: new Set(),
    // 从 append-only 事件流里重建出的已提示 compactionId 集合
    hintedCompactionIds: new Set(),
    // [Phase 3] 从 append-only 事件流重建出的已注入 B 块 compactionId 集合
    recalledCompactionIds: new Set(),
  };
}

/** 深复制状态（用于「整批解析成功才提交」的原子语义）。 */
function cloneSpanState(s) {
  return {
    processedSeq: s.processedSeq,
    seqMeta: new Map(s.seqMeta),
    pendingSummaries: new Map(s.pendingSummaries),
    committedCompactions: s.committedCompactions.slice(),
    shadowedMsgIds: new Set(s.shadowedMsgIds),
    hintedCompactionIds: new Set(s.hintedCompactionIds),
    recalledCompactionIds: new Set(s.recalledCompactionIds),
  };
}

/** 把 event.sourceEventSeqs 统一成 number[]（持久化层可能用 [start,end] 区间压缩）。 */
export function normalizeSourceEventSeqs(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const entry of value) {
    if (typeof entry === 'number' && Number.isSafeInteger(entry) && entry >= 0) {
      out.push(entry);
      continue;
    }
    if (Array.isArray(entry) && entry.length === 2) {
      const start = Number(entry[0]);
      const end = Number(entry[1]);
      if (Number.isSafeInteger(start) && Number.isSafeInteger(end) && start >= 0 && end >= start) {
        for (let seq = start; seq <= end; seq++) out.push(seq);
      }
    }
  }
  return out;
}

/** 取事件里的消息对象：user/message 的 data 就是消息；assistant/message 在 data.message。 */
function messageOf(ev) {
  if (!ev || typeof ev !== 'object') return null;
  if (ev.type === 'user/message') {
    if (!ev.data || typeof ev.data !== 'object') return null;
    // 真实形状 data=message；兼容极老版本 data.message
    return ev.data.message && typeof ev.data.message === 'object' && ev.data.id === undefined ? ev.data.message : ev.data;
  }
  if (ev.type === 'assistant/message') {
    if (!ev.data || typeof ev.data !== 'object') return null;
    return ev.data.message && typeof ev.data.message === 'object' ? ev.data.message : ev.data;
  }
  return null;
}

/** 从任意注入块标签里抽取完整 compactionId（单一实现，hint / B 块共用）。 */
export function extractBlockCompactionIds(content, tag) {
  const text = contentTextOf(content);
  const out = [];
  const name = String(tag || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (!text || !name) return out;
  const re = new RegExp('<' + name + '\\b[^>]*\\bcompaction\\s*=\\s*"([^"]+)"', 'g');
  let m;
  while ((m = re.exec(text))) {
    const id = String(m[1] || '').trim();
    if (id) out.push(id);
  }
  return out;
}

/** 从消息 content 里抽取已落盘轻提示的完整 compactionId。 */
export function extractHintCompactionIds(content) {
  return extractBlockCompactionIds(content, COMPACTED_RECALL_HINT_TAG);
}

/** 从消息 content 里抽取已落盘 B 块的完整 compactionId。 */
export function extractCompactedRecallIds(content) {
  return extractBlockCompactionIds(content, COMPACTED_SESSION_RECALL_TAG);
}

/**
 * 把一批事件折叠进 work state。
 * 任何结构异常都 throw —— 调用方整批回滚，processedSeq 不推进。
 */
function applyEvents(work, events) {
  for (const ev of events) {
    if (!ev || typeof ev !== 'object') throw new Error('invalid session event');
    const seq = Number(ev.seq);
    if (!Number.isSafeInteger(seq) || seq < 0) throw new Error('invalid session event seq');

    // ── 消息元数据 + 已落盘提示扫描（append-only 日志重建去重） ──
    const msg = messageOf(ev);
    if (msg) {
      const mid = msg.id !== undefined && msg.id !== null ? String(msg.id) : '';
      if (mid) {
        work.seqMeta.set(seq, {
          messageId: mid,
          time: Number(ev.time) || 0,
          type: ev.type,
        });
      }
      if (ev.type === 'user/message'
        && msg.source
        && String(msg.source.kind || '') === 'plugin:unified-memory') {
        for (const id of extractHintCompactionIds(msg.content)) work.hintedCompactionIds.add(id);
        for (const id of extractCompactedRecallIds(msg.content)) work.recalledCompactionIds.add(id);
      }
    }

    // ── compaction/summary：只登记为 pending，绝不单凭它判 committed ──
    if (ev.type === 'compaction/summary') {
      const d = ev.data || {};
      const cid = d.compactionId !== undefined && d.compactionId !== null ? String(d.compactionId) : '';
      if (!cid) continue;
      const range = d.shadowedRange && typeof d.shadowedRange === 'object' ? d.shadowedRange : {};
      const start = Number(range.start);
      const end = Number(range.end);
      work.pendingSummaries.set(seq, {
        compactionId: cid,
        shadowedSeqs: normalizeSourceEventSeqs(d.shadowedSeqs),
        shadowedRange: {
          start: Number.isSafeInteger(start) ? start : -1,
          end: Number.isSafeInteger(end) ? end : -1,
        },
      });
      continue;
    }

    // ── compaction/prune 不计入（契约明确排除） ──
    if (ev.type === 'compaction/prune') continue;

    // ── checkpoint 双条件硬核验（AND，禁止 OR） ──
    if (ev.type === 'user/message' && ev.surfaceOp && ev.surfaceOp.op === 'replace') {
      const op = ev.surfaceOp;
      const srcList = normalizeSourceEventSeqs(ev.sourceEventSeqs);
      const cpId = msg && msg.source && msg.source.compactionId !== undefined && msg.source.compactionId !== null
        ? String(msg.source.compactionId)
        : '';
      for (const [summarySeq, pending] of work.pendingSummaries) {
        const rangeOk = op.startSeq === pending.shadowedRange.start && op.endSeq === pending.shadowedRange.end;
        const sourceOk = srcList.includes(summarySeq);
        const idOk = !cpId || cpId === pending.compactionId;
        if (!rangeOk || !sourceOk || !idOk) continue;

        const shadowedIds = [];
        let startMs = 0;
        for (const sq of pending.shadowedSeqs) {
          const meta = work.seqMeta.get(sq);
          if (!meta || !meta.messageId) continue;
          shadowedIds.push(meta.messageId);
          if (!startMs || (meta.time && meta.time < startMs)) startMs = meta.time || startMs;
        }
        work.committedCompactions.push({
          compactionId: pending.compactionId,
          summarySeq,
          checkpointSeq: seq,
          startSeq: pending.shadowedRange.start,
          endSeq: pending.shadowedRange.end,
          startMs,
          cutoffMs: Number(ev.time) || 0,
        });
        for (const mid of shadowedIds) work.shadowedMsgIds.add(mid);
        work.pendingSummaries.delete(summarySeq);
        break;
      }
    }
  }
}

/**
 * 四态分类。阶段 1 只收 fullyCompacted。
 * @param {Array} cards
 * @param {object} spanState
 * @returns {Array<{card:object, cls:'fullyCompacted'|'partial'|'active'|'unknown'|'refuted', shadowedCount:number, total:number}>}
 */
export function classifyCards(cards, spanState) {
  const list = Array.isArray(cards) ? cards : [];
  const state = spanState || {};
  const known = new Set();
  if (state.seqMeta && typeof state.seqMeta.values === 'function') {
    for (const meta of state.seqMeta.values()) {
      if (meta && meta.messageId) known.add(String(meta.messageId));
    }
  }
  const shadowed = state.shadowedMsgIds instanceof Set ? state.shadowedMsgIds : new Set();
  return list.map(function (card) {
    const ids = Array.isArray(card && card.source_message_ids)
      ? card.source_message_ids.map(String).map((x) => x.trim()).filter(Boolean)
      : [];
    const status = String((card && card.status) || '');
    const refuted = status === 'refuted' || Boolean(card && Array.isArray(card.refute_by) && card.refute_by.length);
    if (refuted) return { card, cls: 'refuted', shadowedCount: 0, total: ids.length };
    if (ids.length === 0) return { card, cls: 'unknown', shadowedCount: 0, total: 0 };
    const unresolved = ids.filter((id) => !known.has(id));
    if (unresolved.length > 0) return { card, cls: 'unknown', shadowedCount: 0, total: ids.length };
    const shadowedCount = ids.filter((id) => shadowed.has(id)).length;
    let cls = 'active';
    if (shadowedCount === ids.length) cls = 'fullyCompacted';
    else if (shadowedCount > 0) cls = 'partial';
    return { card, cls, shadowedCount, total: ids.length };
  });
}

/**
 * 统一时间戳解析：兼容数字毫秒与 ISO 字符串。
 * 返回 0 表示不可解析（调用方按 0/未知处理，绝不产生 NaN 击穿 schema）。
 */
export function parseTsMs(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return 0;
    const asNum = Number(trimmed);
    if (Number.isFinite(asNum) && asNum > 0) return asNum;
    const parsed = Date.parse(trimmed);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return 0;
}

/**
 * [Phase 2 · L0 兜底] 把 engram 卡与 L0 轮次卡合成为压缩回忆池。
 *
 * 去重口径：先算 engram 已覆盖的消息 ID 集合，L0 轮次只有在「整轮都被压缩阴影覆盖」
 * 且至少有一条消息 ID 尚未被 engram 覆盖时才下发 —— 严格按未覆盖消息 ID 集合计算，
 * 不用标题/时间兜底，避免 L0 原文与精炼卡重复占位。
 *
 * @param {Array} engramCards 当前会话 engram 卡
 * @param {Array} l0Cards 当前会话 L0 轮次卡
 * @param {object} spanState
 * @returns {{engram:Array, l0:Array, pool:Array}}
 */
export function selectCompactedPool(engramCards, l0Cards, spanState) {
  const engramClassified = classifyCards(engramCards, spanState);
  const engram = engramClassified.filter((x) => x.cls === 'fullyCompacted').map((x) => x.card);
  const covered = new Set();
  for (const item of engramClassified) {
    if (!item || item.cls === 'refuted') continue;
    const ids = Array.isArray(item.card && item.card.source_message_ids) ? item.card.source_message_ids : [];
    for (const id of ids) { const s = String(id || '').trim(); if (s) covered.add(s); }
  }
  const l0 = classifyCards(l0Cards, spanState)
    .filter((x) => x.cls === 'fullyCompacted')
    .map((x) => x.card)
    .filter((card) => {
      const ids = Array.isArray(card && card.source_message_ids)
        ? card.source_message_ids.map(String).map((x) => x.trim()).filter(Boolean)
        : [];
      if (!ids.length) return false;
      // 至少一条消息未被 engram 覆盖，才算「未覆盖消息 ID 集合」里的 L0 兜底；
      // 全被覆盖 = 与 engram 重复，丢弃。
      return ids.some((id) => !covered.has(id));
    });
  return { engram, l0, pool: engram.concat(l0) };
}

/**
 * 在给定卡池里检索（阶段 1 的压缩池搜索）。
 * query === '*' 才表示浏览（按 createdAt 倒序）；空 query 由工具层拦下，这里绝不把空串当浏览。
 * 返回 { total, hits:[{id,score}] }，不做空表伪装。
 */
export function searchCardPool(cards, query, opts) {
  const o = opts || {};
  const list = (Array.isArray(cards) ? cards : []).filter((c) => c && c.id !== undefined && c.id !== null);
  const excludeIds = new Set((Array.isArray(o.excludeIds) ? o.excludeIds : []).map(String));
  const q = String(query === undefined || query === null ? '' : query).trim();
  let pairs = [];
  if (q === '*') {
    const sorted = list.slice().sort(function (a, b) {
      const ta = parseTsMs(a.createdAt);
      const tb = parseTsMs(b.createdAt);
      if (tb !== ta) return tb - ta;
      return String(a.id).localeCompare(String(b.id));
    });
    // 浏览模式给干净的顺序分，绝不把 13 位毫秒时间戳外露成 score
    pairs = sorted.map(function (c, i) {
      const score = Number((1 - i / Math.max(1, sorted.length)).toFixed(4));
      return [String(c.id), score];
    });
  } else if (q === '') {
    pairs = [];
  } else {
    try {
      const tok = createTokenizer({ mode: 'bigram' });
      const idx = createBm25Index(list, tok);
      pairs = searchBm25(idx, q, undefined);
    } catch {
      pairs = [];
    }
  }
  const filtered = pairs.filter((p) => !excludeIds.has(String(p[0])));
  const limit = Math.max(1, Math.min(100, Number(o.k) || 10));
  return {
    total: filtered.length,
    hits: filtered.slice(0, limit).map(function (p) {
      return { id: String(p[0]), score: Number(p[1]) || 0 };
    }),
  };
}

/** 一次性轻提示正文；完整 compactionId 必须落在标签属性里，供跨重启重建。 */
export function buildRecallHint(compactionId) {
  const id = String(compactionId || '').replace(/"/g, '');
  return '<' + COMPACTED_RECALL_HINT_TAG + ' compaction="' + id + '">' + '\n'
    + '（本会话更早的内容已被压缩。需要回忆被压缩段落时，可调用 memory_search：'
    + 'scope="compacted_current_session"，query="*" 浏览，或 query="关键词" 检索。）' + '\n'
    + '</' + COMPACTED_RECALL_HINT_TAG + '>';
}

/**
 * [Phase 3 · B 层] 构造 <compacted-session-recall> 块。
 * 内容全部过 sanitizeInjectionText，防卡标题/摘要伪造闭合标签提前截断。
 */
export function buildCompactedRecallBlock(compactionId, items) {
  const id = String(compactionId || '').replace(/"/g, '');
  const list = Array.isArray(items) ? items : [];
  const lines = [];
  for (const item of list) {
    if (!item) continue;
    const cardId = String(item.id || '').trim();
    if (!cardId) continue;
    const title = sanitizeInjectionText(String(item.title || ''));
    const summary = sanitizeInjectionText(String(item.summary || '')).slice(0, 160);
    let line = '- [' + cardId + '] ' + (title || '(无标题)');
    if (summary) line += '：' + summary;
    lines.push(line);
    if (lines.length >= 5) break;
  }
  if (!lines.length) return '';
  return '<' + COMPACTED_SESSION_RECALL_TAG + ' compaction="' + id + '">' + '\n'
    + '（以下是从本会话已压缩历史自动召回的相关内容；需要全文可用 memory_get 按 id 调取。）' + '\n'
    + lines.join('\n') + '\n'
    + '</' + COMPACTED_SESSION_RECALL_TAG + '>';
}

/**
 * 创建压缩追踪器。
 * @param {{getSessions:()=>any, logger?:object}} deps
 */
export function createCompactionTracker(deps) {
  const d = deps || {};
  const log = d.logger || null;
  const states = new WeakMap();
  // 进程内并发占位：sid:compactionId —— 只在 pre-step 决定落盘后加入，
  // turn-stopping / 异常退出时释放，失败回合允许下次重试。
  const inFlightHintKeys = new Set();
  // [Phase 3 · B 层] 与 hint 分开的并发占位，避免两套注入互相顶掉重试机会
  const inFlightRecallKeys = new Set();
  // [P1 修复] deprecated API 只记一次，别让高活跃会话把 wake.log 刷爆
  let deprecatedLogged = false;
  function makeEventLogger() {
    if (!log) return null;
    return {
      wake(ev) {
        try {
          if (ev && ev.level === 'dispatch-events-deprecated-api') {
            if (deprecatedLogged) return;
            deprecatedLogged = true;
          }
          if (typeof log.wake === 'function') log.wake(ev);
        } catch {}
      },
      miss(ev) {
        try { if (typeof log.miss === 'function') log.miss(ev); } catch {}
      },
    };
  }

  function getSessionsService() {
    try { return typeof d.getSessions === 'function' ? d.getSessions() : null; } catch { return null; }
  }

  function getLiveSession(sid) {
    const sessions = getSessionsService();
    if (!sessions || typeof sessions.get !== 'function') return null;
    let s = null;
    try { s = sessions.get(String(sid)); } catch { s = null; }
    if (!s || typeof s.snapshotEvents !== 'function') return null;
    return s;
  }

  function stateOf(session) {
    let st = states.get(session);
    if (!st) { st = createSpanState(); states.set(session, st); }
    return st;
  }

  /**
   * 增量同步一个会话的 SpanState。
   * @returns {Promise<{ok:true,state:object,session:object}|{ok:false,unavailable:true,reason:string}>}
   */
  async function syncSession(sessionId) {
    const sid = String(sessionId || '');
    if (!sid) return { ok: false, unavailable: true, reason: 'missing-session-context' };
    const session = getLiveSession(sid);
    if (!session) return { ok: false, unavailable: true, reason: 'session-not-live' };
    const base = stateOf(session);
    // [P1 修复] 没有新增事件时直接早退，避免每个 pre-step 都穿透到 deprecated API 日志
    try {
      const seqNow = Number(session.seq);
      if (Number.isSafeInteger(seqNow) && seqNow <= base.processedSeq) {
        return { ok: true, state: base, session };
      }
    } catch {}
    const source = createEventSource({
      getSessions: getSessionsService,
      // 契约：阶段 1 只查 live Session；持久化文件可能滞后，绝不拿它冒充「未压缩」
      getPersistence: () => null,
      // [P1 修复] deprecated API 只记一次，别让高活跃会话把 wake.log 刷爆
      logger: makeEventLogger(),
    });
    let res;
    try {
      res = await source.readAll(sid, { eventCountBefore: base.processedSeq });
    } catch (e) {
      try { log && log.miss && log.miss({ level: 'compacted-recall-read-all', reason: String(e && e.message || e) }); } catch {}
      return { ok: false, unavailable: true, reason: 'session-events-unreadable' };
    }
    if (!res || res.ok !== true) return { ok: false, unavailable: true, reason: 'session-events-unreadable' };
    if (!Array.isArray(res.events)) return { ok: false, unavailable: true, reason: 'session-events-unreadable' };
    const events = res.events;
    if (events.length === 0) return { ok: true, state: base, session };
    try {
      // [P1 修复] 先校验整批事件再筛：畸形 null/缺 seq/非数字 seq 必须整批回滚，
      //   绝不能被 filter 静默过滤后当成 ok:true 返回。
      for (const ev of events) {
        if (!ev || typeof ev !== 'object') throw new Error('invalid session event');
        const seq = Number(ev.seq);
        if (!Number.isSafeInteger(seq) || seq < 0) throw new Error('invalid session event seq');
      }
      const work = cloneSpanState(base);
      const fresh = events.filter((ev) => Number(ev.seq) >= base.processedSeq);
      if (fresh.length === 0) return { ok: true, state: base, session };
      applyEvents(work, fresh);
      // 整批解析成功后才原子提交
      base.seqMeta = work.seqMeta;
      base.pendingSummaries = work.pendingSummaries;
      base.committedCompactions = work.committedCompactions;
      base.shadowedMsgIds = work.shadowedMsgIds;
      base.hintedCompactionIds = work.hintedCompactionIds;
      base.recalledCompactionIds = work.recalledCompactionIds;
      base.processedSeq = Number(fresh[fresh.length - 1].seq) + 1;
    } catch (e) {
      try { log && log.miss && log.miss({ level: 'compacted-recall-parse', reason: String(e && e.message || e) }); } catch {}
      return { ok: false, unavailable: true, reason: 'session-events-unreadable' };
    }
    return { ok: true, state: base, session };
  }

  function getState(sessionId) {
    const session = getLiveSession(sessionId);
    return session ? (states.get(session) || null) : null;
  }

  function latestCommitted(state) {
    const arr = state && Array.isArray(state.committedCompactions) ? state.committedCompactions : [];
    return arr.length ? arr[arr.length - 1] : null;
  }

  function hintKey(sid, compactionId) {
    return String(sid || '') + ':' + String(compactionId || '');
  }

  /** 决定本次 pre-step 是否要发提示；不发时给出原因（便于测试与排查）。 */
  function shouldEmitHint(sessionId, state, messages) {
    const sid = String(sessionId || '');
    const latest = latestCommitted(state);
    if (!latest) return { emit: false, reason: 'no-committed-compaction' };
    const cid = String(latest.compactionId || '');
    if (!cid) return { emit: false, reason: 'no-compaction-id' };
    if (state.hintedCompactionIds && state.hintedCompactionIds.has(cid)) {
      return { emit: false, reason: 'already-hinted', compactionId: cid };
    }
    if (inFlightHintKeys.has(hintKey(sid, cid))) {
      return { emit: false, reason: 'in-flight', compactionId: cid };
    }
    const list = Array.isArray(messages) ? messages : [];
    for (const m of list) {
      const text = contentTextOf(m && m.content);
      if (text.includes('<' + COMPACTED_RECALL_HINT_TAG) && text.includes('compaction="' + cid + '"')) {
        return { emit: false, reason: 'already-in-messages', compactionId: cid };
      }
    }
    return { emit: true, compactionId: cid };
  }

  function beginHint(sessionId, compactionId) {
    inFlightHintKeys.add(hintKey(sessionId, compactionId));
  }

  function releaseHint(sessionId, compactionId) {
    if (compactionId === undefined) {
      const prefix = String(sessionId || '') + ':';
      for (const key of Array.from(inFlightHintKeys)) {
        if (String(key).startsWith(prefix)) inFlightHintKeys.delete(key);
      }
      return;
    }
    inFlightHintKeys.delete(hintKey(sessionId, compactionId));
  }

  /** [Phase 3] 决定本次 pre-step 是否要注入 B 块（同一 compactionId 严格一次）。 */
  function shouldEmitRecall(sessionId, state, messages) {
    const sid = String(sessionId || '');
    const latest = latestCommitted(state);
    if (!latest) return { emit: false, reason: 'no-committed-compaction' };
    const cid = String(latest.compactionId || '');
    if (!cid) return { emit: false, reason: 'no-compaction-id' };
    if (state.recalledCompactionIds && state.recalledCompactionIds.has(cid)) {
      return { emit: false, reason: 'already-recalled', compactionId: cid };
    }
    if (inFlightRecallKeys.has(hintKey(sid, cid))) {
      return { emit: false, reason: 'in-flight', compactionId: cid };
    }
    const list = Array.isArray(messages) ? messages : [];
    for (const m of list) {
      const text = contentTextOf(m && m.content);
      if (text.includes('<' + COMPACTED_SESSION_RECALL_TAG) && text.includes('compaction="' + cid + '"')) {
        return { emit: false, reason: 'already-in-messages', compactionId: cid };
      }
    }
    return { emit: true, compactionId: cid };
  }

  function beginRecall(sessionId, compactionId) {
    inFlightRecallKeys.add(hintKey(sessionId, compactionId));
  }

  function releaseRecall(sessionId, compactionId) {
    if (compactionId === undefined) {
      const prefix = String(sessionId || '') + ':';
      for (const key of Array.from(inFlightRecallKeys)) {
        if (String(key).startsWith(prefix)) inFlightRecallKeys.delete(key);
      }
      return;
    }
    inFlightRecallKeys.delete(hintKey(sessionId, compactionId));
  }

  function inFlightCount() { return inFlightHintKeys.size + inFlightRecallKeys.size; }

  return {
    syncSession,
    getState,
    latestCommitted,
    shouldEmitHint,
    beginHint,
    releaseHint,
    shouldEmitRecall,
    beginRecall,
    releaseRecall,
    inFlightCount,
  };
}

export default {
  COMPACTED_RECALL_HINT_TAG,
  COMPACTED_SESSION_RECALL_TAG,
  createSpanState,
  createCompactionTracker,
  classifyCards,
  selectCompactedPool,
  searchCardPool,
  buildRecallHint,
  buildCompactedRecallBlock,
  extractHintCompactionIds,
  extractCompactedRecallIds,
  extractBlockCompactionIds,
  normalizeSourceEventSeqs,
  parseTsMs,
};
