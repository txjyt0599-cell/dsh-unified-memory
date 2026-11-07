/**
 * lib/card-session.js —— 卡片/消息「归属会话」的唯一判据
 * [2026-10-26 by Assistant · 字段口径统一]
 *
 * ## 为什么要有这个文件
 *
 * 落盘侧的写卡代码（ingest/distill.js、ingest/extract.js）一直写的是**三个同值字段**：
 *   sessionId / sessionKey / source_session_id
 * 而 **sourceSessionId 只存在于 memory_get 的输出里**（由 retrieval/tools.js 派生），
 * 原始 JSONL 里**根本没有这个键**。
 *
 * 于是每个消费方都各自手写一条回退链，三条还不一样：
 *   · retrieval/source-tracer.js : sessionId || sessionKey || source_session_id
 *   · retrieval/retriever.js     : sourceSessionId || sessionId || source_session_id
 *   · ingest/distill.js          : sessionKey || sessionId（再套 normalizeSid）
 *
 * 后果（都真实发生过）：
 *   · 红队给的补丁用 c.sessionId 直接读，字段名对不上 ⇒ 过滤全空、静默失败；
 *   · Assistant排查时查 sourceSessionId，拿到一片 "(无)"，误判成"归属丢了"。
 *   · 这正是本项目第一号铁律「判据只能有一份，修一处漏一处」的又一个实例。
 *
 * ⇒ 统一收口到这里：**任何地方要判断"这条卡/这条消息属于哪个会话"，只准调 sessionIdOf()**。
 */

/** 归属会话可能出现的全部字段名，按优先级排列。新增别名只改这一处。 */
export const SESSION_FIELDS = ['sessionId', 'sessionKey', 'source_session_id', 'sourceSessionId'];

/**
 * 取一条卡片或一条消息的归属会话 id。
 * 依次尝试 SESSION_FIELDS，返回第一个非空字符串（已 trim）；都没有则返回 ''。
 * @param {object} card
 * @returns {string}
 */
export function sessionIdOf(card) {
  if (!card || typeof card !== 'object') return '';
  for (const key of SESSION_FIELDS) {
    const value = card[key];
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (trimmed) return trimmed;
    } else if (value !== undefined && value !== null) {
      const trimmed = String(value).trim();
      if (trimmed && trimmed !== 'undefined' && trimmed !== 'null') return trimmed;
    }
  }
  return '';
}

export default { sessionIdOf, SESSION_FIELDS };
