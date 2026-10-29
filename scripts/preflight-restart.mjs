#!/usr/bin/env node
/**
 * scripts/preflight-restart.mjs —— 重启前预检（防"重启完插件没起来"）
 * [2026-10-24 by Assistant · goal round 6]
 *
 * 为什么要有它：
 *   插件一旦 apply() 抛错，DSH 加载失败 ⇒ 记忆整段消失，
 *   而症状是"重启后Assistant什么都不记得了"——那是最难排查的一类事故。
 *   本脚本在重启前把三件事验完：
 *     ① 全库语法（node --check）
 *     ② 相对 import 不断链
 *     ③ 用**真实 profile 配置**跑一遍 apply，确认注册了 section + 日记工具，且 dispose 干净
 *
 * 用法：node scripts/preflight-restart.mjs
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { dataPath } from '../lib/paths.js';

const ROOT = 'D:/dsh-plugins/dsh-unified-memory';
let fail = 0;
const step = (n) => console.log('\n── ' + n + ' ──');
const bad = (m) => { console.log('  ✗ ' + m); fail++; };

// ── ① 语法 ──
step('① 全库语法');
const files = [];
function walk(d) {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const p = join(d, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p); }
    else if (/\.(js|mjs)$/.test(e.name)) files.push(p);
  }
}
walk(join(ROOT, 'lib')); walk(join(ROOT, 'scripts'));
let synBad = 0;
for (const f of files) {
  try { execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' }); }
  catch { bad('语法错: ' + f.replace(ROOT + '/', '')); synBad++; }
}
console.log('  检查 ' + files.length + ' 个文件，语法错误 ' + synBad + ' 个');

// ── ② import 闭环 ──
step('② 相对 import 闭环');
const RE = /from\s+['"](\.[^'"]+)['"]/g;
let impTotal = 0, impBad = 0;
for (const f of files) {
  const src = readFileSync(f, 'utf8');
  let m;
  while ((m = RE.exec(src))) {
    impTotal++;
    const t = resolve(dirname(f), m[1]);
    const cands = [t, t + '.js', t + '.mjs', join(t, 'index.js')];
    if (!cands.some((c) => existsSync(c))) { bad('断链: ' + f.replace(ROOT + '/', '') + ' → ' + m[1]); impBad++; }
  }
}
console.log('  相对 import ' + impTotal + ' 条，断链 ' + impBad + ' 条');

// ── ③ 真实配置 apply ──
step('③ 真实配置 apply');
const { apply, inject } = await import('file:///' + ROOT + '/lib/index.js');
console.log('  inject = ' + JSON.stringify(inject));
const cfg = {
  enabled: true, emit: 'section', freezePerSession: true,
  injectMaxChars: 8000, budgetTokens: 450, order: 0.6,
  hypergraph: { indexRoot: dataPath('hypergraph') },
  workingMemoryDir: dataPath('working'),
  retrieval: { l0Enabled: true, l0RecentDays: 30, sourceWeight: 0.85, topicBoost: 0.15 },
  logs: { dir: dataPath('logs') },
  __resetMerge: true,
};
const reg = { sections: [], events: new Map(), tools: [] };
const ctx = {
  on(n, fn) { if (!reg.events.has(n)) reg.events.set(n, []); reg.events.get(n).push(fn); return () => {}; },
  effect(fn) { const d = fn(); return typeof d === 'function' ? d : () => {}; },
  get() { return undefined; },
  logger: { info() {}, warn() {}, debug() {}, error() {} },
  systemPrompt: { section(o) { reg.sections.push(o); return () => {}; }, context() { return () => {}; } },
  tools: { register(t) { reg.tools.push(t); return () => {}; } },
};
let dispose = null, err = null;
try { dispose = apply(ctx, cfg); } catch (e) { err = e; }
if (err) bad('apply 抛错: ' + err.message);
console.log('  section 数 = ' + reg.sections.length + (reg.sections.length === 1 ? ' ✓' : ' ✗'));
if (reg.sections.length !== 1) fail++;
const toolNames = reg.tools.map((t) => t && t.name);
const expected = ['diary_write', 'diary_config', 'memory_search', 'memory_get', 'memory_refute'];
const toolsOk = expected.every((t) => toolNames.includes(t)) && reg.tools.length === 5;
console.log('  工具 = [' + toolNames.join(', ') + ']' + (toolsOk ? ' ✓' : ' ✗'));
if (!toolsOk) fail++;
const events = [...reg.events.keys()];
console.log('  钩子 = ' + events.join(', '));
for (const need of ['agent/pre-step', 'agent/turn-stopping', 'session/flush']) {
  if (!events.includes(need)) bad('缺钩子: ' + need);
}
let derr = null;
try { if (typeof dispose === 'function') dispose(); } catch (e) { derr = e; }
if (derr) bad('dispose 抛错: ' + derr.message);
console.log('  dispose ' + (derr ? '✗' : '✓ 干净'));

// ── ④ [2026-10-24 Round 23] README 新鲜度 ──
//   文档撒谎比没文档更坏。之前 README 停在「未激活·六组28项」，实际早就是另一回事。
step('④ README 与代码一致');
try {
  const { execFileSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const p2 = fileURLToPath(new URL('./e2e-readme-fresh.mjs', import.meta.url));
  execFileSync(process.execPath, [p2], { stdio: 'pipe' });
  console.log('  ✓ README 与代码一致');
} catch (e) {
  bad('README 与代码不一致（跑 node scripts/e2e-readme-fresh.mjs 看详情）');
}

step('结论');
console.log(fail === 0 ? '✅ 重启安全（' + files.length + ' 文件 / ' + impTotal + ' import / apply / README 全过）' : '❌ ' + fail + ' 项问题，先修再重启');
process.exit(fail === 0 ? 0 : 1);
