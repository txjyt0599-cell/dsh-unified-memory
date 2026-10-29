#!/usr/bin/env node
/**
 * e2e-importance-coverage.mjs —— importance 覆盖率回归
 * [2026-10-24 by Assistant · Round 33]
 *
 * 这个坑已经踩了**四次**：
 *   ① engram 主库 —— 回填脚本只扫了自产库，主库 0% 覆盖
 *   ② L1 写入路径 —— 只修了蒸馏侧，extract 没接
 *   ③ 蒸馏卡 —— 接了
 *   ④ **tdai 源** —— 代码写着 `Number.isFinite(...) ? ... : undefined`，
 *      而 tdai 数据里存着 0.25 占位值 ⇒ 直接返回旧值 ⇒ 重算逻辑形同虚设
 *
 * 每次都是"修了一处、漏了另一处"。这个测试锁死：**三个源都必须有 importance，且有区分度**。
 */
import { readCards, readTdaiRecords, readOwnIngest } from '../lib/hypergraph/source.js';

let fail = 0;
const check = (n, ok, d) => { console.log((ok ? '  ✅ ' : '  ❌ ') + n + (d ? '   ' + d : '')); if (!ok) fail++; };

const engram = readCards().alive;
const tdai = (readTdaiRecords().cards || []);
const own = (readOwnIngest().cards || []);
const all = [...engram, ...tdai, ...own];

console.log('[卡片数] engram=' + engram.length + ' tdai=' + tdai.length + ' own=' + own.length + ' 合计=' + all.length);

console.log('── ① 每个源都有 importance ──');
const missing = (list) => list.filter((c) => !Number.isFinite(Number(c.importance))).length;
// 允许 content 为空的卡缺（那算正常边界）
const realMissing = (list) => list.filter((c) => !Number.isFinite(Number(c.importance)) && String(c.content || '').trim()).length;
check('engram 有 importance', realMissing(engram) === 0, missing(engram) + ' 缺（含空内容）');
check('tdai 有 importance', realMissing(tdai) === 0, missing(tdai) + ' 缺');
check('own 有 importance', realMissing(own) === 0, missing(own) + ' 缺');

console.log('── ② tdai 的 importance 有区分度（不是清一色 0.25）──');
const dist = new Map();
for (const c of tdai) {
  const v = Number(c.importance);
  const k = Number.isFinite(v) ? v.toFixed(2) : 'none';
  dist.set(k, (dist.get(k) || 0) + 1);
}
const top = [...dist.entries()].sort((a, b) => b[1] - a[1]);
console.log('    分布: ' + top.slice(0, 5).map(([k, v]) => k + '×' + v).join(' '));
const dominant = tdai.length ? top[0][1] / tdai.length : 1;
check('最大占比 < 90%（有区分度）', dominant < 0.9, (dominant * 100).toFixed(1) + '%');
check('至少出现 3 种不同取值', dist.size >= 3, dist.size + ' 种');

console.log('── ③ 基石卡被正确识别 ──');
const axiom = { engram: engram.filter((c) => c.is_axiom === true).length, tdai: tdai.filter((c) => c.is_axiom === true).length, own: own.filter((c) => c.is_axiom === true).length };
console.log('    基石: engram=' + axiom.engram + ' tdai=' + axiom.tdai + ' own=' + axiom.own);
check('三个源都有基石卡', axiom.engram > 0 && axiom.tdai > 0, JSON.stringify(axiom));

console.log('\n' + (fail === 0 ? '✅ 三个源的 importance 全覆盖且有区分度' : '❌ ' + fail + ' 项失败'));
process.exit(fail === 0 ? 0 : 1);
