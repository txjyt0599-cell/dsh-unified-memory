/**
 * 热重载 · 第一步：只读探针（2026-10-28）
 *
 * ## 目标（只做一件事）
 *   在**真实 DSH 进程里**回答三个问题：
 *     ① 插件能拿到 ctx.loader 吗
 *     ② 能按 id（'unified-memory'）找到自己的 entry 吗
 *     ③ 那个 entry 上有 fiber 吗（有 fiber 才能 dispose）
 *
 * ## 安全边界（这是第一步的全部意义）
 *   ⛔ 只读：不 dispose、不 update、不 remove、不改配置
 *   ✅ 只记录"我看到了什么"，不做任何状态变更
 *
 * ## 用法
 *   作为插件内的一个只读工具（或 pre-step 里跑一次），把结果写日志。
 */
export function createHotReloadProbe(deps) {
  const d = deps || {};
  const log = d.logger || null;

  /** 只读探测：返回一份"我能看到什么"的报告 */
  function probe(getLoader, selfPluginId) {
    const report = {
      ok: false,
      loaderReachable: false,
      entriesTotal: 0,
      selfFound: false,
      selfHasFiber: false,
      selfId: String(selfPluginId || ''),
      sampleEntryIds: [],
      notes: [],
    };
    try {
      const loader = typeof getLoader === 'function' ? getLoader() : null;
      if (!loader) {
        report.notes.push('loader 取不到（ctx.loader 为 null/undefined）');
        return report;
      }
      report.loaderReachable = true;

      // ① 能列 entries 吗
      let entries = [];
      if (typeof loader.entries === 'function') {
        try { entries = Array.from(loader.entries()); } catch (e) { report.notes.push('entries() 抛错: ' + e.message); }
      } else {
        report.notes.push('loader 没有 entries() 方法');
      }
      report.entriesTotal = entries.length;
      report.sampleEntryIds = entries.slice(0, 8).map(function (e) {
        try { return String((e && e.options && (e.options.id || e.options.name)) || '(no-id)'); } catch { return '?'; }
      });

      // ② 按 id 找自己
      const target = String(selfPluginId || '');
      for (const e of entries) {
        let id = '';
        try { id = String((e && e.options && (e.options.id || e.options.name)) || ''); } catch {}
        if (id === target) {
          report.selfFound = true;
          // ③ 有没有 fiber
          try { report.selfHasFiber = !!(e && e.fiber && typeof e.fiber.dispose === 'function'); } catch {}
          break;
        }
      }
      if (!report.selfFound) {
        report.notes.push('没在 entries 里找到 id=' + target + '（可能 id 不同，或本插件走的是 bundle 路径）');
      }
      report.ok = report.loaderReachable && report.selfFound && report.selfHasFiber;
      return report;
    } catch (e) {
      report.notes.push('探测抛错: ' + String(e && e.message || e));
      return report;
    }
  }

  /**
   * 把探测结果记进日志（不写文件、不改状态）。
   * @returns {object} 同样的报告，便于调用方判断
   */
  function probeAndLog(getLoader, selfPluginId) {
    const rep = probe(getLoader, selfPluginId);
    try {
      log && log.wake && log.wake({
        level: 'hotreload-probe',
        ok: rep.ok,
        loaderReachable: rep.loaderReachable,
        entriesTotal: rep.entriesTotal,
        selfFound: rep.selfFound,
        selfHasFiber: rep.selfHasFiber,
        selfId: rep.selfId,
        notes: rep.notes.join('; ') || undefined,
      });
    } catch {}
    return rep;
  }

  return { probe, probeAndLog };
}

export default { createHotReloadProbe };
