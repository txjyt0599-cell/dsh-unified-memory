#!/usr/bin/env node
/**
 * diag-corroboration.mjs —— 「同一事实有几张卡背书」盘点
 * [2026-10-24 by Assistant · Round 46]
 *
 * 动机：一个结论如果被多张**独立来源**的卡支持，可信度应该更高。
 *
 * 但实测发现两件事，所以这个工具**只盘点、不改排序**：
 *   ① 高频实体全是泛词（文件 603 / 模型 550 / 路径 398）
 *      ⇒ 按「卡数」加权会让泛词霸榜，越加越糟。
 *   ② 同一事实的表述高度分散（16G / 16 G / 16GB…），还混着无关数字
 *      ⇒ 靠字符串匹配算「背书数」会算错（实测「9060XT 16G」只匹配到 6 张，
 *        而实际提到 9060 的有 40 张）。
 *
 * 结论：**交叉验证值得做，但需要语义级判定，不是字符串计数。**
 *   现阶段把它记成已知局限，并用这个工具人工盘点，不做自动加权。
 *
 * 用法：node scripts/diag-corroboration.mjs [--topic 9060]
 */
import { readCards, readTdaiRecords, readOwnIngest } from '../lib/hypergraph/source.js';

const argv = process.argv.slice(2);
const ti = argv.indexOf('--topic');
const topic = ti >= 0 ? String(argv[ti + 1] || '') : '';

const all = [];
for (const c of readCards().alive) all.push({ src: 'engram', c });
for (const c of (readTdaiRecords().cards || [])) all.push({ src: 'tdai', c });
for (const c of (readOwnIngest().cards || [])) all.push({ src: 'own', c });

console.log('══ 背书盘点 ══');
console.log('  总卡: ' + all.length);

if (!topic) {
  // 无 topic：给出「实体频次」的整体画像，并明确警告泛词风险
  const ENT = new Map();
  for (const { c } of all) {
    for (const e of (Array.isArray(c.entities) ? c.entities : [])) {
      const k = String(e).toLowerCase();
      ENT.set(k, (ENT.get(k) || 0) + 1);
    }
  }
  const top = [...ENT.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15);
  console.log('');
  console.log('── 被最多卡提到的实体（Top15）──');
  top.forEach(([e, n], i) => console.log('  ' + String(i + 1).padStart(2) + '. ' + String(n).padStart(4) + '  ' + e));
  console.log('');
  console.log('⚠️ 注意：上面这些高频项大多是**泛词**（文件/模型/路径/备份）。');
  console.log('   ⇒ 「提到它的卡多」不等于「这个结论更可信」。');
  console.log('   ⇒ 所以本工具**不做自动加权**，只供人工盘点。');
  process.exit(0);
}

// 有 topic：列出所有提到它的卡，按来源/会话分组
const hit = all.filter(({ c }) => {
  const t = String(c.title || '') + ' ' + String(c.summary || '') + ' ' + String(c.content || '').slice(0, 400);
  return t.toLowerCase().includes(topic.toLowerCase());
});
console.log('');
console.log('── 提到「' + topic + '」的卡: ' + hit.length + ' 张 ──');
const bySrc = new Map();
for (const { src } of hit) bySrc.set(src, (bySrc.get(src) || 0) + 1);
console.log('  来源分布: ' + JSON.stringify([...bySrc.entries()]));
// 按会话分组 = 独立来源
const bySession = new Map();
for (const { c } of hit) {
  const k = String(c.sessionId || c.sessionKey || c.id);
  bySession.set(k, (bySession.get(k) || 0) + 1);
}
console.log('  独立会话数: ' + bySession.size + '（这才是「独立背书」的口径）');
console.log('');
console.log('  样例:');
hit.slice(0, 8).forEach(({ src, c }) => {
  console.log('    [' + src + '] ' + String(c.title || '').slice(0, 34));
});
console.log('');
console.log('⚠️ 同一会话里说 10 遍，仍是一家之言 —— 卡数 ≠ 独立背书数。');
