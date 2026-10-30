/**
 * selftest-hotreload-exec.mjs —— 真执行模块验收（2026-10-28）
 *
 * ## 本套是从**一次真实翻车**里长出来的
 *   19:43 真跑了一次 hotreload_apply{confirm:true}：
 *     steps = precheck ok → armed rescue → scheduled reload → disposed self
 *     **然后插件再也没回来**（工具全消失，日志里连 rescue 都没有）。
 *
 * ## 三个真缺陷 ⇒ 三条断言
 *   E1 没有外部重装器 ⇒ **必须拒绝自拆**（不许拆了自己装不回来）
 *   E2 有外部重装器 ⇒ 才允许，且要调它
 *   E3 外部重装器抛错 ⇒ 返回 ok:false（不许静默成功）
 *
 * ## 额外
 *   E4 源码里不许再出现"用 p.ctx 重新 apply"的旧写法（那是死因）
 *   E5 不许有静默 catch（失败要留痕）
 */
import { rotateSelf, reloadSelf } from './lib/dispatch/hotreload-exec.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = fileURLToPath(new URL('./', import.meta.url)).replace(/[\\/]$/, '');

let pass = 0, fail = 0;
const fails = [];
function check(g, name, ok, detail) {
  if (ok) { pass++; console.log('  PASS ' + name + (detail ? '   ' + detail : '')); }
  else { fail++; fails.push(name); console.log('  FAIL ' + name + (detail ? '   ' + detail : '')); }
}

console.log('════ HOTRELOAD-EXEC 真执行验收 ════');

function fakeLoader(id) {
  const events = [];
  return {
    events,
    loader: { entries: () => [{ options: { id }, fiber: { dispose() { events.push('dispose'); } } }] },
  };
}

// ── E1 · 没有外部重装器 ⇒ 拒绝自拆（最关键）──
console.log('\n── E1 · 没有重装器就拒绝 ──');
{
  const f = fakeLoader('unified-memory');
  const r = await rotateSelf({
    getLoader: () => f.loader, selfId: 'unified-memory',
    ctx: {}, config: {}, moduleUrl: 'file:///x.js',
  });
  check('E1', 'E1a 返回 ok=false', r.ok === false, r.reason);
  check('E1', 'E1b 原因是"没有外部重装器"', /no-external-reloader/.test(String(r.reason)), r.reason);
  check('E1', 'E1c **没有 dispose**（不拆自己）', !f.events.includes('dispose'), JSON.stringify(f.events));
  check('E1', 'E1d steps 里写明拒绝理由', (r.steps || []).some(s => /拒绝执行/.test(s)), JSON.stringify(r.steps));
}

// ── E2 · 有外部重装器 ⇒ 允许，且要调它 ──
console.log('\n── E2 · 有重装器才执行 ──');
{
  const f = fakeLoader('unified-memory');
  let called = 0;
  const r = await rotateSelf({
    getLoader: () => f.loader, selfId: 'unified-memory',
    ctx: {}, config: {}, moduleUrl: 'file:///x.js',
    externalReload: async () => { called++; },
  });
  check('E2', 'E2a 返回 ok=true', r.ok === true, JSON.stringify(r.steps));
  check('E2', 'E2b 外部重装器被调用 1 次', called === 1, 'called=' + called);
}

// ── E3 · 重装器抛错 ⇒ 不许静默成功 ──
console.log('\n── E3 · 重装失败要出声 ──');
{
  const f = fakeLoader('unified-memory');
  const r = await rotateSelf({
    getLoader: () => f.loader, selfId: 'unified-memory',
    ctx: {}, config: {}, moduleUrl: 'file:///x.js',
    externalReload: async () => { throw new Error('reload-boom'); },
  });
  check('E3', 'E3a 返回 ok=false', r.ok === false, r.reason);
  check('E3', 'E3b 原因里带重装错误', /external-reload-threw/.test(String(r.reason)), r.reason);
}

// ── E4 · 源码里不许再有"用 p.ctx 重新 apply"（死因）──
console.log('\n── E4 · 死因不许复发 ──');
{
  const SRC = readFileSync(join(ROOT, 'lib/dispatch/hotreload-exec.js'), 'utf8');
  const CODE = SRC.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  check('E4', 'E4a 没有 mod.apply(p.ctx 这种旧写法',
    !/mod\.apply\(\s*p\.ctx/.test(CODE), /mod\.apply\(\s*p\.ctx/.test(CODE) ? '仍存在！' : '已清除');
  check('E4', 'E4b 没有 setTimeout 里的旧重装',
    !/setTimeout\(\s*async\s*\(\s*\)\s*=>\s*\{[^}]*import\(p\.moduleUrl/.test(CODE));
}

// ── E5 · reloadSelf 的语义 ──
console.log('\n── E5 · reloadSelf ──');
{
  const r = await reloadSelf({ getLoader: () => null, selfId: 'x', moduleUrl: '', ctx: null, config: null });
  check('E5', 'E5a 预检不过 ⇒ ok=false', r.ok === false, r.reason);
}

console.log('\n════ SUMMARY ════');
console.log('  pass=' + pass + ' fail=' + fail);
if (fail) console.log('  失败项: ' + fails.join(' | '));
process.exit(fail ? 1 : 0);
