/**
 * lib/dispatch/hotreload-guard.js —— 热重载保险（2026-10-28）
 *
 * ## 为什么需要"保险"
 * 第一步探针已确认（真实进程日志）：
 *   loaderReachable: true · entriesTotal: 227 · selfFound: true · selfHasFiber: true
 * 三问全绿 ⇒ 技术上有条件做热重载。
 *
 * 但最危险的情况是：**dispose 之后没装回来** ⇒ 插件从进程里消失，
 * 只能靠重启救。保险要解决的正是这个。
 *
 * ## 保险的三层设计
 *   ① **预检**：动手前先确认"我确实找得到自己"，找不到就什么都不做
 *   ② **先挂后拆**（关键）：先排一个延迟恢复定时器，**然后**才 dispose。
 *      哪怕中间崩了/进程卡了，定时器到点会把插件装回来。
 *   ③ **成功即撤**：新 fiber 装好后立刻撤掉定时器，避免多余的第二次装载。
 *
 * ## 铁律
 *   ⛔ 绝不"先拆后挂" —— 那是唯一会真正丢插件的顺序
 *   ⛔ 绝不在拿不到 loader 时强行动手
 *   ✅ 一切失败都返回 {ok:false, reason}，不抛、不假装成功
 */

/**
 * @param {object} deps { logger }
 */
export function createHotReloadGuard(deps) {
  const d = deps || {};
  const log = d.logger || null;
  // [2026-10-28] 供测试验证"保险是否先于 dispose 挂上"的**只读计数**。
  //   只暴露数字，不暴露任何操作能力。
  let __armedCount = 0;

  /**
   * 安排一次"保险恢复"：在 ms 毫秒后，如果还没被撤销，就执行 rescue。
   * @returns {{ cancel: Function, fired: () => boolean }}
   */
  function armRescue(ms, rescue) {
    let fired = false;
    __armedCount++;
    let cancelled = false;
    const timer = setTimeout(async () => {
      if (cancelled) return;
      fired = true;
      try {
        await rescue();
      } catch (e) {
        try { log && log.miss && log.miss({ level: 'hotreload-rescue-failed', reason: String(e && e.message || e) }); } catch {}
      }
    }, Math.max(1000, Number(ms) || 3000));
    // 别让这个定时器拖住进程退出
    try { timer.unref && timer.unref(); } catch {}
    return {
      cancel() { cancelled = true; try { clearTimeout(timer); } catch {} },
      fired: () => fired,
    };
  }

  /**
   * 预检：能不能安全地对自己动手。
   * @returns {{ok:boolean, reason?:string, fiber?:object, entry?:object}}
   */
  function precheck(getLoader, selfId) {
    try {
      const loader = typeof getLoader === 'function' ? getLoader() : null;
      if (!loader) return { ok: false, reason: 'no-loader' };
      if (typeof loader.entries !== 'function') return { ok: false, reason: 'no-entries-api' };
      const target = String(selfId || '');
      if (!target) return { ok: false, reason: 'no-self-id' };
      let entry = null;
      for (const e of loader.entries()) {
        let id = '';
        try { id = String((e && e.options && (e.options.id || e.options.name)) || ''); } catch {}
        if (id === target) { entry = e; break; }
      }
      if (!entry) return { ok: false, reason: 'self-not-found' };
      const fiber = entry.fiber;
      if (!fiber || typeof fiber.dispose !== 'function') return { ok: false, reason: 'no-dispose' };
      return { ok: true, fiber, entry };
    } catch (e) {
      return { ok: false, reason: 'precheck-threw:' + String(e && e.message || e) };
    }
  }

  /**
   * 执行一次受保护的热重载。
   *
   * @param {object} p
   *   getLoader()        → loader
   *   selfId             → 自己的 entry id
   *   reload             → async () => void   真正"重新加载"的动作（import + apply）
   *   rescueDelayMs      → 保险多久后强救（默认 3000）
   *   rescue             → async () => void   保险动作（重新 create 自己）
   *   dryRun             → true 则只预检 + 报告计划，不动手
   * @returns {{ok:boolean, dryRun?:boolean, reason?:string, steps:string[]}}
   */
  async function reloadWithGuard(p) {
    const o = p || {};
    const steps = [];

    // ① 预检
    const pre = precheck(o.getLoader, o.selfId);
    if (!pre.ok) {
      return { ok: false, reason: pre.reason, steps: ['precheck failed: ' + pre.reason] };
    }
    steps.push('precheck ok');

    if (o.dryRun === true) {
      // 只报告计划，不动手 —— 这是最安全的验证方式
      steps.push('dryRun: 计划 = 挂保险 → dispose → reload → 撤保险');
      steps.push('dryRun: 未执行任何状态变更');
      try { log && log.wake && log.wake({ level: 'hotreload-dryrun', plan: 'arm->dispose->reload->disarm' }); } catch {}
      return { ok: true, dryRun: true, steps };
    }

    if (typeof o.reload !== 'function') {
      return { ok: false, reason: 'no-reload-fn', steps };
    }
    if (typeof o.rescue !== 'function') {
      return { ok: false, reason: 'no-rescue-fn', steps: steps.concat('拒绝执行：没有保险不拆') };
    }

    // ② 先挂保险（关键顺序）
    const delay = Number(o.rescueDelayMs) || 3000;
    const guard = armRescue(delay, o.rescue);
    steps.push('armed rescue in ' + delay + 'ms');

    // ③ 才 dispose
    try {
      pre.fiber.dispose();
      steps.push('disposed');
    } catch (e) {
      guard.cancel();
      return { ok: false, reason: 'dispose-threw:' + String(e && e.message || e), steps };
    }

    // ④ reload
    try {
      await o.reload();
      steps.push('reloaded');
    } catch (e) {
      // ⚠️ 这里**不 cancel**：让保险到点把插件救回来
      steps.push('reload-threw（保险会接手）');
      return { ok: false, reason: 'reload-threw:' + String(e && e.message || e), steps };
    }

    // ⑤ 成功 ⇒ 撤保险
    guard.cancel();
    steps.push('disarmed');
    try { log && log.wake && log.wake({ level: 'hotreload-ok', steps: steps.join(' -> ') }); } catch {}
    return { ok: true, steps };
  }

  return {
    precheck,
    armRescue,
    reloadWithGuard,
    // 只读调试钩子：已挂的保险数量（供测试验证顺序，不能改变行为）
    __debugArmedCount: () => __armedCount,
  };
}

export default { createHotReloadGuard };
