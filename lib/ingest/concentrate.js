/**
 * [2026-10-23 by Assistant · 红白双队收敛：记忆动力学 三定律]
 *
 * 白队的动力学（浓度/权重/代谢）+ 红队的三道安全阀。
 *
 * 核心哲学：**让重复产生浓度，而不是体积**。
 *   —— 同一件事说三次，应该是一张卡（mentionCount=3），不是三张卡各占一个位。
 *   [2026-11-07 P1-7] 计数器口径拆分：
 *     hits         = 真实使用（memory_get 主动读卡 / 回复采纳）—— 只有这两条来源能涨
 *     mentionCount = 重复提及次数（本模块写）
 *     adoptCount   = 回复采纳次数（adoption.js 写）
 *   排序（four-forces）与冷宫（cold-archive）只读 hits，因此"只有真实使用才延寿"才成立。
 *
 * 红队的三个致命漏洞（全部接受）：
 *   ① 余弦陷阱：4G 与 16G 的向量余弦必然 >0.9（只差一个数字）
 *      ⇒ 若用 sim>0.9 判"同卡"，用户纠正 16G 会反而给 4G 刷票
 *      ⇒ 必须检测：数字冲突 / 显式纠错词
 *   ② 万能钉子户：无条件 hits 加权会让硬件卡霸榜旅游闲聊
 *      ⇒ 必须相关性门控（本文件的 gateBoost）
 *   ③ 缓存背刺：自动改 System Prompt 会杀光前缀缓存
 *      ⇒ 只进 axioms_pending.jsonl，冷启动才合入（见 axioms.js）
 */

export const CONCENTRATION = Object.freeze({
  SIM_THRESHOLD: 0.88,      // 判同卡的最低相似度
  CORRECTION_HIT_BONUS: 2,  // 人类显式纠错，浓度 +2
  MACHINE_SOURCE: 'system_log',
});

/** 提取文本里全部数字（含小数），用于数字冲突检测 */
export function extractNumbers(text) {
  const s = String(text || '');
  const out = [];
  const re = /\d+(?:\.\d+)?/g;
  let m;
  while ((m = re.exec(s)) !== null) out.push(m[0]);
  return out;
}

/** 数字集合是否冲突（有一方存在且不相等即冲突） */
export function hasNumberConflict(a, b) {
  const na = extractNumbers(a);
  const nb = extractNumbers(b);
  if (!na.length || !nb.length) return false;
  // 取较长的作为基准，逐位比；任一不同即视为冲突
  if (na.length !== nb.length) return true;
  for (let i = 0; i < na.length; i++) if (na[i] !== nb[i]) return true;
  return false;
}

/** 是否是用户显式纠错（红队的救命补丁） */
export function isUserCorrection(text) {
  return /不对|错了|说错|说了多少次|而不是|改为|其实是|纠正|记错|不是\s*\d/i.test(String(text || ''));
}

/** 内容指纹（title + content 前 300 字） */
export function fingerprint(card) {
  const { createHash } = require('node:crypto');
  return createHash('sha1')
    .update(String(card && card.title || '') + '\u0000' + String(card && (card.content || card.summary) || '').slice(0, 300), 'utf8')
    .digest('hex').slice(0, 16);
}

/**
 * 浓度引擎（红队修正版 ingestWithConcentration）
 *
 * @param {object} newCard   新来的卡 { title, content, sourceType?, rawSource? }
 * @param {object[]} pool    已有卡池
 * @param {object} opts      { similarity(a,b) -> number }
 * @returns {{ action: 'insert'|'update'|'skip-machine', card, reason }}
 */
export function ingestWithConcentration(newCard, pool, opts) {
  const o = opts || {};
  const cards = Array.isArray(pool) ? pool : [];

  // 找最相似的已有卡（无相似度函数时退化为指纹/标题精确匹配）
  let match = null;
  let bestSim = 0;
  for (const c of cards) {
    let sim = 0;
    if (typeof o.similarity === 'function') {
      try { sim = Number(o.similarity(newCard, c)) || 0; } catch (e) { sim = 0; }
    } else {
      const t1 = String(newCard && newCard.title || '').trim();
      const t2 = String(c && c.title || '').trim();
      if (t1 && t1 === t2) sim = 1.0;
      else if (fingerprint(newCard) === fingerprint(c)) sim = 1.0;
    }
    if (sim > bestSim) { bestSim = sim; match = c; }
  }

  // 全新记忆
  if (!match || bestSim < CONCENTRATION.SIM_THRESHOLD) {
    return {
      action: 'insert',
      // [2026-11-05 by Assistant · 三轮红队共识 · 元级 bug 修复]
      //   原来写 hits: 1 —— 意欲「新卡不算零次使用」，实际后果：
      //     ① 所有「hits > 0 = 用过」的统计全部失真
      //        （实测 863/1562 张 pmi 是「hits=1 且从未有 lastHitAt」的初始化值，
      //          直接被误算成 91.3% 点开率，前两轮红队的核心论据建在这上面）
      //     ② 冷宫判据「hits > 0 ⇒ 不归档」让全新卡天然免疫归档
      //   修法：hits 起始 = 0（真实意义的「还没被用过」）。
      //   ⚠️ 同步改了 lib/scoring/cold-archive.mjs：「用过」改判 lastHitAt > 0。
      //      两处必须一起动，否则 862 张卡瞬间失效。
      // [2026-11-07 P1-7] 新卡同时初始化 mentionCount=0 / adoptCount=0，
      //   hits 保持 0（= 从未被真实使用），三个计数器口径互不混淆。
      card: Object.assign({}, newCard, {
        hits: 0,
        mentionCount: 0,
        adoptCount: 0,
        confidence: newCard && newCard.confidence !== undefined ? newCard.confidence : 0.5,
      }),
      reason: match ? 'sim-below-threshold:' + bestSim.toFixed(3) : 'no-match',
    };
  }

  const newText = String(newCard && (newCard.content || newCard.summary) || '');
  const oldText = String(match && (match.content || match.summary) || '');
  const rawSrc = String(newCard && newCard.rawSource || '') + ' ' + newText;

  // ── 安全阀 1：事实修正（数字冲突 或 显式纠错）⇒ 覆写文本，继承 hits ──
  if (hasNumberConflict(newText, oldText) || isUserCorrection(rawSrc)) {
    match.history_trace = Array.isArray(match.history_trace) ? match.history_trace : [];
    match.history_trace.push(oldText);          // 旧文本留痕，可溯源
    match.title = newCard.title !== undefined ? newCard.title : match.title;
    match.content = newText || match.content;
    // [2026-11-07 P1-7 · 红队修复] 纠错同样是「重复提及」，**不再写 hits**：
    //   hits = 真实使用口径（只由 memory_get / 采纳驱动，见 adoption.js / tools.js）。
    //   纠错的「+1 提及 + CORRECTION_HIT_BONUS」语义整体迁移到 mentionCount，
    //   数值语义不变（0→1+2=3），但不再污染「真实使用」。
    //   —— 这样四股力寿命 / 冷宫判据继续读 hits 时，口径才是干净的。
    const baseM = Number.isFinite(Number(match.mentionCount)) ? Number(match.mentionCount) : 0;
    match.mentionCount = baseM + 1 + CONCENTRATION.CORRECTION_HIT_BONUS;
    match.confidence = 1.0;
    match.last_updated_ts = Date.now();
    match.overridden = true;
    // ── [2026-10-23 by Assistant · 白队补充1：覆写必须联动 L3 refute] ──
    //   L1 事实改了（4GB→16GB），所有"依据 4GB 推出来"的 L3 结论都成了废纸。
    //   这里不直接改 Engram（跨层越权），而是**产出一份待作废清单**，
    //   由调用方在落盘时统一处理（保持 append-only 与职责分离）。
    match.needsEngramRefute = true;
    return {
      action: 'update',
      card: match,
      reason: 'fact-correction-override',
      // 调用方据此扫描 engrams：凡 supporting_facts / 前提引用本卡的，打 status='refuted'
      refuteScopes: { factId: String(match.id || ''), oldText: oldText.slice(0, 200) },
    };
  }

  // ── 安全阀 2：机器探针重复上报 ⇒ 只更新时间戳，绝不累加任何使用计数 ──
  // [2026-11-07 P1-7] 明确：last_verified_ts 是「机器验证时间」，
  //   **不参与**四股力寿命、也**不参与**冷宫「用过」判据（两者只认 lastHitAt/hits）。
  //   否则机器探针会把卡"假装"成被用过。
  if (String(newCard && newCard.sourceType || '') === CONCENTRATION.MACHINE_SOURCE) {
    match.last_verified_ts = Date.now();
    return { action: 'skip-machine', card: match, reason: 'machine-source-no-vote' };
  }

  // ── 正常人类重复提及：不新建卡，**只涨 mentionCount** ──
  // [2026-11-07 P1-7 · 红队修复] 拆字段：
  //   hits         = 真实使用（memory_get 主动读卡 / 回复采纳），本分支**不再碰**
  //   mentionCount = 重复提及次数（本分支 +1）
  //   adoptCount   = 回复采纳次数（adoption.js 写）
  // 旧写法 match.hits = baseH2 + 1 把「又被提了一遍」冒充成「被用过」，
  // 四股力寿命与冷宫判据据此延寿/免归档 = 口径污染。
  // 兼容：老卡没有 mentionCount ⇒ 按 0 起算（不臆测旧 hits 里混了多少次提及）。
  const baseM2 = Number.isFinite(Number(match.mentionCount)) ? Number(match.mentionCount) : 0;
  match.mentionCount = baseM2 + 1;
  match.last_updated_ts = Date.now();
  return { action: 'update', card: match, reason: 'human-repeat-mention+1' };
}

/**
 * 权重引擎（红队修正版 Relevance-Gated Boost）
 *
 * 铁律：**重要性 ≠ 无处不在**。
 *   只有当前话题确实相关（基础分过门槛），才释放浓度杠杆；
 *   否则旅行闲聊时，高 hits 的硬件卡会砸穿 Top5。
 *
 * @param {number} baseScore 基础检索分
 * @param {object} card      卡片（读 hits / confidence）
 * @param {object} opts      { gate: number, alpha: number, beta: number }
 * @returns {number}
 */
export function gateBoost(baseScore, card, opts) {
  const o = opts || {};
  const gate = Number(o.gate) || 0.35;      // 相关性门槛（相对分，0~1）
  const alpha = Number(o.alpha) || 0.15;
  const beta = Number(o.beta) || 0.2;
  const base = Number(baseScore) || 0;

  if (base < gate) return base;              // 不相关 ⇒ 锁死杠杆，原样返回

  // [2026-11-07 P1-7] 「浓度」= 重复提及 + 真实使用，取两者较大：
  //   · mentionCount：同一主题被反复提起（concentrate 写的）
  //   · hits：真实被读/被采纳（memory_get/adoption 写的）
  //   老卡没有 mentionCount ⇒ 回落到 hits（legacy 兼容，行为与改前一致）。
  const mention = Number(card && card.mentionCount);
  const hitN = Number(card && card.hits);
  const hits = Math.max(1, Number.isFinite(mention) ? mention : 0, Number.isFinite(hitN) ? hitN : 0);
  const conf = Math.min(1, Math.max(0, Number(card && card.confidence) || 0.5));
  const concentrationBoost = 1 + alpha * Math.log1p(hits);
  const confidenceBoost = 1 - beta + beta * conf;
  return base * concentrationBoost * confidenceBoost;
}

export default { ingestWithConcentration, gateBoost, extractNumbers, hasNumberConflict, isUserCorrection, fingerprint, CONCENTRATION };
