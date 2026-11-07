/**
 * ingest/belief.js —— 认知可信度协议（期8.1 核心件）
 * [2026-10-23 by Assistant]
 *
 * 要解决的病灶：
 *   期7 的 engram 只有「最后写的胜出（LWW physical Map key 覆盖）」，
 *   无法表达「周一认为方案 A 可行，周三实测失败并撤回」这类观点推翻与反转。
 *
 * 白队终裁（2026-10-23）锁定的四项：
 *   ① 来源赋权固定基分（用户纠正 1.0 > 实测 0.9 > 推测 0.4 > 模型猜 0.2）
 *   ② 状态机 active / scoped_active / refuted / superseded（推翻不删除）
 *   ③ 条件分裂（scope_tags 不同 ⇒ 两者共存，绝不误标 refuted）
 *   ④ 存量迁移保守降级（status=active, scope=[global], confidence=0.5）
 *
 * 铁律：
 *   · **纯函数**，不碰磁盘、不读配置。便于确定性测试。
 *   · 任何异常一律降级为「不改判」（宁可漏判，不可误杀）。
 */

// ── 来源基分（白队 §二 表格，逐字固化）──
export const SOURCE_WEIGHTS = Object.freeze({
  user_correction: 1.00,   // User显式纠正 / 直接指令
  user_observed:   0.90,   // 真实执行报错 / 工具输出 / 日志
  user_speculation:0.40,   // User初步推测 / 假设
  model_inference: 0.20,   // 模型自身推断
});

export const STATUS = Object.freeze({
  ACTIVE:        'active',
  SCOPED_ACTIVE: 'scoped_active',
  REFUTED:       'refuted',
  SUPERSEDED:    'superseded',
  // [2026-10-26 by Assistant · 问题生命周期] 问题已闭环（不删卡、可回滚）
  //   与 refuted 的语义严格区分：
  //     refuted  = 「这条事实说错了」      ⇒ 检索降权 0.150x
  //     resolved = 「这个问题已经解决了」  ⇒ 轻度降权 + 渲染带 [已闭环]
  RESOLVED:      'resolved',
  // [2026-10-26] AI 自称解决、但没有用户确认或工具验证证据 ⇒ 不算闭环，只降权不关旧卡
  CLAIMED:       'claimed',
});

// 白队判决阈值：新结论须高出旧结论 0.30 才算真推翻
export const REFUTE_MARGIN = 0.30;

// ── 存量迁移的保守降级默认值（白队 §9.4 逐字）──
export const LEGACY_DEFAULTS = Object.freeze({
  status: 'active',
  scope_tags: ['global'],
  confidence: 0.5,
  is_tentative: false,
});

// [2026-10-23 · 红队 B-1 阻断] 英文报错词：**保留 \b 词边界**。
//   加上 \b 是为了别把 `errored` / `errors` 误配成 `error`——这条行为原样保留。
const EN_ERROR_RE = /\b(error|exception|exit code [1-9]|EPERM|ENOENT)\b/i;

// [2026-10-23 · 红队 B-1 阻断] 中文/符号报错词：**绝不能加 \b**。
//   中文没有词边界：`编译失败了` 里 `败` 后紧跟 `了`，两侧都不是 \w，
//   `\b` 永不成立 ⇒ 原来和英文混在一个 \b 表达式里时，中文报错词**一个都匹配不上**，
//   实测「编译失败了」「这个方案失败了」「他失败了三次」全被判成 0.6（User明确陈述档），
//   「真实执行报错 = 0.9」这一档对User的主力输入形态形同虚设。
//   修法：拆成独立分支，裸子串匹配（中文左侧是标点/空白，右侧是汉字，都不需要边界）。
const CN_ERROR_RE = /(失败|报错|错误|异常|未通过|不通过|崩溃|崩了|超时|退出码|OOM|✗)/;

/**
 * 从「谁说的 + 说了什么」推断来源基分。
 * 判据刻意保守：识别不到纠正/实测信号时，落到 model_inference(0.2) 之外的中性档，
 * 避免把普通陈述误判成「User纠正」而虚高置信度。
 *
 * @param {{role?:string, text?:string, toolError?:boolean}} ev
 * @returns {number} 0.2 / 0.4 / 0.9 / 1.0
 */
export function inferSourceWeight(ev) {
  try {
    const e = ev || {};
    const text = String(e.text || '');
    // ① 工具报错 / 非零退出 ⇒ user_observed（英文走  分支，中文走无边界分支）
    if (e.toolError === true || EN_ERROR_RE.test(text) || CN_ERROR_RE.test(text)) {
      return SOURCE_WEIGHTS.user_observed;
    }
    // ② User显式纠正：否定/纠正措辞
    if (/不对|不是这样|错了|应该是|纠正|你记错|改一下|重新来|而不是/i.test(text)) {
      return SOURCE_WEIGHTS.user_correction;
    }
    // ③ User推测：模糊措辞
    if (/可能|大概|也许|估计|试试|或许|不确定/i.test(text)) {
      return SOURCE_WEIGHTS.user_speculation;
    }
    // ④ User明确陈述（无模糊词）⇒ 介于纠正与推测之间，按 0.6 记（不加进 SOURCE_WEIGHTS 常量，保持白队四档纯净）
    if (e.role === 'user') return 0.6;
    // ⑤ 默认模型推断
    return SOURCE_WEIGHTS.model_inference;
  } catch {
    return SOURCE_WEIGHTS.model_inference;
  }
}

/** 两个 scope 数组的对称差（用来判「环境前提是否分化」）。 */
export function scopeDelta(a, b) {
  const A = new Set((a || []).map((x) => String(x).toLowerCase()));
  const B = new Set((b || []).map((x) => String(x).toLowerCase()));
  const out = [];
  for (const x of A) if (!B.has(x)) out.push(x);
  for (const x of B) if (!A.has(x)) out.push(x);
  return out;
}

/**
 * 冲突判决 —— 期8 的心脏。
 *
 * 判决四态：
 *   fork   —— scope 分化 ⇒ 条件分裂，两者 scoped_active，**绝不标 refuted**
 *   refute —— 同 scope 且新证据高出 0.30 ⇒ 旧卡 refuted（保留，不删）
 *   merge  —— 同 scope 且分差 ≤0.30 ⇒ 判为补充，都保 active
 *   ignore —— 新证据更弱 ⇒ 新卡 superseded，旧卡不变
 *
 * @returns {{action:'fork'|'refute'|'merge'|'ignore', newStatus:string, oldStatus:string, reason:string}}
 */
export function judgeConflict(newE, oldE) {
  const safeReturn = (reason) => ({
    action: 'merge', newStatus: STATUS.ACTIVE, oldStatus: STATUS.ACTIVE, reason,
  });
  try {
    if (!newE || !oldE) return safeReturn('missing-args');

    // ① 先判作用域 —— 顺序至关重要，先判 scope 才是「防假性推翻」的关键
    const delta = scopeDelta(newE.scope_tags || ['global'], oldE.scope_tags || ['global']);
    if (delta.length > 0) {
      return {
        action: 'fork',
        newStatus: STATUS.SCOPED_ACTIVE,
        oldStatus: STATUS.SCOPED_ACTIVE,
        reason: 'scope-differs:' + delta.join(','),
      };
    }

    const nc = Number(newE.confidence);
    const oc = Number(oldE.confidence);
    if (!Number.isFinite(nc) || !Number.isFinite(oc)) return safeReturn('confidence-not-number');

    // ② 同 scope：比证据强度
    if (nc - oc > REFUTE_MARGIN) {
      return {
        action: 'refute',
        newStatus: STATUS.ACTIVE,
        oldStatus: STATUS.REFUTED,
        reason: 'confident-up:' + nc.toFixed(2) + '>' + oc.toFixed(2),
      };
    }
    if (Math.abs(nc - oc) <= REFUTE_MARGIN) {
      return {
        action: 'merge',
        newStatus: STATUS.ACTIVE,
        oldStatus: STATUS.ACTIVE,
        reason: 'close-enough:' + Math.abs(nc - oc).toFixed(2),
      };
    }
    // ③ 新证据更弱 ⇒ 新卡退让，旧卡不动
    return {
      action: 'ignore',
      newStatus: STATUS.SUPERSEDED,
      oldStatus: STATUS.ACTIVE,
      reason: 'new-weaker:' + nc.toFixed(2) + '<' + oc.toFixed(2),
    };
  } catch {
    return safeReturn('exception');
  }
}

/**
 * 把任意形状的 engram 规范成 v2 schema。
 * 存量卡（期7 及以前）走 LEGACY_DEFAULTS 保守降级 —— 白队 §9.4。
 *
 * @param {object} raw
 * @returns {object} 新对象（不修改入参）
 */
export function normalizeEngramV2(raw) {
  const r = raw || {};
  const isLegacy = !('status' in r) || !('scope_tags' in r) || !('confidence' in r);
  const scope = Array.isArray(r.scope_tags) && r.scope_tags.length
    ? r.scope_tags.map((x) => String(x).toLowerCase())
    : LEGACY_DEFAULTS.scope_tags.slice();

  const conf = Number.isFinite(Number(r.confidence))
    ? Number(r.confidence)
    : LEGACY_DEFAULTS.confidence;

  const status = Object.values(STATUS).includes(r.status)
    ? r.status
    : LEGACY_DEFAULTS.status;

  return Object.assign({}, r, {
    status,
    scope_tags: scope,
    confidence: conf,
    supporting_facts: Array.isArray(r.supporting_facts) ? r.supporting_facts : [],
    refute_by: Array.isArray(r.refute_by) ? r.refute_by : [],
    supersedes: Array.isArray(r.supersedes) ? r.supersedes : [],
    is_tentative: r.is_tentative === true,
    // trace 保留人类可读轨迹；老卡把 summary 当轨迹兜底（只读展示，不参与判决）
    trace: String(r.trace || ''),
    _v2: true,
    _migratedLegacy: isLegacy,
  });
}

/**
 * 检索期过滤（白队 §2.3 表）。
 *
 * @param {Array<object>} engrams
 * @param {{mode?:'default'|'history', scopes?:string[]}} opts
 *        mode=default → 只回 active（+ 命中 scopes 的 scoped_active）
 *        mode=history → 全放行，按 updatedAt 倒序，用于「我之前为什么觉得…」
 */
export function filterEngrams(engrams, opts) {
  const o = opts || {};
  const mode = o.mode === 'history' ? 'history' : 'default';
  const list = Array.isArray(engrams) ? engrams : [];

  if (mode === 'history') {
    return list.slice().sort((a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0));
  }

  const wantScopes = new Set((o.scopes || []).map((x) => String(x).toLowerCase()));
  return list.filter((e) => {
    // [2026-10-23 · 阻断5] **无 status 的卡一律按 active 放行**（显式分支，不是漏写）。
    //   实测 filterEngrams([{id:'L',claim:'x'}], {mode:'default'}) 原来返回 [] ——
    //   生产里有 3000+ 张 tdai 存量卡没有 status 字段，一旦把本函数接进检索，
    //   严格匹配 `st === STATUS.ACTIVE` 会把这批卡整批丢弃（记忆凭空消失）。
    //   口径与 retriever.js:55 的 `(o.status || 'active')` 保持一致，全仓一套默认值。
    const st = (e && e.status) || STATUS.ACTIVE;
    if (st === STATUS.ACTIVE) return true;
    if (st === STATUS.SCOPED_ACTIVE) {
      if (wantScopes.size === 0) return true;   // 未指定环境 ⇒ 全给出并带前缀标注
      const tags = (e.scope_tags || []).map((x) => String(x).toLowerCase());
      return tags.some((t) => wantScopes.has(t));
    }
    return false;
  });
}

/**
 * 识别查询里携带的环境词（用于把 scoped_active 精确限定）。
 * 刻意只认白名单，避免把任意英文单词当环境。
 */
const SCOPE_WORDS = [
  'windows', 'ubuntu', 'arch', 'linux', 'wsl', 'docker',
  'rocm', 'cuda', 'amd', 'nvidia', 'cpu', 'gpu',
];

export function detectQueryScopes(query) {
  const q = String(query || '').toLowerCase();
  const hit = [];
  for (const w of SCOPE_WORDS) {
    if (q.includes(w)) hit.push(w);
  }
  return hit;
}
