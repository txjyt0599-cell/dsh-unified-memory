/**
 * graph.js —— 代数隐式超图（期8.3）
 * 依据：_team-v2/p8/DESIGN.md §五（代数隐式超图）+ §九.2（MAX_EDGE 动态双阈值终裁）
 *
 * ── 数学本体 ──────────────────────────────────────────────
 * 超图 = 节点(实体 V) × 超边(事实 E) 的二部关联矩阵 H：H[v][e] = 1 ⟺ 实体 v 出现在事实 e 里。
 * 一度扩散（找出与种子事实共享实体的其它事实）代数式：H^T · D_v^{-1} · H
 *   · D_v 是对角阵，D_v[v][v] = deg(v)
 *   · D_v^{-1} 就是 TF-IDF 式**度惩罚**：出现在 100 条事实里的 "windows"，
 *     单次贡献只有出现在 2 条里的 "rocm" 的 1/50。
 *
 * ── 为什么"隐式" ──────────────────────────────────────────
 * DESIGN §5.2 铁律：**事实文件已含 entities，无需额外存边**。
 * 不存在独立的"图存储"，只在内存里建两张倒排表（entityToFacts / factToEntities）。
 * ⇒ 没有图腐化问题、没有落盘格式、没有迁移成本、冷启动重建即可（丢失可重建）。
 *
 * ── 三条铁律 ──────────────────────────────────────────────
 *  ① 纯内存 + 纯函数 + 零第三方依赖（只用 Node 内置，不许引图库）
 *  ② 不触碰 belief.js / consolidate.js / normalize.js（期8.1/8.2 已验收）
 *  ③ 本模块不读盘、不写盘、不建索引文件 —— 只做内存演算，便于单测
 */

// ── 常量（白队 §9.2 终裁逐字）────────────────────────────────
/** 绝对下界：实体关联事实数超过它就判超级节点。白队定 100（不是 DESIGN 草稿里的 50）。 */
export const MAX_EDGE_ABS = 100;
/** 融合系数：final = alpha*原始分 + (1-alpha)*归一化扩散分。DESIGN §5.3 定 0.6。 */
export const ALPHA = 0.6;
/** 扩散候选上限：防止单次查询被 one-hop 淹没（默认 200，够用又不炸）。 */
export const DEFAULT_MAX_BOOST_FACTS = 200;

/**
 * 实体归一：小写 + 去首尾空白。
 *
 * 为什么只做小写（不做分词/同义合并）：
 *   DESIGN §5.4 的实体同义归一是**写入侧**的事（要跑向量，O(N)），且判据是"写入时延<5ms"。
 *   本模块是**检索侧**，输入已是写入侧产出的规范词元，再做同义合并会引入
 *   检索期的不可预测抖动。这里只做「保证可比」的最小动作 —— 大小写归一。
 */
function normEntity(e) {
  return String(e === undefined || e === null ? '' : e).trim().toLowerCase();
}

/**
 * ① 建二部关联（倒排）。纯函数，不改输入。
 *
 * @param {Array<{id?:string, fact_id?:string, entities?:string[]}>} l1Facts
 *        L1 事实卡数组。id 取值兼容 fact_id（DESIGN §1.1 用的就是 fact_id）。
 * @returns {{entityToFacts:Map<string,Set<string>>, factToEntities:Map<string,string[]>}}
 */
export function buildIncidence(l1Facts) {
  const entityToFacts = new Map();
  const factToEntities = new Map();
  if (!Array.isArray(l1Facts)) return { entityToFacts, factToEntities };

  for (const f of l1Facts) {
    if (!f || typeof f !== 'object') continue;
    // DESIGN §1.1 用 fact_id，检索侧历史代码用 id —— 两个都认，避免调用方踩坑。
    const fid = String(f.id !== undefined && f.id !== null ? f.id : (f.fact_id !== undefined ? f.fact_id : ''));
    if (!fid) continue;
    const ents = Array.isArray(f.entities) ? f.entities : [];
    const seen = new Set();     // 同一事实内重复实体只记一次（防 deg 虚高）
    const list = [];
    for (const raw of ents) {
      const e = normEntity(raw);
      if (!e || seen.has(e)) continue;
      seen.add(e);
      list.push(e);
      let bucket = entityToFacts.get(e);
      if (bucket === undefined) { bucket = new Set(); entityToFacts.set(e, bucket); }
      bucket.add(fid);
    }
    factToEntities.set(fid, list);
  }
  return { entityToFacts, factToEntities };
}

/**
 * ② 动态超级节点阈值（白队 §9.2 终裁）：threshold = max(100, P99)
 *
 * 为什么是动态而不是硬编码 50：
 *   实体度数服从齐夫分布（长尾极长）。硬编码 50 对 ROCm 这种中频词合理，
 *   但对冷门实体过宽 —— 库一大，几乎所有实体都低于 50，截断形同虚设；
 *   反过来对 windows 这种超高频词又太松。P99 让阈值随库的规模自适应。
 *   取 max(100, P99) 是给小库兜底：实体很少时 P99 可能只有 5，
 *   那样会把正常实体误判成超级节点 ⇒ 用 100 做绝对下界。
 *
 * P99 口径：对「所有实体的度」取 99% 分位数（**向上取整索引法，不用插值** ——
 *   度数是整数，插值出来的小数阈值会让 deg==threshold 的边界行为依赖浮点，
 *   而超级节点判定必须是确定性的、可复现的）。
 *
 * @param {Map<string,Set<string>>} entityToFacts
 * @returns {number}
 */
export function computeDynamicThreshold(entityToFacts) {
  if (!entityToFacts || entityToFacts.size === 0) return MAX_EDGE_ABS;
  const degs = [];
  for (const bucket of entityToFacts.values()) degs.push(bucket.size);
  degs.sort(function (a, b) { return a - b; });
  // 向上取整索引：idx = ceil(0.99 * n) - 1，保证 n=1 时取到唯一那个元素
  const n = degs.length;
  let idx = Math.ceil(0.99 * n) - 1;
  if (idx < 0) idx = 0;
  if (idx > n - 1) idx = n - 1;
  const p99 = degs[idx];
  return Math.max(MAX_EDGE_ABS, p99);
}

/**
 * ③ 一度扩散（含度惩罚 + 超级节点截断 + 融合）。
 *
 * 代数含义：对每个种子事实 s、它的每个实体 v，把 v 关联的其它事实 f 加一次
 *           seed.score / deg(v) —— 这正是 H^T · D_v^{-1} · H 的行展开。
 *
 * 三个关键决策（逐条对应 DESIGN / 白队终裁）：
 *   · 度惩罚 1/deg(v)：D_v^-1。没有它，windows 会把 100 条无关事实全捞进来
 *     （Case 3 的病灶就是这个）。
 *   · 超级节点整条跳过：deg(v) > threshold ⇒ **不发散**（不是"取最近 20 条"）。
 *     为什么选"跳过"不选"取最近 20 条"：后者引入时间排序依赖，结果不可复现，
 *     且仍然把 windows 这种噪声灌进候选池（20 条噪声 >> 1 条真信号）。
 *     代价是超级节点上的关联完全丢失 —— 这是刻意的取舍，因为超级节点
 *     本身就是"无区分度"的代名词。
 *   · 融合 alpha=0.6：原始分为主（BM25 已经过实践检验），扩散分只占 0.4，
 *     且扩散分先做**最大值归一化**再乘 —— 否则扩散分量纲与 BM25 分数不可比。
 *
 * 去重语义：同一 fact 经由多条路径命中时，只**累加 boost**，不重复输出
 *     （调用方拿到的是 id 唯一的数组）。via 记最后一条贡献路径。
 *
 * @param {Array<{id:string, score?:number}>} seedFacts  Stage3 之后的候选集
 * @param {{entityToFacts:Map<string,Set<string>>, factToEntities:Map<string,string[]>}} incidence
 * @param {{alpha?:number, threshold?:number, maxBoostFacts?:number}} [opts]
 * @returns {Array<{id:string, score:number, boost:number, via:string}>}
 *          只含**被扩散加分**的事实（种子自身不回传），按最终分降序。
 */
export function expandOneHop(seedFacts, incidence, opts) {
  const o = opts || {};
  const alpha = o.alpha !== undefined ? Number(o.alpha) : ALPHA;
  const maxBoostFacts = o.maxBoostFacts !== undefined ? Number(o.maxBoostFacts) : DEFAULT_MAX_BOOST_FACTS;

  const entityToFacts = incidence && incidence.entityToFacts;
  const factToEntities = incidence && incidence.factToEntities;
  if (!entityToFacts || !factToEntities) return [];
  if (!Array.isArray(seedFacts) || seedFacts.length === 0) return [];

  // 阈值没传就现算：调用方（warmup）一般会传进来以省一次 O(N log N) 排序，
  // 但单测/临时调用时不能因为漏传就退化成"无截断"。
  const threshold = o.threshold !== undefined && o.threshold !== null
    ? Number(o.threshold)
    : computeDynamicThreshold(entityToFacts);

  // 种子分数索引：融合时需要按 id 找回原始分，避免 O(n²) 的 find
  const seedScore = new Map();
  for (const s of seedFacts) {
    if (s && s.id !== undefined) seedScore.set(String(s.id), Number(s.score) || 0);
  }

  /** @type {Map<string,{boost:number, via:string}>} */
  const boost = new Map();
  let skippedSuper = 0;
  let touchedEntities = 0;

  for (const seed of seedFacts) {
    if (!seed || seed.id === undefined) continue;
    const sid = String(seed.id);
    const sScore = Number(seed.score) || 0;
    if (sScore <= 0) continue;              // 0 分种子不扩散（乘出来也是 0，纯浪费）
    const ents = factToEntities.get(sid);
    if (!ents || ents.length === 0) continue;

    for (const ent of ents) {
      touchedEntities++;
      const bucket = entityToFacts.get(ent);
      if (!bucket) continue;
      const deg = bucket.size;
      // ★ 超级节点截断：整条实体跳过（白队 §9.2）
      if (deg > threshold) { skippedSuper++; continue; }
      // ★ 度惩罚 D_v^-1
      const contrib = sScore / deg;
      for (const fid of bucket) {
        if (fid === sid) continue;          // 种子自身不给自己加分
        const prev = boost.get(fid);
        if (prev === undefined) boost.set(fid, { boost: contrib, via: ent });
        else { prev.boost += contrib; prev.via = ent; }
      }
    }
  }

  // ★ 关键语义修正（期8.3 实跑抓到）：
  //   最初我让本函数只返回「被扩散加分」的事实，结果**种子自己从结果里消失了** ——
  //   实测 Case 3：rocm1 是 BM25 的 top1（23.677 分），但它与 100 条噪声
  //   不共享任何实体 ⇒ 无人指向它 ⇒ boost 里没有它 ⇒ 扩散输出里 rank = -1。
  //   于是融合式里的 alpha*原始分 这一项**永远只对极少数条目生效**，
  //   "融合"名存实亡，调用方拿到的是一个残缺的候选集。
  //
  //   正确语义：返回 **种子 ∪ 邻居 的全集**，两者在同一量纲下可比 ——
  //   这正是 final = alpha*原始 + (1-alpha)*扩散 想要表达的东西。
  //   种子若无邻居指向，boost=0，final 退化为 alpha*原始分（纯保序、不丢条目）。
  for (const s2 of seedFacts) {
    if (!s2 || s2.id === undefined) continue;
    const sid2 = String(s2.id);
    if (!boost.has(sid2)) boost.set(sid2, { boost: 0, via: 'seed' });
  }

  if (boost.size === 0) return [];

  // 归一化：除以最大 boost，把扩散分压到 (0,1]，与 BM25 分数同量纲才可融合。
  // 为什么用最大值而不是 sum：sum 会让"路径多的候选"被路径数放大两次
  // （累加已经体现过一次了），最大值归一化只保序、不放大。
  let maxBoost = 0;
  for (const v of boost.values()) if (v.boost > maxBoost) maxBoost = v.boost;
  const inv = maxBoost > 0 ? 1 / maxBoost : 0;

  const out = [];
  for (const entry of boost) {
    const fid = entry[0];
    const v = entry[1];
    const normBoost = v.boost * inv;
    // 种子事实带自己的原始分；纯扩散候选（不在种子集里）原始分为 0
    const base = seedScore.has(fid) ? seedScore.get(fid) : 0;
    out.push({
      id: fid,
      score: alpha * base + (1 - alpha) * normBoost,
      boost: v.boost,
      via: v.via === 'seed' ? 'seed' : '1hop:' + v.via,
    });
  }
  out.sort(function (a, b) { return b.score - a.score; });
  const capped = out.length > maxBoostFacts ? out.slice(0, maxBoostFacts) : out;
  // 统计信息挂在数组上（不污染元素），供 bench 与 health 观测；
  // 用 defineProperty 隐藏，避免被 JSON.stringify / 遍历带出去。
  Object.defineProperty(capped, 'stats', {
    value: {
      candidates: boost.size,
      skippedSuperNodes: skippedSuper,
      touchedEntities: touchedEntities,
      threshold: threshold,
      maxBoost: maxBoost,
    },
    enumerable: false,
    configurable: true,
    writable: true,
  });
  return capped;
}

/**
 * ④ 图统计（观测用，供 bench / health 报内存与规模）。
 *
 * @param {{entityToFacts:Map<string,Set<string>>, factToEntities:Map<string,string[]>}} incidence
 * @returns {{entities:number, facts:number, edges:number, maxDeg:number, p99Deg:number, superNodes:number, threshold:number}}
 *          edges = 实体-事实关联总数（= Σ deg(v) = Σ |entities(f)|），
 *          这是内存占用的真实代理指标（每条边 ≈ 2 个指针）。
 */
export function graphStats(incidence) {
  const entityToFacts = (incidence && incidence.entityToFacts) || null;
  const factToEntities = (incidence && incidence.factToEntities) || null;
  if (!entityToFacts || !factToEntities) {
    return { entities: 0, facts: 0, edges: 0, maxDeg: 0, p99Deg: 0, superNodes: 0, threshold: MAX_EDGE_ABS };
  }
  let edges = 0;
  let maxDeg = 0;
  const degs = [];
  for (const bucket of entityToFacts.values()) {
    const d = bucket.size;
    edges += d;
    if (d > maxDeg) maxDeg = d;
    degs.push(d);
  }
  degs.sort(function (a, b) { return a - b; });
  const n = degs.length;
  let idx = n > 0 ? Math.ceil(0.99 * n) - 1 : 0;
  if (idx < 0) idx = 0;
  if (idx > n - 1) idx = n - 1;
  const p99Deg = n > 0 ? degs[idx] : 0;
  const threshold = computeDynamicThreshold(entityToFacts);
  let superNodes = 0;
  for (const d of degs) if (d > threshold) superNodes++;
  return {
    entities: entityToFacts.size,
    facts: factToEntities.size,
    edges,
    maxDeg,
    p99Deg,
    superNodes,
    threshold,
  };
}

/**
 * ⑤ 实体派生（**退化路径**，诚实标注）。
 *
 * ⚠️ 期8.3 的时点事实：写入侧（normalize.js / extract.js）**尚未产出 entities 字段** ——
 *    全库 grep 过，生产卡上没有任何 entities。也就是说，如果本模块只认 entities，
 *    建出来的关联矩阵是空的，整个能力形同虚设，bench 会"绿"但毫无意义。
 *
 * ⇒ 这里做一条**显式标注的退化路径**：从卡标题里抽技术词元当实体。
 *    优先顺序（等写入侧实装后自动让位，无需改本文件）：
 *      ① card.entities（DESIGN §1.1 的正路，写入侧产出）
 *      ② card.scope_tags（engram v2 已有，环境词天然是实体）
 *      ③ 标题词元抽取（本函数的主体，退化）
 *
 * 抽取规则（只抽"有区分度"的词，刻意保守）：
 *   · ASCII 字母数字串 ≥3 字符：英文术语（rocm / windows / mtp / hip）
 *   · 数字串：版本号、期次（1024 / 8.3）
 *   · 中文：不做分词（无词典、不许引第三方），只取**连续 ≥2 字的中文串**里
 *     长度 2~4 的滑窗词。这会产出噪声，但度惩罚（D_v^-1）天然压高频噪声，
 *     这正是本设计的防御机制 —— 噪声实体必然高频，必被 1/deg 压死。
 *
 * @param {{entities?:string[], scope_tags?:string[], title?:string, summary?:string}} card
 * @param {{maxEntities?:number}} [opts]
 * @returns {string[]} 已小写归一、去重
 */
export function deriveEntities(card, opts) {
  const o = opts || {};
  const max = o.maxEntities !== undefined ? Number(o.maxEntities) : 8;
  const out = new Set();
  const c = card || {};

  // ① 正路：写入侧已产出 entities
  if (Array.isArray(c.entities) && c.entities.length) {
    for (const e of c.entities) { const n = normEntity(e); if (n) out.add(n); }
  }
  // ② engram v2 的 scope_tags（环境词）
  if (Array.isArray(c.scope_tags)) {
    for (const e of c.scope_tags) { const n = normEntity(e); if (n) out.add(n); }
  }
  if (out.size > 0) return Array.from(out).slice(0, max);

  // ③ 退化：从标题抽词元
  const t = String(c.title || '') + ' ' + String(c.summary || '');
  if (!t.trim()) return [];
  // 英文/数字术语：≥3 字符的 ASCII 字母数字串（含点、下划线、短横）
  const ascii = t.match(/[A-Za-z0-9][A-Za-z0-9._-]{2,}/g);
  if (ascii) for (const w of ascii) { const n = normEntity(w); if (n && !/^\d+$/.test(n) || (/^\d+$/.test(n) && n.length >= 2)) out.add(n); }
  // 中文滑窗：连续中文串里取 2~3 字窗口（无词典下的最小可行方案）
  const cjk = t.match(/[\u4e00-\u9fff]{2,}/g);
  if (cjk) {
    for (const run of cjk) {
      for (let i = 0; i + 2 <= run.length; i++) out.add(run.slice(i, i + 2));
      if (run.length >= 3) for (let i = 0; i + 3 <= run.length; i++) out.add(run.slice(i, i + 3));
    }
  }
  return Array.from(out).slice(0, max);
}

export default {
  buildIncidence,
  deriveEntities,
  computeDynamicThreshold,
  expandOneHop,
  graphStats,
  MAX_EDGE_ABS,
  ALPHA,
  DEFAULT_MAX_BOOST_FACTS,
};
