#!/usr/bin/env node
/**
 * dedupe-titles.mjs —— 标题去重（同标题多卡时补差异点）
 * [2026-10-24 by Assistant · Round 21]
 *
 * 实测数据：481 个标题被多张卡共用，最多一组 <b>26 张</b>（粒子视效项目）。
 *   但查下去发现 —— content 各不相同（26 个不同细节），**不是真冗余**。
 *   真冗余只有 26 张（0.3%）。
 *
 * 真正的问题：**标题太粗，承载不了细节**。
 *   检索时User只看到「我在帮User修复粒子视效并逐项对齐原版配置」×26，
 *   完全分不清哪条是「混合模式改 NormalBlending」、哪条是「bloom 溢光层没渲染」。
 *
 * 做法：同标题的卡，把 content 里的**差异片段**拼进标题
 *   例：「修复粒子视效…」→「修复粒子视效…：混合模式改 NormalBlending」
 *   只读侧处理（不改盘），幂等，可随时关。
 */
import { readCards, readTdaiRecords, readOwnIngest } from './source.js';

const MAX_GROUP = 40;      // 一组超过这么多就不动（太泛，补了也没意义）
const SUFFIX_MAX = 18;     // 补语最多这么长

/**
 * 从 content 里挑一句最能"区分"的话作为标题补语。
 *
 * [Round 21 二次修正] 原实现只看第一句，遇到「用户希望在 NextHubKVM 项目中实现…」
 *   这种**同前缀、差异在句尾**的内容就全军覆没（实测还剩 410 张重复）。
 *   现在改为：**先剥掉与同组卡共同的前缀**，再用剩下的差异部分当补语。
 */
function commonPrefixOf(texts) {
  if (!texts || texts.length < 2) return '';
  let pre = texts[0];
  for (const t of texts.slice(1)) {
    let i = 0;
    while (i < pre.length && i < t.length && pre[i] === t[i]) i++;
    pre = pre.slice(0, i);
    if (!pre) break;
  }
  return pre.length >= 4 ? pre : '';
}

function distinctSuffix(content, groupPrefix) {
  let t = String(content || '').replace(/\s+/g, ' ').trim();
  if (t.length < 8) return '';
  // 剥掉同组公共前缀，剩下的才是真正的差异
  if (groupPrefix && t.startsWith(groupPrefix)) t = t.slice(groupPrefix.length).trim();
  if (t.length < 6) return '';
  // 优先取带专有名词/英文/数字的片段（最能区分）
  const cands = t.split(/[，。；：,;:]/).map((x) => x.trim()).filter((x) => x.length >= 6);
  const scored = cands.map((c) => {
    let s = 0;
    if (/[a-zA-Z]{2,}/.test(c)) s += 3;        // 英文术语
    if (/\d/.test(c)) s += 2;                  // 数字/版本号
    if (/[A-Z]{2,}/.test(c)) s += 2;            // 大写缩写
    if (c.length >= 8 && c.length <= SUFFIX_MAX) s += 2;
    return { c, s };
  }).sort((a, b) => b.s - a.s);
  const best = scored[0];
  if (!best || best.s < 2) return '';
  let c = best.c;
  if (c.length > SUFFIX_MAX) {
    const cut = c.slice(0, SUFFIX_MAX);
    const p = Math.max(cut.lastIndexOf('、'), cut.lastIndexOf(' '));
    c = (p > 8 ? cut.slice(0, p) : cut).trim();
  }
  return c;
}

/**
 * 给一批卡做标题去重（纯函数，返回新数组，不改原对象）
 * @param {Array} cards 每张需要 id/title/content
 */
export function dedupeTitles(cards) {
  const list = Array.isArray(cards) ? cards : [];
  const groups = new Map();
  for (const c of list) {
    const k = String(c && c.title || '').replace(/\s+/g, '');
    if (!k) continue;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(c);
  }
  const out = [];
  for (const c of list) {
    const k = String(c && c.title || '').replace(/\s+/g, '');
    // [Round 21] 占位标题不补后缀 —— 「（无标题）」本来就没内容，补了更怪
    if (/^（无标题）$|^\(untitled\)$/i.test(k)) { out.push(c); continue; }
    const g = groups.get(k) || [];
    if (g.length <= 1 || g.length > MAX_GROUP) { out.push(c); continue; }
    const grpPrefix = commonPrefixOf(g.map((x) => String(x && x.content || '').replace(/\s+/g, ' ').trim()));
    const suf = distinctSuffix(c && c.content, grpPrefix);
    if (!suf) { out.push(c); continue; }
    // 避免补语和原题重复
    if (String(c.title || '').includes(suf.slice(0, 6))) { out.push(c); continue; }
    out.push(Object.assign({}, c, { title: String(c.title || '').slice(0, 24) + '：' + suf }));
  }
  return out;
}

// ── CLI：统计与预演 ──
if (process.argv[1] && process.argv[1].endsWith('dedupe-titles.mjs')) {
  const all = [];
  for (const c of readCards().alive) all.push(c);
  try { for (const c of (readTdaiRecords().cards || [])) all.push(c); } catch {}
  try { for (const c of (readOwnIngest().cards || [])) all.push(c); } catch {}
  const before = new Map();
  for (const c of all) { const k = String(c.title || '').replace(/\s+/g, ''); before.set(k, (before.get(k) || 0) + 1); }
  const after = dedupeTitles(all);
  const afterMap = new Map();
  for (const c of after) { const k = String(c.title || '').replace(/\s+/g, ''); afterMap.set(k, (afterMap.get(k) || 0) + 1); }
  const dupBefore = [...before.values()].filter((n) => n > 1).reduce((a, n) => a + n, 0);
  const dupAfter = [...afterMap.values()].filter((n) => n > 1).reduce((a, n) => a + n, 0);
  console.log('[标题去重]');
  console.log('  卡片总数        : ' + all.length);
  console.log('  重复标题的卡(前) : ' + dupBefore);
  console.log('  重复标题的卡(后) : ' + dupAfter);
  console.log('  改善            : ' + (dupBefore - dupAfter) + ' 张分清了');
  console.log('\n样例（同标题组 → 加补语后）:');
  const sample = [...before.entries()].filter(([k, n]) => n >= 3).slice(0, 2);
  for (const [k] of sample) {
    const grp = all.filter((c) => String(c.title || '').replace(/\s+/g, '') === k).slice(0, 3);
    const fixed = dedupeTitles(grp);
    console.log('  原: ' + k.slice(0, 34) + '  (' + grp.length + ' 张)');
    fixed.forEach((c, i) => console.log('    ' + (i + 1) + '. ' + String(c.title).slice(0, 52)));
  }
}
