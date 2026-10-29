#!/usr/bin/env node
/**
 * e2e-l1-importance.mjs —— L1 写入侧带 importance 的回归测试
 * [2026-10-24 by Assistant · Round 11]
 *
 * 抓到的零接线：L1 提取落盘时没有 importance/is_axiom，
 * 只有蒸馏卡有 ⇒ 新产的 L1 卡永远缺代谢维度（回填只补了存量）。
 * 这个文件有**两处**产卡路径（LLM 主路径 + 启发式兜底），必须都带。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = fileURLToPath(new URL('./', import.meta.url)).replace(/[\\/]$/, '');

const SRC = join(ROOT, '')lib/ingest/extract.js';
const s = readFileSync(SRC, 'utf8');

let fail = 0;
const check = (n, ok, d) => { console.log((ok ? '  ✅ ' : '  ❌ ') + n + (d ? '   ' + d : '')); if (!ok) fail++; };

// ① 每处产卡对象都带 importance
const sites = s.split("id: 'pm_' + Date.now()").length - 1;
console.log('[扫描] 文件里产卡点: ' + sites + ' 处');
check('① 恰好两处产卡路径', sites === 2, sites + ' 处');

// ② 每个产卡块里都要有 importance 字段（用 id 位置往后 600 字符找）
const idxs = [];
let i = -1;
while ((i = s.indexOf("id: 'pm_' + Date.now()", i + 1)) !== -1) idxs.push(i);
for (let k = 0; k < idxs.length; k++) {
  const block = s.slice(idxs[k], idxs[k] + 900);
  const hasImp = block.includes('importance: imp');
  check('产卡点 #' + (k + 1) + ' 带 importance', hasImp, hasImp ? '' : '缺！');
}

// ③ 生产环境已有的 L1 卡（存量）是否都补上了
const { readOwnIngest } = await import('../lib/hypergraph/source.js');
const own = readOwnIngest();
const l1 = (own.cards || []).filter((c) => String(c.id).startsWith('pm:'));
const withImp = l1.filter((c) => Number.isFinite(Number(c.importance)));
console.log('[存量] L1 卡 ' + l1.length + ' 张，带 importance ' + withImp.length + ' 张');
check('③ 存量 L1 卡都已有 importance', l1.length > 0 && withImp.length === l1.length, withImp.length + '/' + l1.length);

console.log('\n' + (fail === 0 ? '✅ 全部通过' : '❌ ' + fail + ' 项失败'));
process.exit(fail === 0 ? 0 : 1);
