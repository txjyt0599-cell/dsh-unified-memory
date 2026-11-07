/**
 * entry-shadow.js —— 入口列表「相关性」的影子观测
 * [2026-11-03 by Assistant · P1-c（agy 红队口径）]
 *
 * ## 为什么先 shadow 不直接上线
 * buildEntryList 现在只按「问题卡优先 + 最新卡补位」装 1800 字符，没有本轮语义相关性。
 * 想改，但 agy 红队点名：N=12 / 1 秒 / 扇出降 30% / 真因果率 +15pp **全是未验证目标**。
 * 所以先只**观察**：把「如果按相关性挑会挑到谁」记下来，提示词一个字都不改。
 *
 * ## 铁律
 *  1. 开关关闭 ⇒ 不读盘、不检索、不改任何字节（调用方负责不进来）。
 *  2. 开关打开 ⇒ entryBuilt.text 仍原样使用，**绝不替换**。
 *  3. 只认**自产卡源**：命中必须能回映射到 existing，否则它进不了 causesOf 的
 *     标题解析范围（causesOf 只在 existing 里按标题找卡），塞进去只浪费预算。
 *  4. 同时记录「无 causes 率」—— 防止有人靠少连边把扇出指标做漂亮。
 *  5. 超时只停等待，**记录 timedOut**，不假装成功；底层检索不保证被取消。
 */
import { appendFileSync, mkdirSync, existsSync, statSync, renameSync, unlinkSync } from 'node:fs';
import { dataPath } from '../paths.js';
import { recordFault } from '../faults.js';

/** 影子日志单文件上限：超过就轮转（改名保留一份 .1 备份），避免无限增长。 */
export const SHADOW_LOG_MAX_BYTES = 2 * 1024 * 1024;

/** 影子日志路径（只写不改；**真实的按大小轮转**，见 rotateIfNeeded） */
export function shadowLogPath() {
  return dataPath('ingest/entry-shadow.jsonl');
}

/** 从本批 fresh 消息构造确定性 query（取最近几条用户话，不引入随机性） */
export function buildShadowQuery(fresh, maxChars) {
  const cap = Number.isFinite(maxChars) ? maxChars : 240;
  const users = (Array.isArray(fresh) ? fresh : [])
    .filter((m) => m && String(m.role || '') === 'user' && typeof m.content === 'string')
    .slice(-3)
    .map((m) => String(m.content).replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  return users.join(' / ').slice(0, cap);
}

/** 归一 id：自产卡有 pmi: 前缀，检索命中可能没有（或反过来） */
function normId(x) {
  return String(x || '').trim().replace(/^pmi:/, '');
}

/** 未退役卡里「没有 causes」的占比 —— 防指标作弊的护栏 */
export function noCauseRate(existing) {
  const list = (Array.isArray(existing) ? existing : []).filter(
    (c) => c && String(c.status || '').toLowerCase() !== 'retired'
  );
  if (!list.length) return { total: 0, without: 0, rate: null };
  let without = 0;
  for (const c of list) {
    const cs = Array.isArray(c.causes) ? c.causes.filter(Boolean) : [];
    if (!cs.length) without += 1;
  }
  return { total: list.length, without, rate: without / list.length };
}

function withTimeout(p, ms) {
  return new Promise((resolve) => {
    let done = false;
    const t = setTimeout(() => { if (!done) { done = true; resolve({ timedOut: true, value: null }); } }, ms);
    if (t && typeof t.unref === 'function') t.unref();
    Promise.resolve(p).then(
      (v) => { if (!done) { done = true; clearTimeout(t); resolve({ timedOut: false, value: v }); } },
      (e) => { if (!done) { done = true; clearTimeout(t); resolve({ timedOut: false, value: null, error: e && e.message ? e.message : String(e) }); } }
    );
  });
}

/**
 * 记录一次影子观测。**永不抛给调用方**。
 * @param {{existing:any[], entryBuilt:{text:string,stats:object}, fresh:any[],
 *          search?:Function, sessionKey?:string, timeoutMs?:number, topN?:number,
 *          now?:number, logPath?:string}} input
 */
export async function recordEntryShadow(input) {
  const o = input || {};
  try {
    const now = Number.isFinite(o.now) ? o.now : Date.now();
    const existing = Array.isArray(o.existing) ? o.existing : [];
    const built = o.entryBuilt || {};
    const text = String(built.text || '');
    const stats = built.stats || {};
    const query = buildShadowQuery(o.fresh, o.queryMaxChars);
    const idSet = new Set();
    for (const c of existing) { idSet.add(normId(c && c.id)); }

    const rec = {
      at: now,
      sessionKey: String(o.sessionKey || ''),
      queryChars: query.length,
      old: {
        chars: text.length,
        bodyChars: Number.isFinite(stats.bodyChars) ? stats.bodyChars : null,
        pickedProblems: Number.isFinite(stats.pickedProblems) ? stats.pickedProblems : null,
        pickedRecent: Number.isFinite(stats.pickedRecent) ? stats.pickedRecent : null,
        pickedTotal: Number.isFinite(stats.pickedTotal) ? stats.pickedTotal : null,
      },
      noCause: noCauseRate(existing),
    };

    if (typeof o.search !== 'function') {
      rec.search = { ran: false, reason: 'no-provider' };
      return write(rec, o.logPath) ? rec : null;
    }
    if (!query) {
      rec.search = { ran: false, reason: 'empty-query' };
      return write(rec, o.logPath) ? rec : null;
    }

    const topN = Number.isFinite(o.topN) ? o.topN : 12;
    const timeoutMs = Number.isFinite(o.timeoutMs) ? o.timeoutMs : 1000;
    const t0 = Date.now();
    // search 没有声明 top-N 参数（agy 核实过 JSDoc 未声明）⇒ 只能拿回结果再截
    const r = await withTimeout(o.search(query, { k: topN }), timeoutMs);
    const searchMs = Date.now() - t0;

    const hits = (r.value && Array.isArray(r.value.hits)) ? r.value.hits : [];
    const mapped = [];
    for (const h of hits) {
      const nid = normId(h && h.id);
      if (!nid) continue;
      if (!idSet.has(nid)) continue;          // 铁律③：只认自产卡源
      mapped.push(String(h.id || nid));
    }
    rec.search = {
      ran: true,
      searchMs,
      timedOut: r.timedOut === true,
      error: r.error || null,
      hits: hits.length,
      mappedToExisting: mapped.length,
      candidateIds: mapped.slice(0, topN),
      degrade: (r.value && (r.value.degrade || r.value.via)) || null,
    };
    return write(rec, o.logPath) ? rec : null;
  } catch (e) {
    recordFault('distill', 'entry-shadow', e);
    return null;
  }
}

/**
 * [2026-11-07 P2-5 · 红队修复] 兑现注释里"按大小粗切"的承诺（原来是空头支票）：
 *   append 前检查文件大小，>= maxBytes 就把它改名为 <path>.1（覆盖上一份 .1），再重新开新文件。
 *   粗切策略只保留 1 份历史，够用来排查近期问题，又不会无限长。
 *   任何一步失败都吞掉（影子观测绝不能影响主流程）。
 */
function rotateIfNeeded(p, maxBytes) {
  try {
    if (!existsSync(p)) return;
    const st = statSync(p);
    if (!st || st.size < maxBytes) return;
    const bak = p + '.1';
    try { if (existsSync(bak)) unlinkSync(bak); } catch { /* 旧备份删不掉就覆盖写失败，忽略 */ }
    renameSync(p, bak);
  } catch (e) {
    recordFault('distill', 'entry-shadow-rotate', e);
  }
}

function write(rec, logPath) {
  try {
    const p = logPath || shadowLogPath();
    const dir = p.slice(0, p.lastIndexOf('/'));
    if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
    rotateIfNeeded(p, SHADOW_LOG_MAX_BYTES);
    appendFileSync(p, JSON.stringify(rec) + '\n', 'utf8');
    return true;
  } catch (e) {
    recordFault('distill', 'entry-shadow-write', e);
    return false;
  }
}
