/**
 * rrf.js —— 三种融合算子，语义各不同，别混用。
 * 依据：DESIGN §1.3 / §3.1 验收 A4。
 *
 * ⚠️ 用途限制（DESIGN §0.3 ③）：
 *   · rrfFuse    —— 只在**同一 Stage 内的多路证据**之间用（BM25 路 + 向量路）。
 *                    **禁止**用于 Stage1 与 Stage3 之间（实测那样 Hit@10 从 98% 掉到 77%）。
 *   · weightedFuse —— 跨 Stage 的**唯一**合法融合（Stage1 永远是主体）。
 */

import { ADAPTIVE_K, STAGE_GUARD } from './types.js';

/**
 * ① 标准 RRF（论文公式，一字不改）：RRF(d) = Σ_m 1 / (k + rank_m(d))
 * rank 从 1 起（不是 0）。
 *
 * @param {Array<Array<string>>} rankLists
 * @param {{k?:number}} [opts]
 * @returns {Array<[string, number]>}
 */
export function rrfFuse(rankLists, opts) {
  const k = opts && opts.k !== undefined ? opts.k : 60;
  const score = new Map();
  for (const list of (rankLists || [])) {
    if (!Array.isArray(list)) continue;
    for (let i = 0; i < list.length; i++) {
      const id = list[i];
      score.set(id, (score.get(id) || 0) + 1 / (k + i + 1));
    }
  }
  return Array.from(score.entries()).sort(function (a, b) { return b[1] - a[1]; });
}

/**
 * ② 跨 Stage 加权融合（本设计的主力）：
 *   score(d) = base(d) + wEpisode*episodeBonus + wEdge*edgeWeight + wAlias*aliasBonus
 *
 * @param {Array<[string, number]>} base  Stage1 归一化后的分数
 * @param {Array<{kind:'episode'|'edge'|'alias', items:Array<[string,number]>}>} bonuses
 * @param {{wEpisode?:number, wEdge?:number, wAlias?:number, wVector?:number, wGraph?:number}} [opts]
 * @returns {Array<[string, number, Record<string, number>]>}
 */
import { gateBoost } from '../ingest/concentrate.js';

/**
 * [2026-10-23 by Assistant · 红白双队：记忆动力学 权重引擎]
 *   相关性门控下的浓度加权 —— 让"被强调过 N 次"的事在相关话题里排得更前，
 *   但**绝不允许**它在无关话题里霸榜（红队拆解的"万能钉子户"灾难）。
 *   默认关闭（concentrationBoostEnabled=false），关闭时逐位等同现状。
 */
export function weightedFuse(base, bonuses, opts) {
  const wEpisode = opts && opts.wEpisode !== undefined ? opts.wEpisode : STAGE_GUARD.wEpisode;
  const wEdge = opts && opts.wEdge !== undefined ? opts.wEdge : STAGE_GUARD.wEdge;
  const wAlias = opts && opts.wAlias !== undefined ? opts.wAlias : STAGE_GUARD.wAlias;
  const wVector = opts && opts.wVector !== undefined ? opts.wVector : 0;
  // [2026-10-23 by Assistant · 期8.3] 图扩散权重。**默认 0 = 关闭 = 与接入前逐位相同**。
  const wGraph = opts && opts.wGraph !== undefined ? opts.wGraph : 0;
  // ── [2026-10-23 · 期8.4 红队裁决二：Score-Gated RRF] ──
  //   红队的数学账：图通道 rank1 在 RRF 里只值 0.0082，BM25 rank25 值 0.0118
  //   ⇒ 全局拉高 wGraph 既救不回真目标，又会挤掉 BM25 的高精准卡。
  //   解法：按图分数**分档加权**
  //     · graphScore >= gate（默认 0.15；实测真救回落 0.150~0.400）
  //       ⇒ 稀有实体强共振，给 wGraphHigh（默认 1.0 = 中性，不带额外加成）
  //     · graphScore <  gate ⇒ 泛化边噪声，只给 wGraphLow（0.3），
  //       且仅当该卡已在 BM25 base 里才计入（不许单独鸠占鹊巢）
  // ── [2026-11-04 by Assistant · 总纲五·甲：wGraphHigh 1.2 → 1.0] ──
  //   【User指出的矛盾】1.2 是在【融合阶段】直接提分
  //     ⇒ 等于「还没读就给它加权限」❌
  //   【User要的】扩散只把卡带进【候选】，只有真被读进回复才 hits+1
  //   【为什么是 1.0 不是 0.3】1.0 = 中性权重，扩散进来的卡「插到队里但不加分」；
  //     0.3 会让它比原生的还弱，等于变相惩罚 —— 那也不符合「带进候选」的语义。
  //     真正的「加权限」现在由采纳核验（adoption）在做，与这里解耦（见 11-04 #5 改动）。
  //   【零风险说明】wGraph 整体默认 0（图扩散关着），这个值只在
  //     graphExpandEnabled===true 时才被用到 ⇒ 当前生产行为一个字节都不变。
  const wGraphHigh = opts && opts.wGraphHigh !== undefined ? Number(opts.wGraphHigh) : 1.0;
  const wGraphLow = opts && opts.wGraphLow !== undefined ? Number(opts.wGraphLow) : 0.3;
  const graphGate = opts && opts.graphGate !== undefined ? Number(opts.graphGate) : 0.15;
  const W = { episode: wEpisode, edge: wEdge, alias: wAlias, vector: wVector, graph: wGraph };

  const total = new Map();
  const parts = new Map();

  function bump(id, key, v) {
    // [2026-10-23 by Assistant · 期8.3] 加 graph 一路。
    //   注意：这里给**所有**条目都补上一个 graph:0 字段（原来没有）。
    //   这是**必要的**——scoreParts 原本只有 4 个键，扩散关掉时新增的第 5 个键若时有时无，
    //   下游 JSON.stringify 的字段集合就会分叉。补 0 保证字段集合恒定。
    if (!total.has(id)) { total.set(id, 0); parts.set(id, { bm25: 0, episode: 0, boost: 0, alias: 0, vector: 0, graph: 0 }); }
    total.set(id, total.get(id) + v);
    parts.get(id)[key] += v;
  }

  for (const pair of (base || [])) {
    if (!pair) continue;
    bump(pair[0], 'bm25', pair[1]);
  }
  for (const b of (bonuses || [])) {
    if (!b || !Array.isArray(b.items)) continue;
    const w = W[b.kind] !== undefined ? W[b.kind] : 0;
    if (w === 0) continue;
    // [2026-10-22 by Assistant] vector 单独一路 —— 原来「其余一律归 episode」会把向量分
    //   混进 Episode 分，既污染 stage2 的可观测性，也让 weight/scoreParts 无法区分来源。
    const key = b.kind === 'edge' ? 'boost' : b.kind === 'alias' ? 'alias'
      : b.kind === 'vector' ? 'vector'
      : b.kind === 'graph' ? 'graph'     // [2026-10-23 · 期8.3] 图扩散单独一路，不混进 boost
      : 'episode';
    for (const item of b.items) {
      if (!item) continue;
      // [2026-10-23 · Score-Gated RRF] 图路按分数分档，其余路照旧
      if (b.kind === 'graph') {
        const gs = Number(item[1]) || 0;
        if (gs >= graphGate) {
          bump(item[0], key, wGraphHigh * gs);
        } else {
          const inBase = base.some(function (pr) { return pr && String(pr[0]) === String(item[0]); });
          if (inBase) bump(item[0], key, wGraphLow * gs);
        }
        continue;
      }
      // ── [2026-11-05 by Assistant · E8 方案 A 已删除 · sonnet §11 回炉裁定] ──
      //   【曾加过的东西】edge 路 inBase 守卫（edgeInBaseGuard 开关，默认 false）。
      //   【为什么删掉】三次独立验证全是 no-op：
      //     · v1(130) 97/130 → 97/130
      //     · v2(100) 70/100 → 70/100
      //     · sonnet 自己复现 62/100 → 62/100
      //   唯一真实副作用：把返回条数从 151 砍到 100 = **削减召回**。
      //   在一个 34% gold 进不了返回列表的系统里，这是反方向改动。
      //   【真根因不是准入】实测 top10 里 em* 340 个槽位**全部在 base 内**，
      //     纯 edge 带进来的 = 0 ⇒ 准入这条路在 top10 上从来没起作用。
      //   【教训】留一个「默认关闭、永不打开」的开关 = 零接线的又一例。
      bump(item[0], key, w * item[1]);
    }
  }

  const out = [];
  for (const pair of total) out.push([pair[0], pair[1], parts.get(pair[0])]);

  // [2026-10-23 · 红白双队：相关性门控浓度加权]
  //   默认关闭。开启时：base 分过 gate 才释放 hits 杠杆，否则原样。
  const concOn = opts && opts.concentrationBoostEnabled === true;
  if (concOn) {
    const cards = (opts && opts.cardsById) || null;
    const gate = opts && opts.concentrationGate !== undefined ? Number(opts.concentrationGate) : 0.35;
    const alpha = opts && opts.concentrationAlpha !== undefined ? Number(opts.concentrationAlpha) : 0.15;
    for (const row of out) {
      const card = cards && cards.get ? cards.get(row[0]) : null;
      if (!card) continue;
      row[1] = gateBoost(row[1], card, { gate, alpha });
    }
  }

  out.sort(function (a, b) { return b[1] - a[1]; });
  return out;
}

/**
 * [2026-10-22 by Assistant] 时间方向判定：把「最早/最久」与「前两天/最近」分开。
 * 返回 'earliest' | 'latest' | null。
 * 这是 temporal 检索能真正生效的关键——光识别成 temporal 还不够，得知道往哪头排。
 */
export function classifyTemporal(query) {
  const s = String(query || '');
  if (!s) return null;
  // 最早的
  if (/(最早|最久|最初|第一次|初次|一开始|最开头|首个|头一回|第一次做|老早|很久以前|从前的)/.test(s)) return 'earliest';
  // 最近的
  //
  // [2026-10-27 by Assistant · 顺带修掉的真 bug]
  //   原词表含裸「今天」「今儿」⇒「今天天气怎么样」「今天吃什么」「今天几号」
  //   全被判成时间意图，然后拿一堆"最近的记忆卡"去回答天气问题（实测 19 条无关卡）。
  //   修法：「今天/今儿」必须**跟在"我们/我/Assistant"或动作词之后**才算时间意图
  //   （"我们今天干了什么" ✓ / "今天天气怎么样" ✗）。
  //   其余绝对时间词（昨天/前天/刚才/最近…）保持原样——它们本身就有回溯语义。
  if (/(最近|最新|这两天|前两天|前几天|昨天|前天|刚才|刚刚|这几日|这段时间|近期)/.test(s)) return 'latest';
  if (/(今天|今儿|今日)/.test(s) && /(我们|咱们|咱|我|Assistant).{0,6}(做|干|搞|弄|聊|说|到哪|什么|咋样|怎么样)/.test(s)) return 'latest';
  if (/(今天|今儿|今日).{0,8}(做|干|搞|弄|聊|说)了什么/.test(s)) return 'latest';
  // [2026-10-22 by Assistant · 补] 无方向的时间词：「什么时候做的 X」「哪天开始」问的是**起点**，
  //   默认按最早排；否则这类最常见的问法会完全不走时间维度（实测 temporal=null）。
  if (/(什么时候|哪天|哪年|多久以前|几时|啥时候)/.test(s)) return 'earliest';
  // 指向过去的模糊说法 → 按最近优先（用户通常想听「上次那事」）
  if (/(上次|上回|上周|上个月|去年)/.test(s)) return 'latest';
  // ── [2026-11-03 by Assistant · 时间检索 v2 · 总纲 §2.7] ──
  //   病灶（实测 7/7 全误判）：
  //     「还记得我们之前一起聊的XX吗」→ latest
  //     「之前那个模型怎么配」        → latest
  //     「以前我们聊过什么」          → latest
  //     「当时那个方案」              → latest
  //   这些都是【口语填充】，不是时间意图。判成 latest 后会注入近7天80张卡（0.5分），
  //   把真正的字面命中挤掉 —— 用户问「XX那件事」，拿到「最近发生的事」，答非所问。
  //
  //   收紧判据：裸「以前/之前/当时/那时候」不算时间意图，
  //             必须配 (a) 时间单位 或 (b) 事件指代 才判 latest。
  // ── [2026-11-04 by Assistant · 撤回上一版的错误改动] ──
  //   Assistant曾想放行「以前**我们**聊过什么」，因为觉得它像时间意图。
  //   但总纲 §2.7 的判据很明确：必须配「时间单位 / 事件指代 / 动词+名词」之一。
  //     「以前我们聊过什么」没有时间单位，也没有名词（"什么"是疑问代词）
  //     ⇒ 属于口语填充，**不该判 latest**（判了会注入近7天卡，与"以前"语义相反）
  //   verify 的 selftest-time-window B 组抓到了这个自相矛盾，Assistant撤销。
  if (/(以前|之前|当时|那时候)/.test(s)) {
    // (a) 带时间单位：「之前那一周」「以前那几天」「当时那个月」
    const _hasUnit = /(以前|之前|当时|那时候).{0,6}(几天|几周|几个月|那年|那月|那天|这周|那阵|一周|一个月|一年|半个月)/.test(s);
    // (b) 带「那次发生的事」指代：「之前说的方案」「当时定的规则」「之前聊过」
    //   ⚠️ 实测踩坑：早期版本写了 `那个(?!月|天|年|周)`，导致
    //      「之前那个模型怎么配」「当时那个方案」全被判 latest —— 因为它们都含「那个」
    //      但这是【指物】不是【指时间】，两者必须分开。
    //   ⇒ 只认「说/聊/做/干/弄/定/用/提/讲」这类**发生过**的动词，以及「那次/那回/那件事」。
    const _hasReferent = /(以前|之前|当时|那时候)(说|聊|做|干|弄|定|用|提|讲|那件事|那次|那回)/.test(s);
    if (_hasUnit || _hasReferent) return 'latest';
    // 否则当口语填充 ⇒ 不判时间，继续往下走（可能被后续规则判 earliest 或 null）
  }
  // ── [2026-10-24 by Assistant · Round 18] 「指代当下」的问法 ──
  //   实测：「我们刚才在做什么」「继续」「接着刚才的」这类**没有一个字能搜索**，
  //   字面 BM25 抓到的是恰好含"继续"二字的卡，而不是最近发生的事。
  //   这类查询的语义就是「按时间倒序取最近的」——必须走时间维度。
  //   用词要严，别把「为什么要重启」这种误判成时间查询。
  if (/(我们|咱俩|咱|我)(刚才|刚刚)?(在)?(做|干|弄|聊|说|搞)(什么|啥|到哪)/.test(s)) return 'latest';
  if (/^(继续|接着|然后呢|后来呢|说下去|接着聊|接着干|接下来呢)[吧啊呀的了。！？!?\s]*$/i.test(s)) return 'latest';
  if (/(上次|上一?个?会话|上次那|刚才那|上一轮)(聊|说|做|干|弄|到哪|什么|啥)/.test(s)) return 'latest';

  // ══════════════════════════════════════════════════════════════════
  // [2026-10-27 by Assistant · 封箱第 1 点：方位/顺序指代 + 进度复盘追问]
  //
  // 病灶（实测）：User说「Assistant想想前面干了什么」——
  //   classifyTemporal 返回 null ⇒ 不走时间种子 ⇒ 字面 BM25 只捞到
  //   「⇒ `www」「记忆卡召回率低」这类 stage3 噪音（20/24 是 stage3）。
  //   实测对照：强制 temporal=latest 后，Top1 变成「l0Rounds增加 / verify全绿 /
  //   L0会话目录断链」——正是当天真干的事。
  //
  // 扩充原则（保守）：
  //   ① 只收**明确指向过去 + 无独立实词主题**的口语词；
  //   ② 不碰「为什么重启了」「记忆系统改造」这类有实词的正常查询（实测均返回 null，
  //      扩充前后一致）；
  //   ③ 「干了什么/做了什么」这类**必须**带时间前缀才算时间意图 ——
  //      单独出现时可能是「这个功能是做什么的」这种非时间问法，不能一刀切。
  // ══════════════════════════════════════════════════════════════════

  // ① 方位/顺序指代（明确指向过去）
  if (/(前面|前头|早先|方才|上一轮|上一步|上一句)/.test(s)) return 'latest';

  // ② 进度/复盘追问（这些词**本身就是**问进度，自带时间语义）
  if (/(捋一捋|复盘|前情提要|进展|干到哪|说到哪|聊到哪|搞到哪|做到哪)/.test(s)) return 'latest';

  // ③ 「做了/干了 什么」组合：必须同时含「我们/咱/Assistant」这类指代主语
  //    （防误伤「这个功能是做什么的」）
  if (/(我们|咱们|咱|Assistant)(前面|刚才|刚刚|之前)?(都)?(做了|干了|搞了|弄了|聊了)什么/.test(s)) return 'latest';

  return null;
}

/** 归一化：除以最大值（只为让 bonus 权重可比较，不做 0..1 截断；DESIGN §1.2 纪律 2） */
export function normalizeScores(list) {
  if (!list || !list.length) return [];
  let max = 0;
  for (const p of list) if (p[1] > max) max = p[1];
  if (max <= 0) return list.map(function (p) { return [p[0], 0]; });
  return list.map(function (p) { return [p[0], p[1] / max]; });
}

/**
 * ③ 自适应 k（规划三档 + 两条护栏 G1/G2）
 *
 * @param {'factual'|'temporal'|'reasoning'|'alias-only'} kind
 * @param {{minEpisode?:number, tokenBudget?:number, avgTokensPerCard?:number}} [opts]
 */
/**
 * [2026-11-06 by Assistant · User定的分组阶梯] 第 page 组该给多少条。
 * 阶梯 30 → 20 → 10，超过 3 组后稳定在 10（不给 0，也不给暴涨）。
 * @param {number} page 1-based
 * @returns {number}
 */
export function pageSizeFor(page) {
  const steps = (STAGE_GUARD.pageSteps && STAGE_GUARD.pageSteps.length)
    ? STAGE_GUARD.pageSteps : [30, 20, 10];
  const p = Math.max(1, Math.floor(Number(page) || 1));
  return p <= steps.length ? steps[p - 1] : steps[steps.length - 1];
}

export function resolveAdaptiveK(kind, opts) {
  const base = ADAPTIVE_K[kind] || ADAPTIVE_K.factual;
  const minEpisode = Math.max(
    STAGE_GUARD.minEpisodeK,
    (opts && opts.minEpisode !== undefined ? opts.minEpisode : 0)
  );
  let episode = Math.max(base.episode, minEpisode);
  let fact = base.fact;

  // ══ [2026-11-06 by Assistant · User定的「给门」规则] ══
  //   默认档位不变（factual 24 / temporal 30 / reasoning 35 / enumerate 60）；
  //   但**强命令**（调用方显式要 N 条）可以把档位抬上去，只受 maxFactK 硬上限保护。
  //   为什么要有这道门：实测 bench 变更题金标链最长 60 行，而调用方按任务需求传 k=60，
  //   旧实现直接无视 ⇒ 无论传多少都只给 30 条 ⇒ 长链必然答不全（chain 0.263）。
  const req = Number(opts && opts.requestedK);
  if (Number.isFinite(req) && req > fact) {
    const cap = Number(opts && opts.maxK) > 0 ? Number(opts.maxK) : (STAGE_GUARD.maxFactK || 120);
    fact = Math.min(Math.floor(req), cap);
    // 强命令同时把 episode 适度抬高（链类查询要跨更多 episode 才拼得全）
    episode = Math.max(episode, Math.min(Math.ceil(fact * 1.2), 64));
  }

  const budget = opts && opts.tokenBudget;
  if (budget !== undefined && budget !== null && budget > 0) {
    const avg = (opts && opts.avgTokensPerCard) || STAGE_GUARD.avgTokensPerCard;
    const cap = Math.max(1, Math.floor(budget / avg));
    fact = Math.min(fact, cap);
  }
  return { topic: base.topic, episode, fact };
}

// [2026-10-22 by Assistant] 补全时间词表：原表漏了「最早/前两天/最近」这类高频说法，
//   导致「最早的项目甲」「前两天我们干什么」被判成 factual，时间维度根本没激活。
const TEMPORAL_RE = /(上次|上回|上周|上个月|去年|昨天|前天|刚才|以前|之前|当时|什么时候|哪天|多久|几天前|那时候|哪个时候|最早|最久|最初|第一次|初次|一开始|最开头|首个|最近|最新|前两天|前几天|这几日|这段时间|time|when)/i;
// [2026-11-06 by Assistant · User「给门」] 枚举意图：要的是**完整集合**，不是最相关几条 ⇒ 升档
//   判据要严：必须出现明确的「列全」信号（列出/所有/每一次/哪些变更/从最初…），
//   不能因为出现「变更」就放行（否则「变更窗口是什么时候」也会被抬到 60 条）。
const ENUMERATE_RE = /(列出|列举|一条条|逐条|按序号|顺序列出|所有(的)?(变更|记录|事件|值)|全部(的)?(变更|记录|事件)|每一次|每次变更|哪些变更|经历过(哪些|什么)变更|从最初到现在|从头到尾|完整(的)?(链|记录|列表|变更))/i;
const REASONING_RE = /(为什么|为何|怎么会|原因|怎么会|导致|是因为|怎么才能|怎么办|意味着|影响|区别|对比|取舍|why|how come)/i;

/** 题型判定（规则法，零模型；判不准退回 factual） */
export function classifyQuery(query) {
  const q = String(query || '');
  if (!q.trim()) return 'factual';
  // 枚举意图优先于 temporal：『从最初到现在经历过哪些变更』同时命中时间词，
  // 但它要的是全链而不是"最早那条"，必须走 enumerate 档。
  if (ENUMERATE_RE.test(q)) return 'enumerate';
  if (REASONING_RE.test(q)) return 'reasoning';
  if (TEMPORAL_RE.test(q)) return 'temporal';
  return 'factual';
}

export default { rrfFuse, weightedFuse, normalizeScores, resolveAdaptiveK, classifyQuery, classifyTemporal };
