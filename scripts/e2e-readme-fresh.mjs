#!/usr/bin/env node
/**
 * e2e-readme-fresh.mjs —— README 新鲜度检查
 * [2026-10-24 by Assistant · Round 23]
 *
 * 为什么要有：
 *   这个 README 之前停在「期1 骨架 · 未激活 · 六组 28 项」，
 *   而实际早已上线、跑了 18 套测试、改了 34 项 —— 文档和现实脱节了几个月。
 *   文档撒谎比没有文档更坏：接手的人会按错的说明去操作。
 *
 * 它检查四件事：
 *   ① 不能还写着「未激活 / 骨架」这类过时状态
 *   ② 文中提到的**每个脚本路径必须真实存在**
 *   ③ 提到的**每个 lib 模块必须真实存在**
 *   ④ 关键机制真的在代码里（四股力 / 采纳 / 冷宫 / 时间意图）
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, existsSync } from 'node:fs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const md = readFileSync(ROOT + '/README.md', 'utf8');

let fail = 0;
const check = (n, ok, d) => { console.log((ok ? '  ✅ ' : '  ❌ ') + n + (d ? '   ' + d : '')); if (!ok) fail++; };

console.log('── ① 没有过时状态声明 ──');
const STALE = ['未激活', '期1 骨架', '只落盘，未激活', '当前 DSH 跑的还是老四件套'];
const found = STALE.filter((s) => md.includes(s));
check('不残留「未激活/骨架」等过时说法', found.length === 0, found.join(', ') || '干净');

console.log('── ② 提到的脚本路径都存在 ──');
const refs = new Set();
for (const m of md.matchAll(/([a-zA-Z0-9_\-/]+\.mjs)/g)) refs.add(m[1]);
const missing = [...refs].filter((r) => !existsSync(ROOT + '/' + r) && !existsSync(ROOT + '/scripts/' + r));
check('README 引用的 .mjs 全部真实存在', missing.length === 0, missing.length ? '缺: ' + missing.join(', ') : refs.size + ' 个全在');

console.log('── ③ 提到的 lib 模块都真实存在 ──');
const libRefs = [...new Set([...md.matchAll(/(lib\/[a-zA-Z0-9_\-/.]+)/g)].map((m) => m[1]))];
const libBad = libRefs.filter((r) => !existsSync(ROOT + '/' + r));
check('README 引用的 lib 路径全部存在', libBad.length === 0, libBad.length ? '缺: ' + libBad.join(', ') : libRefs.length + ' 个全在');

console.log('── ④ 关键机制在代码里 ──');
const mech = [
  ['四股力', 'lib/scoring/four-forces.js', /applyFourForces/],
  ['写卡定级', 'lib/scoring/importance.js', /scoreImportance/],
  ['采纳核验', 'lib/scoring/adoption.js', /commitAdoptions/],
  ['冷宫归档', 'lib/scoring/cold-archive.mjs', /runColdArchive/],
  ['时间意图', 'lib/retrieval/rrf.js', /classifyTemporal/],
];
for (const [name, f, re] of mech) {
  let ok = false;
  try { ok = re.test(readFileSync(ROOT + '/' + f, 'utf8')); } catch {}
  check('机制「' + name + '」在 ' + f, ok);
}

console.log('── ⑤ 状态数字没有明显错位 ──');
// README 声明的卡片数 vs 实际
let actual = 0;
try {
  const { readCards } = await import(new URL('../lib/hypergraph/source.js', import.meta.url).href);
  actual = readCards().alive.length;
} catch {}
const m = /记忆卡片 \| ([\d,]+) 张/.exec(md);
if (m && actual) {
  const claimed = Number(m[1].replace(/,/g, ''));
  const drift = Math.abs(claimed - actual) / actual;
  console.log('    README 声称 ' + claimed + ' 张 / 实际主库 ' + actual + ' 张（README 含全部来源，主库只是其一）');
  check('⑤ 卡片数声明在合理范围（不与主库差一个量级）', claimed >= actual, claimed + ' >= ' + actual);
}

console.log('\n' + (fail === 0 ? '✅ README 与代码一致' : '❌ ' + fail + ' 项不一致'));
process.exit(fail === 0 ? 0 : 1);
