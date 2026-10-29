/**
 * retrieval/breaker.js —— 向量路熔断器（期6红队结论3 的根治件）
 * [2026-10-22 by Assistant]
 *
 * 红队指出：向量端点只有超时，**没有失败熔断/退避**。
 * 断网时每一轮检索都要白等一次超时（默认 12s）⇒ 首字被拖死，而 BM25 明明能正常工作。
 *
 * 纯函数 + 显式时间注入，便于确定性测试：
 *   ok(now)       记录一次成功 ⇒ 复位
 *   fail(now)     记录一次失败 ⇒ 连续 3 次后打开熔断（冷却指数增长，封顶）
 *   allows(now)   当前是否允许尝试（熔断打开期间返回 false ⇒ 调用方直接跳过，零等待）
 *   note()        诊断快照
 */
export function createBreaker(opts) {
  const o = opts || {};
  const threshold = Number(o.threshold) || 3;
  const baseCooldownMs = Number(o.baseCooldownMs) || 5 * 60 * 1000;
  const maxCooldownMs = Number(o.maxCooldownMs) || 30 * 60 * 1000;

  const st = { fails: 0, openUntil: 0, cooldownMs: baseCooldownMs, opens: 0, lastFailAt: 0, lastOkAt: 0 };

  return {
    allows(now) {
      const t = Number(now) || Date.now();
      return t >= st.openUntil;
    },
    ok(now) {
      const t = Number(now) || Date.now();
      st.fails = 0;
      st.openUntil = 0;
      st.cooldownMs = baseCooldownMs;
      st.lastOkAt = t;
    },
    fail(now) {
      const t = Number(now) || Date.now();
      st.fails += 1;
      st.lastFailAt = t;
      if (st.fails >= threshold) {
        st.openUntil = t + st.cooldownMs;
        st.opens += 1;
        // 冷却指数增长，封顶 maxCooldownMs（避免一次故障后永远不再尝试）
        st.cooldownMs = Math.min(maxCooldownMs, st.cooldownMs * 2);
      }
      return { fails: st.fails, openUntil: st.openUntil, cooldownMs: st.cooldownMs };
    },
    note(now) {
      const t = Number(now) || Date.now();
      return {
        fails: st.fails,
        open: t < st.openUntil,
        retryInMs: Math.max(0, st.openUntil - t),
        cooldownMs: st.cooldownMs,
        opens: st.opens,
        threshold,
      };
    },
    reset() { st.fails = 0; st.openUntil = 0; st.cooldownMs = baseCooldownMs; },

    /**
     * [2026-10-26 by Assistant · 向量备路 P0] **探路成功信号**（不是 ok，别混淆）。
     *
     * 场景：主路熔断中，但**备路扛住了**（这一轮检索是有结果的）。
     *   此时如果什么都不做，主路熔断按指数增长冷却 5→10→20→30 分钟，
     *   而备路越常救场、主路越难恢复。
     *
     * 语义设计（刻意与 ok() 区分）：
     *   · ok()      = 「主路真的成功了」⇒ 全部复位
     *   · probeOk() = 「备路替我们争取到一次探路机会」⇒ **只把冷却回缩**（减半、不低于 base），
     *                 失败计数**不清零**。这样主路会更快被再探一次：
     *                 真恢复了 ⇒ 下一次 ok() 复位；还是坏的 ⇒ fail() 立刻重新打开。
     *
     * 为什么不直接 ok()：那等于「备路成功就假装主路好了」，
     *   主路持续故障时会导致每轮都白等一次主路超时（12s），正是原本要避免的坑。
     */
    probeOk(now) {
      const t = Number(now) || Date.now();
      // 只对「当前正处于熔断中」的情形回缩，正常状态不动
      if (t < st.openUntil) {
        st.cooldownMs = Math.max(baseCooldownMs, Math.floor(st.cooldownMs / 2));
        st.openUntil = Math.min(st.openUntil, t + st.cooldownMs);
      }
      return this.note(t);
    },
  };
}
