#!/usr/bin/env node
/**
 * check-tracked-imports.mjs —— 扫「已提交的文件里，相对 import 指向了没提交的文件」
 *
 * [2026-10-30 by Assistant · 开源版 clone 跑不起来的事故复盘]
 *
 * 为什么需要它：
 *   2026-10-30 有使用者 clone 后直接 ERR_MODULE_NOT_FOUND：
 *   lib/index.js -> ./hypergraph/backend.js，而 lib/hypergraph/ 整个目录没进仓库。
 *   根因：.gitignore 里写了裸目录名 "hypergraph/"，git 会匹配**任意层级**同名目录，
 *         把源码目录 lib/hypergraph 一起排掉了（lib/dispatch 同病）。
 *
 *   为什么 37 套自测全绿却没发现：
 *     所有测试都是"在开发机上直接 import"——开发机上文件当然在。
 *     没有任何一条判据站在**「仓库里有什么」**这个视角。
 *
 *   这个脚本就是补那一条：只用 git ls-files 的结果当"世界"，
 *   不看工作区。只要某个相对 import 的落点不在已提交清单里，就红。
 *
 * 用法：
 *   node scripts/check-tracked-imports.mjs
 *   node scripts/check-tracked-imports.mjs --json
 *
 * 退出码：0 = 全部可解析；1 = 有断链（clone 下来必崩）
 */
import { execFileSync } from 'node:child_process';
import { dirname, resolve, join, relative } from 'node:path';

const asJson = process.argv.includes('--json');

// 以 git 仓库根为锚，脚本从任何子目录跑都成立
const REPO = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const toRepoPath = (abs) => relative(REPO, abs).replace(/\\/g, '/');

const tracked = execFileSync('git', ['ls-files'], { encoding: 'utf8', cwd: REPO })
  .split('\n')
  .map((s) => s.trim())
  .filter(Boolean);
const trackedSet = new Set(tracked);

const CODE = /\.(js|mjs|cjs|jsx|ts|mts|cts)$/;
const IMPORT_RE = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)['"](\.[^'"]+)['"]/g;

/** 一个相对路径可能落到的实体（Node ESM 语义：必须写扩展名，这里仍兼容目录/index） */
function candidates(base) {
  return [base, base + '.js', base + '.mjs', base + '.cjs', join(base, 'index.js'), join(base, 'index.mjs')];
}

/** 去掉行/块注释，避免把文档里的示例 import 当成真代码 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const broken = [];
let scanned = 0;

for (const file of tracked) {
  if (!CODE.test(file)) continue;
  const abs = resolve(REPO, file);
  let src;
  try { src = execFileSync('git', ['show', ':' + file], { encoding: 'utf8', cwd: REPO }); } catch { continue; }
  scanned++;
  const body = stripComments(src);
  let m;
  IMPORT_RE.lastIndex = 0;
  while ((m = IMPORT_RE.exec(body))) {
    const spec = m[1];
    const base = resolve(dirname(abs), spec);
    const hit = candidates(base).find((c) => trackedSet.has(toRepoPath(c)));
    if (!hit) broken.push({ file, spec });
  }
}

if (asJson) {
  console.log(JSON.stringify({ scanned, broken }, null, 2));
} else {
  console.log('检查文件数: ' + scanned + '（以 git 已跟踪清单为准）');
  if (broken.length === 0) {
    console.log('✅ 所有相对 import 都能在仓库里找到落点');
  } else {
    console.log('❌ 有 ' + broken.length + ' 处断链（clone 下来会 ERR_MODULE_NOT_FOUND）:');
    for (const b of broken) console.log('   ' + b.file + '  ->  ' + b.spec);
  }
}
process.exitCode = broken.length === 0 ? 0 : 1;
