/**
 * [2026-10-23 by Assistant · 红白双队收敛：记忆动力学 三定律]
 *
 * 白队的动力学（浓度/权重/代谢）+ 红队的三道安全阀。
 *
 * 核心哲学：**让重复产生浓度，而不是体积**。
 *   —— 同一件事说三次，应该是一张卡 hits=3，不是三张卡各占一个位。
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
      card: Object.assign({}, newCard, { hits: 1, confidence: newCard && newCard.confidence !== undefined ? newCard.confidence : 0.5 }),
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
    // [2026-10-23 修] hits=0 时不能用 `|| 1` 兜底（会把 0→2），必须用 NaN 判定
    const baseH = Number.isFinite(Number(match.hits)) ? Number(match.hits) : 0;
    match.hits = baseH + 1 + CONCENTRATION.CORRECTION_HIT_BONUS;
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

  // ── 安全阀 2：机器探针重复上报 ⇒ 只更新时间戳，绝不累加 hits ──
  if (String(newCard && newCard.sourceType || '') === CONCENTRATION.MACHINE_SOURCE) {
    match.last_verified_ts = Date.now();
    return { action: 'skip-machine', card: match, reason: 'machine-source-no-vote' };
  }

  // ── 正常人类重复提及：不新建卡，浓度 +1 ──
  // [2026-10-23 修] 同上：hits=0 必须 0→1，不能 0→2
  const baseH2 = Number.isFinite(Number(match.hits)) ? Number(match.hits) : 0;
  match.hits = baseH2 + 1;
  match.last_updated_ts = Date.now();
  return { action: 'update', card: match, reason: 'human-repeat-hits+1' };
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

  const hits = Math.max(1, Number(card && card.hits) || 1);
  const conf = Math.min(1, Math.max(0, Number(card && card.confidence) || 0.5));
  const concentrationBoost = 1 + alpha * Math.log1p(hits);
  const confidenceBoost = 1 - beta + beta * conf;
  return base * concentrationBoost * confidenceBoost;
}

export default { ingestWithConcentration, gateBoost, extractNumbers, hasNumberConflict, isUserCorrection, fingerprint, CONCENTRATION };
