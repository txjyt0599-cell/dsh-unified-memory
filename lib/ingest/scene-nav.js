/**
 * ingest/scene-nav.js —— 场景导航接管（期7-D 关旧前置）
 * [2026-10-22 by Assistant · 第22轮]
 *
 * 为什么需要它：
 *   tdai 的 <scene-navigation> 由 scene_blocks 生成（10 个场景、11099 字摘要）。
 *   实测日志里 scene_blocks 被读 0 次 —— 但摘要本身有信息量（用户偏好/职业/项目全景）。
 *   关掉 tdai 后这块会消失 ⇒ 需要接管。
 *
 * 为什么不用超图 topics 生成：
 *   实测 470 个 topic 里 439 个 content topic **全只有 1 个成员**，
 *   是单条 episode 的标签，不是主题聚类 ⇒ 生成出来是碎片词，负价值。
 *
 * 正确做法：**直接读 scene_blocks 的 META 段**（那是现成的、人工维护的、
 *   跨会话累积的真实摘要）。超图只做「读 + 排版」，不重造。
 *   这也符合"治本"：不重复建设已经存在且质量更高的东西。
 *
 * 稳定性：按会话快照固化，同会话内逐字节不变（否则破前缀缓存）。
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { dataPath } from '../paths.js';

export const DEFAULT_SCENE_DIR = dataPath('memory-tencentdb/memory-tdai/scene_blocks');

/**
 * 从 scene_blocks 目录读所有场景的元信息，生成导航文本。
 *
 * @param {string} dir  scene_blocks 目录
 * @param {{maxScenes?:number, maxSummaryChars?:number, maxTotalChars?:number}} opts
 * @returns {{text:string, scenes:number, totalChars:number, missing:boolean}}
 */
export function generateSceneNavigation(dir, opts) {
  const navDir = (dir && typeof dir === 'string') ? dir : DEFAULT_SCENE_DIR;
  const o = opts || {};
  const maxScenes = Number.isFinite(Number(o.maxScenes)) ? Number(o.maxScenes) : 10;
  const maxSummaryChars = Number.isFinite(Number(o.maxSummaryChars)) ? Number(o.maxSummaryChars) : 160;
  const maxTotalChars = Number.isFinite(Number(o.maxTotalChars)) ? Number(o.maxTotalChars) : 4000;

  if (!navDir || !existsSync(navDir)) {
    return { text: '', scenes: 0, totalChars: 0, missing: true };
  }

  let names = [];
  try {
    names = readdirSync(navDir).filter((f) => f.endsWith('.md'));
  } catch {
    return { text: '', scenes: 0, totalChars: 0, missing: true };
  }

  const entries = [];
  for (const name of names) {
    try {
      const raw = readFileSync(join(navDir, name), 'utf8');
      const heat = Number((raw.match(/^heat:\s*(\d+)$/m) || [])[1]) || 0;
      const updated = (raw.match(/^updated:\s*(.+)$/m) || [])[1] || '';
      const summary = ((raw.match(/^summary:\s*(.+)$/m) || [])[1] || '').trim();
      const st = statSync(join(navDir, name));
      entries.push({
        title: name.replace(/\.md$/, ''),
        heat,
        updated: updated.slice(0, 19),
        summary: summary.slice(0, maxSummaryChars),
        bytes: st.size,
      });
    } catch { /* 单块坏了不影响其它 */ }
  }

  if (entries.length === 0) return { text: '', scenes: 0, totalChars: 0, missing: true };

  // 按热度降序（最相关的场景排前面）
  entries.sort((a, b) => b.heat - a.heat);
  const picked = entries.slice(0, maxScenes);

  const lines = [];
  lines.push('<scene-navigation>');
  lines.push('（场景记忆索引：以下是按热度排序的主题场景。需要细节时可按路径 read_file 读全文。）');
  lines.push('');
  let total = 0;
  for (const e of picked) {
    const block = '### Path: ' + navDir + '/' + e.title + '.md'
      + '\n**热度**: ' + e.heat + ' | **更新**: ' + e.updated
      + '\nSummary: ' + e.summary;
    if (total + block.length > maxTotalChars) break;
    lines.push(block);
    lines.push('');
    total += block.length;
  }
  lines.push('</scene-navigation>');
  const text = lines.join('\n');
  return { text, scenes: picked.length, totalChars: text.length, missing: false };
}
