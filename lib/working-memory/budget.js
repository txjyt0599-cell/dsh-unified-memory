/**
 * budget.js —— 预算与渲染的纯函数组。零 IO，可单测。
 * 依据：_team-v2/p4/DESIGN.md §1.2；红队 B2（删 500 硬限）/ M2（删 450 总额）。
 */

import { estimateTokens } from '../retrieval/types.js';
import { RENDER_TIER, WM_HARD, normalizeActivation } from './types.js';

/**
 * ① 相对上限：算 L0 预算。
 * cap = clamp(inputTokens * factor, floorTokens, ceilingTokens)
 * 铁律：**没有 500 这类绝对硬限**（红队 B2）；boundBy 用来说明被哪条约束卡住。
 *
 * @param {number} inputTokens User本轮输入的 token 数
 * @param {{l0:{factor:number,floorTokens:number,ceilingTokens:number,maxCards:number,headerTokens:number}}} cfg
 */
export function computeL0Budget(inputTokens, cfg) {
  const c = (cfg && cfg.l0) || {};
  const factor = num(c.factor, 8);
  const floor = num(c.floorTokens, 240);
  const ceiling = num(c.ceilingTokens, 4096);
  const it = Math.max(0, num(inputTokens, 0));
  const raw = it * factor;
  let cap = raw;
  let boundBy = 'factor';
  if (raw < floor) { cap = floor; boundBy = 'floor'; }
  else if (raw > ceiling) { cap = ceiling; boundBy = 'ceiling'; }
  const header = num(c.headerTokens, 75);
  return {
    inputTokens: it,
    l0CapTokens: Math.round(cap),
    usedTokens: header,
    remainingTokens: Math.round(cap) - header,
    boundBy,
    headerTokens: header,
    maxCards: num(c.maxCards, 30),
  };
}

/**
 * ② 渲染一行卡片 → 字符串 + 精确成本。
 * 三档对齐现有分级渲染（第1张 full / 2~3 summary / 其余 title）。
 * 成本一律用 estimateTokens 实测算，不许「均价 × 条数」估。
 */
/**
 * [2026-10-22 by Assistant · 安全红队 P0] 注入前清洗：防「伪造结束标签」+「零宽绕过」。
 *
 * 红队实测：summary 里写 `</unified-memory>` 后接一段假指令，就能在文本内**提前闭合**
 * 注入块，让后面的内容看起来像"块外"的系统指令。
 * 做法：
 *   ① 剥零宽/双向控制字符（`​-‏` 等常被用来绕过字符串匹配）
 *   ② 把注入标签的 `<` 降级成全角 `‹` —— 语义不再是标签，但人眼仍可读
 *   ③ 控制字符换空格
 * 注意：**不清洗普通尖括号**（代码片段里的 `<div>` 要保留），只针对注入标签本身。
 */
export function sanitizeInjectionText(s) {
  let t = String(s === undefined || s === null ? '' : s);
  // ① 零宽 / 双向控制
  t = t.replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/g, '');
  // ② 注入标签降级（大小写不敏感，容忍标签内空白）
  t = t.replace(/<\s*(\/?)\s*unified-memory\b/gi, function (_m, slash) {
    return '\u2039' + (slash || '') + 'unified-memory';
  });
  // ③ 其余控制字符
  t = t.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, ' ');
  // ④ [2026-10-24 by Assistant · Step 5] 剥 HTML 标签（渲染层兜底）
  //   实跑抓到注入里出现「：</style> <span class="bd">记忆系统改造…」——
  //   卡片 summary/content 里存了 VCP 卡片 HTML，原样进了注入。
  t = t.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ');
  t = t.replace(/<\/?[a-zA-Z][^>]{0,300}>/g, ' ');
  t = t.replace(/<[^<>]{0,200}$/g, ' ');
  t = t.replace(/[\u2500-\u257F\u2580-\u259F]/g, ' ');
  t = t.replace(/\s{2,}/g, ' ').trim();
  return t;
}

/**
 * [2026-10-22 by Assistant · 安全红队 P2/S1] 指令性表述检测。
 *
 * 红队原话：「标签和『供参考』说明**不是权限边界**。」
 * 彻底隔离需要改架构（把记忆放到独立的 data 通道），当前做不到；
 * 这里做**第二层防御**：检测记忆内容里是否有明显的"指令式"措辞，
 * 命中就给它打上 `[⚠️数据内含指令式措辞]` 标记，让模型看见"这是被标记的数据"，
 * 而不是让它伪装成正常条目。
 *
 * 保守设计：**只标记、不删除**（删了会丢信息，且可能误伤真正在讨论这些词的记忆）；
 * 模式选择偏严，避免「请忽略这个小问题」这类日常话被误标。
 */
const INSTRUCTIONAL_PATTERNS = [
  // 中文：允许「的/所有/全部/一切/上面这些」等修饰词任意组合、顺序不定、中间可有空白与标点
  /忽略[^。！？\n]{0,12}?(指令|提示词?|要求|规则|设定|约束)/,
  /(无视|忘记|忘掉|抛弃|丢弃|跳过)[^。！？\n]{0,12}?(指令|提示词?|要求|规则|设定|约束)/,
  /(从现在|从此刻|接下来)[^。！？\n]{0,6}?你(就)?(是|要|必须|扮演)/,
  /ignore\s+(all\s+)?(the\s+)?(previous|prior|above|earlier)\s+(instructions?|prompts?|rules?)/i,
  /disregard\s+(all\s+)?(the\s+)?(previous|prior|above|earlier)\s+(instructions?|prompts?|rules?)/i,
  /你(现在|从此)?(是|扮演|变成)一(个|名)/,
  /you\s+are\s+now\s+(a|an)\s+/i,
  /(系统|system)\s*(指令|prompt)\s*[:：]/i,
  /<\s*\|?im_start\|?\s*>/i,
  /<\s*\|?im_end\|?\s*>/i,
];

export function hasInstructionalPattern(text) {
  const s = String(text === undefined || text === null ? '' : text);
  if (s === '') return false;
  for (const re of INSTRUCTIONAL_PATTERNS) {
    try { if (re.test(s)) return true; } catch {}
  }
  return false;
}

export function renderCardLine(card, tier, causes, effects, opts = {}) {
  const e = card || {};
  const title = sanitizeInjectionText(e.title || '(untitled)');
  // [2026-10-26 by Assistant · 跨会话语义修正] layer **只作来源提示，绝不是检索边界**。
  //
  // 事故：原来原样渲染成 [session]，模型看到就推断「这是某会话私有的记忆，与我无关」——
  //   实测另一个会话真的说出「我只翻了自己的记忆」，而检索器从来不读 layer/scope_tags
  //   （全库只有 belief.js 的冲突判决用它）。也就是说：**写进注入、却不参与过滤**的半成品，
  //   给了模型一个错误的分区暗示。
  // ⇒ session 改成「其他窗口」：说明它来自另一个窗口，但仍在同一个共享记忆池里。
  const rawLayer = String(e.layer || 'global');
  const layer = sanitizeInjectionText(rawLayer === 'session' ? '其他窗口' : rawLayer);
  const rawSummary = sanitizeInjectionText(e.summary || '');
  // [P2/S1] 命中指令式措辞就打标（marker 只加在行首，不污染内容）
  const summary = rawSummary;
  // [2026-10-22 by Assistant · L1→L0 详情] 原话补充（默认关，见 WM_DEFAULTS.l0Detail）
  //   注意：这里的文本来自 L0 原始对话，属于不可信内容 ⇒ 一律过 sanitizeInjectionText()。
  const detailCap = Number.isFinite(Number(opts.l0DetailChars)) ? Math.max(0, Number(opts.l0DetailChars)) : 600;
  const d = opts.l0Detail === true ? e.l0Detail : null;
  // [2026-10-22 by Assistant · 复核 P1 修复]
  //   ① 原话里的换行归一为空格 —— 不然一张卡变三行，破坏调用方「按行=一张卡」的假设
  //   ② 超预算改成**渐进截断**而不是整段丢弃 —— 之前「刚超一点就全不要」，
  //      而 200+400+前缀在 cap=600 时几乎必超 ⇒ 实际大量卡拿不到原话
  const flat = (s) => String(s || '').replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
  const du = flat(d && d.user ? sanitizeInjectionText(d.user.content || '') : '');
  const da = flat(d && d.assistant ? sanitizeInjectionText(d.assistant.content || '') : '');
  let detailAllowed = '';
  if (du || da) {
    const PRE_U = '\n  \u21b3 原话(用户): ';
    const PRE_A = '\n  \u21b3 原话(回答): ';
    // 先按「用户 200 / 回答 400」试排；超了按剩余预算逐段缩
    let u = clip(du, 200), a = clip(da, 400);
    let candidate = (u ? PRE_U + u : '') + (a ? PRE_A + a : '');
    if (candidate.length > detailCap) {
      // 剩余预算按 1:2 分给用户与回答（用户问句短、回答长）
      const avail = Math.max(0, detailCap - (u ? PRE_U.length : 0) - (a ? PRE_A.length : 0));
      if (du && da) {
        u = clip(du, Math.max(20, Math.floor(avail / 3)));
        a = clip(da, Math.max(0, avail - u.length));
      } else if (du) {
        u = clip(du, avail);
      } else {
        a = clip(da, avail);
      }
      candidate = (u ? PRE_U + u : '') + (a ? PRE_A + a : '');
    }
    detailAllowed = candidate.length <= detailCap ? candidate : '';
  }
  // [2026-10-22 by Assistant · 补 S1 缺口] 指令式措辞检查**必须也看 L0 原话**——
  //   原话是不可信内容，之前只查 title/summary，等于给 L0 开了后门。
  const suspicious = hasInstructionalPattern(title)
    || hasInstructionalPattern(rawSummary)
    || hasInstructionalPattern(du)
    || hasInstructionalPattern(da);
  let line;
  // [2026-10-22 by Assistant] 时间可见性：让读的人一眼知道「这条多久以前」。
  //   没有时间标签时，两小时前刚落的决定和两周前的旧结论看起来一样，很容易当成同一件事。
  const age = e.ageLabel ? ' (' + e.ageLabel + ')' : '';
  const warnTag = suspicious ? '[⚠️数据内含指令式措辞] ' : '';
  // [Round 47-51 红队死结1修复] 注入区暴露短 ID 前缀，为对话工具 memory_get / memory_refute 提供直接操作靶心
  const idTag = e.id ? '[id: ' + e.id + '] ' : '';
  // [2026-10-26 by Assistant · 问题生命周期可见性]
  //   被关闭的问题卡**不删除**（保留历史与证据），但注入时必须让人一眼看出"它已经修好了"。
  //   否则另一个会话读到旧缺陷，会把历史问题当成现状。
  //   与 refuted 的标记严格区分：
  //     refuted  ⇒ 这条事实本身是错的
  //     resolved ⇒ 这个问题已经解决（结论仍然有效，只是不再待办）
  //     claimed  ⇒ AI 自称解决、但没有验证证据（存疑，不要当已闭环）
  const lifecycleTag = (function () {
    const st = String(e.status || '');
    if (st === 'resolved') return '[✅已闭环] ';
    if (st === 'claimed') return '[⚠️仅AI自称已修·未验证] ';
    return '';
  })();
  // [2026-10-27 · 第2步] 前情脉络：只在 full/summary 档展示，title 档省预算
  const arcTag = (e.arcStory && tier !== RENDER_TIER.title)
    ? (' ↳前情:' + String(e.arcStory).slice(0, 60))
    : '';
  if (tier === RENDER_TIER.full) {
    const cz = briefList(causes);
    const ef = briefList(effects);
    line = '- ' + idTag + walkTag(lifecycleTag) + warnTag + '[[' + title + ']][' + layer + ']' + age
      + (cz ? ' ↑因:' + cz : '')
      + (ef ? ' ↓果:' + ef : '')
      + ': ' + clip(summary, 120)
      + detailAllowed;
  } else if (tier === RENDER_TIER.summary) {
    line = '- ' + idTag + walkTag(lifecycleTag) + warnTag + '[[' + title + ']][' + layer + ']' + age + ': ' + clip(summary, 80) + detailAllowed;
  } else {
    line = '- ' + idTag + walkTag(lifecycleTag) + warnTag + '[[' + title + ']]' + age;
  }
  return { line, costTokens: estimateTokens(line) };
}

/** 生命周期标记直出（留一层包装，方便统一改格式/加颜色）。 */
function walkTag(tag) { return String(tag || ''); }

function briefList(list) {
  if (!Array.isArray(list) || list.length === 0) return '';
  return list.map(function (x) { return sanitizeInjectionText(String(x)); }).join(';').slice(0, 60);
}
function clip(s, n) {
  const str = String(s || '');
  return str.length > n ? str.slice(0, n) : str;
}
function num(v, d) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

/**
 * ③ 最终排序分（规划 §4.2）。
 * S = retrievalScore * sigmoid(B - bias) * (1 + 0.6 * A_norm)
 *
 * ⚠️ 双重加权护栏（DESIGN §5 坑2）：若上游已经把激活乘进 retrievalScore，
 *    这里再乘一次就等于平方。调用方必须传 doubleWeight=false，本函数会跳过 A 项。
 */
export function finalScore(args) {
  const a = args || {};
  const ret = Math.max(0, num(a.retrievalScore, 0));
  const B = num(a.baseActivation, 0);
  const A = clamp01(num(a.spreadActivation, 0));
  const bias = a.bias !== undefined ? num(a.bias, WM_HARD.BIAS) : WM_HARD.BIAS;
  const w = a.spreadWeight !== undefined ? num(a.spreadWeight, 0.6) : 0.6;
  const gain = a.doubleWeight === false ? 1 : 1 + w * A;
  return ret * normalizeActivation(B - bias) * gain;
}

/** ④ 交点分组键：anchors>=2 的节点整组前置（不靠单一分数"混合加成"）。 */
export function isIntersection(anchorCount) {
  return num(anchorCount, 0) >= 2;
}

function clamp01(x) {
  if (!Number.isFinite(x)) return 0;
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

export default { computeL0Budget, renderCardLine, finalScore, isIntersection };
