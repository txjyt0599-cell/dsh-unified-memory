/**
 * 降级调度器（期1 骨架）。
 * 四级降级表（红队 H3 要求写死，不许嵌套递归）：
 *   L0 hypergraph  → 期2 才有，期1 恒不可用
 *   L1 engram      → 期1 只有 health()，recall 抛 ⇒ 自动降级
 *   L2 alias+grep  → 期1 用 journal 的 readRaw 做 grep 兜底（只搜记忆目录，不搜日记）
 *   L3 fixed       → 固定文案
 * 铁律：任一级抛错都 catch，绝不向上冒（否则整轮崩）。
 */
export const DEGRADE_LEVELS = ['hypergraph', 'engram', 'grep', 'fixed'];

export const FIXED_TEXT = '（记忆检索本轮不可用，Assistant按记忆诚实原则只用当前上下文）';

export function createOrchestrator({ backends = [], scorer = null, logger = null, budgetTokens = 450, retriever = null } = {}) {
  const byId = new Map(backends.map((b) => [b.id, b]));

  function levelAvailability() {
    const avail = {};
    for (const id of DEGRADE_LEVELS) {
      if (id === 'fixed') { avail[id] = true; continue; }
      if (id === 'grep') { avail[id] = !!byId.get('journal'); continue; }
      const b = byId.get(id);
      // 健康 ≠ 可用：后端必须声明「真能检索」才算 up（期1 engram 明确 false）
      const healthy = !!(b && typeof b.health === 'function' && b.health().ok);
      const implemented = b?.recallImplemented !== false;
      avail[id] = healthy && implemented;
    }
    return avail;
  }

  async function recall(query, opts) {
    const t0 = Date.now();
    // [2026-10-21 by Assistant · 期4 联动] 调用方可覆盖候选池预算。
    //   背景：orchestrator 原用固定 budgetTokens(450) 截断 retriever 候选，
    //   那是给「平铺渲染」设的输出预算；期4 接管渲染后，候选池不该被输出预算卡死
    //   （实测：24 条候选被砍到 4 条，L0 只能从那 4 条里挑）。
    const candidateBudget = opts && opts.tokenBudget !== undefined ? opts.tokenBudget : budgetTokens;

    // ── 期3 L0：三级检索（有 retriever 且已暖 ⇒ 直接用；任何异常一律下行，不上抛）──
    if (retriever) {
      try {
        const h = retriever.health();
        if (h && h.ok) {
          // [2026-10-27 · 双轨制] excludeIds：直通区已保送的 id，检索侧直接剔除，绝不双份占 token
          const searchOpts = { tokenBudget: candidateBudget };
          if (opts && Array.isArray(opts.excludeIds) && opts.excludeIds.length) {
            searchOpts.excludeIds = opts.excludeIds;
          }
          const r = await retriever.search(query, searchOpts);
          if (r && r.hits && r.hits.length) {
            logger?.wake({ level: 'retrieval:' + r.degrade, n: r.hits.length, ms: r.timing && r.timing.total, q: String(query).slice(0, 80) });
            // [2026-10-23 · 双轨] flashback 一起带出去，供注入层渲染「远期联想」独立区块
          return { level: 'hypergraph', hits: r.hits, ms: Date.now() - t0, degrade: r.degrade, tokens: r.tokens, flashback: r.flashback || null };
          }
          logger?.miss({ level: 'retrieval-empty', ms: r && r.timing && r.timing.total, q: String(query).slice(0, 80) });
        }
      } catch (e) {
        // 静默下行，但**必须留痕**：期3 曾因变量名笔误被 catch 吞掉，整条分支失效却无任何症状
        try { logger?.miss({ level: 'retrieval-error', reason: String(e && e.message || e), q: String(query).slice(0, 80) }); } catch {}
      }
    }

    const avail = levelAvailability();

    // L1: engram —— 期1 必然抛 not-implemented，正好验证降级链
    if (avail.engram) {
      try {
        const hits = await byId.get('engram').recall(query, { limit: 5 });
        if (hits && hits.length) {
          const r = { level: 'engram', hits, ms: Date.now() - t0 };
          logger?.wake({ level: r.level, n: hits.length, ms: r.ms, q: String(query).slice(0, 80) });
          return r;
        }
      } catch { /* 落到下一级 */ }
    }

    // L2: grep 兜底（只读本子以外的东西——期1 无来源，返回空）
    if (avail.grep) {
      try {
        const hits = [];   // 期1 无 grep 数据源，必然空
        if (hits.length) {
          const r = { level: 'grep', hits, ms: Date.now() - t0 };
          logger?.wake({ level: r.level, n: hits.length, ms: r.ms, q: String(query).slice(0, 80) });
          return r;
        }
        logger?.miss({ level: 'grep-empty', ms: Date.now() - t0, q: String(query).slice(0, 80) });
      } catch {}
    }

    // L3: 固定文案
    logger?.miss({ level: 'fixed', ms: Date.now() - t0, q: String(query).slice(0, 80) });
    return { level: 'fixed', hits: [], text: FIXED_TEXT, ms: Date.now() - t0 };
  }

  return { recall, levelAvailability, DEGRADE_LEVELS };
}
