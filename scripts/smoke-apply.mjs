#!/usr/bin/env node
/**
 * smoke-apply.mjs —— 启动冒烟：用假 ctx 跑一遍 apply()，确保重启不会炸
 * [2026-10-22 by Assistant]
 *
 * 为什么需要：所有自测都是"直接 import 子模块"，**从没测过 apply() 本身**。
 * 而 DSH 加载插件的第一步就是 apply(ctx, config)。这里一旦抛错，
 * 整个记忆插件不加载 ⇒ 注入消失 ⇒ User重启后会觉得"记忆坏了"。
 *
 * 做法：构造一个最小可用的假 ctx（systemPrompt.section + on + logger + get），
 *      用**接近真实 profile 的 config** 跑 apply，断言：
 *        ① 不抛错
 *        ② 注册了 section
 *        ③ 注册了 pre-step / turn-stopping 钩子
 *        ④ 返回的 dispose 能安全调用
 *        ⑤ 重复 apply（模拟热重载）不报"already registered"
 */
import { pathToFileURL } from 'node:url';

// [2026-10-22 by Assistant] 关键：标记探针来源为 test。
//   否则本脚本写的 apply 探针会和真实 DSH 的混在 section-register.jsonl 里，
//   时间线一交错就会让人误判"生产在异常 apply"（我已经因此误判过一次）。
process.env.PM_PROBE_SRC = 'test';

let fail = 0;
const ok = (n, c, d) => { console.log((c ? '  ✅ ' : '  ❌ ') + n + (d === undefined ? '' : '   ' + d)); if (!c) fail++; };

function makeCtx() {
  const sections = [];
  const events = new Map();
  const contexts = [];
  const ctx = {
    on(name, fn) {
      if (!events.has(name)) events.set(name, []);
      events.get(name).push(fn);
      return () => { const a = events.get(name) || []; const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); };
    },
    effect(fn, label) { try { const d = fn(); return typeof d === 'function' ? d : () => {}; } catch (e) { throw e; } },
    get() { return undefined; },
    logger: { info() {}, warn() {}, debug() {}, error() {} },
    systemPrompt: {
      section(opts) { sections.push(opts); return () => { const i = sections.indexOf(opts); if (i >= 0) sections.splice(i, 1); }; },
      context(opts) { contexts.push(opts); return () => {}; },
    },
    // [2026-10-24] 假 tools 服务：让 diary_write / diary_config 的注册路径也被冒烟覆盖
    tools: {
      registered: [],
      register(def) { this.registered.push(def); return () => { const i = this.registered.indexOf(def); if (i >= 0) this.registered.splice(i, 1); }; },
    },
  };
  return { ctx, sections, events, contexts };
}

// [开源版] 路径改成相对脚本自身推导，换机器也能跑
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { dataPath } from '../lib/paths.js';
const __selfDir = dirname(fileURLToPath(import.meta.url));
const mod = await import(pathToFileURL(join(__selfDir, '..', 'lib', 'index.js')).href);

// ── 1 · 默认配置（接近 profile）──
console.log('── 1 · apply() 默认配置 ──');
const c1 = makeCtx();
let dispose1 = null;
let err1 = null;
try {
  dispose1 = mod.apply(c1.ctx, {
    enabled: true, emit: 'section', freezePerSession: true,
    injectMaxChars: 8000, budgetTokens: 450, order: 0.6,
    hypergraph: { indexRoot: dataPath('hypergraph') },
    workingMemoryDir: dataPath('working'),
    retrieval: { l0Enabled: true, l0RecentDays: 30, sourceWeight: 0.85, topicBoost: 0.15 },
    logs: { dir: dataPath('logs') },
  });
} catch (e) { err1 = e; }
ok('1.1 apply() 不抛错', !err1, err1 && String(err1.message || err1).slice(0, 200));
ok('1.2 注册了 systemPrompt.section', c1.sections.length === 1, 'n=' + c1.sections.length);
ok('1.3 注册了 agent/pre-step', (c1.events.get('agent/pre-step') || []).length >= 1);
ok('1.4 注册了 agent/turn-stopping', (c1.events.get('agent/turn-stopping') || []).length >= 1);
ok('1.5 注册了 session/flush（期7 捕获）', (c1.events.get('session/flush') || []).length >= 1, 'n=' + (c1.events.get('session/flush') || []).length);
const regTools = (c1.ctx.tools.registered || []).map(t => t.name);
// [2026-10-28 by Assistant · 派单状态机接线] 期望清单补三个 dispatch 手柄。
//   原来这里硬编码「必须正好 6 个」——加了工具就红。
//   这不是"测试太严"，是**断言写成了"总数相等"而不是"该有的都在"**：
//   前者会在每次正当扩容时假红，久了就会被当成噪音忽略掉（那才是最危险的）。
//   ⇒ 改成：必须全部包含 + 总数不得少于清单（多出来的允许，但要点名）。
const expectedTools = [
  'diary_write', 'diary_config', 'diary_read',
  'memory_search', 'memory_get', 'memory_refute',
  'dispatch_send', 'dispatch_scan', 'dispatch_close',
];
const missingTools = expectedTools.filter(t => !regTools.includes(t));
const extraTools = regTools.filter(t => !expectedTools.includes(t));
const allToolsPresent = missingTools.length === 0 && regTools.length >= expectedTools.length;
ok('1.6 注册了 ' + expectedTools.length + ' 个工具（3 日记 + 3 记忆 + 3 派单）', allToolsPresent,
  'n=' + regTools.length + (missingTools.length ? ' 缺=' + missingTools.join(',') : '') + (extraTools.length ? ' 多=' + extraTools.join(',') : ''));
ok('1.7 返回 dispose 函数', typeof dispose1 === 'function');
if (typeof dispose1 === 'function') {
  let derr = null; try { dispose1(); } catch (e) { derr = e; }
  ok('1.7 dispose 不抛', !derr, derr && String(derr.message || derr).slice(0, 150));
}

// ── 2 · section 渲染（模拟一轮真实装配）──
console.log('── 2 · section 文本可渲染 ──');
{
  const c2 = makeCtx();
  let d2 = null;
  try {
    d2 = mod.apply(c2.ctx, {
      enabled: true, budgetTokens: 450,
      hypergraph: { indexRoot: dataPath('hypergraph') },
      workingMemoryDir: 'C:/Users/Administrator/AppData/Local/Temp/pm-wm-smoke',
      ingest: { configPath: 'C:/Users/Administrator/AppData/Local/Temp/pm-nonexistent-config.json' },
      hypergraphAutoRefresh: false,          // 冒烟不重建
      logs: { dir: 'C:/Users/Administrator/AppData/Local/Temp/pm-logs-smoke' },
    });
  } catch (e) { console.log('    apply 抛错: ' + String(e && e.message).slice(0, 120)); }
  const sec = c2.sections[0];
  ok('2.1 拿到了 section 定义', !!sec && typeof sec.text !== 'undefined');
  if (sec) {
    let text = '';
    let rerr = null;
    try {
      text = typeof sec.text === 'function' ? sec.text({}) : sec.text;
    } catch (e) { rerr = e; }
    ok('2.2 section.text 同步渲染不抛', !rerr, rerr && String(rerr.message || rerr).slice(0, 150));
    ok('2.3 渲染出字符串（可为空）', typeof text === 'string', 'type=' + typeof text + ' len=' + (text || '').length);
  }
  if (typeof d2 === 'function') { try { d2(); } catch {} }
}

// ── 3 · 全关配置（回滚档）──
console.log('── 3 · 回滚档（enabled:false）──');
{
  const c3 = makeCtx();
  let d3 = null; let e3 = null;
  try { d3 = mod.apply(c3.ctx, { enabled: false }); } catch (e) { e3 = e; }
  ok('3.1 enabled:false 不抛且直接返回', !e3);
  ok('3.2 不注册任何 section', c3.sections.length === 0, 'n=' + c3.sections.length);
}

// ── 4 · 热重载（同 ctx 再 apply 一次）──
console.log('── 4 · 热重载 ──');
{
  const c4 = makeCtx();
  let e4 = null;
  let d4 = null;
  try {
    d4 = mod.apply(c4.ctx, { enabled: true, hypergraphAutoRefresh: false, ingest: { configPath: '/nonexistent.json' }, logs: { dir: 'C:/Users/Administrator/AppData/Local/Temp/pm-logs-smoke2' } });
    if (typeof d4 === 'function') d4();
    d4 = mod.apply(c4.ctx, { enabled: true, hypergraphAutoRefresh: false, ingest: { configPath: '/nonexistent.json' }, logs: { dir: 'C:/Users/Administrator/AppData/Local/Temp/pm-logs-smoke2' } });
  } catch (e) { e4 = e; }
  ok('4.1 卸载后重新 apply 不抛（热重载安全）', !e4, e4 && String(e4.message || e4).slice(0, 200));
  if (typeof d4 === 'function') { try { d4(); } catch {} }
}

// ── 5 · 空配置不得清空已生效的能力（实跑抓到的真 bug）──
console.log('── 5 · 空配置幂等 ──');
{
  const c5 = makeCtx();
  let d5 = null;
  // 先带完整配置 apply
  d5 = mod.apply(c5.ctx, {
    enabled: true, hypergraphAutoRefresh: false,
    ingest: { configPath: 'C:/Users/Administrator/AppData/Local/Temp/pm-nonexistent.json' },
    logs: { dir: 'C:/Users/Administrator/AppData/Local/Temp/pm-logs-smoke3' },
  });
  const sectionsAfterFull = c5.sections.length;
  // 关键：再 apply 一次**空配置**（模拟 DSH 热装配传空对象）
  let err5 = null;
  try { mod.apply(c5.ctx, {}); } catch (e) { err5 = e; }
  ok('5.1 空配置 apply 不抛错', !err5, err5 && String(err5.message || err5).slice(0, 150));
  // 空配置不应把 section 数量归零（沿用上次配置 ⇒ 仍然注册）
  ok('5.2 空配置不清空 section（沿用上次有效配置）',
    c5.sections.length >= sectionsAfterFull,
    'before=' + sectionsAfterFull + ' after=' + c5.sections.length);
  if (typeof d5 === 'function') { try { d5(); } catch {} }
}

// ── 6 · 部分缺失配置不得丢掉已生效的段（实跑抓到的 l0 消失 bug）──
console.log('── 6 · 配置按段合并 ──');
{
  const c6 = makeCtx();
  let d6 = null;
  // ① 先给完整配置（含 retrieval.l0Enabled）
  d6 = mod.apply(c6.ctx, {
    enabled: true, hypergraphAutoRefresh: false,
    retrieval: { l0Enabled: true, l0RecentDays: 30 },
    ingest: { configPath: 'C:/Users/Administrator/AppData/Local/Temp/pm-nonexistent.json' },
    logs: { dir: 'C:/Users/Administrator/AppData/Local/Temp/pm-logs-smoke4' },
  });
  // ② 再 apply 一份「非空但缺 retrieval」的配置（真实 bug 的形态）
  mod.apply(c6.ctx, { enabled: true, budgetTokens: 450 });
  // 判据：l0 不能因为缺段而消失 ⇒ 通过探针记录确认
  let l0Ok = false;
  try {
    const fs = await import('node:fs');
    // [开源版] 不能用字面量 '~/...'（Node 不展开 ~）⇒ 走 paths 模块推导
    const { dataPath } = await import('file://' + join(__selfDir, '..', 'lib', 'paths.js').replace(/\\/g, '/'));
    const raw = fs.readFileSync(dataPath('probe', 'section-register.jsonl'), 'utf8');
    const lines = raw.split('\n').filter(Boolean);
    // [2026-10-25] 逆向匹配当前测试进程专属 pid，避免并发日志挤出最后 60 行导致假阴性
    for (let i = lines.length - 1; i >= 0 && i >= lines.length - 300; i--) {
      const l = lines[i];
      if (l.indexOf('retrieval-config') < 0) continue;
      try {
        const o = JSON.parse(l);
        if (o.src === 'test' && o.pid === process.pid) {
          if (o.l0Effective === true) l0Ok = true;
          break;
        }
      } catch {}
    }
  } catch {}
  ok('6.1 缺 retrieval 的配置不会把 l0 关掉（按段合并生效）', l0Ok, l0Ok ? 'l0Effective 保持 true' : '被覆盖成 false');
  if (typeof d6 === 'function') { try { d6(); } catch {} }
}

console.log('');
console.log(fail === 0 ? '✅ 启动冒烟通过' : '❌ 有 ' + fail + ' 项失败');
process.exitCode = fail === 0 ? 0 : 1;
