/**
 * verbatim-lookup.js —— 按 messageId 回查原文（原文锚点的读取侧）
 *
 * 【为什么有它】
 *   卡片是「抽取式」：一旦提炼就丢细节。今天实测可读性只有 49-74%，
 *   「谁在做什么」只有 56% —— 根因不是模型笨，是卡里信息不够。
 *   而原文 99.8% 仍在 phoebe-memory/{ingest,memory-tencentdb/memory-tdai}/conversations/。
 *
 *   所以给卡加了两样东西（distill.js 写）：
 *     ① source_message_ids  指针 → 能回查全文
 *     ② verbatim            内联片段 → 不依赖外部，永不失效
 *
 *   本模块负责 ① 的读取：给一批 messageId，回查原文。
 *
 * 【纪律】
 *   · 只读，不写任何 conversations 文件
 *   · 查不到就返回 null，**绝不猜**（与 framestore 的「宁慢勿错」同一条）
 *   · 启动时建一次索引（id → 原文），之后按 id O(1) 取
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dataPath } from '../paths.js';

/** 原文留存目录（按优先级） */
export const CONVERSATION_DIRS = () => [
  dataPath('ingest/conversations'),
  dataPath('memory-tencentdb/memory-tdai/conversations'),
];

let _index = null;      // Map<messageId, {content, role, timestamp, sessionId}>
let _builtAt = 0;
let _stats = { messages: 0, sessions: 0, dirs: 0 };

/** 建索引（幂等；force 强制重建） */
export function buildVerbatimIndex(opts = {}) {
  const force = opts.force === true;
  if (_index && !force) return _stats;
  const idx = new Map();
  const sessions = new Set();
  let dirs = 0;
  for (const d of CONVERSATION_DIRS()) {
    if (!existsSync(d)) continue;
    dirs += 1;
    let files = [];
    try { files = readdirSync(d).filter((f) => f.endsWith('.jsonl')); } catch { continue; }
    for (const f of files) {
      let raw = '';
      try { raw = readFileSync(d + '/' + f, 'utf8'); } catch { continue; }
      for (const line of raw.split('\n')) {
        if (line.length < 20) continue;
        let o; try { o = JSON.parse(line); } catch { continue; }
        const id = String(o.id || '').trim();
        if (!id) continue;
        idx.set(id, {
          content: String(o.content || ''),
          role: String(o.role || ''),
          timestamp: Number(o.timestamp) || 0,
          sessionId: String(o.sessionId || o.sessionKey || ''),
        });
        const s = String(o.sessionId || o.sessionKey || '');
        if (s) sessions.add(s);
      }
    }
  }
  _index = idx;
  _builtAt = Date.now();
  _stats = { messages: idx.size, sessions: sessions.size, dirs };
  return _stats;
}

/** 按 id 取原文；查不到返回 null（不猜） */
export function lookupOne(messageId) {
  if (!_index) buildVerbatimIndex();
  const hit = _index.get(String(messageId || '').trim());
  return hit || null;
}

/** 批量取；返回 { id: 原文|null } */
export function lookupMany(ids) {
  if (!_index) buildVerbatimIndex();
  const out = {};
  for (const id of (Array.isArray(ids) ? ids : [])) {
    out[String(id)] = _index.get(String(id).trim()) || null;
  }
  return out;
}

/**
 * 给一张卡补齐原文（卡有 source_message_ids 就用指针取全文，
 * 没有指针就退回它自带的 verbatim 内联片段）。
 *
 * @returns {{ok:boolean, source:'pointer'|'inline'|'none', verbatim:string, full:string, role:string}}
 */
export function resolveCardVerbatim(card, opts = {}) {
  const c = card || {};
  const ids = Array.isArray(c.source_message_ids) ? c.source_message_ids : [];
  if (ids.length) {
    const got = lookupMany(ids);
    const parts = [];
    let role = '';
    for (const id of ids) {
      const v = got[id];
      if (v && v.content) {
        parts.push(v.content.replace(/\s+/g, ' ').trim());
        if (!role && v.role) role = v.role;
      }
    }
    if (parts.length) {
      const full = parts.join(' / ');
      return {
        ok: true,
        source: 'pointer',
        verbatim: String(c.verbatim || full.slice(0, 30)),
        full: opts.maxChars ? full.slice(0, opts.maxChars) : full,
        role,
      };
    }
  }
  const inl = String(c.verbatim || '').trim();
  if (inl) return { ok: true, source: 'inline', verbatim: inl, full: inl, role: '' };
  return { ok: false, source: 'none', verbatim: '', full: '', role: '' };
}

/** 统计（给体检/探针用） */
export function verbatimStats() {
  return { ..._stats, builtAt: _builtAt, indexed: !!_index };
}

/** 清索引（测试用） */
export function resetVerbatimIndex() {
  _index = null;
  _builtAt = 0;
  _stats = { messages: 0, sessions: 0, dirs: 0 };
}
