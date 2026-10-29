/**
 * selftest-dispatch-signature.mjs —— sendMessage 真实签名验收（2026-10-28）
 *
 * ## 治什么病
 *   第一次真实派单报错：Cannot read properties of undefined (reading 'signal')
 *   根因：`agentTeams.sendMessage(caller, request)` 是**两个参数**，
 *        我原来只传了一个 { target, message } ⇒ request 变 undefined。
 *
 * ## 为什么之前的测试没抓到
 *   所有测试都用**假的 sendMessage**（`async (args) => {...}`），
 *   假函数不校验参数个数 ⇒ 传一个还是两个都能过 ⇒ **测试与现实脱节**。
 *
 * ## 本套怎么补
 *   1. 契约测试：用"严格要求两个参数"的假函数，一个参数就抛错
 *   2. 源码断言：接线代码必须写 `sendMessage(caller, {...})` 而不是 `sendMessage(args)`
 */
import { readFileSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLedger } from './lib/dispatch/ledger.js';
import { createDispatchTools } from './lib/dispatch/tool.js';
import { STATE } from './lib/dispatch/state-machine.js';

let pass = 0, fail = 0;
const fails = [];
function check(g, name, ok, detail) {
  if (ok) { pass++; console.log('  PASS ' + name + (detail ? '   ' + detail : '')); }
  else { fail++; fails.push(name); console.log('  FAIL ' + name + (detail ? '   ' + detail : '')); }
}

console.log('════ DISPATCH-SIGNATURE 验收 ════');

const tmp = mkdtempSync(join(tmpdir(), 'sig-'));

// ── A · 契约：假 sendMessage 严格要两个参数 ──
console.log('\n── A · 契约（严格两参）──');
{
  const ledger = createLedger({ path: join(tmp, 'a.json') });
  let gotArgs = null;
  const tools = createDispatchTools({
    ledger,
    // 模拟真实 agentTeams.sendMessage(caller, request)
    // [2026-10-28 强化 · 模拟真实 mailbox.send]
    //   真实实现里是 AbortSignal.any([request.signal, lifecycle.signal])，
    //   所以 request.signal **必须是真 AbortSignal**，缺了会报
    //   "signals[0] is not of type AbortSignal"。
    sendMessage: async function (caller, request) {
      gotArgs = { argc: arguments.length, caller, request };
      if (arguments.length < 2) throw new Error('Cannot read properties of undefined (reading \'signal\')');
      if (!request || !request.signal || typeof request.signal.aborted !== 'boolean') {
        throw new Error('signals[0] is not of type AbortSignal.');
      }
      if (!Array.isArray(request.content)) throw new Error('request.content missing');
      return { messageId: 'team-message-sig-1', status: 'accepted' };
    },
    getAgents: () => [],
    getSessionEvents: () => [],
  });
  const send = tools.find(t => t.name === 'dispatch_send');
  // [2026-10-28 补] execute 必须接第二参 exec，否则拿不到 signal
  const fakeSignal = new AbortController().signal;
  const fakeExec = { agent: { id: 'fake-agent' }, signal: fakeSignal };
  const res = await send.execute({ target: 'peer-a', body: '【现象】x' }, fakeExec);
  check('A', 'A1 派单成功（说明传参被接受）', res.ok === true, JSON.stringify(res));
  check('A', 'A1b exec.signal 被一路传到 request.signal',
    !!(gotArgs && gotArgs.request && gotArgs.request.signal === fakeSignal),
    gotArgs && gotArgs.request && gotArgs.request.signal ? 'signal 已传' : 'signal 缺失');
  // [2026-10-28 强化] 只判 argc===2 不够：单参数调用时 JS 会把 args 填入 caller、
  //   request 变 undefined，argc 仍是 1 —— 所以更要判 **request 这个形参有没有拿到对象**。
  check('A', 'A2 假函数收到 2 个参数', gotArgs && gotArgs.argc === 2, 'argc=' + (gotArgs && gotArgs.argc));
  check('A', 'A2b 第二形参（request）拿到的是对象，不是 undefined',
    gotArgs && gotArgs.request && typeof gotArgs.request === 'object',
    'request=' + (gotArgs && typeof gotArgs.request));
  check('A', 'A2c 第一形参（caller）不是 args 对象（说明没把两个参数挤在一起）',
    gotArgs && !(gotArgs.caller && gotArgs.caller.target && gotArgs.caller.message === undefined && gotArgs.caller.content === undefined && Array.isArray(gotArgs.caller.content) === false && gotArgs.caller.target === 'peer-a' && gotArgs.request === undefined),
    'caller=' + (gotArgs && typeof gotArgs.caller));
  let a3ok = false, a3detail = 'n/a';
  try {
    const t = gotArgs && gotArgs.request && gotArgs.request.target;
    a3ok = !!t;
    a3detail = String(t);
  } catch (e) { a3ok = false; a3detail = 'throw:' + e.message; }
  check('A', 'A3 request 里有 target', a3ok, a3detail);
  // [2026-10-28 修测试自身崩溃] 原写法 `gotArgs.request.content` 在 request 为 undefined 时
  //   会抛 TypeError（未捕获）⇒ 整个测试进程崩溃、process.exit 跑不到 ⇒ 退出码 0
  //   ⇒ 变异脚本看到的"没抛错"其实是"测试崩了"。
  //   这正是今天反复出现的形态：**检查自己坏了，却表现得像通过**。
  //   修法：可选链 + 外层 try，任何取值失败都算该断言失败，不许让测试崩掉。
  let a4ok = false, a4detail = 'n/a';
  try {
    const c = gotArgs && gotArgs.request && gotArgs.request.content;
    a4ok = Array.isArray(c);
    a4detail = c === undefined ? 'undefined' : (Array.isArray(c) ? 'array(' + c.length + ')' : typeof c);
  } catch (e) { a4ok = false; a4detail = 'throw:' + e.message; }
  check('A', 'A4 request 里有 content 数组', a4ok, a4detail);
}

// ── B · 反例：真实 sendMessage 会读 request.signal / request.content ──
//   [2026-10-28 修正] 上一版 B1 断言写得没有区分度（"ok===true 或 status===confirmed" 恒真）。
//   真正要防的是：**传进去的 request 结构对不对**（真实实现会读 request.content）。
console.log('\n── B · 反例：request 结构必须正确 ──');
{
  const ledger = createLedger({ path: join(tmp, 'b.json') });
  let seen = null;
  const tools = createDispatchTools({
    ledger,
    // 模拟真实实现：会读 request.content / request.signal，拿不到就炸
    sendMessage: async function (caller, request) {
      seen = {
        argc: arguments.length,
        hasContent: !!(request && Array.isArray(request.content)),
        hasSignal: !!(request && request.signal && typeof request.signal.aborted === 'boolean'),
        target: request && request.target,
      };
      if (!request || !Array.isArray(request.content)) throw new Error('request.content missing');
      if (!seen.hasSignal) throw new Error('signals[0] is not of type AbortSignal.');
      return { messageId: 'm-b' };
    },
    getAgents: () => [],
    getSessionEvents: () => [],
  });
  const send = tools.find(t => t.name === 'dispatch_send');
  const res = await send.execute({ target: 'peer-b', body: '正文' }, { agent: { id: 'b-agent' }, signal: new AbortController().signal });
  check('B', 'B1 request 带 content 数组（真实实现要读它）', seen && seen.hasContent === true, JSON.stringify(seen));
  check('B', 'B0 request 带真 AbortSignal（真实实现要读它）', seen && seen.hasSignal === true, JSON.stringify(seen && seen.hasSignal));
  check('B', 'B2 request 带 target', seen && seen.target === 'peer-b', JSON.stringify(seen && seen.target));
  check('B', 'B3 派单成功', res.ok === true, String(res.ok));
}

// ── C · 源码断言：接线层必须传两个参数 ──
console.log('\n── C · 源码断言（接线层）──');
{
  const SRC = readFileSync('D:/dsh-plugins/dsh-unified-memory/lib/index.js', 'utf8');
  const CODE = SRC.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  check('C', 'C1 接线代码里 sendMessage 传了两个参数（caller + request）',
    /teams\.sendMessage\(\s*caller\s*,/.test(CODE) || /sendMessage\(\s*[a-zA-Z_]+\s*,\s*\{/.test(CODE),
    '找到 caller 形参');
  check('C', 'C2 构造了 content 数组（不是 message 字段）',
    /content:\s*\[\s*\{\s*type:\s*'text'/.test(CODE));
  check('C', 'C3 有 caller 缺失时的明确报错',
    /需要 caller|caller（当前 Agent）/.test(CODE));
}

try { rmSync(tmp, { recursive: true, force: true }); } catch {}

console.log('\n════ SUMMARY ════');
console.log('  pass=' + pass + ' fail=' + fail);
if (fail) console.log('  失败项: ' + fails.join(' | '));
process.exit(fail ? 1 : 0);
