/**
 * types.js —— 期3 检索的常量与运行期断言。零 IO，零依赖。
 * 依据：_team-v2/p3/DESIGN.md §1.1 / §1.3 / §1.4 / §0.6 / PREREQ-MEASURED.md
 */

/** 字段权重：硬约束 3 —— title 只有 P50=9 / max=12 字，summary/content 远大于 title */
/**
 * [2026-10-21 by Assistant · 消融实测后上调] title: 0.4 → 2.0
 *
 * 原值 0.4 的依据是「title 只有 P50=9 / max=12 字」——从长度推信息量，属无效推论
 * （红队 2026-10-21 已指出）。实测证明它不只无效，而且有害：
 *
 *   130 条 title 派生查询集上的 Recall@10：
 *     title 0.4（原值） → 72.31%
 *     title 1.0         → 83.08%
 *     title 2.0（现值） → 86.15%   ← 过红队 H2 的 80% 线且留余量
 *     title 3.0         → 90.00%   ← 但这是在 title 派生集上扫出的最大值，过拟合风险高
 *
 * 取 2.0 不取 3.0：3.0 是「在同一套查询集上调出来的最优」，属过拟合；
 * 2.0 已过线且保守。真实查询日志到位后应重新校准（见附 5 待决问题）。
 */
export const FIELD_WEIGHT = Object.freeze({ title: 2.0, summary: 1.0, content: 1.0 });

/** 自适应 k：规划三档原文（DESIGN §1.3）；episode 会被 G1 护栏抬到 >= 20 */
export const ADAPTIVE_K = Object.freeze({
  factual: Object.freeze({ topic: 8, episode: 16, fact: 24 }),
  temporal: Object.freeze({ topic: 10, episode: 20, fact: 30 }),
  reasoning: Object.freeze({ topic: 12, episode: 25, fact: 35 }),
  'alias-only': Object.freeze({ topic: 6, episode: 8, fact: 12 }),
});

/** 阶段护栏（DESIGN §1.5 G1 / §0.4 实测推出来的，不是拍的） */
export const STAGE_GUARD = Object.freeze({
  /** kE 下限：实测 kE=10 掉 11pp，kE=20 才回到 97% —— 配置传小也不生效 */
  minEpisodeK: 20,
  /** Stage1 卡级候选池（论文 initial_candidates = 100） */
  candidatePool: 100,
  /** Stage3 候选上限 */
  maxCandidates: 400,
  /** 融合权重：实测 wEdge 0.2/0.3 均为 100% */
  wEdge: 0.2,
  wAlias: 0.15,
  wEpisode: 0.0,
  /**
   * [2026-10-22 by Assistant · 向量路] 向量召回的融合权重。
   * 0 = 关闭（没有 key / 没有索引时自动走这里，退回纯 BM25）。
   * 注意：向量 cosine ∈ [0,1]，BM25 原始分可能到几百 ⇒ 调用侧会先按
   * 「BM25 池内最大分 × vectorScale」缩放，本条只控制相对强度。
   */
  wVector: 0.9,
  /** 扩展邻居上限：实测 1 步平均新增 4.59~45 张，不截断会撑爆 L0 */
  maxNeighbors: 24,
  /** 剪枝阈值（红队 H5 的接口，本图不触发但保留） */
  minActivation: 0.01,
  /** token 估算用（p4 实测注入级均值） */
  avgTokensPerCard: 30.9,
});

/** alias 熔断规则（DESIGN §1.4 规则表） */
export const ALIAS_RULES = Object.freeze({
  /** A · 多词熔断：>=2 个不同词命中 => confident。实测误触发 15/30 -> 2/30 */
  minDistinctHits: 2,
  /** B · 领域词豁免：纯拉丁/数字标识符，单词即必中。实测误触发 0/30 */
  domainBypass: true,
  /** 词长下限 */
  minChars: 2,
  /** df 上限：超过视为 stop term，不参与必中 */
  maxDf: 80,
  /** 返回候选上限 */
  maxResults: 10,
});

/** alias 语法停用表（只服务 alias 通道；BM25 不需要，IDF 已压制高频词） */
export const STOPWORDS = Object.freeze(new Set([
  '今天', '明天', '昨天', '现在', '刚才', '一会', '几点', '多少', '哪里', '哪个',
  '什么', '怎么', '为什么', '是不是', '这个', '那个', '这些', '那些', '这样', '那样',
  '这里', '那里', '一下', '一点', '一起', '一样', '时候', '可以', '没有', '已经',
  '需要', '就是', '不是', '我们', '他们', '因为', '所以', '但是', '然后', '之前',
  '之后', '东西', '地方', '问题', '使用', '进行', '出现', '导致', '确认', '完成',
  '检查', '帮助', '喜欢', '觉得', '知道', '应该', '可能', '不能', '不要', '以后',
  '以前', '开始', '结束', '时间', '起来', '出来', '下来', '过来', '名字', '笑话',
  '电影', '天气', '好吃', '好看', '外面', '里面', '手机', '文件', '价格', '衣服',
  '颜色', '声音', '音量',
  // ── [2026-10-24 by Assistant · Round 17 口语填充词] ──
  //   实测：「显存到底多少G」被 alias 抽成关键词「到底」⇒ 召回一堆无关卡。
  //   User的问句里这类填充词极多，不滤掉就会把真关键词挤出去。
  '到底', '究竟', '大概', '大约', '差不多', '来着', '的话', '而已',
  '有没有', '能不能', '会不会', '要不要', '对不对', '好不好',
  '其实', '反正', '估计', '好像', '感觉', '似乎', '也许',
  '咋办', '咋整', '咋回事',
  // ── [2026-10-24 by Assistant · Round 32] 疑问/指代虚词 ──
  //   实测：「桌宠最早的立绘怎么做」被这些词占满 2 字块 ⇒ 真词「桌宠」只占 22%
  //   ⇒ 覆盖率不够 ⇒ 门控整批清空（明明库里有 164 张立绘相关卡）。
  //   这些词在**内容判据**里不该算"有信息量"。
  '最早', '最初', '首先', '刚刚', '马上', '原先', '原来', '本来',
  '怎么', '如何', '怎样', '什么样', '哪些', '哪个', '哪种',
  '做什么', '怎么做', '干什么', '为啥', '是什么',
  '最早', '早的', '出的', '做的', '用的', '有了',
]));

/** 降级档（对齐期1 orchestrator.DEGRADE_LEVELS，不另起一套） */
export const DEGRADE_LEVELS = Object.freeze(['full', 'no-episode', 'alias-only', 'fixed']);

/** 领域词判定：纯拉丁/数字/下划线/点/斜线的标识符（KVMem / bm25 / rc3 / v1.2.3） */
export function isDomainTerm(w) {
  return /^[a-z0-9][a-z0-9_.\-\/]*$/.test(String(w || '').toLowerCase()) && /[a-z0-9]/.test(w);
}

/** 运行期断言：expandHypergraph 的步数护栏（>=3 才是病态，1 与 2 都合法） */
export function assertPathHops(n) {
  const v = n === undefined ? 1 : n;
  if (v !== 1 && v !== 2) {
    throw new Error('expandHypergraph: maxPathHops 只接受 1 或 2，收到 ' + v);
  }
  return v;
}

/** 运行期断言：因果边未实测前不许纳入（红队 P1 护栏） */
export function assertRelationEdges(flag) {
  if (flag) {
    throw new Error('expandHypergraph: includeRelationEdges 未通过 P1 实测，暂不允许');
  }
}

/** token 估算：CJK 按 0.7、ASCII 按 4 字符 1 token（与 p1/p4 同口径） */
export function estimateTokens(text) {
  const s = String(text || '');
  let cjk = 0;
  for (const ch of s) if (/[\u4e00-\u9fff]/.test(ch)) cjk++;
  const rest = s.length - cjk;
  return Math.ceil(cjk * 0.7 + rest / 4);
}

export default {
  FIELD_WEIGHT, ADAPTIVE_K, STAGE_GUARD, ALIAS_RULES, STOPWORDS, DEGRADE_LEVELS,
  isDomainTerm, assertPathHops, assertRelationEdges, estimateTokens,
};
