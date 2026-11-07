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

// ── [2026-11-04 by Assistant · 精确关键词命中豁免] ──
//   User：「只要是精确关键词命中，就完全豁免衰减惩罚
//          比如我去年和你干了 xx 事 你还记得吗」
//   判定：相关度 >= Top1 的这个比例（几乎并列）且卡片里真出现了查询实词。
export const REL_EXACT_FOR_EXEMPT = 0.95;
// [2026-11-04] 只有时间命中（关键词没中）时，相关度必须几乎并列 Top1 才豁免。
//   防「问去年 ⇒ 去年所有卡都免疫」的漏洞。
export const REL_TIME_ONLY_FOR_EXEMPT = 0.99;

/**
 * [2026-11-04 by Assistant · User定：时间标签也是「精确命中」的一条腿]
 *
 * User原话：
 *   「本身我们对记忆卡片新的应该是有时间标签和事件类型标签的
 *    这个设计本身就是为了部分长时间遗忘的老卡被精确命中重新拉顶」
 *   「比如我去年和你干了 xx 事 你还记得吗」
 *
 * 这句话里有**两个**可检索维度：
 *   ① 关键词「xx 事」  ⇒ isExactKeywordHit（已有）
 *   ② 时间「去年」     ⇒ 本函数
 *
 * 语义：User说「去年」，而卡的事件时间（eventTs，退化 createdAt）**确实落在去年**，
 *   说明时间和事实都对上了 ⇒ 这张卡该被唤醒，不该因"太久没用"被压到 0.35。
 *
 * @param {object} card
 * @param {{lo?:number, hi?:number}|null} win 时间窗口（天，来自 parseTimeWindow）
 * @param {number} nowTs
 * @returns {boolean} 卡片事件时间是否落在窗口内
 */
/**
 * [2026-11-07 P2-1 · 红队修复] 卡片时间戳归一化 —— 与 time-window.ageDaysOf 同口径：
 *   eventTs 优先（只接受数字）；createdAt 若为 **ISO 字符串必须 Date.parse**，
 *   原来这里直接 Number(card.createdAt) ⇒ ISO 字符串变 NaN ⇒ 时间豁免永远不生效。
 * @returns {number} ms 时间戳，0 表示无法确定
 */
function cardTsOf(card) {
  const e = Number(card && card.eventTs);
  if (Number.isFinite(e) && e > 0) return e;
  const v = card && card.createdAt;
  let n = NaN;
  if (typeof v === 'number') n = v;
  else if (typeof v === 'string' && v) n = Date.parse(v);
  else n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export function isTimeMatchedHit(card, win, nowTs) {
  if (!card || !win) return false;
  const lo = Number(win.lo);
  const hi = Number(win.hi);
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return false;
  // 事件时间：优先 eventTs，退化 createdAt（ISO 字符串会被 Date.parse）
  const ts = cardTsOf(card);
  if (!ts) return false;
  const now = Number.isFinite(Number(nowTs)) ? Number(nowTs) : Date.now();
  const ageDays = (now - ts) / 86400000;
  // [2026-11-07 P2-1] 边界口径统一为 lo < ageDays <= hi（与 retriever 时间窗硬过滤一致），
  //   原来这里写 >= lo ⇒ 恰好落在 lo 的边界卡"一处入选、一处不豁免"。
  return ageDays > lo && ageDays <= hi;
}

// ══ [2026-11-04 by Assistant · 事件类型标签（titleType）接进检索] ══
//   User原话：「本身我们对记忆卡片新的应该是有时间标签和事件类型标签的
//              这个设计本身就是为了部分长时间遗忘的老卡被精确命中重新拉顶」
//
//   现状：六类标签写进卡了（distill.js:720），但**检索侧一次都没读过**（grep 0 处）。
//
//   接法：**软加权，不做硬过滤**。理由：覆盖只有 0.4%（73/16,976），
//     硬过滤会误杀 99.6% 没有标签的卡。
//
//   判据：查询里出现某类关键词 ⇒ 该类型卡拿小额加成（最多 +8%），
//     只在「相关度几乎并列」时才起作用（同档 tie-break），不影响跨档排序。
const TYPE_CUES = {
  decision: /(决定|拍板|定了|选哪个|选了|方案定|采纳|否决|不要哪个)/,
  process: /(怎么做的|做了什么|流程|步骤|过程|怎么改|如何实现|干了些啥)/,
  incident: /(报错|挂了|崩了|故障|事故|为什么坏|根因|踩坑|bug|失败)/,
  experience: /(开心|难过|感受|体验|经历|那次|旅游|吃|玩)/,
  persona: /(User喜欢|User偏好|我习惯|User讨厌|User爱)/,
  fact: /(是什么|什么是|原理|定义|参数|配置说明)/,
};

/**
 * 根据查询判断「User在问哪一类事」。
 * @param {string} query
 * @returns {string|null} decision|process|incident|fact|experience|persona，判断不出返回 null
 */
export function inferQueryTitleType(query) {
  const q = String(query || '');
  if (!q) return null;
  for (const [type, re] of Object.entries(TYPE_CUES)) {
    if (re.test(q)) return type;
  }
  return null;
}

/**
 * 判断一张卡是否被**查询的实词**精确命中（不是语义沾边）。
 * 只有 >=2 个汉字的中文实词才算，避免「的/了/是」这类单字误判。
 * @param {object} card
 * @param {string} query
 * @returns {boolean}
 */
export function isExactKeywordHit(card, query) {
  const q = String(query || '').trim();
  if (!q || !card) return false;
  const hay = String(card.title || '') + ' ' + String(card.summary || '') + ' ' + String(card.content || '');
  if (!hay) return false;

  // ⚠️ [2026-11-04 第一版踩坑] 原写法用 /[\u4e00-\u9fff]{2,8}/g 切词，
  //   实测「还记得去年一起做的项目甲渲染改造吗」被切成
  //     ["还记得去年一起做", "的项目甲渲染改造吗"]  ← 整段当一个词，永远查不到。
  //   中文没有空格，正则切不出词边界。
  //
  //   修法：**滑动窗口**——从查询里取 2~6 字的连续子串去卡里找。
  //   只要有一个 >=3 字的子串命中，就算「关键词精确命中」。
  //   为什么要 >=3：2 字会撞上「配置」「路径」这种通用词（和 isAdopted 踩过的同一个坑）。
  const STOP_CHARS = new Set('的了吗呢吧啊呀是我们你他她它这那哪个和与或就都也还再又很太更最'.split(''));
  const clean = [];
  for (const ch of q) {
    if (/[\u4e00-\u9fff]/.test(ch)) clean.push(ch);
    else clean.push(' ');   // 非中文当分隔符
  }
  const s = clean.join('');

  // 按空格切段，每段内部再滑窗
  for (const seg of s.split(/\s+/)) {
    if (seg.length < 2) continue;
    const maxLen = Math.min(6, seg.length);
    for (let len = maxLen; len >= 3; len--) {
      for (let i = 0; i + len <= seg.length; i++) {
        const sub = seg.slice(i, i + len);
        // 跳过全是虚词的子串
        let real = 0;
        for (const ch of sub) if (!STOP_CHARS.has(ch)) real++;
        if (real < 3) continue;
        if (hay.indexOf(sub) >= 0) return true;
      }
    }
  }

  // ── [2026-11-07 P2-1 · 红队修复] 支持英文/数字技术 token ──
  //   病灶：上面把非中文全部当分隔符 ⇒ 「示例显卡」「L0」「429」这类查询
  //   被清成空格，永远切不出关键词 ⇒ 技术查询的"精确命中豁免"形同虚设。
  //   修法：单独抽 **含数字** 的字母数字 token（长度>=2），大小写不敏感地做子串匹配。
  //   只要 token 里带数字（示例显卡 / L0 / 429 / T1.1 / P0）才算技术词，
  //   纯英文常见词（ok/to/the）不会被误当关键词。
  const HAY_L = hay.toLowerCase();
  const techTokens = q.match(/[A-Za-z0-9]+(?:[._-][A-Za-z0-9]+)*/g) || [];
  for (const tok of techTokens) {
    if (tok.length < 2) continue;
    if (!/[0-9]/.test(tok)) continue;
    if (HAY_L.indexOf(tok.toLowerCase()) >= 0) return true;
  }
  return false;
}
export const MAX_HITS = 20;            // 强度封顶常数（我们量级：先 20，数据涨了再抬）
export const W = { imp: 0.45, rec: 0.30, str: 0.35 };

export const HALF_LIFE = {
  axiom: Infinity,   // 基石：永不衰减（**只认 is_axiom === true**）
  quasiaxiom: 180,   // 准基石：importance >= 0.8 但非基石（温和过渡档）
  important: 60,     // 重要决定：60 天
  volatile: 21,      // 日常流水：21 天
};

// ── [2026-11-04 by Assistant · 动态半衰期（越用越难忘）] ──
//   User原话：「真实的记忆本来就是越用越多次越难忘记」
//   公式：HL = base × (1 + GROWTH × log1p(hits))，封顶 MAX_HL
//   GROWTH/MAX_HL 标 🔶 = 待 shadow 验证（总纲 §三 的共识：数据窗口只有 79 天，
//   180 天半衰期无法验证，所以只能先用参数扫描，不能宣称已校准）
// ══ [2026-11-04 by Assistant · 线性衰减模型（User定稿）] ══
//   User原话：
//     「本来就不应该有『多少次算常用』这个概念
//      我要的是线性衰减权重和，线性通过使用次数增加衰减需要时间
//      用的多的自然就在头部是常用的了，而不是设置个次数门」
//
//   【Assistant之前错在哪】一直在设门槛：
//     · imp >= 0.8 才补偿  ← 门槛
//     · hits >= 100 算常用 ← 门槛
//     · log1p 边际递减 + MAX_HL 封顶 ← 双重拐点
//   User从来没要这些。要的是**连续、无拐点**：
//
//     lifespan = BASE + hits × PER_HIT     ← 每用一次，寿命线性 +PER_HIT 天
//     recency  = 1 - age / lifespan        ← 线性衰减（不是指数）
//     age      = 距「最后一次被想起」的天数（没 lastHitAt 就用 createdAt）
//
//   【为什么线性比指数好】
//     ① 没有"多少次算常用"的门：999 次和 1000 次之间不会突变
//     ② 用的多的自然寿命长 ⇒ 自然在头部，不需要额外加权
//     ③ 边际贡献恒定：第 1000 次使用和第 1 次一样值 PER_HIT 天
//        （指数 log1p 是边际递减，第 1000 次几乎没贡献，违背"真实记忆越用越难忘"）
//
//   【不需要封顶】线性模型下限是 1-BASE/lifespan，寿命越长趋近 1 但不会失控；
//     且 age 会继续长，超过 lifespan 后归 0（自然死亡）。
export const LIN = {
  BASE: 30,      // 🔶 初始寿命（新卡/没被用过）30 天
  PER_HIT: 1,    // 🔶 每多一次使用，寿命 +1 天
};

// 旧的指数路参数（dynamicHL 开关用）——User已定改走线性，
// 但保留这套以便回滚/对照，不与 LIN 混用。
export const DYN_HL = {
  GROWTH: 0.8,
  MAX_HL: 180,
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
export function halfLifeOf(card, opts) {
  const imp = Number(card && card.importance);
  const value = Number.isFinite(imp) ? imp : 0.35;
  // 基石：红线，永不衰减（User：基石是记忆特权）
  if (card && card.is_axiom === true) return HALF_LIFE.axiom;
  // 分档基线
  let base;
  if (value >= 0.8) base = HALF_LIFE.quasiaxiom;
  else if (value >= 0.55) base = HALF_LIFE.important;
  else base = HALF_LIFE.volatile;
  // [2026-11-04 by Assistant · User原话：真实的记忆本来就是越用越多次越难忘记]
  //   旧行为（默认）：直接返回分档基线，hits 完全不参与 ⇒ 被想起 100 次和 1 次忘得一样快。
  //   开启 dynamicHL：半衰期随「被想起次数」增长，封顶 MAX_HL。
  //     HL = base × (1 + GROWTH × log1p(hits))，再 min(MAX_HL)
  //   为什么用 log1p 而不是线性：次数是长尾分布（P50=0，max=12918），
  //     线性会让 1 万次的卡半衰期几十万天 = 永久特权，违背「起点优势不是永久特权」。
  //   为什么乘法但封顶：乘法保证「同一起点下，用得越多越难忘」；
  //     封顶 MAX_HL 刹住极端值，防止复活成不死卡。
  const o = opts || {};
  if (o.dynamicHL !== true) return base;
  const hits = Math.max(0, Number(card && card.hits) || 0);
  const lastHit = Number(card && card.lastHitAt) || 0;

  // ── [2026-11-04 by Assistant · 总纲 3.3 最终公式 v2：老卡补偿 ──]
  //   User已定：initHalfLife = 90 天，是「起点优势，不是永久特权」。
  //   Sonnet 已否决「乘法」方案（倍率恒 3x = 永久特权 + 突破 MAX）。
  //   定稿走「首次命中后作废 init」：
  //     · 从没被用过（lastHitAt 空）⇒ init 或 BASE_HL_INIT(90)
  //     · 用过（lastHitAt 有值）   ⇒ init 作废，走纯动态
  //   为什么必须作废：否则 init 变成永久地板，
  //     正是 Sonnet 指出的「前 11~12 次命中半衰期一点都不涨」。
  //   ⚠️ [2026-11-04 by Assistant · 第二次修正：init 不该补半衰期，该补起点]
  //   第一版把 init 写成「半衰期地板」⇒ 实测是**空操作**：
  //     imp>=0.8 的卡 base 本来就 = quasiaxiom = 180 = MAX_HL
  //     ⇒ Math.max(180, 90) = 180，一点没变。
  //   真正的病是「起点」：老卡 createdAt 在 200 天前 ⇒ ageDays=200 ⇒ 早凉了。
  //   init 的本意是「假设这张老卡实际只老 90 天」⇒ 把起点推到 now-90d。
  //   ⇒ 补偿逻辑移到 decayAnchorOf()，见那里。
  //   （这里保留一个提示，防后人又在这里补半衰期）

  // [2026-11-04] 指数路（旧）保留可回滚：GROWTH/MAX 用独立常量，不与线性模型混用
  const grown = base * (1 + DYN_HL.GROWTH * Math.log1p(hits));
  return Math.min(grown, DYN_HL.MAX_HL);
}

// ══════════════════════════════════════════════════════════════════
// [2026-11-04 by Assistant · User原话：想起就回顶部，再继续往下降]
//
// 【User指出的真病根】
//   「gateBoost 这一系列的扩散权重导致新卡上不来旧卡下不去」
//   「扩散记忆选中回想到就拉到顶部然后继续往下降」
//
// 【代码实证：User说对了，而这是一个从来没实现的约定】
//   recencyOf  L77: const created = card.createdAt;  ← 按「出生」算
//   strengthOf L90: const created = card.createdAt;  ← 也按「出生」算
//   而卡上明明有 lastHitAt（实测 5,627 张 / 33.4% 有值）
//   ⇒ 代码**一次都没用它做衰减起点**
//   ⇒ 「被想起」不会重置年龄 ⇒ 老卡一旦老就永远老
//
// 【User当初定的设计（总纲 L234 原话）】
//   「如果被想起回到顶部再开始继续算下降衰减」
//   ⇒ 衰减起点应该是 max(lastHitAt, createdAt)
//
// 【开关】decayAnchorLastHit（默认 false = 与改前逐位相同）
//   走 config 透传，User批准后一行配置即可开启。
// ══════════════════════════════════════════════════════════════════

/**
 * 衰减起点：卡片的「年龄」从哪一刻开始算。
 *
 * 默认（useLastHit=false）⇒ createdAt（旧行为，逐位相同）
 * 开启（useLastHit=true）  ⇒ max(lastHitAt, createdAt)
 *
 * 为什么取 max 而不是直接用 lastHitAt：
 *   有些卡的 lastHitAt 可能早于 createdAt（历史数据脏），取 max 保证
 *   起点永远不早于出生时间，避免「负年龄」导致分数 > 1。
 *
 * @param {object} card
 * @param {boolean} useLastHit 是否按「最后一次被想起」重置
 * @returns {number} 起点时间戳（ms），0 = 无法确定
 */
// [2026-11-06 by Assistant · User指出「顶部堆几千卡不下降」的根因] 统一时间解析：
//   旧代码 Number(card.createdAt) 对 **ISO 字符串** createdAt 得 NaN→0 ⇒ 锚点空 ⇒ recencyOf 恒返回 1.0
//   ⇒ 新格式卡(createdAt 是 ISO 串，实测 2976/3249) 全部**永不衰减、永久堆顶**。这是真 bug。
//   这里按「数字直接用 / 纯数字串转数字 / 其它 Date.parse」解析，createdAt 与 lastHitAt 同口径。
function parseTsAny(v) {
  if (typeof v === 'number') return Number.isFinite(v) && v > 0 ? v : 0;
  const s = String(v === undefined || v === null ? '' : v).trim();
  if (!s) return 0;
  if (/^\d+$/.test(s)) { const n = Number(s); return n > 0 ? n : 0; }
  const t = Date.parse(s);
  return Number.isFinite(t) && t > 0 ? t : 0;
}

export function decayAnchorOf(card, useLastHit, opts) {
  const created = parseTsAny(card && card.createdAt);
  const lastHit = parseTsAny(card && card.lastHitAt);
  const o = opts || {};

  // ── [2026-11-04 by Assistant · 老卡补偿 initHalfLife=90（总纲 3.3 公式 v2）──]
  //   User已定：给老卡「起点优势 90 天」，不是永久特权。
  //   【为什么补起点而不是半衰期】第一版补半衰期实测是空操作：
  //     imp>=0.8 ⇒ base=180=MAX_HL ⇒ 补 90 完全没变化。
  //   真正的病在起点：老卡 createdAt 在 200 天前 ⇒ ageDays=200 ⇒ 早凉。
  //   init 的本意 = 「假设这张老卡实际只老 90 天」⇒ 起点推到 now-90d。
  //
  //   【生效条件（三个都满足）】
  //     ① 开关 initHalfLifeHL === true
  //     ② 从没被用过（lastHitAt 空）—— 用过就走 lastHitAt，无需补偿
  //     ③ 卡确实「老」（createdAt 早于 now-90d）—— 否则补偿无意义
  //   【为什么只给强卡】总纲六#3 已定：9,587 张 hits=0 的噪声卡若都给 90 天
  //     = 噪声集体镀金。门槛 imp >= 0.8（实测 903 张）。
  if (o.initHalfLifeHL === true && !lastHit) {
    const imp = Number(card && card.importance);
    const impValue = Number.isFinite(imp) ? imp : 0.35;
    if (impValue >= 0.8) {
      const initDays = Number(card && card.initHalfLife) || 90;
      const floor = Number(o.nowTs) ? Number(o.nowTs) - initDays * 86400000 : 0;
      // 起点 = max(createdAt, now-initDays)：只往前推，不往后拉
      return floor > 0 ? Math.max(created, floor) : created;
    }
  }

  if (!useLastHit) return created;
  if (!lastHit) return created;            // 没被想起过 ⇒ 按出生算（合理）
  return Math.max(created, lastHit);
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

export function recencyOf(card, nowTs, opts) {
  const o = opts || {};
  if (!Number.isFinite(halfLifeOf(card, {})) && card && card.is_axiom === true) return 1.0;

  // ── [2026-11-04 by Assistant · 线性衰减（开关 linearDecay，默认关）──]
  if (o.linearDecay === true) {
    // 基石：红线，恒 1.0
    if (card && card.is_axiom === true) return 1.0;
    const hits = Math.max(0, Number(card && card.hits) || 0);
    // 起点：最后一次被想起（没有就出生）—— User要的「想起回顶部」
    const anchor = decayAnchorOf(card, true, { nowTs });
    if (!anchor) return 1.0;
    const ageDays = Math.max(0, (dayFloor(nowTs) - anchor) / 86400000);
    // 寿命：BASE + hits × PER_HIT（线性，无门槛、无封顶）
    const lifespan = (Number(o.linBase) || LIN.BASE) + hits * (Number(o.linPerHit) || LIN.PER_HIT);
    if (lifespan <= 0) return 0;
    // 线性衰减：到寿命终点归 0
    return Math.max(0, Math.min(1, 1 - ageDays / lifespan));
  }

  // ── 旧路径（指数 + 分档）：默认，与改前逐位相同 ──
  const hl = halfLifeOf(card, o);
  if (!Number.isFinite(hl)) return 1.0;
  const anchor = decayAnchorOf(card, o.decayAnchorLastHit === true, { initHalfLifeHL: o.initHalfLifeHL === true, nowTs });
  if (!anchor) return 1.0;
  const ageDays = Math.max(0, (dayFloor(nowTs) - anchor) / 86400000);
  return Math.pow(0.5, ageDays / hl);
}

/** 强度：log1p 归一化到 [0,1]，非基石再随久未使用缓慢回落 */
export function strengthOf(card, nowTs, opts) {
  const hits = Math.max(0, Number(card && card.hits) || 0);
  const raw = Math.log1p(Math.min(hits, MAX_HITS)) / Math.log1p(MAX_HITS);
  if (card && card.is_axiom === true) return raw;
  const o = opts || {};
  // ── [2026-11-04 by Assistant · strengthOf 也走线性（与 recencyOf 同口径）──]
  //   为什么必须一起改：如果 recency 线性、strength 还指数，两套衰减会打架，
  //   强度那一维会在 recency 已经归零时还有残余，导致"该死透的卡还留一点分"。
  if (o.linearDecay === true) {
    const anchorL = decayAnchorOf(card, true, { nowTs });
    if (!anchorL) return raw;
    const ageL = Math.max(0, (dayFloor(nowTs) - anchorL) / 86400000);
    const lifeL = (Number(o.linBase) || LIN.BASE) + hits * (Number(o.linPerHit) || LIN.PER_HIT);
    if (lifeL <= 0) return 0;
    return raw * Math.max(0, Math.min(1, 1 - ageL / lifeL));
  }
  const hl = halfLifeOf(card, o);   // [2026-11-04] 同上，半衰期随 hits 增长
  if (!Number.isFinite(hl)) return raw;
  // [2026-11-04] 衰减起点默认 createdAt，开启后按最后一次被想起
  const anchor = decayAnchorOf(card, o.decayAnchorLastHit === true, { initHalfLifeHL: o.initHalfLifeHL === true, nowTs });
  if (!anchor) return raw;
  const ageDays = Math.max(0, (dayFloor(nowTs) - anchor) / 86400000);
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
export function applyFourForces(card, baseRelevance, nowTs, opts) {
  // [2026-11-04 by Assistant] opts.decayAnchorLastHit 透传给 recencyOf / strengthOf
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
  const rec = recencyOf(card, nowTs, opts);
  const str = strengthOf(card, nowTs, opts);
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
  // ══════════════════════════════════════════════════════════════════
  // [2026-11-04 by Assistant · User定：「精确关键词命中就完全豁免衰减惩罚」]
  //
  // User原话：
  //   「只要是精确关键词命中，就完全豁免衰减惩罚
  //    比如我去年和你干了 xx 事 你还记得吗」
  //
  // 【为什么必须加】没这条时，衰减到底的卡乘数只剩 0.35：
  //   一张 100 天没用的卡被 BM25 完美命中（R=1.0）⇒ 1.0 × 0.35 = 0.35
  //   而一张新鲜但只有 0.5 相关的卡 ⇒ 0.5 × 1.0 = 0.50
  //   ⇒ **冷门的完美匹配会输给新鲜的不相关卡** ⇒ User说的"关键词拉起"失效。
  //
  // 【判据：什么算"精确关键词命中"】
  //   由调用方通过 opts.exactHit 传入布尔值（retriever 侧判定 BM25 top 命中）。
  //   本函数只负责"豁免"，不自己猜关键词——避免又造一套模糊判据。
  //
  // 【豁免范围】只豁免**时间衰减**（recLack / penaltyFlux），
  //   不豁免重要度惩罚（impLack）——「久未使用」不该罚，"本来就不重要"仍该罚。
  // ══════════════════════════════════════════════════════════════════
  // [2026-11-04] 豁免的两条腿：关键词精确命中（exactHit）或 时间标签命中（timeHit）
  //   User：「有时间标签和事件类型标签…就是为了长时间遗忘的卡被精确命中重新拉顶」
  const exemptAllowed = !(opts && opts.exactHitExempt === false);
  const exactHitExempt = exemptAllowed && ((opts && opts.exactHit === true) || (opts && opts.timeHit === true));
  let penaltyFinal = penalty;
  if (exactHitExempt) {
    // 只清掉 recency 那部分惩罚，保留 impLack 部分
    const impPenalty = Math.min(0.65, 0.25 * impLack);
    penaltyFinal = impPenalty;
  }
  const penaltyAfterStrength = penaltyFinal * (1 - 0.6 * str);
  const multiplier = Math.max(0.35, Math.min(1.0, 1 - penaltyAfterStrength));

  return {
    score: safeR * multiplier,
    gated: true,
    parts: {
      R: safeR, I: imp, Rec: rec, Str: str,
      mult: Number(multiplier.toFixed(4)),
      exactExempt: exactHitExempt === true,   // [2026-11-04] 便于自检/排查
      exemptVia: exactHitExempt ? ((opts && opts.exactHit === true) ? 'keyword' : 'time') : null,
    },
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

  // [2026-11-04] 查询问的是哪一类事（titleType 软加权用；判断不出 = null = 不加成）
  const queryType = o.titleTypeBoost === false ? null : inferQueryTitleType(o.query);

  const items = [];
  for (const raw of (list || [])) {
    const id = isPair ? String(raw[0]) : String(raw && raw.id);
    const score = rawScore(raw);
    const card = cardsById && cardsById.get ? (cardsById.get(id) || cardsById.get(id.replace(/^(tdai|pm|pmi):/, ''))) : null;
    // ── [2026-11-04 by Assistant · User定：「精确关键词命中就完全豁免衰减惩罚」] ──
    //   判据（两条同时满足才算精确命中）：
    //     ① 这张卡与 Top1 的相关度几乎并列（>= maxR × REL_EXACT，默认 0.95）
    //        ⇒ 说明它就是「最贴题的那一批」
    //     ② 调用方传了 query 且卡片标题/正文里出现了**查询的实词**（长度>=2 的中文串）
    //        ⇒ 这是"关键词命中"而不是"语义沾边"
    //   为什么不用「BM25 排第一」当判据：融合后的分里还混了向量/graph，
    //     排第一不代表关键词精确命中（向量也可能把不相关的顶上来）。
    const relToTop = maxR > 0 ? score / maxR : 0;
    // ── [2026-11-04 二次修正：时间单独成立必须有更严的相关度门槛] ──
    //   实测漏洞：「去年」这个词对所有去年的卡都成立，
    //   若时间单独就给豁免 ⇒ 「只要问去年，去年所有卡都免疫衰减」= 免疫化。
    //   修正：
    //     ① 关键词命中 ⇒ 相关度 >= 95% Top1 即可豁免（关键词是真信号）
    //     ② 只有时间命中 ⇒ 相关度必须 >= 99% Top1（几乎并列第一才认）
    //        理由：时间只说明"是那段时间的"，不说明"是这件事"，
    //              必须靠相关度补上"就是这件事"的证据。
    const kwHit = isExactKeywordHit(card, o.query) && relToTop >= REL_EXACT_FOR_EXEMPT;
    const tmHit = isTimeMatchedHit(card, o.timeWindow, nowTs) && relToTop >= REL_TIME_ONLY_FOR_EXEMPT;
    const callOpts = (kwHit || tmHit)
      ? Object.assign({}, o, { exactHit: kwHit, timeHit: tmHit })
      : o;
    let out;
    if (score < relFloor) {
      out = { score, gated: false, parts: { R: score, I: 0, Rec: 0, Str: 0, mult: 1 } };
    } else {
      out = applyFourForces(card || {}, score, nowTs, callOpts);
    }
    const bucket = Math.floor(score / width);
    // ── [2026-11-04 by Assistant · titleType 软加权（只在档内 tie-break）] ──
    //   User要的事件类型标签：查「怎么做的」优先 process 类；查「为什么挂了」优先 incident 类。
    //   加成幅度小（<=8%），且**只影响同档内顺序**，不跨档 ⇒ 不会把最贴题的卡挤下去。
    //   没有 titleType 的老卡（99.6%）加成 1.0，等于不参与，零歧视。
    let typeBoost = 1;
    if (queryType && card && card.titleType) {
      if (String(card.titleType) === queryType) typeBoost = 1.08;
    }
    items.push({
      raw,
      bucket,                     // 档：越大越靠前（=相关度越高）
      score: out.score * typeBoost,   // 档内排序用（四股力微调 × 类型加成）
      rel: score,
      parts: Object.assign({}, out.parts, { typeBoost: typeBoost === 1 ? undefined : typeBoost }),
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
