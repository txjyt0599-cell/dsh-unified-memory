/**
 * ingest/persona.js —— L3 人格画像的接管（关旧插件后不丢User画像）
 * [2026-10-22 by Assistant · 期7-D 前置]
 *
 * 为什么需要它：
 *   tdai 的 L3（persona.md，32KB）是**User画像**——偏好、底线、职业背景，
 *   每轮注入成 <user-persona>。它由 tdai 自己的 persona-generator 持续更新。
 *   一旦关掉 tdai，这个文件就**不再更新**，而且新内容也不会再产生。
 *
 * 但User要的是"不影响我们的超图"——画像属于记忆的一部分，
 * 不能因为关插件就退化成一堆静态文本。
 *
 * 做法（**只读 + 接管生成**两条腿）：
 *   ① 读取：直接读 persona.md（超图已经只读它所在地，无需迁移存量）
 *   ② 生成：超图自己也能「从最近对话提炼画像要点」，追加到自己的 persona 文件
 *      —— 不急着重写整份 32KB（那是 tdai 的格式），先做**增量要点**：
 *      偏好/底线/职业/环境这类稳定事实，只增不改。
 *
 * 保守原则：
 *   · 默认**不写入**（personaTakeover 必须显式开）——迁移期先读为主
 *   · 写入只追加、只追加"看起来像稳定事实"的句子，不做主观改写
 *   · 永远保留 tdai 的 persona.md 原文件（只读引用，绝不改它）
 */
import { readFileSync, existsSync, appendFileSync } from 'node:fs';
import { dirs } from './core.js';
import { dataPath } from '../paths.js';

// [2026-10-22 by Assistant · 关旧审计抓到]
//   这里原本硬编码 tdai 的 persona.md 路径 —— 虽然只是"只读"，但关旧之后那个文件就不存在了，
//   属于"对旧插件的隐式依赖"。审计脚本（legacy-off-sim）把它揪了出来。
//   修法：路径**可配置**，且**缺失时自动降级**到超图自己的增量笔记，
//        不让主链路依赖旧文件的存在。
export const DEFAULT_PERSONA_SRC = dataPath('memory-tencentdb/memory-tdai/persona.md');
/** 超图自己的画像笔记（关旧后由它接棒，**不依赖任何旧插件**） */
export const OWN_PERSONA_NOTES = 'persona-notes.md';

/**
 * 读**画像主档**（只读）。
 *
 * [关旧降级] tdai 的 persona.md 是权威主档，但**不是必需的**：
 *   文件不在（关旧插件了）⇒ 自动回退到超图自己的 persona-notes.md；
 *   两个都没有 ⇒ 返回 empty，调用方按"暂无画像"处理，**绝不报错**。
 *
 * @param {string} src   主档路径
 * @param {string} [own] 超图自有的增量笔记路径（降级用）
 */
export function readPersona(src = DEFAULT_PERSONA_SRC, own) {
  const tryRead = (p) => {
    try {
      if (!p || !existsSync(p)) return null;
      const text = readFileSync(p, 'utf8');
      return { text, bytes: Buffer.byteLength(text, 'utf8'), path: p };
    } catch { return null; }
  };
  const main = tryRead(src);
  if (main) return { text: main.text, bytes: main.bytes, path: main.path, source: 'primary', missing: false };
  const fallback = tryRead(own);
  if (fallback) return { text: fallback.text, bytes: fallback.bytes, path: fallback.path, source: 'own-notes', missing: false, degraded: true };
  return { text: '', bytes: 0, path: null, source: 'none', missing: true };
}

/**
 * 从文本里抽「稳定事实」句子（用于增量积累画像要点）。
 * 判据很保守：只认「用户/User + 是/喜欢/偏好/习惯/从事/要求」这类句式。
 */
export function extractPersonaFacts(text, opts) {
  const o = opts || {};
  const max = Number(o.maxItems) || 8;
  const out = [];
  const seen = new Set();
  const sentences = String(text || '').split(/[。！？\n]/);
  for (const raw of sentences) {
    const s = raw.replace(/\*\*|__|\`|^[\s>•·\-|]+/g, '').replace(/\s+/g, ' ').trim();
    if (s.length < 12 || s.length > 120) continue;
    // 必须明确指向"用户/User"的稳定属性
    if (!/(用户|User)[（(]?[^）)]{0,8}[）)]?\s*(是|喜欢|偏好|讨厌|习惯|擅长|从事|要求|希望|不喜欢)/.test(s)) continue;
    const fp = s.slice(0, 40);
    if (seen.has(fp)) continue;
    seen.add(fp);
    out.push(s);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * 把新抽到的画像要点**追加**到超图自己的 persona 文件（不动 tdai 原件）。
 * 返回 { appended, file, reason }
 */
export function appendPersonaFacts(root, facts, opts) {
  const o = opts || {};
  if (!Array.isArray(facts) || facts.length === 0) return { appended: 0, reason: 'no-facts' };
  const d = dirs(root);
  const file = d.root + '/persona-notes.md';
  try {
    const lines = [];
    if (!existsSync(file)) {
      lines.push('# 超图画像要点（自动积累）');
      lines.push('');
      lines.push('> 由 unified-memory 从对话增量提取；tdai 的 persona.md 仍为权威主档。');
      lines.push('');
    }
    let added = 0;
    const existing = existsSync(file) ? readFileSync(file, 'utf8') : '';
    for (const f of facts) {
      const key = String(f).slice(0, 24);
      if (existing.indexOf(key) >= 0) continue;      // 已在文件里就跳过
      lines.push('- ' + String(f));
      added++;
    }
    if (added > 0) appendFileSync(file, lines.join('\n') + '\n', 'utf8');
    return { appended: added, file, reason: added ? null : 'all-duplicate' };
  } catch (e) { return { appended: 0, file, reason: String(e && e.message || e) }; }
}
