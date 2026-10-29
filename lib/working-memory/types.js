/**
 * types.js —— 期4 分层工作记忆的常量与配置默认值。零 IO、零依赖。
 * 依据：_team-v2/p4/DESIGN.md §1.1 / §1.5；红队 B2（相对上限）/ H5（队列≠输出）/ L1（合并规则）。
 *
 * 三条铁律：
 *   ① L0 容量是**相对上限**（输入 token × factor），不许出现 500 token 这类硬限
 *   ② 扩散的 queueCap（保险丝）与 outputCap（真输出）**分开计**，不许混称
 *   ③ 无超边卡（noEdge）只走 Stage1 原分入 L0，bonus=0、不降权、不被过滤
 */

/** 工作记忆层级。L0=本回合注入区；L1/L2/L3=常驻候选池（不占上下文）。 */
export const WM_LEVELS = Object.freeze(['L0', 'L1', 'L2', 'L3']);

/** 渲染粒度：同一预算下粒度决定能装几张（p4 实测：30 张分级渲染 ≈357 token）。 */
export const RENDER_TIER = Object.freeze({ full: 'full', summary: 'summary', title: 'title' });

/** 进入 L0 的原因（可观测、可解释）。 */
export const WM_REASON = Object.freeze({
  retrieval: 'retrieval', spread: 'spread', intersection: 'intersection',
  carry: 'carry', pinned: 'pinned',
});

/** 默认配置（全部带实测依据，改之前先看 DESIGN §0 实测表）。 */
export const WM_DEFAULTS = Object.freeze({
  l0: Object.freeze({
    /** 相对上限系数：L0 ≤ 输入 token × 8（规划口径，红队 B2 认可的替换值） */
    factor: 8,
    /**
     * 地板：极短输入（"嗯"）也要能装下足够多的入口。
     *
     * [2026-10-22 by Assistant · 实测修正] 原值 240 是照「平均 30.9 tok/张」算的，
     * 但**渲染不是均匀成本**：第 1 张是 full 档（[[标题]][层] ↑因 ↓果 : 摘要120字）
     * 单张就吃 ~150 token，剩 90 token 只够 2~3 条标题。
     * 实测日志长期是「L0 已用 237/240」—— 打满且只装 3~5 张。
     * 后果：User问「Assistant刚才说了什么」这类**短查询**（20 token × 8 = 160 < 240），
     * 只能拿到 3~5 条标题，细节全在 open 展开里，所以别的会话「答不上来」。
     *
     * 240 → 800：短查询能装 15~20 条（1 full + 2 summary + 其余 title）。
     * 成本可控：注入在**消息尾**，不破前缀缓存，560 token 增量走 cacheRead 极便宜。
     */
    floorTokens: 800,
    /** 天花板保险丝：占 100k 上下文的 4%，防长输入把注入撑爆 */
    ceilingTokens: 4096,
    /** 卡数上限 = Stage3 top-30 口径 */
    maxCards: 30,
    /** 注入段 HEADER 的固定 token 开销（实测 75）——必须计入预算 */
    headerTokens: 75,
  }),
  /**
   * [2026-10-22 by Assistant · 架构补] 时间新鲜度。
   *
   * 为什么必须有：原架构里候选对象只有 {cardId, score, via}，
   *   finalScore = base × gain，**时间完全不参与**；
   *   渲染档位又按 BM25 排名给 ⇒ 结果就是「两天前刚发生的事」和「两周前的事」
   *   在注入里一样长、甚至后者更长。User说的「越近越详细」做不到。
   *
   * 现在：recency = 0.5 ^ (ageDays / halfLifeDays)，进 finalScore 加权，
   *   并且**渲染档位按 recency 分配**（最近 detailTop 条给 full/summary）。
   */
  /** L1→L0 原话补充默认关闭，避免扩大注入面。 */
 l0Detail: false,
 l0DetailChars:600,
 recency: Object.freeze({
    /** 半衰期（天）：7 天前的事权重减半 */
    halfLifeDays: 7,
    /** 进 finalScore 的权重（0 = 不参与排序，只影响渲染档位） */
    weight: 0.6,
    /** 渲染时最近几条给详细档位（full / summary / summary） */
    detailTop: 3,
    /** 渲染行是否显示「多久以前」 */
    showAge: true,
  }),
  l1: Object.freeze({
    /** 实测每会话 confirmed 卡 P90=43 ⇒ 40 覆盖九成会话（待 100 探针复验） */
    maxCards: 40,
    minActivation: 0.05,
    idleDropMs: 14 * 24 * 3600 * 1000,
  }),
  l2: Object.freeze({
    maxCards: 300,
    minActivation: 0.02,
  }),
  l3: Object.freeze({
    /** 只防全量载入内存，不是淘汰线 */
    maxCards: 20000,
  }),
  spread: Object.freeze({
    /** 每跳衰减（NeuralMemory 默认；规划允许 λ∈[0.3,0.7] 网格搜索） */
    decay: 0.5,
    /** 实测 3 跳已覆盖 P99 211 节点 */
    maxHops: 3,
    /** 剪枝阈值（红队 H5 明确要求） */
    minActivation: 0.01,
    /** ★队列上限 = 保险丝（实测 3 跳峰值 335 / 5 跳 571 ⇒ 永不熔断），不是性能旋钮 */
    queueCap: 5000,
    /** ★输出上限 = 真正决定输出多少张，默认 50（规划口径） */
    outputCap: 50,
    /** 多锚点种子数上限（种子 = Stage3 top-N） */
    maxSeeds: 5,
    /** 交点加成：anchorCount 每多 1，排序分 ×(1+bonus) */
    intersectionBonus: 0.6,
    /** 继承（carry）卡的排序权重折扣：不让上回合焦点压过本回合真命中 */
    carryDiscount: 0.8,
  }),
  activation: Object.freeze({
    /** 多会话合并的指数加权移动平均系数（红队 L1 建议值） */
    alpha: 0.7,
    /** 时间半衰期（7 天）：L1 恢复时按此衰减历史激活 */
    halfLifeMs: 7 * 24 * 3600 * 1000,
    /** 记录数上限（实测 6142 条 ≈0.8MB，留 3 倍余量） */
    maxRecords: 20000,
    /** sourceSession 的 LRU 深度（只作溯源，不参与数值计算） */
    maxSessions: 8,
    /** 锁过期时间，与期2 超图锁同口径（HARD.LOCK_STALE_MS） */
    lockStaleMs: 120_000,
  }),
});

/** 硬纪律（跨模块共用，别各写一份）。 */
export const WM_HARD = Object.freeze({
  /** activation.json 的格式版本 */
  SCHEMA_VERSION: 1,
  /** 衰减到低于此值视为 0（浮点噪声闸） */
  EPSILON: 1e-9,
  /** 单次 assemble 允许的最大候选处理量（防上游给超大列表） */
  MAX_CANDIDATES: 2000,
  /** 基础激活 bias（规划 §4.2 的 sigmoid 平移量） */
  BIAS: 0.5,
});

/** 浅合并用户配置（只接受已知键，未知键忽略——防拼错静默失效）。 */
export function resolveConfig(cfg) {
  const c = cfg || {};
  function pick(base, over) {
    const out = {};
    for (const k of Object.keys(base)) {
      out[k] = over && over[k] !== undefined && over[k] !== null ? over[k] : base[k];
    }
    return out;
  }
  return {
    l0: pick(WM_DEFAULTS.l0, c.l0),
    l0Detail: c.l0Detail === true,
 l0DetailChars: Number.isFinite(Number(c.l0DetailChars)) ? Math.max(0, Number(c.l0DetailChars)) : WM_DEFAULTS.l0DetailChars,
 recency: pick(WM_DEFAULTS.recency, c.recency),
    l1: pick(WM_DEFAULTS.l1, c.l1),
    l2: pick(WM_DEFAULTS.l2, c.l2),
    l3: pick(WM_DEFAULTS.l3, c.l3),
    spread: pick(WM_DEFAULTS.spread, c.spread),
    activation: pick(WM_DEFAULTS.activation, c.activation),
    /** 总开关：false ⇒ assemble 直接返回空（R1 软回滚档） */
    enabled: c.enabled !== false,
  };
}

/** 归一化激活到 0..1（sigmoid）。落盘前统一走这里，避免量级漂移。 */
export function normalizeActivation(raw) {
  const x = Number(raw);
  if (!Number.isFinite(x)) return 0;
  if (x >= 0) return 1 / (1 + Math.exp(-x));
  const e = Math.exp(x);
  return e / (1 + e);
}

export default { WM_LEVELS, RENDER_TIER, WM_REASON, WM_DEFAULTS, WM_HARD, resolveConfig, normalizeActivation };
