/**
 * lib/retrieval/tools.js —— 对话层主动记忆工具集
 * [2026-10-25 by Assistant · 红白双队终裁指令]
 *
 * 彻底打通记忆系统"地下算法"与"对话交互（Agentic Loop）"的最后一公里：
 *   ① memory_search —— 主动深挖历史记忆（防回音室、硬上限10条、支持时间范围）
 *   ② memory_get    —— 调取卡片完整未截断的正文与全量元数据
 *   ③ memory_refute —— 当面推翻错误记忆并破旧立新（0.15x降权 + replacementFact直接立新基石卡）
 *
 * 铁律：
 *   - 遵守 DSH ToolDefinition 规范：无外部额外依赖、无损 JSON、严禁输出 undefined / null 破坏 Schema。
 *   - 遵守四路分流写盘：主库 / 自产 / L1 / tdai 严格各归其位，杜绝孤儿数据。
 */
import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { extractEntities } from '../ingest/entities.js';
import { cleanTitle } from '../ingest/title-clean.js';
import { traceSourceSnippets, resolveSourceRef } from './source-tracer.js';
import { dataPath } from '../paths.js';

export const MEMORY_SEARCH = 'memory_search';
export const MEMORY_GET = 'memory_get';
export const MEMORY_REFUTE = 'memory_refute';

const SEARCH_PARAMS = {
  type: 'object',
  additionalProperties: false,
  properties: {
    query: {
      type: 'string',
      description: '精准检索词（请提取核心实体、模块名或报错码，避免传入整句废话，尽量与当前轮已注入的词拉开角度）',
    },
    limit: {
      type: 'integer',
      description: '返回条数上限，默认 5，硬上限 10（防上下文爆炸）',
    },
    temporal: {
      type: 'string',
      enum: ['all', 'recent_7d', 'older_than_7d'],
      description: '时间范围过滤：默认 all；找近期改动用 recent_7d；找陈年老账用 older_than_7d',
    },
  },
  required: ['query'],
};

const SEARCH_OUTPUT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean' },
    query: { type: 'string' },
    count: { type: 'integer' },
    hits: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          summary: { type: 'string' },
          ageDays: { type: 'integer' },
          score: { type: 'number' },
          is_axiom: { type: 'boolean' },
          injected: { type: 'boolean' },
          refuted: { type: 'boolean' },
        },
        required: ['id', 'title', 'summary', 'is_axiom', 'injected', 'refuted'],
      },
    },
  },
  required: ['ok', 'query', 'count', 'hits'],
};

const GET_PARAMS = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: {
      type: 'string',
      description: '目标卡片的精确 ID（如从 <unified-memory> 或 memory_search 中看到的 [id: xxx]）',
    },
    grepSource: {
      type: 'string',
      description: '（可选）在卡片关联的原始会话或原始记录中检索关键词/正则切片，按需调取原始对话现场（万字原始案卷直通电梯）',
    },
  },
  required: ['id'],
};

const GET_OUTPUT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean' },
    id: { type: 'string' },
    title: { type: 'string' },
    summary: { type: 'string' },
    content: { type: 'string' },
    createdAt: { type: 'integer' },
    ageDays: { type: 'integer' },
    importance: { type: 'number' },
    is_axiom: { type: 'boolean' },
    entities: { type: 'array', items: { type: 'string' } },
    refuted: { type: 'boolean' },
    refute_by: { type: 'array', items: { type: 'string' } },
    sourceSessionId: { type: 'string' },
    sourceSnippets: { type: 'array', items: { type: 'string' } },
    sourceTrace: {
      type: 'object',
      additionalProperties: false,
      properties: {
        status: {
          type: 'string',
          enum: ['hit', 'no_match', 'no_session_id', 'not_found', 'backend_error', 'timeout'],
        },
        sessionId: { type: 'string' },
        backend: { type: 'string' },
        matches: { type: 'integer' },
        elapsedMs: { type: 'integer' },
        source_trace_ms: { type: 'integer' },
        truncated: { type: 'boolean' },
        candidateTruncated: { type: 'boolean' },
        channelAError: { type: 'string' },
        error: { type: 'string' },
      },
      required: ['status', 'matches', 'elapsedMs', 'source_trace_ms', 'truncated'],
    },
    reason: { type: 'string' },
  },
  required: ['ok'],
};

const REFUTE_PARAMS = {
  type: 'object',
  additionalProperties: false,
  properties: {
    cardId: {
      type: 'string',
      description: '需要被推翻的错误卡片 ID（单卡模式，与 cardIds 二选一）',
    },
    cardIds: {
      type: 'array',
      items: { type: 'string' },
      description: '需要被批量推翻的错误卡片 ID 列表（一石多鸟批量模式）',
    },
    reason: {
      type: 'string',
      description: '简述推翻原因（如："Windows 32位探针溢出误报，实际非4G"）',
    },
    replacementFact: {
      type: 'string',
      description: '（推荐填写）用户纠正后的正确事实陈述。若库内已有高度匹配基石卡则自动复用并加权，否则建立唯一定论基石卡',
    },
  },
  required: ['reason'],
};

const REFUTE_OUTPUT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean' },
    cardId: { type: 'string' },
    cardIds: { type: 'array', items: { type: 'string' } },
    refutedCount: { type: 'integer' },
    refuted: { type: 'boolean' },
    replacementCardId: { type: 'string' },
    isReusedCard: { type: 'boolean' },
    note: { type: 'string' },
    reason: { type: 'string' },
  },
  required: ['ok'],
};

const D_MS = 86400000;
const MAIN_FILE = dataPath('engram-relay/engrams.jsonl');
const OWN_FILE = dataPath('ingest/engrams.jsonl');
const L1_DIR = dataPath('ingest/records');
const TDAI_DIR = dataPath('memory-tencentdb/memory-tdai/records');

function resolveCardTargetFile(card) {
  const id = String(card && card.id || '');
  if (id.startsWith('pmi:')) return OWN_FILE;
  const d = Number(card && card.createdAt) || Date.now();
  const dt = new Date(d);
  const p = dt.getFullYear() + '-' + String(dt.getMonth() + 1).padStart(2, '0') + '-' + String(dt.getDate()).padStart(2, '0') + '.jsonl';
  if (id.startsWith('pm:')) return L1_DIR + '/' + p;
  if (id.startsWith('tdai:')) return TDAI_DIR + '/' + p;
  return MAIN_FILE;
}

function persistCardAppend(card, file) {
  try {
    const dir = file.replace(/[/\\][^/\\]+$/, '');
    if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
    appendFileSync(file, JSON.stringify(card) + '\n', 'utf8');
    return true;
  } catch {
    return false;
  }
}

export function createMemoryTools({ retriever, cardMap, prefetcher, getSessionId, logger } = {}) {
  const sessionRefutedIds = new Set();
  const sessionCardsCache = new Map();
  const sessionFactAxiomCache = new Map();

  function getCardFromSources(id) {
    const sid = String(id || '');
    if (!sid) return null;
    if (sessionCardsCache.has(sid)) return sessionCardsCache.get(sid);
    let card = null;
    if (cardMap) {
      if (typeof cardMap.get === 'function') card = cardMap.get(sid);
      else if (typeof cardMap === 'function') {
        const m = cardMap();
        if (m && typeof m.get === 'function') card = m.get(sid);
      }
    }
    if (!card && retriever && typeof retriever.getCard === 'function') {
      try { card = retriever.getCard(sid); } catch {}
    }
    return card || null;
  }

  // ① memory_search
  const searchTool = {
    name: MEMORY_SEARCH,
    description: '【主动深挖历史记忆】仅当 <unified-memory> 被动切片不足以回答、用户明确要求盘点过往记录（如\'查查上月关于某事的所有记录\'）、或需跨关键词排查历史经验时调用。严禁在普通寒暄或被动记忆已足够时滥用。单次调用后请直接基于结果作答。',
    parameters: SEARCH_PARAMS,
    output: {
      schema: SEARCH_OUTPUT,
      render: (_a, v) => [{
        type: 'text',
        text: v.ok
          ? ('检索到 ' + v.count + ' 条记忆：' + (v.hits || []).map(h => '[' + h.id + '] ' + h.title).join('；'))
          : '记忆检索未找到相关内容。',
      }],
    },
    async execute(args) {
      const a = args || {};
      const q = String(a.query || '').trim();
      if (!q || !retriever || typeof retriever.search !== 'function') {
        return { ok: true, query: q, count: 0, hits: [] };
      }
      const limit = Math.min(10, Math.max(1, Number(a.limit) || 5));
      const temporal = a.temporal || 'all';
      const sessId = (getSessionId && getSessionId()) || '';
      const injectedIds = new Set((prefetcher && prefetcher.lastInjectedIds && prefetcher.lastInjectedIds(sessId)) || []);

      let rawHits = [];
      try {
        const res = await retriever.search(q, { k: Math.max(20, limit * 2) });
        rawHits = (res && Array.isArray(res.hits)) ? res.hits : [];
      } catch (e) {
        logger?.miss?.({ level: 'tool-memory-search-failed', reason: String(e && e.message || e) });
        return { ok: false, query: q, count: 0, hits: [] };
      }

      const now = Date.now();
      const formatted = [];
      for (const h of rawHits) {
        const id = String(h && h.id || '');
        if (!id) continue;
        const card = getCardFromSources(id) || h;
        const ageDays = card.createdAt ? Math.max(0, Math.round((now - Number(card.createdAt)) / D_MS)) : 0;

        if (temporal === 'recent_7d' && ageDays > 7) continue;
        if (temporal === 'older_than_7d' && ageDays <= 7) continue;

        const isInjected = injectedIds.has(id);
        const isRefuted = Boolean(Array.isArray(card.refute_by) && card.refute_by.length > 0);

        formatted.push({
          id,
          title: String(card.title || h.title || '(无标题)'),
          summary: String(card.summary || h.summary || '').slice(0, 150),
          ageDays,
          score: Number((Number(h.score) || 0).toFixed(4)),
          is_axiom: card.is_axiom === true,
          injected: isInjected,
          refuted: isRefuted,
        });
      }

      // [红队死结3修复] 破除回音室效应：将未注入的增量卡片排在前面，把被动预取未覆盖的新信息提供出来
      formatted.sort((x, y) => {
        if (x.injected !== y.injected) return x.injected ? 1 : -1;
        return y.score - x.score;
      });

      const finalHits = formatted.slice(0, limit);
      return {
        ok: true,
        query: q,
        count: finalHits.length,
        hits: finalHits,
      };
    },
  };

  // ② memory_get
  const getTool = {
    name: MEMORY_GET,
    description: '【调取卡片完整原文】仅当你在 <unified-memory> 或 memory_search 结果中看到了具体的卡片 [id]，且其摘要被截断、需要查看完整未切片的正文/配置细节/上下文来源时调用。严禁盲猜 ID。',
    parameters: GET_PARAMS,
    output: {
      schema: GET_OUTPUT,
      render: (_a, v) => {
        let text = v.ok
          ? ('【' + v.title + '】(' + v.id + ')\n' + v.content)
          : ('查卡失败：' + (v.reason || '未知原因'));
        if (v.sourceTrace) {
          if (v.sourceTrace.status === 'hit' && v.sourceSnippets && v.sourceSnippets.length) {
            text += '\n\n【原始案卷现场检索命中 ' + v.sourceSnippets.length + ' 处 (耗时 ' + v.sourceTrace.elapsedMs + 'ms)】\n' + v.sourceSnippets.join('\n---\n');
          } else {
            text += '\n\n【原始案卷回溯状态: ' + v.sourceTrace.status + (v.sourceTrace.error ? (' - ' + v.sourceTrace.error) : '') + '】';
          }
          if (v.sourceTrace.channelAError) {
            text += '\n【通道 A 提示: ' + v.sourceTrace.channelAError + '】';
          }
          if (v.sourceTrace.candidateTruncated) {
            text += '\n【案卷提示: 候选路径超过 3 个，已截断扫描】';
          }
        }
        return [{ type: 'text', text }];
      },
    },
    async execute(args) {
      const a = args || {};
      const id = String(a.id || '').trim();
      if (!id) return { ok: false, reason: '必须提供卡片 id' };

      const card = getCardFromSources(id);
      if (!card) return { ok: false, reason: '未找到指定 id 的卡片: ' + id };

      const now = Date.now();
      const ageDays = card.createdAt ? Math.max(0, Math.round((now - Number(card.createdAt)) / D_MS)) : 0;
      const isRefuted = Boolean(Array.isArray(card.refute_by) && card.refute_by.length > 0);

      // [红队回溯电梯 · 结构化状态闭环] 若传入 grepSource，按卡片关联会话进行深度原始切片调取
      const grepSource = a.grepSource && typeof a.grepSource === 'string' ? a.grepSource.trim() : '';
      let sourceSnippets = [];
      let sourceTrace = null;

      const sRef = resolveSourceRef(card);
      const sid = sRef.sessionId || '';

      if (grepSource) {
        const traceRes = traceSourceSnippets({
          sessionId: sid,
          grep: grepSource,
          maxSnippets: 3,
          snippetMaxChars: 800,
        });
        sourceSnippets = traceRes.snippets || [];
        const stObj = {
          status: traceRes.status,
          matches: traceRes.matches,
          elapsedMs: traceRes.elapsedMs,
          source_trace_ms: traceRes.elapsedMs,
          truncated: traceRes.truncated || false,
        };
        if (traceRes.sessionId) stObj.sessionId = traceRes.sessionId;
        if (traceRes.backend) stObj.backend = traceRes.backend;
        if (traceRes.candidateTruncated) stObj.candidateTruncated = true;
        if (traceRes.channelAError) stObj.channelAError = traceRes.channelAError;
        if (traceRes.error) stObj.error = traceRes.error;
        sourceTrace = stObj;
      }

      const out = {
        ok: true,
        id: String(card.id),
        title: String(card.title || '(无标题)'),
        summary: String(card.summary || ''),
        content: String(card.content || card.summary || ''),
        createdAt: Math.round(Number(card.createdAt) || now),
        ageDays,
        importance: Number.isFinite(Number(card.importance)) ? Number(card.importance) : 0.25,
        is_axiom: card.is_axiom === true,
        entities: Array.isArray(card.entities) ? card.entities.map(String) : [],
        refuted: isRefuted,
        refute_by: Array.isArray(card.refute_by) ? card.refute_by.map(String) : [],
      };
      if (sid) out.sourceSessionId = sid;
      if (sourceTrace) out.sourceTrace = sourceTrace;
      if (sourceSnippets.length) out.sourceSnippets = sourceSnippets;
      return out;
    },
  };

  // ③ memory_refute
  const refuteTool = {
    name: MEMORY_REFUTE,
    description: '【当面推翻错误记忆并立新】仅当用户明确指出某条历史记忆有误（如参数记错、方案已废除）时调用。调用后旧卡将立刻按 0.15x 权重沉底，同时若提供 replacementFact 将直接写入高优正确事实。同一 cardId 请勿重复调用。',
    parameters: REFUTE_PARAMS,
    output: {
      schema: REFUTE_OUTPUT,
      render: (_a, v) => [{
        type: 'text',
        text: v.ok
          ? ('已成功推翻卡片 ' + v.cardId + '：' + (v.note || '已标记沉底') + (v.replacementCardId ? ('；新事实已立卡：' + v.replacementCardId) : ''))
          : ('推翻失败：' + (v.reason || '未知原因')),
      }],
    },
    async execute(args) {
      const a = args || {};
      const currentSessId = (getSessionId && getSessionId()) || '';
      const reason = String(a.reason || '').trim();
      if (!reason) return { ok: false, reason: '必须提供推翻原因 reason' };

      // [一石多鸟升级] 支持单卡模式 (cardId) 与批量模式 (cardIds)
      const inputIds = Array.isArray(a.cardIds)
        ? a.cardIds.map((x) => String(x || '').trim()).filter(Boolean)
        : (a.cardId ? [String(a.cardId).trim()] : []);
      if (!inputIds.length) return { ok: false, reason: '必须提供 cardId 或 cardIds' };

      // [白队防抖锁] 过滤在当前会话已推翻过的卡片
      const targetIds = inputIds.filter((id) => !sessionRefutedIds.has(id));
      if (!targetIds.length) {
        return {
          ok: true,
          cardId: inputIds[0],
          cardIds: inputIds,
          refuted: true,
          refutedCount: 0,
          note: '目标卡片在本会话中均已推翻过，权重已处于 0.150x 沉底状态，无需重复操作',
        };
      }

      // 获取所有有效目标卡片
      const validCards = [];
      for (const cid of targetIds) {
        const c = getCardFromSources(cid);
        if (c) validCards.push(c);
      }
      if (!validCards.length) return { ok: false, reason: '未找到任何待推翻的目标卡片' };

      let replacementCardId = '';
      let isReusedCard = false;
      const repFact = a.replacementFact && typeof a.replacementFact === 'string' ? a.replacementFact.trim() : '';

      // [抽离事实主语 & 浓度去重] 如果提供了更正事实：
      if (repFact) {
        const normFact = repFact.replace(/\s+/g, '').slice(0, 80);
        if (sessionFactAxiomCache.has(normFact)) {
          // 本会话中已为相同事实建立过基石卡：直接复用其 ID，杜绝重复三胞胎！
          replacementCardId = sessionFactAxiomCache.get(normFact);
          isReusedCard = true;
          const existingCard = getCardFromSources(replacementCardId);
          if (existingCard) {
            const updatedAxiom = Object.assign({}, existingCard, {
              hits: (Number(existingCard.hits) || 0) + validCards.length,
              lastHitAt: Date.now(),
              reinforces: Array.from(new Set([...(existingCard.reinforces || []), ...validCards.map((c) => String(c.id))])),
            });
            const targetFile = resolveCardTargetFile(existingCard);
            persistCardAppend(updatedAxiom, targetFile);
            sessionCardsCache.set(replacementCardId, updatedAxiom);
            if (cardMap && typeof cardMap.set === 'function') cardMap.set(replacementCardId, updatedAxiom);
          }
        } else {
          // 首次遇到该事实定论：建立唯一定论新基石卡（一石多鸟，只建一张）
          replacementCardId = 'pmi:fact_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
          const firstCard = validCards[0];
          const newTitle = cleanTitle ? cleanTitle('事实更正：' + (firstCard.title || '事实')) : ('事实更正：' + (firstCard.title || '事实'));
          let newEntities = [];
          try { newEntities = extractEntities ? extractEntities({ title: newTitle, content: repFact }) : []; } catch {}

          const newCard = {
            id: replacementCardId,
            title: newTitle,
            summary: repFact.slice(0, 100),
            content: repFact,
            status: 'confirmed',
            importance: 0.95,
            is_axiom: true,
            createdAt: Date.now(),
            entities: Array.isArray(newEntities) ? newEntities : [],
            reinforces: validCards.map((c) => String(c.id)),
            hits: validCards.length,
            lastHitAt: Date.now(),
            sessionId: currentSessId || '',
            sessionKey: currentSessId || '',
            source_session_id: currentSessId || '',
          };

          persistCardAppend(newCard, OWN_FILE);
          sessionCardsCache.set(replacementCardId, newCard);
          sessionFactAxiomCache.set(normFact, replacementCardId);
          if (cardMap && typeof cardMap.set === 'function') cardMap.set(replacementCardId, newCard);
        }
      }

      // ② 将所有待推翻旧卡挂上推翻标记，追加写回各自来源文件
      const markId = replacementCardId || ('manual_refute_' + Date.now());
      for (const card of validCards) {
        const cid = String(card.id);
        const curRef = Array.isArray(card.refute_by) ? card.refute_by.slice() : [];
        if (!curRef.includes(markId)) curRef.push(markId);

        // ── [2026-10-27 by Assistant · 第三优先：打破「基石只升不降」单向门] ──
        //   病灶：被推翻的卡虽然检索期乘 0.15x 沉底，但如果它 is_axiom === true，
        //         仍会永久占据"基石"席位（永不衰减 / 永不进冷宫 / 永不计入淘汰）。
        //         而全仓没有任何路径能把 is_axiom 从 true 改回 false ⇒ 单向门。
        //   修法：推翻即摘除公理头衔。语义上完全站得住：
        //         **一张被证伪的事实，不该继续顶着公理身份。**
        //   注意：replacementFact 新建的那张正确事实卡仍设 is_axiom: true（合理，
        //         它本身就是User当面纠正的铁律）；但它下次被推翻时同样会被降级 ⊂ 不再是单向门。
        const wasAxiom = card.is_axiom === true;
        const updatedCard = Object.assign({}, card, {
          refute_by: curRef,
          refute_reason: reason,
          refutedAt: Date.now(),
        });
        if (wasAxiom) {
          updatedCard.is_axiom = false;
          updatedCard.axiomRevokedAt = Date.now();
          updatedCard.axiomRevokedBy = 'memory_refute';
        }

        const targetFile = resolveCardTargetFile(card);
        persistCardAppend(updatedCard, targetFile);

        sessionCardsCache.set(cid, updatedCard);
        if (cardMap && typeof cardMap.set === 'function') cardMap.set(cid, updatedCard);
        sessionRefutedIds.add(cid);
      }

      const out = {
        ok: true,
        cardId: validCards[0].id,
        cardIds: validCards.map((c) => String(c.id)),
        refutedCount: validCards.length,
        refuted: true,
        isReusedCard,
        note: replacementCardId
          ? (isReusedCard
              ? '旧卡已全数沉底，推翻指向已有的权威基石卡（' + replacementCardId + '）并加权，杜绝重复建卡'
              : '旧卡已全数沉底，正确事实已建立唯一定论基石卡并写入基石库')
          : '目标旧卡已全数标记推翻，后续检索中按 0.150x 权重沉底',
      };
      if (replacementCardId) out.replacementCardId = replacementCardId;
      return out;
    },
  };

  return [searchTool, getTool, refuteTool];
}
