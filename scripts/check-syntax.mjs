#!/usr/bin/env node
/**
 * check-syntax.mjs —— 对每一个**已提交**的 JS 文件做语法解析
 *
 * [2026-10-30 by Assistant]
 *
 * 为什么需要它：
 *   commit 3f116ad 的批量路径替换把 25 个文件改成了非法 JS：
 *     const ROOT = join(ROOT, '')lib';        ← 括号/引号错位
 *     29 处 join(ROOT, 'xxx'                   ← 少了右括号
 *   这些文件**没有一个被 lib/ import**，所以插件照常加载、smoke 照常通过，
 *   而 14 套自测脚本一跑就 SyntaxError（旧 runner 也不显示，于是没人发现）。
 *
 *   一句话：仓库里躺着一批"从来没被加载过、所以永远没人发现"的坏文件。
 *   这个脚本把它们全部过一遍 node --check。
 *
 * 用法：
 *   node scripts/check-syntax.mjs
 *   node scripts/check-syntax.mjs --json
 *
 * 退出码：0 = 全部可解析；1 = 有坏文件
 */
import { execFileSync } from 'node:child_process';

const asJson = process.argv.includes('--json');
const REPO = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const CODE = /\.(js|mjs|cjs)$/;
const SKIP = /(^|\/)(node_modules|_tmp)\//;

const files = execFileSync('git', ['ls-files'], { encoding: 'utf8', cwd: REPO })
  .split('\n').map((s) => s.trim()).filter((f) => f && CODE.test(f) && !SKIP.test(f));

const bad = [];
for (const f of files) {
  try {
    execFileSync(process.execPath, ['--check', f], { cwd: REPO, stdio: 'pipe' });
  } catch (e) {
    const out = String((e && (e.stderr || e.message)) || '');
    const m = out.match(/(SyntaxError|ReferenceError|Error):[^\n]*/);
    bad.push({ file: f, error: (m ? m[0] : 'unknown').slice(0, 160) });
  }
}

if (asJson) {
  console.log(JSON.stringify({ checked: files.length, bad }, null, 2));
} else {
  console.log('语法检查: ' + files.length + ' 个已提交的 JS 文件');
  if (bad.length === 0) {
    console.log('✅ 全部可解析');
  } else {
    console.log('❌ 有 ' + bad.length + ' 个文件解析失败（它们从没被加载过，所以在别处看不出来）:');
    for (const b of bad) console.log('   ' + b.file + '  →  ' + b.error);
  }
}
process.exitCode = bad.length === 0 ? 0 : 1;
