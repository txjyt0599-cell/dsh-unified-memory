/**
 * selftest-hotreload-tools.mjs —— 热重载工具验收（2026-10-28）
 *
 * ## 为什么要有这套（今天最丢脸的一个 bug）
 *   hotreload-tools.js 写完后，`node --check` 报 OK、84 个文件语法扫描全过，
 *   但**运行时 import 直接 "Invalid or unexpected token"**。
 *   根因：`.join('\n')` 被写成了**真正的换行符**（字符串字面量里断行）。
 *   ⇒ 静态检查看不见，只在 ESM 解析时炸。
 *   ⇒ 本套加一条：**用 ESM 真解析一遍**，且全项目扫"字符串字面量里断行"。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = fileURLToPath(new URL('./', import.meta.url)).replace(/[\\/]$/, '');
// [2026-10-28 关键修正] 原来用**静态 import**：一旦源码有语法错误（正是本套要查的病），
//   测试在 import 阶段就崩了 —— 一条断言都跑不到，退出码还是 0。
//   ⇒ 改动态 import：**先扫源码（H2），再加载模块**。
//   这样即使源码坏了，H2 也能正常报红。
let createHotReloadTools = null;
let importError = null;

let pass = 0, fail = 0;
const fails = [];
function check(g, name, ok, detail) {
  if (ok) { pass++; console.log('  PASS ' + name + (detail ? '   ' + detail : '')); }
  else { fail++; fails.push(name); console.log('  FAIL ' + name + (detail ? '   ' + detail : '')); }
}

console.log('════ HOTRELOAD-TOOLS 验收 ════');

// ── H2 · 关键：源码里不许有"字符串字面量里断行" ──
//   [顺序很重要] 这一组必须**先于**模块加载执行 —— 否则源码坏了会在 import 阶段崩掉。
//   判据：一行以单引号开头、但行尾没有配对的单引号（引号数为奇数），且不是注释
console.log('\n── H2 · 字符串字面量断行（今天这个 bug）──');
{
  const files = [];
  (function walk(d) {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.js')) files.push(p);
    }
  })(join(ROOT, '')lib');

  // [2026-10-28 修正] 第一版判据太糙：用"单引号个数是奇数"，
  //   但正常英文缩写（don't / it's）本身就有奇数个单引号 ⇒ 全是误报。
  //   真正的病灶形态是**行尾落在字符串字面量内部**：
  //     某行以 '...' 开头且**行末没有闭合的引号**，下一行又继续。
  //   ⇒ 改成：只查"行尾状态为'在字符串里'且该行不是纯注释"的行，
  //      并且要求下一行**不是**以引号或运算符正常续接的形式出现。
  const bad = [];
  for (const f of files) {
    const lines = readFileSync(f, 'utf8').split('\n');
    for (let i = 0; i < lines.length; i++) {
      const L = lines[i];
      if (/^\s*(\/\/|\*|\/\*)/.test(L)) continue;      // 注释行跳过
      if (/^\s*\*/.test(L)) continue;
      // 逐字符走一遍，维护"当前是否在单引号字符串内"（跳过 \\ 转义与双引号）
      let inS = false, inD = false, inBt = false;
      for (let j = 0; j < L.length; j++) {
        const c = L[j];
        const prev = j > 0 ? L[j - 1] : '';
        if (prev === '\\') continue;
        if (!inD && !inBt && c === "'") inS = !inS;
        else if (!inS && !inBt && c === '"') inD = !inD;
        else if (!inS && !inD && c === '`') inBt = !inBt;
      }
      // [2026-10-28 二次修正] 上面的字符扫描仍会误报：正则字面量（/^['"]|['"]$/g）里的引号
      //   被当成字符串引号，把状态机带偏。
      //   ⇒ 改用**最窄、最准**的病灶特征：今天这个 bug 的形态是
      //        `].join('`  ← 行尾正好是一个未闭合的单引号，且下一行以 `')` 开头
      //      也就是"单引号 + 行尾"紧跟"下一行以引号或 ) 开头"。
      //   只查这一种，宁可漏也别误报（误报会让守门测试失去可信度）。
      // [2026-10-28 三次修正] 前两版都漏了真实形态：
      //     ].join('        ← 行尾是"引号"，但后面紧跟的是行尾，不是下一行引号
      //     '),
      //   判据改成两条任一命中即报：
      //     ① 行尾是引号 且 下一行以引号开头
      //     ② 行尾是引号 且 该行**没有**闭合（即行内引号计数为奇数）
      const tail = L.replace(/\s+$/, '');
      const nxt = (lines[i + 1] || '').trim();
      const endsWithQuote = /['"]$/.test(tail);
      if (endsWithQuote && !/[+,]$/.test(tail)) {
        let q = 0;
        for (let j = 0; j < tail.length; j++) {
          if ((tail[j] === "'" || tail[j] === '"') && (j === 0 || tail[j - 1] !== String.fromCharCode(92))) q++;
        }
        const oddQuotes = q % 2 === 1;
        if (oddQuotes || /^['"]/.test(nxt)) {
          bad.push(f.replace(join(ROOT, '')', '') + ':' + (i + 1) + ' 尾=' + JSON.stringify(tail.slice(-22)));
        }
      }
    }
  }
  check('H2', 'H2a 全项目无"字符串字面量跨行"的可疑行', bad.length === 0, bad.slice(0, 3).join(' | ') || '干净');
}

// ── H1 · 模块能被 ESM 真解析（在 H2 扫完之后才加载）──
console.log('\n── H1 · 模块可加载 ──');
try {
  const mod = await import('./lib/dispatch/hotreload-tools.js');
  createHotReloadTools = mod.createHotReloadTools;
} catch (e) {
  importError = String(e && e.message || e);
}
check('H1', 'H1a 模块能被 ESM 解析（不报 Invalid token）', importError === null, importError || 'ok');
check('H1', 'H1b createHotReloadTools 是函数', typeof createHotReloadTools === 'function', typeof createHotReloadTools);

// ── H3 · 两个工具的形状 ──
console.log('\n── H3 · 工具形状 ──');
{
  const called = [];
  const fakeLoader = { entries: () => [{ options: { id: 'unified-memory' }, fiber: { dispose() { called.push('dispose'); } } }] };
  // [2026-10-28] 模块可能因语法错误而加载失败（H1 已报红）——这里不能再崩，
  //   否则整个测试死掉、退出码变 0，变异脚本会误判"没抓到"。
  let tools = [];
  let mkErr = null;
  try {
    if (typeof createHotReloadTools === 'function') {
      tools = createHotReloadTools({ logger: null, getLoader: () => fakeLoader, selfId: 'unified-memory' }) || [];
    } else { mkErr = 'createHotReloadTools 不可用'; }
  } catch (e) { mkErr = String(e && e.message || e); }
  check('H3', 'H3a 返回 3 个工具', tools.length === 3, mkErr || tools.map(t => t.name).join(','));
  check('H3', 'H3b 名字是 probe + dryrun + apply',
    tools.map(t => t.name).join(',') === 'hotreload_probe,hotreload_dryrun,hotreload_apply', mkErr || '');
  for (const t of tools) {
    check('H3', 'H3c ' + t.name + ' 有 output.schema+render',
      !!(t.output && t.output.schema && typeof t.output.render === 'function'));
  }
}

// ── H4 · probe 只读 ──
console.log('\n── H4 · probe 只读 ──');
{
  const called = [];
  const fakeLoader = { entries: () => [{ options: { id: 'unified-memory' }, fiber: { dispose() { called.push('dispose'); } } }] };
  const tools = (typeof createHotReloadTools === 'function' ? (createHotReloadTools({ getLoader: () => fakeLoader, selfId: 'unified-memory' }) || []) : []);
  const probe = tools.find(t => t.name === 'hotreload_probe') || null;
  const r = probe ? await probe.execute({}) : { ok: false, notes: 'probe 不存在' };
  check('H4', 'H4a probe 返回 ok=true', r.ok === true, JSON.stringify(r));
  check('H4', 'H4b probe **没有** dispose', !called.includes('dispose'), JSON.stringify(called));
}

// ── H5 · dryrun 只报告不动手 ──
console.log('\n── H5 · dryrun 不动手 ──');
{
  const called = [];
  const fakeLoader = { entries: () => [{ options: { id: 'unified-memory' }, fiber: { dispose() { called.push('dispose'); } } }] };
  const tools = (typeof createHotReloadTools === 'function' ? (createHotReloadTools({ getLoader: () => fakeLoader, selfId: 'unified-memory' }) || []) : []);
  const dr = tools.find(t => t.name === 'hotreload_dryrun') || null;
  const r = dr ? await dr.execute({}) : { ok: false, reason: 'dryrun 不存在', steps: [] };
  check('H5', 'H5a dryrun 返回 ok=true 且标记 dryRun', r.ok === true && r.dryRun === true, JSON.stringify(r.reason || ''));
  check('H5', 'H5b dryrun **没有** dispose', !called.includes('dispose'), JSON.stringify(called));
  check('H5', 'H5c 报告了计划步骤', (r.steps || []).length > 0, JSON.stringify(r.steps));
}

// ── H6 · 找不到自己时两个工具都要如实报 ──
console.log('\n── H6 · 找不到自己 ──');
{
  const tools = (typeof createHotReloadTools === 'function' ? (createHotReloadTools({ getLoader: () => ({ entries: () => [] }), selfId: 'unified-memory' }) || []) : []);
  const probe = tools.find(t => t.name === 'hotreload_probe') || null;
  const dr = tools.find(t => t.name === 'hotreload_dryrun') || null;
  const p = probe ? await probe.execute({}) : { ok: false, notes: 'probe 不存在' };
  const d = dr ? await dr.execute({}) : { ok: false, reason: 'dryrun 不存在' };
  check('H6', 'H6a probe 报 ok=false', p.ok === false, p.notes);
  check('H6', 'H6b dryrun 报 ok=false', d.ok === false, d.reason);
}

// ── H7 · hotreload_apply 的双门禁（最关键的安全断言）──
//   [2026-10-28] 真执行工具的守门：
//     ① confirm 不为 true ⇒ 只报告，绝不动手
//     ② 没有 rotate 实现 ⇒ 也拒绝
console.log('\n── H7 · apply 工具门禁 ──');
{
  const called = [];
  const fakeLoader = { entries: () => [{ options: { id: 'unified-memory' }, fiber: { dispose() { called.push('dispose'); } } }] };
  let rotateCalls = 0;
  let tools = [];
  try {
    if (typeof createHotReloadTools === 'function') {
      tools = createHotReloadTools({
        getLoader: () => fakeLoader, selfId: 'unified-memory',
        rotate: async () => { rotateCalls++; return { ok: true, steps: ['fake-rotate'] }; },
      }) || [];
    }
  } catch {}
  const apply = tools.find(t => t.name === 'hotreload_apply') || null;

  // ① 不传 confirm
  const r1 = apply ? await apply.execute({}) : { ok: true, steps: [] };
  check('H7', 'H7a 不传 confirm ⇒ dryRun 且不动手', r1.dryRun === true && rotateCalls === 0, 'rotateCalls=' + rotateCalls);
  check('H7', 'H7b 不传 confirm ⇒ 不 dispose', !called.includes('dispose'), JSON.stringify(called));

  // ② confirm 传非 true 值
  const r2 = apply ? await apply.execute({ confirm: 1 }) : { dryRun: true };
  check('H7', 'H7c confirm=1（非 true）⇒ 仍不动手', r2.dryRun === true && rotateCalls === 0, 'rotateCalls=' + rotateCalls);

  // ③ confirm:true ⇒ 真调用 rotate
  const r3 = apply ? await apply.execute({ confirm: true }) : { ok: false };
  check('H7', 'H7d confirm:true ⇒ 真的调用 rotate', rotateCalls === 1, 'rotateCalls=' + rotateCalls);
  check('H7', 'H7e 返回 dryRun=false', r3.dryRun === false);

  // ④ 没注入 rotate ⇒ 拒绝
  let t2 = [];
  try {
    if (typeof createHotReloadTools === 'function') {
      t2 = createHotReloadTools({ getLoader: () => fakeLoader, selfId: 'unified-memory' }) || [];
    }
  } catch {}
  const a2 = t2.find(t => t.name === 'hotreload_apply') || null;
  // [2026-10-28] 包 try/catch：变异掉门禁后这里会抛 TypeError，
  //   不许让异常把整个测试带崩（今天第 6 次同类）。
  let r4 = null, thrown7 = null;
  try { r4 = a2 ? await a2.execute({ confirm: true }) : { ok: false, reason: '无工具' }; }
  catch (e) { thrown7 = String(e && e.message || e); }
  check('H7', 'H7f 没注入 rotate ⇒ 拒绝执行（不许抛错）',
    thrown7 === null && r4 !== null && r4.ok === false && /rotate/.test(String(r4.reason || '')),
    thrown7 ? 'threw: ' + thrown7 : String(r4 && r4.reason));
}

console.log('\n════ SUMMARY ════');
console.log('  pass=' + pass + ' fail=' + fail);
if (fail) console.log('  失败项: ' + fails.join(' | '));
process.exit(fail ? 1 : 0);
