/**
 * inject-fingerprint.js —— 消息尾注入去重指纹（R3-P0-2 真实长度修复）
 *
 * 旧实现用 slice(100,220)+slice(-180)：生产 3.5K~5K 文本时中间 <hot-memory>
 * 完全不在指纹里，改 hot 不换指纹 ⇒ 新热区被静默跳过。
 * 现在：三段各自完整提取、各自 SHA-256；消息可只含 hot/pulse（尾部去重会剥掉 L0），
 *        用 mergeInjectionHashes 把多步消息里的三段合并后再比对。
 */
import { createHash } from 'node:crypto';

const BLOCK_RE = /<(unified-memory|hot-memory|cross-session-pulse|ongoing-thread)>[\s\S]*?<\\?\/\1>/g;
const KEY_BY_TAG = { 'unified-memory': 'l0', 'hot-memory': 'hot', 'cross-session-pulse': 'pulse', 'ongoing-thread': 'ongoing' };

function hashOf(s) {
  return createHash('sha256').update(String(s || '').replace(/\\n/g, '\n').replace(/\s+/g, ' ').trim()).digest('hex');
}

/** 把消息 content 还原成原始文本；不要先 JSON.stringify（会转义引号/反斜杠）。 */
export function contentTextOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map(function (part) {
      if (typeof part === 'string') return part;
      return part && typeof part.text === 'string' ? part.text : '';
    }).join('\n');
  }
  return '';
}

/** 扫全量历史消息里有没有某个标签（diary-nudge / unified-memory 多步去重）。 */
export function messagesHaveBlock(messages, tag) {
  const list = Array.isArray(messages) ? messages : [];
  return list.some(function (m) { return contentTextOf(m && m.content).includes(tag); });
}

/** 返回 { l0, hot, pulse } 三段各自的完整内容哈希；不存在则为空串。 */
export function injectionBlockHashes(text) {
  const out = { l0: '', hot: '', pulse: '', ongoing: '' };
  const s = String(text || '');
  let m;
  BLOCK_RE.lastIndex = 0;
  while ((m = BLOCK_RE.exec(s))) {
    const k = KEY_BY_TAG[m[1]];
    if (k) out[k] = hashOf(m[0]);
  }
  return out;
}

/** 从 JSON.stringify 后的消息里提取全部注入块（可只有 hot/pulse，不要求有 L0）。 */
export function extractInjectionBlock(jsonString) {
  const s2 = String(jsonString || '');
  const out = [];
  let m;
  BLOCK_RE.lastIndex = 0;
  while ((m = BLOCK_RE.exec(s2))) out.push(m[0]);
  return out.join('\n');
}

/** 按上次注入哈希剥离未变化的块，只留下新/变化的块；用于增量注入。 */
export function trimInjectedBlocks(text, lastHashes) {
  const last = lastHashes || {};
  const out = String(text || '').replace(/<(unified-memory|hot-memory|cross-session-pulse|ongoing-thread)>[\s\S]*?<\\?\/\1>/g, function (block, tag) {
    const key = KEY_BY_TAG[tag];
    if (!key || !last[key]) return block;
    return injectionBlockHashes(block)[key] === last[key] ? '' : block;
  });
  return out.replace(/\n{3,}/g, '\n\n').trim();
}

/** 多步消息合并：每种块取最后一次出现（最新），允许分属不同消息。 */
export function mergeInjectionHashes(list) {
  const out = { l0: '', hot: '', pulse: '', ongoing: '' };
  for (const h of (Array.isArray(list) ? list : [])) {
    if (!h) continue;
    for (const k of ['l0', 'hot', 'pulse', 'ongoing']) if (h[k]) out[k] = h[k];
  }
  return out;
}

/** candidate 覆盖 reference 中所有存在的块且内容一致 ⇒ 视为已注入。 */
export function injectionHashesMatch(candidate, reference) {
  const c = candidate || {};
  const r = reference || {};
  const keys = ['l0', 'hot', 'pulse', 'ongoing'].filter(k => r[k]);
  if (!keys.length) return false;
  return keys.every(k => c[k] && c[k] === r[k]);
}

/** 兼容旧测试：三段哈希的 JSON 指纹（仅供调试）。 */
export function injectionFingerprint(text) {
  return JSON.stringify(injectionBlockHashes(text));
}

export default { contentTextOf, messagesHaveBlock, trimInjectedBlocks, injectionBlockHashes, extractInjectionBlock, mergeInjectionHashes, injectionHashesMatch, injectionFingerprint };
