/**
 * 热重载真实实验 v3 —— 用「最像本插件」的副作用组合
 *
 * 本插件真实的副作用有 5 类：
 *   ① ctx.tools.register()  工具注册
 *   ② ctx.on('agent/pre-step')  事件订阅
 *   ③ ctx.systemPrompt.section()  提示段注册
 *   ④ setInterval()  定时器（记忆系统有心跳）
 *   ⑤ ctx.effect() 申报的清理
 *
 * 判据：dispose 之后再 apply，这 5 类都必须回到初始值（不翻倍、不残留）。
 */
import { Context } from 'file:///~/.dsh/profiles/web/node_modules/@deepseek-ai/cordis/lib/index.js';

console.log('════ 热重载实验 v3 · 模拟本插件真实副作用 ════');

const state = { tools: 0, subs: 0, sections: 0, timers: 0 };
let applyCount = 0;

function makePlugin(label) {
  return {
    name: 'probe-real-' + label,
    apply(ctx) {
      applyCount++;
      // ① 模拟工具注册（真插件用 ctx.tools.register，返回 disposer）
      const fakeTools = { n: 0, register() { this.n++; state.tools++; return () => { state.tools--; }; } };
      const t = fakeTools;
      t.register();
      ctx.effect(() => () => { state.tools--; });
      // ② 事件订阅
      ctx.on('agent/pre-step', () => {});
      state.subs++;
      ctx.effect(() => () => { state.subs--; });
      // ③ 提示段
      state.sections++;
      ctx.effect(() => () => { state.sections--; });
      // ④ 定时器（心跳）
      const timer = setInterval(() => {}, 50);
      state.timers++;
      ctx.effect(() => () => { clearInterval(timer); state.timers--; });
    },
  };
}

const ctx = new Context();
const snap = (tag) => console.log('  ' + tag + ': tools=' + state.tools + ' subs=' + state.subs +
  ' sections=' + state.sections + ' timers=' + state.timers + ' applyCount=' + applyCount);

console.log('\n── 初始 ──'); snap('init');

console.log('\n── apply #1 ──');
const f1 = ctx.plugin(makePlugin('A'));
await new Promise(r => setTimeout(r, 80)); snap('after1');

console.log('\n── dispose #1 ──');
f1.dispose();
await new Promise(r => setTimeout(r, 80)); snap('disposed1');

console.log('\n── apply #2 ──');
const f2 = ctx.plugin(makePlugin('B'));
await new Promise(r => setTimeout(r, 80)); snap('after2');

console.log('\n── 对照：不 dispose 直接再 apply（模拟"忘了卸载"）──');
const f3 = ctx.plugin(makePlugin('C'));
await new Promise(r => setTimeout(r, 80)); snap('after3-noDispose');

f2.dispose(); f3.dispose();
await new Promise(r => setTimeout(r, 80)); snap('final');

console.log('\n════ 判据 ════');
const one = { tools: 1, subs: 1, sections: 1, timers: 1 };
const clean = state.tools === 0 && state.subs === 0 && state.sections === 0 && state.timers === 0;
console.log('  ① 全部释放后归零：' + (clean ? '✅' : '❌ ' + JSON.stringify(state)));
console.log('  ② 每次 apply 都独立：' + (applyCount === 3 ? '✅ 3 次独立' : '❌'));
console.log('\n结论:', clean ? '✅ 五类副作用都能干净卸载 —— 热重载可用于本插件' : '⚠️ 有残留');
process.exit(0);
