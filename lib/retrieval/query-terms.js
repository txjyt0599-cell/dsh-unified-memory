/**
 * lib/retrieval/query-terms.js —— 查询词切分与两把尺（2026-10-28 · 结构重构）
 *
 * ## 为什么单独成模块
 * 这些判据原来全塞在 retriever.js（2451 行）里，结果是今天一天踩了三个同类型的坑：
 *   ① 归一化把「最早」当虚词剥掉 ⇒ 时间通道失效（crosssource C4 连挂两次）
 *   ② literalsHit 改成复用 qTermsOf ⇒ 严格尺被稀释 ⇒ 库外话题硬凑 24 条
 *   ③ L0 通道被归一化影响 ⇒ 「记忆改造到哪了」L0 命中 2 → 0
 * 三次都是"同一段逻辑散在别处，改一处忘了另一处"。抽成独立模块后：
 *   · 两把尺并排放、各自写明用途与方向
 *   · 谁要动它们，必须在这个文件里同时看到两把
 *
 * ## 两把尺的方向（这是本模块的核心知识，别合并！）
 *   qTermsOf   —— **宽容尺**：剥掉虚词后切实词。用途：算覆盖率、判"有没有实词"。剥错会误杀。
 *   literalsHit —— **严格尺**：不剥虚词，原样切。用途：判"这条命中是不是真相关"。放宽会硬凑。
 *   两把方向相反。合并 = 其中一把必然坏掉（已实测两次）。
 */

import { STOPWORDS } from './types.js';

/** 常用虚词表 = 项目统一 STOPWORDS + 几个英文虚词 */
export const COMMON_QW = (function () {
  const s = new Set(Array.from(STOPWORDS || []));
  for (const w of ['how', 'what', 'the', 'and', 'for', 'you', 'are', 'can', 'this', 'that', 'with', 'from', 'was', 'were']) s.add(w);
  return s;
})();

/** 单字虚词：夹在实词之间会造出跨界碎片（我/的/是/多/大…） */
const SINGLE_VIRTUAL = new Set(
  '的了嘛呢吧啊呀嗯哦你我他她它是和与就都也还很太又才把被给让对从到说做个这那多大好要会能去来上下里外中'.split('')
);

/**
 * 剥掉虚词（多字词优先，再剥单字），返回只剩实词的串。
 *
 * 实测价值：『我刚才说的那个显存是多大的来着』
 *   不剥 → 我刚/才说/说的/的那/个显/显存/存是/是多/多大/大的/的来（11 个，显存只占 1/11）
 *   剥后 → 「显存」（覆盖率 100%，门控不再误杀）
 */
export function stripVirtual(s) {
  const multi = Array.from(COMMON_QW).filter(function (w) { return w && w.length >= 2; });
  multi.sort(function (a, b) { return b.length - a.length; });   // 长词优先，避免被短词先吃掉
  let t = String(s || '');
  for (let pass = 0; pass < 4; pass++) {
    let changed = false;
    for (const w of multi) {
      if (t.indexOf(w) >= 0) { t = t.split(w).join('\u0000'); changed = true; }
    }
    let out = '';
    for (const c of t) {
      if (SINGLE_VIRTUAL.has(c)) { out += '\u0001'; changed = true; } else out += c;
    }
    t = out;
    if (!changed) break;
  }
  // 占位符直接抹掉（不留空位，否则剥完的字会重组出假词）
  return t.replace(/[\u0000\u0001]+/g, '');
}

/**
 * **宽容尺**：把查询切成实词集合（先剥虚词，再切 2 字块）。
 * 用途：算"查询里的实词有多少被卡覆盖" —— 覆盖率判据。
 * ⛔ 不要拿它去判"这条命中是不是真相关"（那要用 literalsHit）。
 */
export function qTermsOf(query) {
  const qs = String(query || '').toLowerCase();
  const terms = new Set();
  for (const m of qs.match(/[a-z0-9][a-z0-9_.\-]{1,}/g) || []) if (!COMMON_QW.has(m)) terms.add(m);
  const stripped = stripVirtual(qs);
  for (const run of stripped.match(/[\u4e00-\u9fa5]{2,}/g) || []) {
    for (let i = 0; i + 2 <= run.length; i++) {
      const bg = run.slice(i, i + 2);
      if (!COMMON_QW.has(bg)) terms.add(bg);
    }
    if (run.length === 2 && !COMMON_QW.has(run)) terms.add(run);
  }
  return terms;
}

/**
 * [2026-11-06 by Phoebe · 修「守门误杀」bug]
 *
 * 问题实证（生产库，同一主题）：
 *   「User的显卡是什么型号」                                        → 24 条 ✓
 *   「根据之前的讨论，User的显卡当前是什么型号？（请给出值、状态，以及该值生效的序号）」 → **0 条** ✗
 *   根因：literalsHit 把**整句**切 2 字块当分母。模板尾巴（请给出/以及/生效的序号…）
 *   把分母从 ~9 撑到 ~17，真实命中只有「User/显卡/型号」3 个 ⇒ cover 0.18 < 0.30 ⇒ 判"无真信号"⇒ 空回。
 *
 * 修法：算相关性之前，先剥掉**问法模板**（括号补充说明、对话引用前缀、答题格式要求）。
 *   —— 剥的是"怎么问"，不是"问什么"，所以库外守门（红烧肉）不受影响。
 * ⛔ 只在 literalsHit 内部用；BM25 检索仍用原句。
 */
const ASK_TEMPLATE_RULES = [
  /[（(\[][^）)\]】]*[）)\]】]/g,                       // 括号补充说明（请给出值、状态…）
  /^(?:根据|按照|基于|照着|依据|如前|如上|结合)(?:之前|刚才|上面|上述|前面|前述|以上)?(?:的)?(?:讨论|内容|信息|记录|对话|结果)?[，,。；;]?/,
  /(?:请|麻烦)?(?:你)?(?:帮我)?(?:给出|列出|说明|回答|输出|按序号|按顺序|顺序)/g,
  /(?:以及|并且|同时|还有|和)(?:该?值(?:的)?)?(?:状态|序号|依据|出处)/g,
  /(?:分别|具体)?(?:是什么|是多少|为何|为什么)/g,
  /(?:当前|现在|目前)?(?:的)?(?:值和状态|值|状态)(?:分别)?(?:是什么|为何)?/g,
  /(?:截至|截止|到)(?:第\s*\d+\s*[次章轮回]|现在|目前|今天)?/g,
  /在?第\s*\d+\s*[次章轮回](?:这个时间点|时|之前|之后)?/g,
  /(?:从最初到现在|从开始到现在)?(?:经历过|经历)(?:哪些)?(?:变更|变化)?/g,
  /(?:每一次|每次)(?:变更)?(?:前后)?(?:的)?(?:值)?/g,
  /(?:生效的?序号|生效|序号|先后顺序)/g,
];

export function stripAskTemplate(q) {
  let s = String(q || '');
  if (!s) return s;
  const before = s;
  for (const re of ASK_TEMPLATE_RULES) { try { s = s.replace(re, ' '); } catch (e) { /* 保持原串 */ } }
  s = s.replace(/[，,。.；;：:？?！!、\s]+/g, ' ').trim();
  // 兜底：剥完太平（<2 个汉字）就退回原串，宁可严格也别放空
  const hanCount = (s.match(/[\u4e00-\u9fa5]/g) || []).length;
  return hanCount >= 2 ? s : before;
}

/**
 * **严格尺**：查询实词在给定文本里命中了多少。
 * 用途：判"这条命中是不是真相关"（门控用）。
 * ⛔ 不要剥虚词 —— 剥了会变宽松，库外话题就会被硬凑进来（实测「红烧肉」返回 24 条）。
 *
 * @returns {{total:number, long:number, cover:number}}
 */
export function literalsHit(query, text) {
  const qs = String(query || '').toLowerCase();
  const ts = String(text || '').toLowerCase();
  if (!qs || !ts) return { total: 0, long: 0, cover: 0 };
  // [2026-11-06] 先剥「问法模板」再切块 —— 修「长问句被模板尾巴稀释 ⇒ 误判无真信号 ⇒ 空回」
  //   只影响相关性判定；BM25/检索本身仍用原句。库外话题（红烧肉）剥完仍是原样，守门不受影响。
  const qCore = stripAskTemplate(qs);
  const terms = new Set();
  for (const m of qCore.match(/[a-z0-9][a-z0-9_.\-]{1,}/g) || []) if (!COMMON_QW.has(m)) terms.add(m);
  for (const run of qCore.match(/[\u4e00-\u9fa5]{2,}/g) || []) {
    for (let i = 0; i + 2 <= run.length; i++) {
      const bg = run.slice(i, i + 2);
      if (!COMMON_QW.has(bg)) terms.add(bg);
    }
  }
  let total = 0;
  let long = 0;
  for (const t of terms) {
    if (!ts.includes(t)) continue;
    total++;
    if (t.length >= 3) long++;   // 3 字以上算长词，偶然命中概率低
  }
  const all = terms.size || 1;
  return { total, long, cover: total / all };
}

/** 中文时间意图词（显式 vs 语气型，语义不同，处理方式也不同） */
export const TIME_WORD = /最早|最初|最晚|最新|刚才|刚刚|之前|以前|上次|上周|上月|昨天|前天|今天|今年|去年|当时|那时|后来|最后|第一次/;
/** 显式时间意图：必须整句保留，剥掉会让 temporal 通道失效 */
export const EXPLICIT_TIME_INTENT = /最早|最初|最晚|最新|上次|上周|上月|昨天|前天|去年|当时|那时|后来|最后|第一次/;

/** 库内领域词（用于判断"这条查询是不是在问本机真实话题"） */
export const IN_SCOPE_WORD = /显存|显卡|内存|硬盘|功耗|四股|日记|项目甲|素材图|超图|向量|蒸馏|检索|注入|协议|端口|配置|模型|记忆|阀门|气动|设备短语|设备短语|再生|工单|规程|插件|面板|会话|技能|裁决|记忆卡|索引|体检|重启|编译|部署/;

/** 明显库外话题（归一化一律不许碰） */
export const OUT_OF_SCOPE = /天气|预报|食谱|菜谱|红烧肉|怎么做菜|小说|推荐|股价|股票|彩票|汇率|星座|旅游攻略|电影|音乐|歌曲/;

export default { COMMON_QW, stripVirtual, qTermsOf, literalsHit, stripAskTemplate, TIME_WORD, EXPLICIT_TIME_INTENT, IN_SCOPE_WORD, OUT_OF_SCOPE };
