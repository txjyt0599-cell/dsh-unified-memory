#!/usr/bin/env node
/**
 * audit-criteria-numbers.mjs —— 复验判据手册引用的数字（只读）
 * [2026-10-31 by Assistant]
 *
 * 手册 CRITERIA-HANDBOOK-v0.1 里写了三个数字：
 *   标题碎片 27.3% / 标题含表格或代码 4.6% / note+session 36.2%
 * 这个脚本让它们**任何人跑一遍都能复现**。
 *
 * 用法：PM_DATA_ROOT=<数据根> node scripts/audit-criteria-numbers.mjs
 */
import { readFileSync, existsSync } from 'node:fs';

const REPO = new URL('..', import.meta.url).pathname.replace(/^\//, '');
const LIB = 'file:///' + REPO.replace(/^\/+/, '') + 'lib/';
const { dataPath } = await import(LIB + 'paths.js');

const f = dataPath('engram-relay/engrams.jsonl');
if (!existsSync(f)) {
  console.log("找不到主库:", f);
  console.log("请设置 PM_DATA_ROOT 指向数据根");
  process.exit(2);
}

const rows = [];
for (const line of readFileSync(f, 'utf8').split('\n')) {
  if (!line) continue;
  let o; try { o = JSON.parse(line); } catch { continue; }
  rows.push(o);
}
const N = rows.length;
if (!N) { console.log("主库为空"); process.exit(2); }
const pct = (x) => ((x / N) * 100).toFixed(1);

// 标题以字母/引号/替换符开头 => 被截断的碎片
const RE_FRAG = /^[a-zA-Z"'\uFFFD]/;
const frag = rows.filter((o) => RE_FRAG.test(String(o.title || ""))).length;
// 标题含表格竖线或代码标签
const RE_TBL = /[|`]|<div|class=/;
const tbl = rows.filter((o) => RE_TBL.test(String(o.title || ""))).length;
// 过程噪音高发区
const noteSess = rows.filter((o) => o.kind === "note" && o.layer === "session").length;

console.log("════ 判据手册数字复验 ════");
console.log("数据源:", f);
console.log("总卡数:", N);
console.log("");
console.log("D2 标题碎片       =", frag, "(" + pct(frag) + "%)   手册 27.3%");
console.log("D2 标题含表格/码  =", tbl, "(" + pct(tbl) + "%)   手册 4.6%");
console.log("D5 note+session   =", noteSess, "(" + pct(noteSess) + "%)   手册 36.2%");
console.log("");
console.log("注意：这三个数字是**归纳依据**，不是阈值。它们说明坏卡确实大量存在，");
console.log("     不能推出「这些卡全都该丢」—— 有些 note 记录了关键决策理由（见手册 U2）。");