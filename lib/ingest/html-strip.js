/**
 * lib/ingest/html-strip.js —— 注入前剥 HTML（渲染层兜底）
 * [2026-10-24 by Assistant · Step 5]
 *
 * 实跑抓到：注入文本里出现「…：</style> <span class="bd">记忆系统改造 · 交接回放…」。
 * 原因是卡片 summary/content 里存了 VCP 卡片的 HTML 片段，原样进了注入。
 * 这些标签对模型毫无意义，只占 token、让记忆看起来像坏数据。
 *
 * 独立性：不碰 sanitizeInjectionText（那个负责注入标签降级/控制字符），
 * 这里是**展示层清洗**，两者叠加使用。
 */

const BLOCK = /<(script|style)[\s\S]*?<\/\1>/gi;
const TAG = /<\/?[a-zA-Z][^>]{0,300}>/g;
const OPEN_TAIL = /<[^<>]{0,200}$/g;
const BOX = /[\u2500-\u257F\u2580-\u259F]/g;

export function stripHtml(s) {
  let t = String(s === undefined || s === null ? '' : s);
  t = t.replace(BLOCK, ' ');
  t = t.replace(TAG, ' ');
  t = t.replace(OPEN_TAIL, ' ');
  t = t.replace(BOX, ' ');
  t = t.replace(/\s{2,}/g, ' ').trim();
  return t;
}
