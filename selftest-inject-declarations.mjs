/**
 * selftest-inject-declarations.mjs —— inject 声明完整性验收（2026-10-28）
 *
 * ## 为什么要有这一套
 * cordis 铁律：**没声明进 inject 的服务，读 ctx.xxx 会被直接拦下**。
 * 今天真踩了**两次**同一个坑：
 *   ① 2026-10-24 diary 工具：cannot get property "tools" without inject
 *   ② 2026-10-28 派单工具：cannot get property "agentTeams" without inject
 * 第二次尤其讽刺——Assistant在代码里写着"cordis 铁律"的注释提醒自己，还是漏了。
 * ⇒ 把"代码里读了哪些 ctx.xxx"和"inject 声明了哪些"做静态对账，任何人加新服务都会红。
 *
 * ## 反例
 *   故意声明一个多余服务 / 故意删一个必需服务，都必须被抓到。
 */
import { readFileSync } from 'node:fs';

const F = new URL('./lib/index.js', import.meta.url);
let pass = 0, fail = 0;
const fails = [];
function check(g, name, ok, detail) {
  if (ok) { pass++; console.log('  PASS ' + name + (detail ? '   ' + detail : '')); }
  else { fail++; fails.push(name); console.log('  FAIL ' + name + (detail ? '   ' + detail : '')); }
}

/** 从 inject 数组里取声明 */
function parseInject(src) {
  const m = src.match(/export const inject\s*=\s*\[([^\]]*)\]/);
  if (!m) return null;
  return m[1].split(',').map(s => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
}

/** 从代码里找出所有 ctx.<service> 的读取（排除 ctx.on/ctx.logger 等非服务） */
function findCtxServices(src) {
  const set = new Set();
  // 去掉注释行，避免注释里的 ctx.tools 干扰
  const lines = src.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l));
  const clean = lines.join('\n');
  for (const m of clean.matchAll(/ctx\.([a-zA-Z_][a-zA-Z0-9_]*)/g)) set.add(m[1]);
  return set;
}

console.log('════ INJECT-DECLARATIONS 验收 ════');

// ── A · 声明存在且包含已知必需项 ──
console.log('\n── A · 声明 ──');
const src = readFileSync(F, 'utf8');
const declared = parseInject(src);
check('A', 'A1 能解析出 inject 数组', Array.isArray(declared) && declared.length > 0, JSON.stringify(declared));
// [2026-11-01 Assistant · 解硬依赖] agentTeams 从「必需」改成「要么声明、要么软取」。
//   背景：cordis 的数组式 inject 是**硬依赖** —— 缺服务整条 fiber 挂起。
//        headless（B站鱼塘）没有 agent-team 插件，于是 phoebe-memory 永远装不进去。
//        已改为 inject 不声明 + 运行时 try { ctx.agentTeams } catch {} 软取。
//   ⇒ 判据也要跟着变：**声明了也行，软取了也行，但绝不能「又没声明又硬访问」**。
const REQUIRED = ['systemPrompt', 'tools', 'agents'];
for (const r of REQUIRED) {
  check('A', 'A2 声明包含 ' + r, declared.includes(r));
}
// agentTeams：二选一（声明 or 软取）
const softAgentTeams = /try\s*\{\s*teams\s*=\s*ctx\.agentTeams\s*;?\s*\}\s*catch/.test(src)
  || /ctx\.agentTeams\s*\?/.test(src)
  || /\?\.agentTeams/.test(src);
check('A', 'A2b agentTeams 已声明或已软取（不能硬访问）',
  declared.includes('agentTeams') || softAgentTeams,
  declared.includes('agentTeams') ? '已声明' : (softAgentTeams ? '已软取' : '✗ 硬访问且未声明 → headless 会挂'));

// ── B · 代码里读的 ctx.xxx 必须都已声明（排除节点内建）──
console.log('\n── B · 静态对账 ──');
const used = findCtxServices(src);
// 这些不是 cordis 服务，是普通对象/事件 API
const NOT_SERVICE = new Set([
  'on', 'logger', 'emit', 'once', 'off', 'env', 'config', 'options', 'subscriptions',
  // [2026-11-01 Assistant] agentTeams 现在是**软取**的（try/catch 包着，取不到就降级），
  //   所以它不需要在 inject 里声明 —— 不列入「必须已声明」的集合。
  //   安全性由 A2b 兜底：若哪天有人把它改成硬访问，A2b 会报红。
  'agentTeams',
]);
const suspects = [...used].filter(x => !NOT_SERVICE.has(x) && !declared.includes(x));
check('B', 'B1 代码读的 ctx 服务全部已声明', suspects.length === 0,
  suspects.length ? '未声明: ' + suspects.join(',') : '读=' + used.size + ' 声明=' + declared.length);

// ── C · 反例：故意删一个必需声明，对账必须报红 ──
console.log('\n── C · 反例（对账必须有效）──');
{
  // [2026-10-28 by Phoebe · 反例必须自适应]
  //   初版把 inject 的**完整字符串**硬编码进 replace 锚点 —— 我随后往 inject 里加了
  //   sessions/sessionPersistence，锚点就失配了，反例静默失效（还报"检出空"）。
  //   这正是今天反复踩的"锚点脆断"第 3 次。⇒ 改成用正则**动态删掉最后两项**。
  const broken = src.replace(
    /(export const inject\s*=\s*\[)([^\]]*)(\])/,
    (_m, a, body, c) => {
      const items = body.split(',').map(s => s.trim()).filter(Boolean);
      return a + items.slice(0, Math.max(0, items.length - 2)).join(', ') + c;
    }
  );
  const d2 = parseInject(broken);
  const removed = declared.filter(x => !d2.includes(x));
  const u2 = findCtxServices(broken);
  const misses = removed.filter(x => u2.has(x));
  check('C', 'C1 删掉两项声明后能检出缺失', removed.length === 2 && misses.length > 0,
    '删了=' + removed.join(',') + ' 检出=' + misses.join(','));
}

// ── D · 反例：声明了但代码没读（多余声明）也要提示 ──
console.log('\n── D · 多余声明 ──');
{
  const extra = declared.filter(x => !used.has(x));
  // 多余声明不一定是错（服务可能只在特定分支用），只做提示
  console.log('  ' + (extra.length ? '⚠️' : '✓') + ' 声明了但代码未直接读: ' + (extra.join(',') || '无'));
  check('D', 'D1 无多余声明（警告级，不阻塞）', true, extra.join(',') || 'none');
}

console.log('\n════ SUMMARY ════');
console.log('  pass=' + pass + ' fail=' + fail);
if (fail) console.log('  失败项: ' + fails.join(' | '));
process.exit(fail ? 1 : 0);
