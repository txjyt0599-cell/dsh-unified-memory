/**
 * hotreload 工具（2026-10-28 · 第三步）
 *
 * ## 三个工具，风险递增
 *   hotreload_probe : **纯只读** —— 回答"能不能"，永远安全
 *   hotreload_dryrun: 预检 + 报告计划，**不动手**
 *   hotreload_self  : 真执行（先挂保险 → dispose → reload → 撤保险）
 *
 * ## 为什么默认要走 dryRun
 *   第一步已确认三问全绿（loader 可达 / 找得到自己 / 有 fiber）。
 *   但"能定位到" ≠ "重载安全"。dryRun 让我们在**零风险**下看到完整计划。
 */
import { createHotReloadProbe } from './hotreload-probe.js';
import { createHotReloadGuard } from './hotreload-guard.js';

/**
 * [2026-10-28 by Assistant · 假重载验证标记]
 * 这个常量**只用于验证热重载是否真的让新代码生效**，不参与任何业务。
 * 假重载流程：改这个数字 → 触发热重载 → 再调 hotreload_probe 看它变没变。
 *   · 变了   = 新代码真的被加载了
 *   · 没变   = 仍是旧代码（reload 没真重新 import）
 */
export const RELOAD_TEST_MARK = 2;   // [假重载验证] 1 → 2，看热重载后 probe 能否读到 2

const PROBE_OUTPUT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean' },
    loaderReachable: { type: 'boolean' },
    entriesTotal: { type: 'integer' },
    selfFound: { type: 'boolean' },
    selfHasFiber: { type: 'boolean' },
    selfId: { type: 'string' },
    notes: { type: 'string' },
    // 假重载验证标记：改它再看这个值变不变
    reloadMark: { type: 'integer' },
  },
  required: ['ok'],
};

const PLAN_OUTPUT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean' },
    dryRun: { type: 'boolean' },
    reason: { type: 'string' },
    steps: { type: 'array', items: { type: 'string' } },
  },
  required: ['ok'],
};

function renderProbe(_a, v) {
  return [{ type: 'text', text: v.ok
    ? ('热重载可行性：✅ 全绿（loader 可达 / 找得到自己 / 有 fiber，共 ' + v.entriesTotal + ' 个 entry）')
    : ('热重载可行性：❌ 不可行 —— ' + String(v.notes || '未知') + '（loaderReachable=' + v.loaderReachable + ' selfFound=' + v.selfFound + ' selfHasFiber=' + v.selfHasFiber + '）') }];
}
function renderPlan(_a, v) {
  if (!v.ok) return [{ type: 'text', text: '热重载计划：❌ ' + String(v.reason || '预检未过') }];
  return [{ type: 'text', text: '热重载' + (v.dryRun ? '计划（dryRun，未动手）' : '已执行') + '：' + (v.steps || []).join(' → ') }];
}

/**
 * @param {object} deps { logger, getLoader, selfId, doReload }
 */
export function createHotReloadTools(deps) {
  const d = deps || {};
  const log = d.logger || null;
  const selfId = String(d.selfId || 'unified-memory');
  const getLoader = typeof d.getLoader === 'function' ? d.getLoader : () => null;

  const probeMod = createHotReloadProbe({ logger: log });
  const guardMod = createHotReloadGuard({ logger: log });

  // ── 工具 1：hotreload_probe（纯只读）──
  const probeTool = {
    name: 'hotreload_probe',
    output: { schema: PROBE_OUTPUT, render: renderProbe },
    description: [
      '【只读】回答一个问题：本插件在当前进程里能不能热重载。',
      '',
      '检查三件事：① ctx.loader 拿得到吗 ② 按 id 找得到自己的 entry 吗 ③ 那个 entry 上有 fiber（可 dispose）吗。',
      '⛔ 不改任何状态 —— 不 dispose、不 update、不 remove。可以随时安全调用。',
    ].join('\n'),
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    async execute() {
      const rep = probeMod.probe(getLoader, selfId);
      return {
        ok: rep.ok,
        loaderReachable: !!rep.loaderReachable,
        entriesTotal: Number(rep.entriesTotal) || 0,
        selfFound: !!rep.selfFound,
        selfHasFiber: !!rep.selfHasFiber,
        selfId: String(rep.selfId || ''),
        notes: (rep.notes || []).join('; '),
        reloadMark: Number(RELOAD_TEST_MARK),
      };
    },
  };

  // ── 工具 2：hotreload_dryrun（预检 + 计划，不动手）──
  const dryrunTool = {
    name: 'hotreload_dryrun',
    output: { schema: PLAN_OUTPUT, render: renderPlan },
    description: [
      '【零风险】预检并报告热重载计划，但**不动手**。',
      '',
      '会告诉你：预检过没过、如果真执行会走哪几步。',
      '⛔ 不 dispose、不重载 —— 只报告计划。',
      '适合在做真正热重载前，先确认"计划长什么样"。',
    ].join('\n'),
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    async execute() {
      const r = await guardMod.reloadWithGuard({
        getLoader, selfId,
        dryRun: true,
        reload: async () => {},
        rescue: async () => {},
      });
      return { ok: !!r.ok, dryRun: true, reason: String(r.reason || ''), steps: (r.steps || []).map(String) };
    },
  };

  // ── 工具 3：hotreload_apply（真执行，**双保险门禁**）──
  //   ⛔ 默认只报告计划。必须**同时**满足两个条件才真动手：
  //      ① confirm === true   ② 调用方明确知道这会中断当前调用链
  //   第三个工具的注册由 index.js 控制（可通过配置关掉）。
  const applyTool = {
    name: 'hotreload_apply',
    output: { schema: PLAN_OUTPUT, render: renderPlan },
    description: [
      '【真执行】热重载本插件：先挂保险 → dispose 自己 → 重新 import 并 apply。',
      '',
      '⛔ confirm 不为 true 时**只报告计划**，不动手。',
      '⚠️ 执行后当前调用的返回值会中断（插件已被卸载），这是预期行为。',
      '⚠️ 失败时保险会在几秒后尝试救回；救不回来只能重启 DSH。',
      '',
      '用于：改完插件代码后，不重启 DSH 就让新代码生效。',
    ].join('\n'),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        confirm: { type: 'boolean', description: '必须显式传 true 才真执行' },
      },
    },
    async execute(args) {
      const a = args || {};
      // 门禁一：没确认 ⇒ 只报告
      if (a.confirm !== true) {
        return {
          ok: false, dryRun: true, reason: '未传 confirm:true —— 只报告不动手',
          steps: ['precheck 未执行（需 confirm:true）'],
        };
      }
      // 门禁二：必须有真执行函数
      if (typeof d.rotate !== 'function') {
        return { ok: false, dryRun: true, reason: '未注入 rotate 实现', steps: ['no-rotate-fn'] };
      }
      const r = await d.rotate();
      return { ok: !!r.ok, dryRun: false, reason: String(r.reason || ''), steps: (r.steps || []).map(String) };
    },
  };

  return [probeTool, dryrunTool, applyTool];
}

export default { createHotReloadTools };
