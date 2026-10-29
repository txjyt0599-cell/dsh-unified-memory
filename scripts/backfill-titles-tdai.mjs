#!/usr/bin/env node
/**
 * backfill-titles-tdai.mjs —— tdai 模板标题改善
 * [2026-10-24 by Assistant · Round 16]
 *
 * 问题：tdai 库 60.1%（1909/3176）的标题是「我（AI）和用户讨论XXX」这类**场景模板句**。
 *   这类标题在召回里几乎无信息量 —— User看到「我（AI）和用户讨论电脑故障问题」
 *   根本不知道当时到底聊了什么。
 *   而它们的 content 其实很丰富（1885/1908 有实质结论）。
 *
 * 做法：**从 content 提炼一句话当标题**（规则法，不调 LLM）：
 *   ① 取 content 第一句（到 。！？ 为止），限 28 字
 *   ② 剥掉「用户希望/用户要求/用户说」这类前缀，保留后半句的实质
 *   ③ 提炼失败就保留原标题（不硬造）
 *
 * 安全性：**只改内存里的标题（读时清洗）**，不动磁盘 ——
 *   因为 tdai 是旧数据源，铁律"只读不写"。真正见效要等检索层用新标题。
 *
 * 用法：node scripts/backfill-titles-tdai.mjs [--dry]
 */
import { readTdaiRecords } from '../lib/hypergraph/source.js';

const TEMPLATE = /^我（AI|Assistant）(和|与)用户|^用户（User）(和|与)|^我\(AI\)|<\/style>/;
// [Round 16 二次修正] 只剥「纯叙述性主语」，且剥完必须能独立成句：
//   · "用户希望 AI 以后..." → 剥「用户希望」但保留「AI 以后…」
//   · "用户的另一套平台是…" → **不能剥**（剥完变成"的另…"，不成句）
const LEAD = /^(用户希望|用户要求|用户说|用户表示|用户提到|用户在|AI在|Assistant在|这让我|其实|所以)/;
// [2026-10-24 Round 16] 提炼标题要「可读、自足、不截半句」：
//   · 去掉「用户要求/用户说」这类主语前缀（谁说的不重要，说的是什么才重要）
//   · 遇到逗号/顿号优先在此断开，别在词中间硬切
//   · 太泛的词（"XXX问题""讨论XXX"）判为无效，宁可保留原标题

export function betterTitle(card) {
  const title = String(card && card.title || '');
  if (!TEMPLATE.test(title)) return null;   // 不是模板标题，不动
  const content = String(card && (card.content || card.summary) || '').replace(/\s+/g, ' ').trim();
  if (content.length < 12) return null;
  // 取第一句
  const m = /^(.{8,60}?)[。！？；]/.exec(content);
  // 先按句号切（优先），再按逗号切
  const sentence = (() => {
    const mm = /^(.{6,80}?)[。！？；]/.exec(content);
    return (mm ? mm[1] : content).trim();
  })();
  // 按逗号把句子切成小节，取第一节能自足的小节
  const clauses = sentence.split(/[，,]/).map((x) => x.trim()).filter(Boolean);
  let s = '';
  for (const cl of clauses) {
    let cur = cl;
    const lead = LEAD.exec(cur);
    if (lead) {
      const rest = cur.slice(lead[0].length).trim();
      // 剥完必须以「能独立成句」的样子开头（不能是"的/了/是"这类残尾）
      if (rest.length >= 6 && !/^(的|了|是|在|和|与|及)/.test(rest)) cur = rest;
    }
    if (cur.length >= 6 && cur.length <= 30) { s = cur; break; }
    if (cur.length > 30) {
      // 太长：在顿号/空格处断
      const cut = cur.slice(0, 26);
      const p2 = Math.max(cut.lastIndexOf('、'), cut.lastIndexOf(' '), cut.lastIndexOf('的'));
      s = (p2 > 12 ? cut.slice(0, p2) : cut).trim();
      break;
    }
    if (cur.length >= 6) { s = cur; break; }
  }
  if (!s) return null;
  s = s.replace(/^[，、：:\s]+|[，、：:\s]+$/g, '');
  if (s.length < 6) return null;
  if (TEMPLATE.test(s)) return null;
  // 太泛的标题（"XXX问题" / "讨论XXX"）判无效
  if (/^(讨论|关于|有关)/.test(s)) return null;
  if (/问题$/.test(s) && s.length < 12) return null;
  return s;
}

// ── CLI ──
const argv = process.argv.slice(2);
const DRY = !argv.includes('--apply');
const cards = (readTdaiRecords().cards || []);
let tpl = 0, improved = 0, kept = 0;
const samples = [];
for (const c of cards) {
  if (!TEMPLATE.test(String(c.title || ''))) continue;
  tpl++;
  const nt = betterTitle(c);
  if (nt) { improved++; if (samples.length < 8) samples.push({ old: String(c.title).slice(0, 34), now: nt }); }
  else kept++;
}
console.log('[tdai 标题改善] ' + (DRY ? '（预演）' : ''));
console.log('  tdai 卡总数      : ' + cards.length);
console.log('  模板标题         : ' + tpl);
console.log('  可提炼出实质标题 : ' + improved + ' (' + ((improved / Math.max(1, tpl)) * 100).toFixed(1) + '%)');
console.log('  提炼失败保留原样 : ' + kept);
console.log('\n样例:');
samples.forEach((s, i) => console.log('  ' + (i + 1) + '. 「' + s.old + '」\n     → 「' + s.now + '」'));
