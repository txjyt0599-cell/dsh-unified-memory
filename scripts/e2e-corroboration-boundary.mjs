#!/usr/bin/env node
/**
 * e2e-corroboration-boundary.mjs —— 交叉验证的边界（**不做**什么）
 * [2026-10-24 by Assistant · Round 46]
 *
 * 这轮的结论是「**不实现**自动交叉验证加权」，理由要用测试锁住：
 *   ① 按「提到某词的卡数」加权 ⇒ 泛词霸榜
 *      实测：文件 603 / 模型 550 / 路径 398 / 备份 388 / 参数 369
 *   ② 同一事实表述分散 ⇒ 字符串匹配算不准
 *      实测：「9060XT 16G」只匹配到 6 张，而提到 9060 的有 114 张
 *   ③ 「卡数」≠「独立背书数」
 *      实测：114 张卡来自 105 个独立会话 —— 但同一会话里说 10 遍仍是一家之言
 *
 * 这个测试的价值：**防止以后有人（包括未来的Assistant）一拍脑袋
 *   把「提及次数」加进排序权重，把检索搞坏。**
 */
import { readCards } from '../lib/hypergraph/source.js';

let fail = 0;
const check = (n, ok, d) => { console.log((ok ? '  ✅ ' : '  ❌ ') + n + (d ? '   ' + d : '')); if (!ok) fail++; };

const all = readCards().alive;

// ── ① 泛词霸榜证据 ──
console.log('── ① 高频实体是泛词（不能按次数加权）──');
const ENT = new Map();
for (const c of all) {
  for (const e of (Array.isArray(c.entities) ? c.entities : [])) {
    const k = String(e).toLowerCase();
    ENT.set(k, (ENT.get(k) || 0) + 1);
  }
}
const top = [...ENT.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
console.log('    Top5: ' + top.slice(0, 5).map(([e, n]) => e + '×' + n).join(' / '));
const GENERIC = ['文件', '模型', '路径', '备份', '参数', '日志', '窗口', '配置'];
const genericInTop = top.filter(([e]) => GENERIC.includes(e)).length;
check('Top10 里有大量泛词（≥4 个）⇒ 次数加权会拉偏', genericInTop >= 4, genericInTop + ' 个泛词');

// ── ② 表述分散证据 ──
console.log('── ② 同一事实表述分散（字符串匹配算不准）──');
const about9060 = all.filter((c) => /9060/i.test(String(c.title || '') + String(c.content || '').slice(0, 300)));
const strict16 = about9060.filter((c) => /9060X?T?\s*(是|为)?\s*16\s*G/i.test(String(c.title || '') + String(c.content || '').slice(0, 300)));
console.log('    提到 9060: ' + about9060.length + ' 张，其中严格匹配「9060...16G」: ' + strict16.length + ' 张');
check('严格匹配数远少于提及总数（说明表述分散）', strict16.length < about9060.length * 0.5,
  strict16.length + ' vs ' + about9060.length);

// ── ③ 卡数 ≠ 独立背书 ──
console.log('── ③ 卡数 ≠ 独立背书数 ──');
const bySession = new Map();
for (const c of about9060) {
  const k = String(c.sessionId || c.sessionKey || c.id);
  bySession.set(k, (bySession.get(k) || 0) + 1);
}
console.log('    9060 相关: ' + about9060.length + ' 张卡 / ' + bySession.size + ' 个独立会话');
check('卡数与独立会话数不等（同一会话可产多张）', about9060.length !== bySession.size,
  about9060.length + ' vs ' + bySession.size);
const multi = [...bySession.values()].filter((n) => n > 1).length;
check('存在"同一会话多张卡"的情况', multi > 0, multi + ' 个会话产出多张');

console.log('');
console.log('── 结论 ──');
console.log('  ⇒ 交叉验证**值得做**，但必须是语义级判定（实体/关系），');
console.log('    不是「某词出现多少次」。现阶段**不实现**自动加权，');
console.log('    只用 diag-corroboration.mjs 人工盘点。');

console.log('');
console.log(fail === 0 ? '✅ 边界已确认（不做自动加权是对的）' : '❌ ' + fail + ' 项失败');
process.exit(fail === 0 ? 0 : 1);
