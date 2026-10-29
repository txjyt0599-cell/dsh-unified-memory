/**
 * lib/ingest/resolution.js —— 问题生命周期（open → resolved）
 * [2026-10-26 by Assistant · 根因治理]
 *
 * 为什么存在：
 *   记忆库原来只建模「事实」，不建模「问题的生命周期」。
 *   缺陷能入库，"已修好"入不了库 —— 因为 distill 提示词把过程叙述过滤掉了，
 *   而"通过、已清、已落地"长得和过程叙述一模一样。
 *   结果：后几轮的缺陷记全了，终态一张没有。
 *
 * 本模块提供四件事（都可在写盘前同步调用，零额外 LLM 开销）：
 *   ① buildEntryList   —— 入口列表按「待关闭的问题卡优先」重排 + 去重
 *   ② isProblemCard    —— 判定一张卡是不是「问题类」（可能被关闭的）
 *   ③ detectResolution —— 从本轮对话里识别「这个问题解决了」
 *   ④ hasEvidence      —— 判定该解决声明有没有证据（防 AI 自嗨）
 */
/**
 * 本地 2-gram 重叠率（与 distill.bigramOverlap 同口径，但**不 import 它**）。
 * [2026-10-26] 必须自己实现：distill.js 会 import 本模块，
 *   反过来再 import distill 会形成 ESM 循环依赖，初始化顺序不可控。
 */
function bigramOverlap(a, b) {
  const grams = (s) => {
    const set = new Set();
    const text = String(s || '').toLowerCase();
    for (const seg of text.match(/[\u4e00-\u9fff]+/g) || []) {
      if (seg.length === 1) { set.add(seg); continue; }
      for (let i = 0; i < seg.length - 1; i++) set.add(seg.slice(i, i + 2));
    }
    for (const w of text.match(/[a-z0-9][a-z0-9_.-]*/g) || []) {
      if (w.length >= 2) set.add('w:' + w);
    }
    return set;
  };
  const A = grams(a); const B = grams(b);
  if (A.size === 0 || B.size === 0) return 0;
  let hit = 0;
  for (const g of A) if (B.has(g)) hit++;
  return hit / Math.max(A.size, B.size);
}

/**
 * 从问题卡标题里提炼「问题主题」——剥掉待解决状态的修饰词。
 *
 * 为什么需要：标题常写成「延迟拆分功能未落地」「X 字段写死为 0」「Y 测试失败」，
 *   这些词描述的是**当时的状态**；当问题解决后对话里说的是「延迟拆分功能已落地」，
 *   直接拿原标题做子串匹配永远失败。剥掉否定/未完成修饰后，只留问题本身。
 */
export function problemSubject(title) {
  let s = String(title || '').trim();
  // 剥掉常见的"未完成"修饰（前缀/后缀都可能有）
  s = s.replace(/(未落地|未修|未通过|未完成|未解决|未闭环|未生效|未补齐|未修正|待修|待办|待确认|待补)/g, '');
  s = s.replace(/(失败|报错|异常|缺失|缺少|缺口|问题|缺陷|阻塞|卡住|挂了|不工作)/g, '');
  s = s.replace(/(已落地|已修|已解决|已闭环)$/, '');
  s = s.replace(/[\s\-—_，,。.、:：;；]+/g, '');
  return s.trim();
}

/** 问题类卡的特征词（标题或摘要命中即算） */
const PROBLEM_RE = /(缺陷|问题|失败|未通过|不通过|未落地|待修|待办|待确认|报错|异常|缺口|阻塞|卡住|超时|泄漏|bugs?|fails?|broken|missing|P[0-3]\b|TODO)/i;

/** 结论/终态信号（描述"已经解决"的词） */
const RESOLVE_SIGNAL = /(已通过|全绿|已修|修好|修复完成|已落地|已清|已删|已解决|已闭环|验收通过|签收|通过验收|根治|已生效|已补齐|已修正)/;

/** 证据信号：只有这些才算「真的验证过」 */
const EVIDENCE_SIGNAL = /(verify|verify 全绿|全绿|测试通过|\b\d+\s*[/／]\s*\d+\s*(项|个|套)?|assert|断言|实测|实测结果|回归通过|检查通过|审计通过|绿灯|0\s*(失败|failed))/i;

/**
 * 判定一张卡是不是「问题类」卡（可被 resolution 关闭的候选）。
 */
export function isProblemCard(card) {
  if (!card || typeof card !== 'object') return false;
  const st = String(card.status || 'active');
  if (st !== 'active' && st !== 'scoped_active') return false;
  const text = String(card.title || '') + ' ' + String(card.summary || '');
  return PROBLEM_RE.test(text);
}

/**
 * 构建「已有记忆入口」列表。
 *
 * [根因修复] 原来：existing.filter(非 retired).map(...).join('\n').slice(0, 1800)
 *   —— 数据源是 createdAt 升序（实测 294 升 vs 10 逆），slice 永远切最老那批。
 *   实测：305 张卡 → 只装 50 张（16.4%），覆盖停在 10-22 16:31，
 *        而库内最新卡是 10-23 01:15（差 8.7 小时全被挡在门外）。
 *        被挡住的 255 张里 61 张是问题卡 —— 于是模型永远不知道该关什么。
 *
 * 现在改为三段式装配（保证每次都在预算内看到最该看的那批）：
 *   ① 待关闭的问题卡（最新优先）—— 这是本模块的主要目的
 *   ② 最近新增的卡（最新优先）  —— 防止新卡被永久挤掉
 *   ③ 其余卡（可省略）
 * 同标题去重（保留最新一条），并在每行带 [id: xxx]，让模型能精确引用。
 *
 * @param {object[]} existing 卡库（readOwnEngrams 的返回）
 * @param {{ budgetChars?: number, problemQuota?: number }} [opts]
 * @returns {{ text: string, stats: object }}
 */
export function buildEntryList(existing, opts = {}) {
  const budget = Number.isFinite(Number(opts.budgetChars)) ? Number(opts.budgetChars) : 1800;
  // 问题卡占预算的 60%（留 40% 给最新卡，避免又变成"只看问题不看新事"）
  const problemQuota = Number.isFinite(Number(opts.problemQuota))
    ? Number(opts.problemQuota)
    : Math.floor(budget * 0.6);

  const alive = (Array.isArray(existing) ? existing : [])
    .filter((c) => c && String(c.status || 'active') !== 'retired');

  // 同标题去重：保留 createdAt 最新的一条（旧的是历史版本，没必要占位）
  const byTitle = new Map();
  for (const c of alive) {
    const key = String(c.title || '').trim();
    if (!key) continue;
    const prev = byTitle.get(key);
    if (!prev || Number(c.createdAt || 0) > Number(prev.createdAt || 0)) byTitle.set(key, c);
  }
  const deduped = Array.from(byTitle.values());
  const dedupeDropped = alive.length - deduped.length;

  const newestFirst = deduped.sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));

  // [2026-10-26] 两种行格式，差别很大（实测 69 张问题卡）：
  //   摘要版 72 字符/行 ⇒ 只装 26 张；精简版 33 字符/行 ⇒ 装 55 张，翻倍。
  //   问题卡是「要被点名叫号关闭」的，模型只需要认得出是哪张 —— 标题 + id 足够。
  //   普通卡可能被引用内容，仍保留摘要。
  const fmtProblem = (c) => String(c.id || '') + '  ' + String(c.title || '');
  const fmtNormal = (c) => '[[' + String(c.title || '') + ']] ' + String(c.summary || '').slice(0, 40)
    + ' [id: ' + String(c.id || '') + ']';

  const problems = newestFirst.filter(isProblemCard);
  const others = newestFirst.filter((c) => !isProblemCard(c));

  const picked = [];
  const pickedIds = new Set();
  let problemChars = 0;
  let pickedProblems = 0;

  // ① 问题卡优先（最新优先，精简格式）
  for (const c of problems) {
    const line = fmtProblem(c);
    if (problemChars + line.length + 1 > problemQuota) break;
    picked.push(line);
    pickedIds.add(String(c.id));
    problemChars += line.length + 1;
    pickedProblems++;
  }

  // ② 最新卡占剩下的预算（跳过已选的）
  let totalChars = problemChars;
  let pickedRecent = 0;
  for (const c of others) {
    if (pickedIds.has(String(c.id))) continue;
    const line = fmtNormal(c);
    if (totalChars + line.length + 1 > budget) break;
    picked.push(line);
    pickedIds.add(String(c.id));
    totalChars += line.length + 1;
    pickedRecent++;
  }

  // 输出时给两段加不同标题，让模型一眼分清「要关闭的」和「参考的」
  const problemLines = picked.slice(0, pickedProblems);
  const normalLines = picked.slice(pickedProblems);
  const sections = [];
  if (problemLines.length) {
    sections.push('【待处理的问题卡（如本轮已解决，请在 resolves 里填它的标题）】\n' + problemLines.join('\n'));
  }
  if (normalLines.length) {
    sections.push('【参考卡】\n' + normalLines.join('\n'));
  }

  return {
    text: sections.join('\n\n'),
    stats: {
      aliveTotal: alive.length,
      deduped: deduped.length,
      dedupeDropped,
      problemCards: problems.length,
      pickedProblems,
      pickedRecent,
      pickedTotal: picked.length,
      chars: totalChars,
      budget,
    },
  };
}

/**
 * 从一轮对话里识别「某个已存在的问题被解决了」。
 *
 * 两种来源：
 *   ① 模型显式输出 resolves: [标题...]（首选）
 *   ② 确定性兜底：句子命中 RESOLVE_SIGNAL 且与某张问题卡有实体/标题重合
 *
 * @param {string} conversation 本轮对话文本
 * @param {object[]} problemCards 候选问题卡（已是 isProblemCard 通过的那些）
 * @param {{ llmResolves?: string[], hasUserConfirm?: boolean }} [ctx]
 * @returns {{ candidates: Array<{card:object, evidence:boolean, reason:string}> }}
 */
export function detectResolution(conversation, problemCards, ctx = {}) {
  if (!Array.isArray(problemCards) || problemCards.length === 0) return { candidates: [] };
  const text = String(conversation || '');
  const candidates = [];
  const seen = new Set();

  const push = (card, evidence, reason) => {
    const id = String(card && card.id || '');
    if (!id || seen.has(id)) return;
    seen.add(id);
    candidates.push({ card, evidence, reason });
  };

  // ① 模型显式点名（最可靠）
  const llmResolves = Array.isArray(ctx.llmResolves) ? ctx.llmResolves : [];
  for (const t of llmResolves) {
    const target = String(t || '').trim();
    if (!target) continue;
    for (const c of problemCards) {
      const ct = String(c.title || '');
      if (ct === target || bigramOverlap(ct, target) >= 0.55) {
        push(c, true, 'llm-resolves: ' + target);
        break;
      }
    }
  }

  // ② 确定性兜底：只有出现"解决信号"才扫
  if (RESOLVE_SIGNAL.test(text)) {
    const evidenceInText = EVIDENCE_SIGNAL.test(text);
    const userConfirmed = ctx.hasUserConfirm === true;
    for (const c of problemCards) {
      if (seen.has(String(c.id))) continue;
      // [2026-10-26 修正] 原来用「标题前 8 字」做子串匹配，实测直接失效：
      //   标题「延迟拆分功能未落地」，前 8 字是「延迟拆分功能未」（带"未"），
      //   而对话里是「延迟拆分功能已落地」 ⇒ 永远匹配不上。
      //   否定词是"待解决状态"的描述，不是"问题主题"的一部分，必须剔除后再比。
      const subject = problemSubject(String(c.title || ''));
      if (!subject || subject.length < 4) continue;
      // 主题必须在本轮对话里出现过（聊到了这张卡）
      if (!text.includes(subject)) continue;
      // 且必须有一句同时含"主题 + 解决信号"（说的正是这件事已解决）
      const solvedLine = text.split(/[。\n！？]/).some(
        (s) => RESOLVE_SIGNAL.test(s) && s.includes(subject)
      );
      if (!solvedLine) continue;
      push(c, evidenceInText || userConfirmed,
        evidenceInText ? 'tool-or-test-evidence' : (userConfirmed ? 'user-confirmed' : 'ai-claimed-only'));
    }
  }

  return { candidates };
}
