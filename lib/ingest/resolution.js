/**
 * lib/ingest/resolution.js —— 问题生命周期（open → resolved）
 * [2026-10-26 by Phoebe · 根因治理]
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
import { dataRoot } from '../paths.js';

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
/**
 * [2026-11-03 by Phoebe · soul P0②「同状态同字节」]
 *
 * 为什么需要它：入口列表是提示词的一段。若同一轮两次调用产出不同字节，
 * 或者新卡一到就整体重排，**prompt cache 前缀必碎** —— 这正是User一直在追的
 * 缓存命中率问题（T1.1 77.2% vs T2.1 0.0%）的同一类病。
 *
 * 参照 dsh-soul（src/graph-memory.js:38-48）的做法：**把时钟量化**。
 *   「A 依赖时钟，朴素读路径会让同一轮两次调用产出不同字节，
 *     破坏同状态同字节，连带打碎 prompt cache 前缀。」
 * 量化后一个桶内逐字节相同，跨桶才轮转。
 *
 * 5 分钟的理由（照抄它的判断）：比一次工具循环长，比一个工作会话短。
 */
export const ENTRY_QUANTUM_MS = 5 * 60 * 1000;

/** 把时间戳压到桶起点；桶内所有时刻等价 ⇒ 排序稳定。 */
export function quantizeTs(ts, quantum) {
  const q = Number.isFinite(Number(quantum)) && Number(quantum) > 0 ? Number(quantum) : ENTRY_QUANTUM_MS;
  const t = Number(ts);
  if (!Number.isFinite(t)) return 0;
  return Math.floor(t / q) * q;
}

export function buildEntryList(existing, opts = {}) {
  const budget = Number.isFinite(Number(opts.budgetChars))
    ? Math.max(0, Math.floor(Number(opts.budgetChars)))
    : 1800;
  // 问题卡占预算的 60%（留 40% 给最新卡，避免又变成"只看问题不看新事"）。
  // problemQuota 包含问题段标题及段内换行；段间空行只计入总预算。
  const problemQuota = Number.isFinite(Number(opts.problemQuota))
    ? Math.min(budget, Math.max(0, Math.floor(Number(opts.problemQuota))))
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

  // [2026-11-03 by Phoebe · soul P0②] 原来的写法是纯 createdAt DESC：
  //   新卡一进来就整体重排 ⇒ 1800 字符里装谁全变 ⇒ 提示词前缀必碎。
  // 现在：① 时间**量化到 5 分钟桶**，同桶内时刻等价；
  //       ② 用 id 字典序做**总序兜底**，结果与输入数组顺序无关（不依赖 Array.sort 的稳定性假设）。
  //   => 同一桶内、同一份卡库，输出逐字节相同。
  // [2026-11-07 P2-5] quantumMs 必须是**有限正数**：传 0 会让 bucket = floor(t/0)*0 = NaN。
  //   旧写法 Number.isFinite(0)===true ⇒ 接受 0 ⇒ 产生 NaN 桶。这里统一拦住。
  const qRaw = Number(opts.quantumMs);
  const quantum = Number.isFinite(qRaw) && qRaw > 0 ? qRaw : ENTRY_QUANTUM_MS;
  const bucketOf = (c) => quantizeTs(c && c.createdAt, quantum);
  const newestFirst = deduped.slice().sort((a, b) => {
    const d = bucketOf(b) - bucketOf(a);
    if (d !== 0) return d;
    const ai = String((a && a.id) || '');
    const bi = String((b && b.id) || '');
    return ai < bi ? -1 : (ai > bi ? 1 : 0);
  });

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
  const problemTitle = '【待处理的问题卡（如本轮已解决，请在 resolves 里填它的标题）】';
  const normalTitle = '【参考卡】';
  let problemSection = '';
  let normalSection = '';
  let bodyChars = 0;
  let pickedProblems = 0;
  let pickedRecent = 0;

  // ① 问题卡优先（最新优先，精简格式）。标题和换行先计入，再试装整张卡；
  //    超长卡只跳过自己，不能挡住后面可能装得下的短卡。
  for (const c of problems) {
    const line = fmtProblem(c);
    const candidate = problemSection ? problemSection + '\n' + line : problemTitle + '\n' + line;
    if (candidate.length > problemQuota || candidate.length > budget) continue;
    problemSection = candidate;
    picked.push(line);
    pickedIds.add(String(c.id));
    bodyChars += line.length;
    pickedProblems++;
  }

  // ② 最新卡占剩下的预算（跳过已选的）。段间两个换行也在这里计入总预算。
  for (const c of others) {
    if (pickedIds.has(String(c.id))) continue;
    const line = fmtNormal(c);
    const candidate = normalSection ? normalSection + '\n' + line : normalTitle + '\n' + line;
    const totalChars = problemSection.length + (problemSection ? 2 : 0) + candidate.length;
    if (totalChars > budget) continue;
    normalSection = candidate;
    picked.push(line);
    pickedIds.add(String(c.id));
    bodyChars += line.length;
    pickedRecent++;
  }

  const text = problemSection + (problemSection && normalSection ? '\n\n' : '') + normalSection;
  return {
    text,
    stats: {
      aliveTotal: alive.length,
      deduped: deduped.length,
      dedupeDropped,
      problemCards: problems.length,
      pickedProblems,
      pickedRecent,
      pickedTotal: picked.length,
      chars: text.length,
      bodyChars,
      budget,
    },
  };
}

/**
 * [2026-11-03 by Phoebe · soul P0②] 按**时间桶冻结**的入口列表。
 *
 * 光有量化排序还不够：桶内新卡一到，1800 字符里装谁依然会变。
 * 要真正做到「同状态同字节」，必须让**同一桶内直接复用上次算好的结果**。
 *
 * 代价（必须说清）：桶内最多**晚 5 分钟**才看见新卡。
 * 换来的是：提示词前缀在一个桶内逐字节稳定 ⇒ prompt cache 可以持续命中。
 * 这与 dsh-soul 的取舍完全一致（5 分钟量子）。
 *
 * 注意：**不缓存坏结果**——算出来是空文本时不冻结，避免一次空库把整桶钉死。
 *
 * @param {object[]} existing 卡库
 * @param {{ budgetChars?:number, problemQuota?:number, quantumMs?:number,
 *           now?:number, freeze?:boolean, cache?:{bucket:number,key:string,result:object} }} [opts]
 */
/**
 * 生命周期指纹 —— 专门用来打破冻结。
 *
 * [2026-11-03 by Phoebe · 红队第二批] 红队反例：
 *   同一 5 分钟桶内，一张问题卡从 active 改成 resolved，
 *   注入里**仍然显示「待处理」** ⇒ 诱导模型重复闭环。
 *
 * 红线（红队原话）：「新卡可延迟，终态不得延迟。」
 *
 * ## 只统计**终态卡**，不统计整库 id 集合（实测换来的）
 * 第一版把「每张卡的 id + 是否活跃」全算进指纹，结果：
 *   新卡一进 ⇒ id 集合变 ⇒ 指纹变 ⇒ 立刻重算 ⇒ 前缀保留率从 100% 掉到 67%。
 * 用真实卡库（1,600+ 张）对三种口径实测：
 *   A 纯桶（无指纹）        前缀保留 100%
 *   B 桶 + 整库活跃 id 集合   前缀保留  67%   ← 第一版，代价太大
 *   C 桶 + **仅终态签名**     前缀保留 100%   ← 现在这版
 * 因为「新卡到达」本来就不该打破冻结（红队明确允许延迟），
 * 真正必须立刻失效的只有「某张卡进入终态」这一件事。
 * 所以指纹 = 终态卡的 id 集合签名：终态增加/变化 ⇒ 键变 ⇒ 立刻重算；
 * 没有终态变化 ⇒ 键不变 ⇒ 新卡照旧被延迟，前缀完整保住。
 */
export function lifecycleFingerprint(existing) {
  const list = Array.isArray(existing) ? existing : [];
  const parts = [];
  for (const c of list) {
    if (!c) continue;
    const id = String(c.id || '');
    if (!id) continue;
    const st = String(c.status || 'active').toLowerCase();
    const dead = (st === 'retired' || st === 'resolved' || st === 'refuted'
      || c.resolved === true || c.refuted === true);
    if (dead) parts.push(id);          // 只记终态卡，不记活跃卡
  }
  parts.sort();
  // 用轻量哈希避免键过长（同一个桶内只需能区分"变没变"）
  let h = 0;
  const s = parts.join(',');
  for (let i = 0; i < s.length; i++) { h = (h * 31 + s.charCodeAt(i)) | 0; }
  return parts.length + '#' + (h >>> 0).toString(36);
}

/**
 * [2026-11-05 by Phoebe · AA19c 实测抓到的真 bug] 库身份指纹。
 *
 * 病灶：冻结缓存的 key 只有 [bucket, budget, problemQuota, quantum, lifeFp]，
 *   而 lifeFp **只统计终态卡**（retired/resolved/refuted）—— 这是红队第二批
 *   为了「前缀保留率从 67% 拉回 100%」刻意做的取舍。
 *   ⇒ 副作用：两个**全是 active 卡**的不同库，lifeFp 完全相同（都是 '0#0'），
 *     同 5 分钟桶内会命中同一份缓存 ⇒ 库 A 的入口文本被库 B 拿去用。
 *
 * 实测暴露：selftest-ingest 的 AA19c 稳定失败（written=1），单独跑却正常。
 *   因为几十个临时库轮流跑，且旧卡都是 active ⇒ 全部撞同一个缓存。
 *   **生产只有一个库，所以之前从未暴露** —— 但这是真 bug，不是测试问题。
 *
 * 修法：key 里补一把**库身份**。
 *   · 取 existing 前 3 个 id（排序后）做轻哈希
 *   · 为什么不取整库 id：那会把前缀保留率打到 67%（第一版实测）
 *   · 为什么前 3 个就够：不同库的卡 id 天然不同；生产库的 id 集合几乎不变
 *   · 实测：生产库新增卡后 libFp 不变 ✅；两个测试库 libFp 不同 ✅
 */
function libraryFingerprint(existing) {
  // ⚠️ 约束（红队第二条红线，selftest-atomic-freeze ④e 锁死）：
  //   **新卡到达不得打破冻结** —— 否则前缀保留率从 100% 掉到 67%。
  //
  //   第一版取「前 3 个 id 排序哈希」⇒ 新卡进前 3 就变 ⇒ ④e 挂。
  //   第二版取「字典序最小 id」⇒ 单测里 'pmi:new' < 'pmi:p1' 仍然变 ⇒ ④e 还挂。
  //
  //   ⇒ 结论：**用 id 集合做指纹这条路走不通**（任何包含新卡的做法都会破坏冻结，
  //     任何不含新卡的做法都区分不了库）。
  //
  //   改用「**建库时间**」：
  //     · 取 existing 里最早的 createdAt 取整到分钟
  //     · 新卡 createdAt 一定更晚 ⇒ 该值**永不变化** ⇒ 冻结 ✓
  //     · 不同测试库用不同时间戳夹具 ⇒ 天然区分 ✓
  //     · 空库 ⇒ '0#'
  //   这是唯一同时满足「新卡不破冻结」与「跨库可区分」的稳定特征。
  const list = Array.isArray(existing) ? existing : [];
  let earliest = 0;
  for (const c of list) {
    if (!c) continue;
    const t = Number(c.createdAt) || Number(c.eventTs) || 0;
    if (t > 0 && (earliest === 0 || t < earliest)) earliest = t;
  }
  if (!earliest) return '0#';
  return 't' + Math.floor(earliest / 60000);
}

export function buildEntryListStable(existing, opts = {}) {
  // [2026-11-07 P2-5] 同上：quantumMs 只能取有限正数，0/负/NaN 一律回退默认量子。
  const qRaw2 = Number(opts.quantumMs);
  const quantum = Number.isFinite(qRaw2) && qRaw2 > 0 ? qRaw2 : ENTRY_QUANTUM_MS;
  const now = Number.isFinite(Number(opts.now)) ? Number(opts.now) : Date.now();

  // 冻结关闭（测试/排障用）⇒ 直接透传，逐字节等同旧行为
  if (opts.freeze === false) return buildEntryList(existing, opts);

  const bucket = Math.floor(now / quantum) * quantum;
  // ★ 冻结键补入生命周期指纹（红队第二批）：终态一变，键就变，立刻重算
  const lifeFp = lifecycleFingerprint(existing);
  // ★ [2026-11-05] 再补库身份：防「两个全是 active 卡的不同库」撞同一缓存
  const libFp = libraryFingerprint(existing);
  // [2026-11-07 P2-5 · 红队修复] libraryFingerprint 只用活跃 ID/最早 createdAt，
  //   两个备份库/测试库只要 ID 集合与最早时间相同就可能共享同一份缓存 ⇒ 不能当"唯一身份"。
  //   修法：缓存 key 里**显式加入以数据根为依据的 namespace**（调用方可传 cacheNamespace 覆盖）。
  //   生产只有一个数据根 ⇒ namespace 稳定；不同库/不同数据根 ⇒ 天然隔离。
  const cacheNs = String(opts.cacheNamespace || opts.dataRoot || dataRoot());
  const key = [
    cacheNs,                 // ★ 数据根命名空间（防跨库串缓存，主防线）
    bucket,
    opts.budgetChars || 1800,
    opts.problemQuota === undefined ? '-' : opts.problemQuota,
    quantum,                 // 量子参数变了也要重算
    lifeFp,                  // 生命周期变了必须重算
    libFp,                   // 库身份（辅助，防同数据根内不同夹具撞车）
  ].join('|');

  const cache = opts.cache && typeof opts.cache === 'object' ? opts.cache : null;
  // 命中冻结：原样返回，保证逐字节相同
  if (cache && cache.key === key && cache.result && cache.result.text) {
    return cache.result;
  }

  const result = buildEntryList(existing, opts);
  // 空结果不冻结（否则一次空库会把整桶钉死 5 分钟）
  if (!result || !result.text) return result;

  if (cache) {
    cache.bucket = bucket;
    cache.key = key;
    cache.result = result;
  }
  return result;
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
