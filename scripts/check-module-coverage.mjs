#!/usr/bin/env node
/**
 * check-module-coverage.mjs —— 扫「仓库里有文件、但图上没有模块」
 *
 * [2026-10-27 by Assistant · 补 normify_sync 的盲区]
 *
 * 为什么需要它：
 *   normify_sync 只做 git diff + 已声明模块的 source 校验，
 *   **不扫「仓库里有哪些文件没有对应模块」**。
 *   实测（两个会话各自独立复现过）：
 *     新建 lib/scoring/_x.js 后 sync 报 changed_files:['…/_x.js']，
 *     但 new_files:[] 且 suggested_modules:[] ⇒ 它只把这文件列进"变了"，
 *     不告诉你"它需要建模块"。
 *   后果：validate 全绿 ≠ 图完整。实测曾有 18 个 lib 文件无模块，validate 仍 0 error。
 *
 * 用法：
 *   node scripts/check-module-coverage.mjs
 *   node scripts/check-module-coverage.mjs --json
 *
 * 退出码：0 = 全覆盖；1 = 有未覆盖文件（可接进 CI / verify）
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// [2026-10-30] 从脚本位置推导，别再写死开发机路径
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const STRUCT = 'normify-unified-memory';
const SCAN_DIRS = ['lib'];                       // 只扫源码，不扫 scripts/ 等
const EXT = /\.(js|mjs|py)$/;
const IGNORE = /(^|\/)(node_modules|_tmp|__tests__)\//;

function walk(dir, root, out = []) {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = dir + '/' + e.name;
    if (e.isDirectory()) { if (!IGNORE.test(p)) walk(p, root, out); }
    else if (EXT.test(e.name)) out.push(p.slice(root.length + 1).replace(/\\/g, '/'));
  }
  return out;
}

/**
 * 从 tree.json 里收集全部模块声明的 source 路径。
 *
 * [2026-10-27 修正] tree.json 的 modules 是**以 id 为键的对象**（不是数组）：
 *   { modules: { "pmem": {...}, "pmem.diary": {...} } }
 *   Assistant第一版按数组遍历，导致读到 0 条 source、把 77 个文件全误报成未覆盖。
 */
function coveredFromTree() {
  const treePath = STRUCT + '/tree.json';
  if (!existsSync(treePath)) return null;
  const tree = JSON.parse(readFileSync(treePath, 'utf8'));
  const covered = new Set();
  const collect = (m) => {
    if (!m || typeof m !== 'object') return;
    for (const s of m.source || []) if (s && s.path) covered.add(String(s.path).replace(/\\/g, '/'));
  };
  const mods = tree.modules;
  if (Array.isArray(mods)) mods.forEach(collect);
  else if (mods && typeof mods === 'object') Object.values(mods).forEach(collect);
  for (const t of tree.trees || []) {
    if (Array.isArray(t.modules)) t.modules.forEach(collect);
    else if (t.modules && typeof t.modules === 'object') Object.values(t.modules).forEach(collect);
    if (t.root) collect(t.root);
  }
  return covered;
}

const all = [];
for (const d of SCAN_DIRS) all.push(...walk(REPO + '/' + d, REPO));
const covered = coveredFromTree();
if (covered === null) {
  console.error('找不到 ' + STRUCT + '/tree.json —— 先跑 normify_build');
  process.exit(2);
}
const uncovered = all.filter(f => !covered.has(f));

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ ok: uncovered.length === 0, total: all.length, covered: all.length - uncovered.length, uncovered }, null, 2));
} else {
  console.log('源码文件: ' + all.length);
  console.log('已被模块覆盖: ' + (all.length - uncovered.length));
  console.log('未覆盖: ' + uncovered.length);
  if (uncovered.length) {
    console.log('');
    for (const f of uncovered) console.log('  ✗ ' + f);
    console.log('');
    console.log('修法：给这些文件建模块（或确认它们不该进架构图，加进白名单）');
  } else {
    console.log('✓ 全覆盖');
  }
}
process.exit(uncovered.length === 0 ? 0 : 1);
