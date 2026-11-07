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
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { extractEntities } from '../ingest/entities.js';
import { cleanTitle } from '../ingest/title-clean.js';
import { traceSourceSnippets, resolveSourceRef } from './source-tracer.js';
import { dataPath } from '../paths.js';
// [2026-11-06 · 红队 P0-2] 统一的 id→磁盘文件定位器（fail-closed，绝不投影整卡覆盖）
import { locateCard, toRawId, withCardLock } from '../memory/card-locator.js';
// [2026-11-04] 故障记账（核心路径不许静默吞异常）
import { recordFault } from '../faults.js';

// ── [2026-11-04 by Assistant · 红队风险2 观测] ──
//   把「某档位的卡被点开」记进 wake.log，供事后算各档位点开率。
//   只追加写，失败不阻断（但会 recordFault，不静默）。
function logTierOpen(tier, cardId, sessionId) {
  try {
    const dir = dataPath('logs');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const line = JSON.stringify({
      t: new Date().toISOString(),
      level: 'l0-tier-open',
      tier: String(tier),
      cardId: String(cardId),
      sessionId: String(sessionId || '').slice(0, 40),
    });
    appendFileSync(dir + '/wake.log', line + '\n', 'utf8');
  } catch (e) { recordFault('tools', 'tier-open-append', e); }
}

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
      description: '本组返回条数（默认 5）。要盘点/列出完整清单时可调到 30；硬上限 30（防上下文爆炸）',
    },
    page: {
      type: 'integer',
      description: '分页组号：1=30条、2=20条、3及以后=10条。上一组没覆盖全就加 1 再调一次，插件会自动跳过已返回的卡、不会重复。',
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
    // [2026-11-06 by Assistant · User「让 LLM 自己判」] 分页信号：还有没有下一组
    hasMore: { type: 'boolean' },
    page: { type: 'integer' },
    nextPageSize: { type: 'integer' },
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
    // [2026-11-06 · 红队 P1-2] 原话/原文追溯默认**按需**：只有显式 grepSource 或
    //   includeSource:true 才展开，不再因为卡里有 message_ids 就自动把整窗原文塞回来。
    includeSource: {
      type: 'boolean',
      description: '（可选）设为 true 时按卡片 source_message_ids 主动展开原文片段；默认不动（按需回溯）',
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
    verbatim: { type: 'string', description: '内联原话片段；与卡片 content 分开返回，不拼接进正文' },
    createdAt: { type: 'integer' },
    ageDays: { type: 'integer' },
    importance: { type: 'number' },
    is_axiom: { type: 'boolean' },
    entities: { type: 'array', items: { type: 'string' } },
    refuted: { type: 'boolean' },
    refute_by: { type: 'array', items: { type: 'string' } },
    sourceSessionId: { type: 'string' },
    sourceSnippets: { type: 'array', items: { type: 'string' } },
    // [2026-11-04 by Assistant] 主动读取记账字段（User定义「被使用」= memory_get）
    //   不声明会被 schema 校验拦掉：「value.hits is not allowed」
    hits: { type: 'integer', description: '本次读取后的累计使用次数（hits）' },
    touched: { type: 'boolean', description: '是否已记账（hits+1 + lastHitAt 重置）' },
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
        // [2026-11-06 · 红队 P1-2] 原文完整性：请求数 / 命中数 / 缺失数（部分缺失不再假 ok）
        requested: { type: 'integer' },
        found: { type: 'integer' },
        missing: { type: 'integer' },
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
    partial: { type: 'boolean', description: '部分成功：部分目标卡写盘失败' },
    failedCount: { type: 'integer', description: '写盘失败的目标卡数' },
    details: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { id: { type: 'string' }, ok: { type: 'boolean' }, error: { type: 'string' } }, required: ['id', 'ok'] } },
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

/**
 * [2026-11-05 by Assistant · 红队 P0-1] 从文件里取某 id 的最新一行（LWW 语义）。
 *
 * 事故背景：此前 tools.js:286 调用了本函数却**既没定义也没 import**，
 * ReferenceError 被下方的 `catch {}` 静默吞掉 ⇒ 「写前读盘防竞态」从未生效。
 * 现补齐本地实现（与 scoring/adoption.js:121 同口径，不跨模块引入以避循环依赖）。
 */
function readLatestLine(file, id) {
  try {
    if (!file || !existsSync(file)) return null;
    // [红队 P0-2] 必须用 canon id 比较：检索层是 pm:/pmi:/tdai: 前缀，磁盘原文不带。
    const want = toRawId(id);
    let last = null;
    for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
      if (!line) continue;
      let o; try { o = JSON.parse(line); } catch { continue; }
      if (o && toRawId(o.id) === want) last = o;
    }
    return last;
  } catch { return null; }
}

/**
 * [2026-11-05 by Assistant · 红队 P0-1 根因] 回写前的 read-merge-write。
 *
 * 事故：266 张 pm 卡丢了 type/priority/scene_name/metadata/timestamps 等 10 个字段。
 * 根因：`card` 是检索层构造的**投影对象**（source.js 只挑检索需要的字段），
 *       直接 appendFileSync(JSON.stringify(card)) = 用投影覆盖磁盘原文。
 * 改法：写前拿磁盘原文做底，投影只覆盖它真正要改的字段（patch），其余原样保留。
 *
 * @param {object} card   要落盘的对象（可能是投影）
 * @param {string} file   目标文件
 * @param {object} [patch] 本次真正要改的字段（不给则视为整卡写入，保持旧行为）
 */
// [独立复审 R2-1] 对外入口：以卡 raw id 加跨进程锁后再执行真正的读-折叠-追加
function persistCardAppend(card, file, patch) {
  const key = card && card.id !== undefined ? card.id : (file || 'anon');
  return withCardLock(key, () => persistCardAppendUnlocked(card, file, patch));
}

function persistCardAppendUnlocked(card, file, patch) {
  try {
    // ── [红队 P0-2] 有 patch = 回写已有卡 ⇒ 先定位磁盘原文，读-合并-写；找不到就 fail-closed。
    //   绝不再用 `Object.assign({}, card, patch)` 的投影对象整卡覆盖磁盘（那会丢 10 个字段+复制身份）。
    if (patch && card && card.id !== undefined) {
      let targetFile = file;
      let diskRaw = null;
      // [终审 F1] 工具写回**必须**先走 global 跨文件折叠：不被显式 file / sourcePath 提前短路。
      //   sourcePath 只作为候选首项参与折叠，不再「命中即返回」。
      const loc = locateCard(card, { global: true });
      if (loc) { diskRaw = loc.row; targetFile = loc.file; }
      // 兜底：全局找不到时，才尝试调用方显式给的目标文件（极少调用意图）
      if (!diskRaw) { diskRaw = readLatestLine(file, card.id); targetFile = file; }
      if (!diskRaw) {
        recordFault('tools', 'persist-card-no-original', new Error('找不到磁盘原文，拒绝投影覆盖: ' + String(card.id)));
        return { ok: false, reason: 'disk-original-not-found', id: String(card.id) };
      }
      const out = Object.assign({}, diskRaw, patch);
      const dir = targetFile.replace(/[/\\][^/\\]+$/, '');
      if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
      appendFileSync(targetFile, JSON.stringify(out) + '\n', 'utf8');
      return { ok: true, file: targetFile };
    }
    // 无 patch = 新建卡整卡写入（如 replacementFact 新基石卡），直接追加到目标文件
    const dir = file.replace(/[/\\][^/\\]+$/, '');
    if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
    appendFileSync(file, JSON.stringify(card) + '\n', 'utf8');
    return { ok: true, file };
  } catch (e) {
    recordFault('tools', 'persist-card', e);
    return { ok: false, reason: String(e && e.message || e).slice(0, 80) };
  }
}

// ══════════════════════════════════════════════════════════════════
// [2026-11-04 by Assistant · User定义的「被使用」= 次数权重真正该涨的地方]
//
// User原话：
//   「这个自然算是次数权重，和回到头部一起的。
//    次数权重不是被检索到、是被使用到的，
//    不然这卡只要被检索到 20 多张卡一起升权不是乱套了。
//    回溯也一起算」
//
// ⇒ 只有**模型主动选中这张卡去读**（memory_get）或**用卡回溯电梯**
//   （grepSource），才算一次「使用」：
//     · hits + 1        ← 次数权重（决定 lifespan = BASE + hits × PER_HIT）
//     · lastHitAt = now ← 回到头部（衰减起点重置）
//   两者是同一件事的两个面 —— User明确说「和回到头部一起的」。
//
// ❌ 不涨 hits 的（否则 20+ 张一起升权，乱套）：
//     · 被检索出来（retriever.search 返回）
//     · 被注入 context（assemble 拼进 system prompt）
//     · 回复里字面撞上关键词（isAdopted 的 bigram/entity 判据 —— 太粗）
// ══════════════════════════════════════════════════════════════════

/**
 * 记一次「真实使用」：hits+1 + lastHitAt=now，append-only 落盘。
 * LWW 语义下同 id 取最后一行，所以不需要改老行。
 *
 * @param {object} card 卡片对象（会被就地更新，供同会话后续复用）
 * @returns {{ok:boolean, hits:number, reason?:string}}
 */
function touchCardOnUse(card, ctx) {
  try {
    if (!card || !card.id) return { ok: false, hits: 0, reason: 'no-card' };
    const cid = String(card.id);
    // [2026-11-04] 同步上报「真实使用」给 prefetcher，供 commitTurn 算激活值
    //   （红队实测：原来 commitTurn 把"注入"当"使用"，这里补真信号）
    try {
      const pf = ctx && ctx.prefetcher;
      if (pf && typeof pf.recordRealUse === 'function') pf.recordRealUse(ctx.sessionId, cid);
    } catch (rfErr) { recordFault('tools', 'record-real-use', rfErr); }
    // ── [2026-11-04 by Assistant · 红队风险2 观测] ──
    //   记下「这张卡被点开时，它在 L0 里是什么渲染档（full/summary/title）」。
    //   为什么要记：风险2 假设「full 档卡信息已完整 ⇒ 模型不需点开 ⇒ hits 不涨」，
    //     要验证它必须知道「每次 memory_get 的卡属于哪个档」。
    //   怎么用：日志里 l0-tier-open × l0-tier-snapshot ⇒ 算各档位被点开比例。
    //   ⚠️ 只记录，不参与任何判据。
    try {
      const pf = ctx && ctx.prefetcher;
      if (pf && typeof pf.tierOf === 'function') {
        const tier = pf.tierOf(ctx.sessionId, cid);
        if (tier) {
          try { logTierOpen(tier, cid, ctx.sessionId); } catch (lgErr) { recordFault('tools', 'tier-open-log', lgErr); }
        }
      }
    } catch (tfErr) { recordFault('tools', 'tier-open-query', tfErr); }
    const now = Date.now();
    // [红队 P0-2] 用统一定位器拿磁盘原文的最新 hits（不再按 createdAt 猜文件、不再比带前缀 id）。
    let baseHits = Number(card.hits) || 0;
    let targetFile = '';
    try {
      const loc = locateCard(card);
      if (loc) {
        targetFile = loc.file;
        if (Number.isFinite(Number(loc.row.hits))) baseHits = Math.max(baseHits, Number(loc.row.hits));
      }
    } catch {}
    // 只写增量 patch，不拿投影整卡覆盖磁盘原文
    const patch = { hits: baseHits + 1, lastHitAt: now, lastHitReason: 'memory_get' };
    const updated = Object.assign({}, card, patch);
    if (!targetFile) targetFile = resolveCardTargetFile(card);
    const res = persistCardAppend(updated, targetFile, patch);
    // 就地更新，让本会话后续读到新值（仅写成功时）
    if (res && res.ok) {
      card.hits = updated.hits;
      card.lastHitAt = updated.lastHitAt;
    }
    return { ok: !!(res && res.ok), hits: updated.hits, reason: res && res.reason };
  } catch (e) {
    return { ok: false, hits: 0, reason: String(e && e.message || e).slice(0, 80) };
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
    description: '【主动深挖历史记忆】仅当 <unified-memory> 被动切片不足以回答、用户明确要求盘点过往记录（如\'查查上月关于某事的所有记录\'）、或需跨关键词排查历史经验时调用。严禁在普通寒暄或被动记忆已足够时滥用。'
      + '【分页规则 · 重要】盘点/列举/「多回忆一些」这类要**完整集合**的查询：先调一次（默认 5 条，要清单一上来就传 limit:30）；'
      + '若返回 hasMore:true 或你判断覆盖还不全（比如变更链中间有断层、只看到部分记录），**自己再调一次并把 page 加 1**——'
      + '插件会自动跳过已返回的卡、只给新的一批（第2组20条，第3组起10条），不会重复。不要因为第一组少就认定"只有这么多"。',
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
      // [2026-11-06 by Assistant · User「LLM 自己判」] 上限从 10 提到 30（盘点类查询需要）
      const limit = Math.min(30, Math.max(1, Number(a.limit) || 5));
      // 分页：page=1→30, 2→20, 3+→10（阶梯）；显式 limit 优先
      const page = Math.max(1, Math.floor(Number(a.page) || 1));
      const temporal = a.temporal || 'all';
      const sessId = (getSessionId && getSessionId()) || '';
      const injectedIds = new Set((prefetcher && prefetcher.lastInjectedIds && prefetcher.lastInjectedIds(sessId)) || []);

      let rawHits = [];
      let lastHasMore = false;
      let lastNextSize = 0;
      try {
        const res = await retriever.search(q, { k: Math.max(20, limit * 2), page });
        rawHits = (res && Array.isArray(res.hits)) ? res.hits : [];
        lastHasMore = Boolean(res && res.hasMore);
        lastNextSize = Number(res && res.nextPageSize) || 0;
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

      // [2026-11-06 by Assistant · User「让 LLM 自己判」] 按页取切片：前 page-1 组视为已看过
      const seen = (page - 1) * 30;   // 保守估计：前几组共看过这么多条
      const finalHits = formatted.slice(seen, seen + limit);
      return {
        ok: true,
        query: q,
        count: finalHits.length,
        hits: finalHits,
        hasMore: lastHasMore || (formatted.length > seen + finalHits.length),
        page,
        nextPageSize: lastNextSize || (page === 1 ? 20 : 10),
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
        if (v.ok && v.verbatim) {
          text += '\n\n【原话锚点 · 内联片段】\n' + v.verbatim;
        }
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

      // [2026-10-31 · 二级降级] 一级 message_ids 精确取，二级 sessionId+grep 兜底。
      //   业主定调「走二级降级比一次跑两个好」：
      //     有一级指针就只跑一级，命中即返回；一级没命中才降级到 grep。
      const hasMsgIds = Array.isArray(sRef.messageIds) && sRef.messageIds.length > 0;
      const includeSource = a.includeSource === true;
      // [红队 P1-2] 默认不自动展开原文：只有显式 grepSource 或 includeSource:true 才跑。
      if (grepSource || (includeSource && hasMsgIds)) {
        const traceRes = traceSourceSnippets({
          sessionId: sid,
          messageIds: hasMsgIds ? sRef.messageIds : undefined,
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
        // [红队 P1-2] 有 messageIds 时报告原文完整性，部分缺失也如实标出
        if (hasMsgIds) {
          stObj.requested = sRef.messageIds.length;
          stObj.found = Number(traceRes.matches) || 0;
          stObj.missing = Math.max(0, stObj.requested - stObj.found);
        }
        sourceTrace = stObj;
      }

      const out = {
        ok: true,
        id: String(card.id),
        title: String(card.title || '(无标题)'),
        summary: String(card.summary || ''),
        content: String(card.content || card.summary || ''),
        verbatim: String(card.verbatim || ''),
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

      // ── [2026-11-04 by Assistant · User定义：这才是「被使用」 ──]
      //   User：「次数权重不是被检索到、是被使用到的，
      //          不然这卡只要被检索到 20 多张卡一起升权不是乱套了。回溯也一起算」
      //   走到这里说明模型**主动选中了这张卡并读了内容**（可能还用了回溯电梯）
      //   ⇒ 算一次真实使用：hits+1（次数权重）+ lastHitAt=now（回顶部）
      //   失败不影响返回（这是记账，不该阻断读卡）
      const touch = touchCardOnUse(card, {
        prefetcher: prefetcher || null,
        sessionId: (typeof getSessionId === 'function' ? getSessionId() : '') || '',
      });
      if (touch.ok) {
        out.hits = touch.hits;          // 顺带回给调用方看，便于自检
        out.touched = true;
      }
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
      let replacementWritten = false;   // [独立复审 R1] 更正卡是否真的写盘成功
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
            const axiomPatch = {
              hits: (Number(existingCard.hits) || 0) + validCards.length,
              lastHitAt: Date.now(),
              reinforces: Array.from(new Set([...(existingCard.reinforces || []), ...validCards.map((c) => String(c.id))])),
            };
            const updatedAxiom = Object.assign({}, existingCard, axiomPatch);
            const targetFile = resolveCardTargetFile(existingCard);
            // [独立复审 R1] 检查写盘结果：失败则不更新内存缓存、不谎报
            const wAxiom = persistCardAppend(updatedAxiom, targetFile, axiomPatch);
            if (wAxiom && wAxiom.ok) {
              sessionCardsCache.set(replacementCardId, updatedAxiom);
              if (cardMap && typeof cardMap.set === 'function') cardMap.set(replacementCardId, updatedAxiom);
              replacementWritten = true;
            } else {
              recordFault('tools', 'refute-axiom-write', new Error((wAxiom && wAxiom.reason) || 'write-failed'));
            }
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

          // [独立复审 R1] 检查写盘结果：失败则不建缓存、不把它当"已立新基石卡"
          const wNew = persistCardAppend(newCard, OWN_FILE);
          if (wNew && wNew.ok) {
            sessionCardsCache.set(replacementCardId, newCard);
            sessionFactAxiomCache.set(normFact, replacementCardId);
            if (cardMap && typeof cardMap.set === 'function') cardMap.set(replacementCardId, newCard);
            replacementWritten = true;
          } else {
            recordFault('tools', 'refute-newfact-write', new Error((wNew && wNew.reason) || 'write-failed'));
            replacementCardId = '';
            isReusedCard = false;
          }
        }
      }

      // ② 将所有待推翻旧卡挂上推翻标记，追加写回各自来源文件
      const markId = replacementCardId || ('manual_refute_' + Date.now());
      let refutedOk = 0;              // [独立复审 R1] 真正写盘成功的张数
      const failures = [];
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
        // [2026-11-05 · 红队 P0-1] 只 patch 推翻相关字段，不整卡覆盖
        const refutePatch = {
          refute_by: curRef,
          refute_reason: reason,
          refutedAt: Date.now(),
        };
        if (wasAxiom) {
          refutePatch.is_axiom = false;
          refutePatch.axiomRevokedAt = Date.now();
          refutePatch.axiomRevokedBy = 'memory_refute';
        }
        const updatedCard = Object.assign({}, card, refutePatch);

        const targetFile = resolveCardTargetFile(card);
        // [独立复审 R1] 只有写盘成功才更新内存缓存与"本会话已推翻"，否则如实计入失败
        const wRes = persistCardAppend(updatedCard, targetFile, refutePatch);
        if (wRes && wRes.ok) {
          sessionCardsCache.set(cid, updatedCard);
          if (cardMap && typeof cardMap.set === 'function') cardMap.set(cid, updatedCard);
          sessionRefutedIds.add(cid);
          refutedOk++;
        } else {
          failures.push({ id: cid, ok: false, error: (wRes && wRes.reason) || 'write-failed' });
        }
      }

      // [独立复审 R1] 如实返回：ok/refuted/refutedCount 反映真实写盘结果，部分成功标 partial
      const hasReplacement = Boolean(repFact);
      const out = {
        ok: refutedOk > 0,
        cardId: validCards[0].id,
        cardIds: validCards.map((c) => String(c.id)),
        refutedCount: refutedOk,
        refuted: refutedOk > 0,
        partial: refutedOk > 0 && refutedOk < validCards.length,
        failedCount: failures.length,
        isReusedCard,
        note: refutedOk === 0
          ? '写盘失败：未能推翻任何目标卡（重启后不会生效），请检查磁盘写权限/锁'
          : (hasReplacement
              ? (replacementWritten
                  ? (isReusedCard
                      ? '旧卡沉底 ' + refutedOk + '/' + validCards.length + '，正确事实指向已有权威基石卡（' + replacementCardId + '）'
                      : '旧卡沉底 ' + refutedOk + '/' + validCards.length + '，正确事实已建唯一定论基石卡并写入')
                  : ('旧卡沉底 ' + refutedOk + '/' + validCards.length + '；但更正事实卡写盘失败，未立新基石卡'))
              : ('目标旧卡已沉底 ' + refutedOk + '/' + validCards.length + '（手动词条推翻），后续检索按 0.150x 降权')),
      };
      if (failures.length) out.details = failures;
      if (replacementWritten && replacementCardId) out.replacementCardId = replacementCardId;
      return out;
    },
  };

  return [searchTool, getTool, refuteTool];
}
