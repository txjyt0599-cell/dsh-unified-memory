#!/usr/bin/env node
/**
 * audit-card-fields.mjs —— 产卡路径字段完整性审计
 * [2026-10-24 by Assistant · Round 12]
 *
 * 这个项目反复栽在「某条产卡路径漏字段」上：
 *   · entities 漏透传 ⇒ 图是空的
 *   · createdAt 丢 ⇒ 越近越详细失效
 *   · importance 只有蒸馏有、L1 没有 ⇒ 代谢维度对主力卡无效
 * 每次都是"修了一个路径，另外两处还在漏"。
 *
 * 这个审计把所有**真正落盘产卡**的位置找出来，逐个检查必须字段。
 * 判据：产卡对象（含 id: 或 engrams 落盘）必须带这些键。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'lib');
const REQUIRED = ['importance', 'is_axiom', 'createdAt', 'entities'];

// 产卡标志：出现这些说明在构造一张要落盘的卡
const SIGNATURES = [
  "id: 'pm_' + Date.now()",       // L1 卡
  'id, createdAt: nowMs',          // 蒸馏卡
  "id: 'pmi_'",                    // 预留
];

function walk(d, out = []) {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const p = join(d, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p, out); }
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}
const files = walk(ROOT);

let sites = [];
for (const f of files) {
  const s = readFileSync(f, 'utf8');
  for (const sig of SIGNATURES) {
    let i = -1;
    while ((i = s.indexOf(sig, i + 1)) !== -1) {
      // 往前 200 找到对象开头，往后 1200 作为该卡构造块
      const start = Math.max(0, s.lastIndexOf('{', i) - 100);
      const block = s.slice(start, i + 1200);
      const line = s.slice(0, i).split('\n').length;
      sites.push({ file: f.replace(ROOT + '/', ''), line, block: block, sig });
    }
  }
}

console.log('[审计] 找到 ' + sites.length + ' 处产卡构造点');
let fail = 0;
for (const st of sites) {
  const miss = REQUIRED.filter((k) => !st.block.includes(k + ':') && !st.block.includes(k + ' ='));
  const ok = miss.length === 0;
  console.log((ok ? '  ✅ ' : '  ❌ ') + st.file + ':' + st.line + (ok ? '  字段齐全' : '  缺: ' + miss.join(', ')));
  if (!ok) fail++;
}

console.log('\n' + (fail === 0 ? '✅ 所有产卡点字段齐全' : '❌ ' + fail + ' 处缺字段'));
process.exit(fail === 0 ? 0 : 1);
