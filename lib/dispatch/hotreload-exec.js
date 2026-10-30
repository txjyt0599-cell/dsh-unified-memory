/**
 * lib/dispatch/hotreload-exec.js —— 真执行热重载（2026-10-28）
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⛔⛔ 本模块的第一版**真跑就翻车了，请务必先读这段** ⛔⛔
 *
 * 2026-10-28 19:43，第一次真执行 hotreload_apply{confirm:true}：
 *   steps = precheck ok → armed rescue → scheduled reload → disposed self
 *   **然后记忆插件永久消失**：工具全没、日志零条 rescue、没有第二次注册。
 *
 * 三个死因（都是我写的）：
 *   ① 重装回调用了 `mod.apply(p.ctx, p.config)` —— p.ctx 属于刚被 dispose 的 fiber
 *      ⇒ 必然抛错。**这是最致命的**。
 *   ② catch 全静默 ⇒ 失败了也看不出来，看起来"安排了"实际一步没跑。
 *   ③ 保险动作和被保对象**用同一个死掉的 ctx** ⇒ **保险等于没有**。
 *      讽刺的是我当时写了 22 项验收 + 3 条变异全绿 ——
 *      因为测试用的都是假 ctx，假的永远不会失效。
 *
 * 结论（已写进 E1~E5 五条断言锁死）：
 *   **进程内自愈做不到**。插件被 dispose 后就没有"活的 ctx"了，
 *   除非宿主提供外部重装入口（externalReload）。
 *   ⇒ 本模块现在：没有 externalReload 就**拒绝自拆**，绝不再拆了自己装不回来。
 * ══════════════════════════════════════════════════════════════════════
 *
 * ## 仍然成立的部分
 *   ESM 模块缓存可用 `?v=时间戳` 绕过（import 能拿到新代码）；
 *   cordis 的 fiber.dispose() 确实能干净卸载（实验证明五类副作用归零）。
 *   **卡住的只有"装回来"这一步。**
 *
 * ## 安全设计（继承保险模块）
 *   ① 预检不过 ⇒ 一律不动手
 *   ② 先挂保险 ⇒ 才 dispose
 *   ③ reload 失败 ⇒ 保险到点接手
 *   ④ 成功 ⇒ 撤保险
 */

import { createHotReloadGuard } from './hotreload-guard.js';

/**
 * @param {object} p
 *   getLoader()       → loader
 *   selfId            → 自己的 entry id
 *   moduleUrl         → 要重新加载的模块 URL（如 file:///.../lib/index.js）
 *   applyArgs         → { ctx, config }  重新 apply 需要的参数
 *   rescueDelayMs     → 保险延迟
 * @returns {Promise<{ok:boolean, reason?:string, steps:string[], newMark?:number}>}
 */
export async function reloadSelf(p) {
  const g = createHotReloadGuard({});
  const steps = [];

  const pre = g.precheck(p.getLoader, p.selfId);
  if (!pre.ok) return { ok: false, reason: 'precheck:' + pre.reason, steps: ['precheck failed'] };
  steps.push('precheck ok');

  if (typeof p.moduleUrl !== 'string' || !p.moduleUrl) {
    return { ok: false, reason: 'no-module-url', steps };
  }
  if (!p.ctx || !p.config) {
    return { ok: false, reason: 'no-apply-args', steps: steps.concat('缺少 ctx/config，无法重新 apply') };
  }

  // ── [2026-10-28 真跑后重写] ──
  //   旧版本这里是 `mod.apply(p.ctx, p.config)` —— 那是造成"插件永久消失"的死因：
  //   p.ctx 属于**已被 dispose 的 fiber**，用它 apply 一定抛错。
  //   ⇒ 现在 reloadSelf 只做"**准备**"：真正拿到新代码（import 带时间戳），
  //      但**不**用旧 ctx 去 apply。apply 必须由外部重装器用**活的 ctx** 执行。
  const rescue = async () => {
    // 保险也只做"把新代码取回来"，不擅自 apply
    try {
      await import(p.moduleUrl);
      steps.push('rescue-imported');
    } catch (e) {
      steps.push('rescue-failed:' + String(e && e.message || e));
    }
  };

  // reload 动作：带时间戳绕过 ESM 缓存，拿到**新代码**（不 apply）
  const reload = async () => {
    const sep = p.moduleUrl.includes('?') ? '&' : '?';
    const freshUrl = p.moduleUrl + sep + 'v=' + Date.now();
    const mod = await import(freshUrl);
    steps.push('fresh-module-imported（未 apply —— 需活的 ctx）');
    return mod;
  };

  // ⚠️ 注意：这里**不 dispose**，而是让调用方决定。
  //   为什么？因为 dispose 会把当前正在执行的这段代码也一起干掉
  //   （我们此刻就在被 dispose 的插件里跑）。
  //   ⇒ 真正的顺序必须是：先把"重装动作"排到一个**外部载体**（setTimeout/微任务）里，
  //      再 dispose 自己。见 rotateSelf()。
  return { ok: true, steps: steps.concat('prepared (尚未 dispose)'), _reload: reload, _rescue: rescue };
}

/**
 * 旋转式热重载：**先安排、后自毁**。
 *   ① 立刻安排一个异步任务（脱离当前调用栈）去执行 reload
 *   ② 然后 dispose 自己
 *   ③ 异步任务在下一轮事件循环里执行 ⇒ 那时旧 fiber 已经卸掉，新代码可以干净装上
 *
 * @returns {Promise<{ok:boolean, reason?:string, steps:string[]}>}
 */
export async function rotateSelf(p) {
  const g = createHotReloadGuard({});
  const pre = g.precheck(p.getLoader, p.selfId);
  if (!pre.ok) return { ok: false, reason: 'precheck:' + pre.reason, steps: ['precheck failed'] };
  if (!p.ctx || !p.config || !p.moduleUrl) {
    return { ok: false, reason: 'missing-args', steps: ['缺少 ctx/config/moduleUrl'] };
  }

  const steps = ['precheck ok'];
  const delay = Number(p.rescueDelayMs) || 5000;

  // ── [2026-10-28 真跑一次后修三个真缺陷] ──
  //   第一次真执行的结果：dispose 成功，但**插件再也没装回来**。
  //   日志里没有 rescue，也没有第二次注册 —— 说明"安排的重装"根本没跑到。
  //
  //   缺陷 ①（致命）：setTimeout 的回调里用了 `p.ctx` ——
  //      那是**已被 dispose 的 fiber 的 ctx**。用它 apply 会抛，
  //      而我在 catch 里静默吞掉了 ⇒ 看起来"安排了"，实际什么都没发生。
  //      ⇒ 修：重装**根本不该复用旧 ctx**。必须由宿主提供"能重新拉起自己"的能力
  //        （DSH 里= loader.create/update；拿不到就明确报"不支持自愈"，别假装）。
  //   缺陷 ②：保险同样依赖同一套 p.ctx ⇒ 保险与被保对象有同一个死因，
  //      **这等于没有保险**。⇒ 修：保险必须是外部载体（文件标记 + 外部器），
  //      或者干脆承认"进程内自愈不可能"，退回"重启"。
  //   缺陷 ③：catch 全静默 ⇒ 失败无痕。⇒ 修：把每一步失败都记下来。
  //
  //   ⇒ 本版的诚实结论：**进程内自愈做不到**（除非宿主提供 reloader）。
  //      所以 rotateSelf 改成：先检查有没有可靠的外部重装能力；
  //      没有就**拒绝执行**（而不是拆了自己再装不回来）。
  const hasExternalReloader = typeof p.externalReload === 'function';
  if (!hasExternalReloader) {
    return {
      ok: false,
      reason: 'no-external-reloader：没有可靠的"把自己装回来"的能力，拒绝自拆',
      steps: ['precheck ok', '拒绝执行：进程内自愈不可靠（实测已证明会永久丢插件）'],
    };
  }
  steps.push('external reloader available');

  // ① 先挂保险（如果调用方能给保险动作）
  let guard = null;
  if (typeof p.rescueDelayMs === 'number' && typeof p.rescue === 'function') {
    guard = g.armRescue(delay, async () => {
      try { await p.rescue(); } catch { /* 外部器自己去记 */ }
    });
    steps.push('armed rescue in ' + delay + 'ms');
  }

  // ② 交给外部重装器：它负责"卸载 + 重新加载"
  try {
    await p.externalReload();
    steps.push('external reload done');
  } catch (e) {
    if (guard) guard.cancel();
    return { ok: false, reason: 'external-reload-threw:' + String(e && e.message || e), steps };
  }

  if (guard) guard.cancel();
  return { ok: true, steps };
}

export default { reloadSelf, rotateSelf };
