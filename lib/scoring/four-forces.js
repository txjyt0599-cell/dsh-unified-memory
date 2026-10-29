/**
 * lib/scoring/four-forces.js —— 四股力乘法门控（Step 2）
 * [2026-10-24 by Assistant · 红白双队终版 v1.0 签字]
 *
 * 为什么必须是乘法而不是加法：
 *   加法里「高重要 + 高新鲜」能靠保底分挤进**无关话题**的 Top5（红队抓出来的炸弹）。
 *   正确结构：相关度 R 是门票，另外三股力只是**放大器**，R 不过门 → 杠杆锁死。
 *
 *   score = R × (1 + wImp·Imp + wRec·Rec + wStr·Str)
 *
 * 参数按我们自己的量级调（不盲抄红白双队）：
 *   · MAX_HITS = 20（他们给 50，但我们库里 97% 的 hits=0、最高才 4；
 *     用 50 会让强度这一维几乎恒为 0 = 白做）
 *   · 半衰期三档：基石 ∞ / 重要 60 天 / 流水 21 天（他们一刀切 14 天，
 *     对「跨周任务」偏狠）
 */

export const GATE_THRESHOLD = 0.012;   // RRF 相关度门槛（约等于 BM25/向量进前 20）
export const MAX_HITS = 20;            // 强度封顶常数（我们量级：先 20，数据涨了再抬）
export const W = { imp: 0.45, rec: 0.30, str: 0.35 };

export const HALF_LIFE = {
  axiom: Infinity,   // 基石：永不衰减（**只认 is_axiom === true**）
  quasiaxiom: 180,   // 准基石：importance >= 0.8 但非基石（温和过渡档）
  important: 60,     // 重要决定：60 天
  volatile: 21,      // 日常流水：21 天
};

/**
 * 半衰期分档。
 *
 * [2026-10-27 by Assistant · 第三优先：关掉隐式基石暗门]
 *
 * 原实现：`if (is_axiom === true || value >= 0.8) return Infinity`
 *   ⇒ importance >= 0.8 是一条**绕过 is_axiom 正式判定的暗门**，
 *     门槛比正式基石还低，而且和 is_axiom 一样是单向的（importance 一旦 >=0.8 不会自己降下来）。
 *
 * 实测影响面（2026-10-27 全库统计，6927 张活卡）：
 *   · is_axiom === true           : 1010 张（14.6%）
 *   · importance >= 0.8           : 1395 张（20.1%）
 *   · 其中「>=0.8 但不是基石」的   : **390 张**（5.6%）—— 这批就是暗门的实际受益者
 *
 * 修法（红队拍板的温和过渡，不一刀切）：
 *   · is_axiom === true        ⇒ Infinity（真基石，永不衰减）
 *   · importance >= 0.8 非基石 ⇒ **180 天**（半年几乎不衰减，390 张卡近期分数平稳零震荡，
 *                                 但一年维度看不再是"永久公理"）
 *   · >= 0.55                  ⇒ 60 天
 *   · 其余                     ⇒ 21 天
 *
 * 回滚：把 quasiaxiom 设回 Infinity 即等价于旧行为。
 */
export function halfLifeOf(card) {
  const imp = Number(card && card.importance);
  const value = Number.isFinite(imp) ? imp : 0.35;
  if (card && card.is_axiom === true) return HALF_LIFE.axiom;
  if (value >= 0.8) return HALF_LIFE.quasiaxiom;
  if (value >= 0.55) return HALF_LIFE.important;
  return HALF_LIFE.volatile;
}

/** 新鲜度：基石恒 1；其余按半衰期指数衰减 */
// ── [2026-10-24 实测修正 ⑧:时间粒度 = 天] ──
//   症状：selftest-bridge E1 挂（「同查询重复 pre-step 注入内容稳定」）。
//   根因：nowTs 用毫秒 ⇒ 两次调用差几十毫秒 ⇒ ageDays 微变 ⇒ 分数微变
//        ⇒ 排序在边界卡上翻转 ⇒ 注入内容不稳定。
//   影响不只是测试：同一轮里 pre-step 可能重跑，内容抖动会白白浪费缓存。
//   修法：把时间量化到**天**（四股力的语义本来就是天级，秒级抖动毫无意义）。
export function dayFloor(nowTs) {
  const n = Number(nowTs);
  const t = Number.isFinite(n) ? n : Date.now();
  return Math.floor(t / 86400000) * 86400000;
}

export function recencyOf(card, nowTs) {
  const hl = halfLifeOf(card);
  if (!Number.isFinite(hl)) return 1.0;
  const created = Number(card && card.createdAt) || 0;
  if (!created) return 1.0;
  const ageDays = Math.max(0, (dayFloor(nowTs) - created) / 86400000);
  return Math.pow(0.5, ageDays / hl);
}

/** 强度：log1p 归一化到 [0,1]，非基石再随久未使用缓慢回落 */
export function strengthOf(card, nowTs) {
  const hits = Math.max(0, Number(card && card.hits) || 0);
  const raw = Math.log1p(Math.min(hits, MAX_HITS)) / Math.log1p(MAX_HITS);
  if (card && card.is_axiom === true) return raw;
  const hl = halfLifeOf(card);
  if (!Number.isFinite(hl)) return raw;
  const created = Number(card && card.createdAt) || 0;
  if (!created) return raw;
  const ageDays = Math.max(0, (dayFloor(nowTs) - created) / 86400000);
  // [2026-10-24 Round 15 二次修正] 强度自身也会随时间回落，但**衰减要慢得多**（hl×4）。
  //   原来是 hl×2：200 天的老卡强度归零 ⇒ 就算 hits=20 也完全抵扣不了惩罚，
  //   等于"用进废退"没有真实效果（实测 hits=0 与 20 只差 0.0087）。
  //   改成 hl×4 后，200 天老卡仍保留约一半强度 ⇒ hits 能真正起到抗遗忘作用。
  return raw * Math.pow(0.5, ageDays / (hl * 4));
}

/**
 * 四股力合成。
 * @param {object} card 卡片（需要 importance / is_axiom / createdAt / hits）
 * @param {number} baseRelevance 相关度底座（归一化后的分）
 * @param {number} nowTs 时间
 * @returns {{score:number, gated:boolean, parts:{R:number,I:number,Rec:number,Str:number}}}
 */
export function applyFourForces(card, baseRelevance, nowTs) {
  const R = Number(baseRelevance);
  const safeR = Number.isFinite(R) ? R : 0;
  // 【第一道闸】相关度不过门 ⇒ 杠杆锁死，返回原分
  if (safeR < GATE_THRESHOLD) {
    return { score: safeR, gated: false, parts: { R: safeR, I: 0, Rec: 0, Str: 0 } };
  }
  // ── [2026-10-24 实测修正 ⑤:未知 ≠ 不重要] ──
  //   A/B 抓到：实时写入的 L1 卡（pm: 前缀）还没有 importance 字段，
  //   上一版按 0.25 兜底 ⇒ 一出生就被当成「流水」打 0.55 折，
  //   结果最贴题的卡反而被老卡挤掉（实测《评分模型 v1》掉到第 3）。
  //   修法：缺字段 = **中性**（0.55，不给奖惩），只有明确低分才罚。
  const impRaw = Number(card && card.importance);
  const imp = Number.isFinite(impRaw) ? Math.max(0, Math.min(1, impRaw)) : 0.55;
  const rec = recencyOf(card, nowTs);
  const str = strengthOf(card, nowTs);
  // ── [2026-10-24 实测修正 · 这是Assistant对红白双队公式的偏离，必须说明] ──
  //   他们给的是：mult = 1 + 0.45·I + 0.30·Rec + 0.35·Str
  //   跑 100 轮模拟时发现**结构缺陷**：常数项 1.0 托底 ⇒
  //     流水卡无论多久，mult 都不低于 1+0.45·0.25 = 1.11
  //     ⇒ 180 天后只降 6%，等于"淡忘"根本没发生（判定①实测失败）。
  //   修法：把常数托底拆成「下限 + 可变部分」，让乘数能真正落到 0.15 量级：
  //     mult = (0.30 + 0.55·Imp) × (0.35 + 0.65·Rec) + 0.25·Str
  //   实测效果：新流水 0.44 → 180 天后 0.15（降 65%）；基石稳定 0.80；
  //            基石 / 老流水 ≈ 5.2 倍，既有淡忘又不误伤基石。
  const impPart = 0.30 + 0.55 * imp;
  const recPart = 0.35 + 0.65 * rec;
  const raw = impPart * recPart + W.str * str;

  // ── [2026-10-24 实测修正 ③:乘数封顶区间] ──
  //   A/B 实测（5 条真查询）：上一版乘数最高 ~5x ⇒ 「不那么贴题但重要」的卡
  //   把**最贴题**的卡挤出了 Top5（实测「记忆系统 四股力 打分」里
  //   最贴题的《评分模型 v1 · 四股力》直接掉出前 5）——这是不可接受的。
  //   定位改动：四股力是**微调**，不是重新排序的主角；相关度必须仍然是老大。
  //   做法：把 raw 线性映射到 [MULT_MIN, MULT_MAX]（1.0 附近），封住动态范围。
  // ── [2026-10-24 实测修正 ④:只罚不赏（关键定调）] ──
  //   A/B 实测（5 条真查询，三轮调参）结论：
  //     只要乘数能 > 1，就一定会出现「重要但不够贴题」的卡把最贴题的卡挤下去
  //     （实测《评分模型 v1 · 四股力》被《记忆年表卡入库》挤掉 Top1）。
  //   这是**不可接受**的：相关度是User的问题「问到没问到」，不能被别的维度改写。
  //   所以把乘数封在 (0, 1]：四股力**只负责让她淡忘，不负责帮她抬升**。
  //     最贴题的卡 ×1.0 仍是第一；冷掉的流水卡 ×0.55 自然沉底。
  //   这也正好对上 Neuro 的做法：遗忘曲线是**减法**，不是加分。
  // [2026-10-24 实测校准] 有了「分档 tie-break」保护之后，乘数范围可以放开：
  //   跨档永远不会被改写（0.03 档宽），档内怎么调都不会把最贴题的卡挤到下一档。
  // [2026-10-24 实测校准 ⑦:纯惩罚化] A/B 反复证明「不确定性必须不罚」：
  //   分档之后（0.03 档宽）已保证最贴题卡不被跨档挤掉，
  //   但档内如果给「未知重要度」的中立卡也打折，等价于罚了无辜者。
  //   最终形态：乘数 = 1 − 惩罚；只有**明确**的坏信号才扣分。
  //     · 惩罚项 = 0.65·(1−Rec) + 0.25·(1−tImp)，其中 tImp 只在 imp 明确 < 0.55 时才 < 1
  //     · 基石（is_axiom）：惩罚恒为 0 ⇒ 乘数恒 1.00
  //     · 新卡（Rec≈1）且 imp 未知/较高 ⇒ 惩罚≈0 ⇒ 乘数≈1.00（不打折）
  //     · 冷透的流水卡 ⇒ 惩罚≈1 ⇒ 乘数≈0.35（真正沉底）
  const isAxiom = card && card.is_axiom === true;
  const penaltyFlux = 0.65;
  if (isAxiom) {
    return { score: safeR, gated: true, parts: { R: safeR, I: imp, Rec: rec, Str: str, mult: 1 } };
  }
  // 动量：只有明确弱的重要度才罚（imp>=0.55 视为「不罚」）
  const impLack = imp >= 0.55 ? 0 : (0.55 - imp) / 0.55;      // 0 .. 1
  const recLack = 1 - rec;                                     // 0 .. 1
  let penalty = penaltyFlux * recLack + 0.25 * impLack;
  penalty = Math.max(0, Math.min(0.65, penalty));

  // ── [2026-10-24 by Assistant · Round 15 抓到的真问题：强度完全没生效] ──
  //   实测：同年龄同重要度下 hits=0 与 hits=10 的分数**一模一样（0.6000）**。
  //   原因：原来把 strength 写成「从 penalty 里减」（strengthGain = 0.10·str），
  //         但新卡 recLack=0、impLack=0 ⇒ penalty 本来就是 0，
  //         减完再 clamp(≥0) ⇒ **hits 再多也归零**，强度这一维形同虚设。
  //   修法：把强度改成**独立的小额加成**（最多 +25%），且仍限制在"只罚不赏"的
  //         大原则之内 —— 即：有过贡献的卡可以少罚甚至微升，但**永远不超过相关度本身**。
  //         （≤1.0 的帽子不改：相关度仍是老大，强度只影响同档内的先后）
  //   [Round 15 二次修正] 上封 1.0 意味着「强度」只能**抵扣惩罚**，不能超过 R 本身。
  //   上一版写成 (1-penalty)+0.25·str 再 min(1.0) ⇒ 新卡 penalty=0 时仍是 1.0，
  //   hits 还是看不出区别（实测 hits=0 与 20 都是 0.6000）。
  //   正确做法：**只让 strength 抵扣 penalty**（乘法抵扣，不是加法）：
  //     penalty' = penalty × (1 − 0.6·str)
  //   ⇒ new card (penalty=0) 仍然 1.0（没被罚过，谈不上"抵扣"）
  //   ⇒ old flowing card (penalty=0.65): hits=0 → ×1.00；hits=20 → ×0.40 ⇒ 0.65→0.26
  //   这符合"用进废退"：**常用的老卡没那么容易被遗忘**。
  const penaltyAfterStrength = penalty * (1 - 0.6 * str);
  const multiplier = Math.max(0.35, Math.min(1.0, 1 - penaltyAfterStrength));

  return {
    score: safeR * multiplier,
    gated: true,
    parts: { R: safeR, I: imp, Rec: rec, Str: str, mult: Number(multiplier.toFixed(4)) },
  };
}

/**
 * 批量重排：给融合后的候选列表重新打分并排序。
 * 输入是 [[id, score], ...] 或 [{id, score}, ...]，输出同结构。
 */
export function rerankWithFourForces(list, cardsById, nowTs, opts) {
  const o = opts || {};
  if (o.enabled === false) return list;
  const isPair = Array.isArray(list) && Array.isArray(list[0]);
  const rawScore = (raw) => (isPair ? Number(raw[1]) : Number(raw && raw.score)) || 0;

  // ── [2026-10-24 实测修正 ②:相对门控] ──
  //   A/B 实测：只按绝对阈值 0.012 放行时，融合分归一化后大量卡都过线
  //   ⇒ 乘法杠杆（最高 ~5x）能把「相关但次优」的卡挤掉（实测「日记本写在哪里」
  //     Top1 从最贴题的那张被换成了泛泛的卡片）。
  //   修法：只有相对 Top1 分 >= REL_GATE 的卡才参与重排；更低的卡保持原分。
  //   语义：重要度/新鲜度可以在「同一话题带」内翻盘，但绝不允许跨界硬拉。
  // [2026-10-24 实测校准] 0.45 太宽：0.8 相关度的卡能靠杠杆翻过 1.0 相关度的最贴题卡。
  //   收到 0.80 ⇒ 只有「几乎同一档相关」的卡才允许靠重要度/新鲜度翻盘。
  // 只罚不赏之后，相对门控只需要防「完全无关的卡被算进去」，0.35 足够
  const REL_GATE = Number.isFinite(Number(o.relGate)) ? Number(o.relGate) : 0.35;
  let maxR = 0;
  for (const raw of (list || [])) { const v = rawScore(raw); if (v > maxR) maxR = v; }
  const relFloor = maxR * REL_GATE;

  // ── [2026-10-24 实测修正 ⑥:同档 tie-break（关键）] ──
  //   三轮 A/B 结论：只要四股力能**改写已过线卡的相对顺序**，最贴题的卡就会被挤掉
  //   （实测《评分模型 v1 · 四股力》连续被《记忆年表卡入库》顶掉 Top1）。
  //   根本原因：相关度回答的是「User问的这件事，这张卡沾不沾边」——
  //     这个判断不能被「新不新、重不重要」改写，否则就是答非所问。
  //   最终设计：按相关度分**档**（宽度 = Top1 的 8%）；档间严格按相关度，
  //     **档内**才用四股力做 tie-break。这样：
  //       · 最贴题的卡永远在它那一档的最前面，绝不被下一档挤掉
  //       · 但同档里（相关度差不多）"流水账"会被"基石/常用的"压下去
  // [2026-10-24 实测校准] 0.08（8%）太宽：相关度差 7% 的两张卡被算成同档，
  //   结果「重要但略不贴题」的旧卡把最贴题的新卡顶掉（实测 3/5 条查询发生）。
  //   收到 0.03（3%）⇒ 只有相关度「几乎并列」时才让四股力做 tie-break。
  const BUCKET_W = Number.isFinite(Number(o.bucketWidth)) ? Number(o.bucketWidth) : 0.03;
  const width = Math.max(1e-9, maxR * BUCKET_W);

  const items = [];
  for (const raw of (list || [])) {
    const id = isPair ? String(raw[0]) : String(raw && raw.id);
    const score = rawScore(raw);
    const card = cardsById && cardsById.get ? (cardsById.get(id) || cardsById.get(id.replace(/^(tdai|pm|pmi):/, ''))) : null;
    let out;
    if (score < relFloor) {
      out = { score, gated: false, parts: { R: score, I: 0, Rec: 0, Str: 0, mult: 1 } };
    } else {
      out = applyFourForces(card || {}, score, nowTs);
    }
    const bucket = Math.floor(score / width);
    items.push({
      raw,
      bucket,                     // 档：越大越靠前（=相关度越高）
      score: out.score,           // 档内排序用（四股力微调后的分）
      rel: score,
      parts: out.parts,
      gated: out.gated,
    });
  }
  // 档间按桶降序；同桶内按四股力分降序（再退化到原相关度）
  items.sort(function (a, b) {
    if (b.bucket !== a.bucket) return b.bucket - a.bucket;
    if (Math.abs(b.score - a.score) > 1e-12) return b.score - a.score;
    return b.rel - a.rel;
  });
  if (o.withParts === true) return items;
  return items.map(function (it) { return it.raw; });
}
