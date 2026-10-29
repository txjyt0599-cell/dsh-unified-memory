#!/usr/bin/env node
/**
 * e2e-title-quality.mjs —— 召回标题质量回归
 * [2026-10-24 by Assistant · Round 16]
 *
 * 抓到的真问题：tdai 库 60%（1859/3176）的标题是「我（AI）和用户讨论XXX」这类
 * 场景模板句 —— 召回时只看到「讨论电脑故障问题」，根本不知道聊了什么。
 * 而它们的 content 其实很丰富（1885/1908 有实质结论）。
 *
 * 修法：从 content 提炼一句能自足的短句（规则法，零 LLM）。
 * 本测试锁四件事：
 *   ① 模板标题必须基本清零
 *   ② 提炼出来的标题要是「人话」（不是模板句、不是纯符号）
 *   ③ 不能有 HTML / 时间戳 / 占位符残留
 *   ④ 提炼失败必须保留原标题（不能变空）
 */
import { readTdaiRecords } from '../lib/hypergraph/source.js';
import { betterTdaiTitle } from '../lib/ingest/title-clean.js';

const cards = (readTdaiRecords().cards || []);
let fail = 0;
const check = (n, ok, d) => { console.log((ok ? '  ✅ ' : '  ❌ ') + n + (d ? '   ' + d : '')); if (!ok) fail++; };
// [Round 16] 判据要准：不是「以我在开头」就坏，而是「只有套话、没有具体信息」才坏。
//   坏例：「我（AI）和用户讨论电脑故障问题」—— 去掉主语后只剩「讨论电脑故障问题」，泛
//   好例：「我在和User排查 dsh-browser 接入问题」—— 有具体对象（dsh-browser），可读
//   判据：以「我在/我（xx）」开头 **且** 剥掉主语后 <12 字 **且** 不含英文/数字/专有名词
const TPL = /^我[（(][^）)]{0,10}[）)]|^我在(和|与)/;
function isVagueTemplate(t) {
  const s = String(t || '');
  if (!TPL.test(s)) return false;
  // 剥主语
  const rest = s
    .replace(/^我[（(][^）)]{0,10}[）)]\s*/, '')
    .replace(/^(和|与|协助|为|帮)\s*(用户|User|Assistant)?[（(][^）)]{0,6}[）)]\s*/, '')
    .replace(/^(和|与|协助|为|帮)\s*(用户|User|Assistant)\s*/, '')
    .trim();
  if (rest.length >= 12) return false;                    // 够长 = 有内容
  if (/[a-zA-Z0-9]/.test(rest)) return false;             // 含英文/数字 = 有具体对象
  return true;                                            // 又短又纯中文 = 套话
}

console.log('[tdai 卡 ' + cards.length + ' 张]\n');

// ① 模板标题清零
const tpl = cards.filter((c) => isVagueTemplate(c.title));
check('① 套话标题基本清零（<1%）', tpl.length / cards.length < 0.01,
  tpl.length + ' 张 (' + ((tpl.length / cards.length) * 100).toFixed(2) + '%)');
if (tpl.length) tpl.slice(0, 3).forEach((c) => console.log('     · ' + String(c.title).slice(0, 36)));

// ③ 无脏残留
const dirty = cards.filter((c) => {
  const t = String(c.title || '');
  return /<\/?[a-zA-Z]/.test(t) || /\d{4}-\d{2}-\d{2}T/.test(t) || /用户（未具名）/.test(t);
});
check('③ 无 HTML/时间戳/占位符残留', dirty.length / cards.length < 0.005,
  dirty.length + ' 张 (' + ((dirty.length / cards.length) * 100).toFixed(2) + '%)');

// ② 标题是人类可读（不是纯符号、长度合理）
const bad = cards.filter((c) => {
  const t = String(c.title || '').trim();
  return t.length < 2 || /^[\s\p{P}\p{S}]+$/u.test(t);
});
check('② 标题都是可读文本（非纯符号）', bad.length === 0, bad.length + ' 张');

// ④ 提炼函数：模板句有内容时能提炼，没内容时返回 null（保留原样）
const withContent = betterTdaiTitle('我（AI）和用户讨论电脑故障问题', '用户要求AI在回答电脑故障排查问题时，不需要记住具体配件配置。');
check('④a 有实质内容 → 能提炼', typeof withContent === 'string' && withContent.length >= 6, JSON.stringify(withContent));
const noContent = betterTdaiTitle('我（AI）和用户讨论电脑故障问题', '');
check('④b 没内容 → 返回 null（保留原标题，不硬造）', noContent === null);
const notTpl = betterTdaiTitle('示例设备A再生示例单据的正确流程', '正文随便');
check('④c 非模板标题 → 不动', notTpl === null);

// ⑤ 抽样展示（人工可读性）
console.log('\n[抽样：改进后的 tdai 标题]');
cards.slice(0, 6).forEach((c) => console.log('  · ' + String(c.title).slice(0, 42)));

console.log('\n' + (fail === 0 ? '✅ 全部通过' : '❌ ' + fail + ' 项失败'));
process.exit(fail === 0 ? 0 : 1);
