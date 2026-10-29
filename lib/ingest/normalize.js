/**
 * ingest/normalize.js —— LLM 输出的**容错归一化**（期7 治本点）
 * [2026-10-22 by Assistant · 旁路实跑抓到]
 *
 * 实跑证据（glm-4.6v-flash，2026-10-22）：
 *   让它输出 {type, scene_name, content, priority}，它返回的是
 *   {"阶段":"期7","事件":"写入侧搬迁完成","完成任务":[...],"结果":"...","状态":"已跑通"}
 *   —— 字段名完全是它自己编的。
 *
 * 结论（这是设计教训，不是模型 bug）：
 *   **不能把「机器可解析」寄希望于小模型听话**。旧实现能跑，是因为它做了宽松兜底；
 *   只做严格 schema 校验 ⇒ 一个字段不合就整批丢弃 ⇒ 提取率 0（本次实跑 2 窗口全丢）。
 *
 * 所以这里做三层归一化：
 *   ① 字段别名映射（type/kind/类型/类别、content/内容/描述、title/标题…）
 *   ② 缺失关键字段时**按内容推断**（有"喜欢/是/习惯"→persona；有"要求/以后"→instruction；否则 episodic）
 *   ③ 实在提不出 → 返回空，由调用方走启发式兜底（保底不断流）
 */
import { sha1_16 } from './core.js';
// [2026-10-24 by Assistant · 判据只留一份] HTML 清洗统一走 html-strip.js。
//   之前这里有自己的 stripHtmlDeep、html-strip.js 有 boost 版 stripHtml —— 两份判据
//   是这个项目出过事故的老毛病（"判据只能有一份"）。这里改成复用，行为取并集（更严）。
import { stripHtml as _stripHtmlShared } from './html-strip.js';
// [2026-10-24 Round 28] 标题兜底按词边界截断（防英文残词）
import { cutAtWord } from './title-clean.js';

/** 从任意对象里按别名取第一个非空字符串。 */
function pick(obj, names) {
  for (const n of names) {
    const v = obj && obj[n];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return '';
}

/** 把对象里所有字符串值摊平（用于「它随便命名但内容在」的情况）。 */
function allStrings(obj, depth) {
  const out = [];
  const d = Number(depth) || 0;
  if (d > 2 || !obj || typeof obj !== 'object') return out;
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    if (typeof v === 'string' && v.trim()) out.push([k, v.trim()]);
    else if (Array.isArray(v)) {
      for (const x of v) { if (typeof x === 'string' && x.trim()) out.push([k, x.trim()]); }
    } else if (v && typeof v === 'object') {
      for (const p of allStrings(v, d + 1)) out.push(p);
    }
  }
  return out;
}

const TYPE_ALIASES = {
  persona: ['persona', '偏好', '个人信息', '用户画像', 'profile'],
  instruction: ['instruction', '指令', '规则', '约束', '要求'],
  episodic: ['episodic', '事件', 'episode', '进展', '活动'],
};

function inferType(text) {
  const t = String(text || '');
  if (/(要求|以后都|从现在开始|必须|不得|禁止|记住)/.test(t)) return 'instruction';
  if (/(用户|User).{0,6}(喜欢|偏好|习惯|擅长|讨厌|是|住在|从事)/.test(t)) return 'persona';
  return 'episodic';
}

/**
 * 把 LLM 返回的任意数组归一化成我们的 L1 卡。
 * @param {Array} arr   parseJsonArray 的结果
 * @param {{defaultLayer?:string, maxItems?:number}} [opts]
 * @returns {Array<{type:string, scene_name:string, content:string, priority:number, evidence:string}>}
 */

// ══════════════════════════════════════════════════════════════════
// [2026-10-23 by Assistant · 期8 附带修复]
//   实跑抓到：normalizeL1 有质量闸门，但 normalizeEngrams（蒸馏路径）**没有**，
//   于是同一批坏标题（会话：session-xxx / 额度修复）从蒸馏侧漏了 16 张。
//   ⇒ 把判据抽成共享函数，两条路径都过同一道闸。这是白队「消灭双轨制」的同一条纪律。
// ══════════════════════════════════════════════════════════════════
const ID_LIKE = /^[\s#>*\-　]*(?:会话\s*[:：]\s*)?(?:sess(?:ion)?|id|conv|rec|turn)[-_]?[0-9a-f]{4,}/i;
const UUID_LIKE = /^[\s#>*\-　]*(?:[a-z]*[:：]?\s*)?[0-9a-f]{8}-[0-9a-f]{4}-/i;

/** 标题是不是「纯 ID / 会话号」形态（含各种截断与前缀变体）。 */
export function isIdLikeTitle(t) {
  const s = String(t || '').trim();
  if (!s) return false;
  return ID_LIKE.test(s) || UUID_LIKE.test(s);
}

/**
 * 标题过短且不含具体名词（如「额度修复」「坏卡修复」「测试通过」）。
 * 阈值 6 字：中文里 6 字以下几乎不可能是可区分的名词性结论。
 */
export function isTooShortVague(t) {
  const s = String(t || '').trim();
  // [2026-10-23] 与 memory-health.mjs 的判据**逐字对齐**：长度 < 6 一律不合格。
  //   早先版本加了「含技术名词就放过」的例外，结果「额度修复」这种 4 字泛称从缝里漏过去，
  //   而体检仍判它不合格 ⇒ 两处判据打架。判据只能有一份。
  return s.length < 6;
}

// ══════════════════════════════════════════════════════════════════
// [2026-10-23 by Assistant · 期8.3.2 · **闸门装错字段**的治本修复]
//
//   事故：昨天给 normalize.js 加了坏标题闸门（isIdLikeTitle / isTooShortVague），
//   单测全绿，但生产当天仍新产 29 张坏卡（4 字泛称 / UUID / 英文叙述）。
//
//   真根因（逐行复核确认）：
//     L1 卡上**根本没有 title 字段**，只有 scene_name（见 extract.js:457-462 落盘对象）。
//     而 extract.js:194 的启发式兜底路径连 normalizeL1 都不走，直接 content.slice(0,36)。
//     ⇒ 「改 title 的闸门」对 L1 这条链路完全无效 —— 闸门装错了字段名。
//
//   治法：闸门**下沉**成「scene_name 的统一净化函数」sanitizeTitle(title, content)，
//   所有产卡点（extract 主路径 / extract 兜底路径 / distill 蒸馏）**都必须过它**。
//   判据只有一份（isGoodTitle），与 scripts/memory-health.mjs 逐字对齐。
// ══════════════════════════════════════════════════════════════════

/** 场景叙述模板（标题以这些起头 ⇒ 是场景不是结论）。 */
const SCENE_TPL_ANY = /^我（AI）在|^我在和|^AI正在|^正在和|^现在去|^接下来|第\s*\d+\s*轮|^关于.{0,12}(的|讨论|问题)|^本次|^这次|^本轮|^会话/;
/** 说话人前缀（"AI：" / "助手：" / "user:"）。 */
const SPEAKER_PREFIX = /^[\s#>*\-•·]*(?:AI|助手|用户|assistant|user)\s*[:：]\s*/i;
/** UUID 形态（含截断）。 */
const UUID_ANY = /^[\s#>*\-　]*(?:[a-z]*[:：]?\s*)?[0-9a-f]{8}-[0-9a-f]{4}-/i;
/**
 * 提炼后要剥掉的「场景/过程前缀」（标题不该以它们起头）。
 * 注意这是**剥离**词表，比上面的 SCENE_TPL_ANY（判定词表）更宽 ——
 *   判据要严、提炼要能救。二者分开，避免「判不合格→提炼→还是不合格」的死循环。
 */
const SCENE_HEAD_STRIP = /^(这次|本次|本轮|这轮|会话|这让我|这没问题|这说明|那就是|其实|其实就是|先验证|先看|接下来|然后|接着|另外|同时|并且|现在我|让我们一起)+/;

/**
 * 反复剥 HTML 标签（嵌套/残余如 "</div>" "<style>"）。
 * [2026-10-24] 改为复用 html-strip.js 的 stripHtml —— **判据只留一份**。
 *   额外保留一轮通用标签剥离，兜住 stripHtml 没覆盖的少数残缺形态。
 */
function stripHtmlDeep(s) {
  let t = _stripHtmlShared(s);
  for (let i = 0; i < 2; i++) {
    const before = t;
    t = t.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    if (t === before) break;
  }
  return t;
}

/**
 * 按字数切，切点尽量停在分隔符（空格/中文标点/冒号）边界。
 *
 * [2026-10-23 · Lead 裁定后的英文放行] 24 **字符**对中文够用（≈24 字），
 *   对英文却只有约 4 个词 —— 再被回退一刀就剩 2 个词，永远过不了「≥3 实词」。
 *   ⇒ 无中文时改用**按词切**（EN_MAX_WORDS 个词），中文仍按字符。
 */
const EN_MAX_WORDS = 8;
function cutAt(s, n) {
  const t = String(s || '').trim();
  if (!t) return t;
  const han = /[\u4e00-\u9fff]/.test(t);
  if (!han) {
    // 英文：按词切，切在词边界（天然不会断词）
    const ws = t.split(/\s+/);
    return ws.length <= EN_MAX_WORDS ? t : ws.slice(0, EN_MAX_WORDS).join(' ');
  }
  if (t.length <= n) return t;
  const cut = t.slice(0, n);
  const tail = cut.slice(-10);
  const sep = Math.max(
    tail.lastIndexOf(' '), tail.lastIndexOf('，'), tail.lastIndexOf('、'),
    tail.lastIndexOf('：'), tail.lastIndexOf(':'), tail.lastIndexOf('；'),
  );
  const out = sep > 0 ? cut.slice(0, cut.length - (10 - sep)).trim() : cut;
  // [2026-10-23] 回退不能退到「把中文丢光」：实测 'selftest-ingest.mjs 的自测结果为…'
  //   在 .mjs 后的空格处回退 ⇒ 只剩 'selftest-ingest.mjs'，无中文 ⇒ 被自己的判据拒。
  //   回退是为了「不断词」，不是为了让标题变短 ⇒ 丢了中文就别退。
  const hadHan = /[\u4e00-\u9fff]/.test(cut);
  if (hadHan && !/[\u4e00-\u9fff]/.test(out)) return cut;
  return out || cut;
}

/**
 * [2026-10-23 · Lead 裁定] 纯英文标题走**降级放行**而非丢弃。
 *   理由：卡里的内容有价值，只是标题不是中文，丢卡是错的。
 *   但「空壳前缀」（Investigation of / Fixing bugs in / Verification of …）仍判不合格 ——
 *   它们是过程叙述，与中文侧的 SCENE_TPL_ANY 同源；这类要**从正文重新提炼**。
 */
const EN_SHELL = /^(investigation|verification|validation|analysis|study|review|examination|summary|note|fixing|fix|running|run|working|work|testing|test|checking|check|debugging|debug|updating|update|adding|add|removing|remove|refactoring|refactor|making|make|doing|do|investigating|verifying|validating|analyzing|resolving|resolve|handling|handle|trying|try|looking|look|seeing|see|completing|complete|finishing|finish|starting|start|continuing|continue)\s*(of|in|on|at|to|the|a|an|for|and)?\s+/i;

/** 英文标题合格判据（**只在无中文时**启用）。 */
export function isGoodEnglishTitle(t) {
  const s = String(t || '').trim();
  if (!s) return false;
  if (!/[a-zA-Z]{3,}/.test(s)) return false;
  const words = s.match(/[a-zA-Z]{2,}/g) || [];
  if (words.length < 3) return false;                    // ≥3 个实词
  if (EN_SHELL.test(s)) return false;                    // 空壳/过程性前缀
  // 全大写缩写串（如 "API RATE LIMIT"）不算合格标题
  if (s === s.toUpperCase() && /[A-Z]{4,}/.test(s)) return false;
  return true;
}

/** 标题合格判据：中文口径与 memory-health.mjs 对齐；无中文时走英文降级分支。 */
export function isGoodTitle(t) {
  const s = String(t || '').trim();
  if (!s) return false;
  if (isIdLikeTitle(s)) return false;             // session id / UUID
  if (UUID_ANY.test(s)) return false;             // 裸 UUID（含截断）
  if (SCENE_TPL_ANY.test(s)) return false;        // 场景叙述模板
  if (/[\u4e00-\u9fff]/.test(s)) {
    if (s.length < 6) return false;               // 4 字泛称「对抗审查」
    return true;
  }
  // 无中文 ⇒ 英文降级分支（Lead 裁定：放行而非丢弃，旧行为是无条件 false）
  return isGoodEnglishTitle(s);
}

/** 从正文首句提炼标题（≤24 字，切点停在分隔符）。 */
function deriveTitleFromContent(content) {
  const s = stripHtmlDeep(content).replace(SPEAKER_PREFIX, '');
  const first = (s.split(/[。！？\n；;]/)[0] || '').trim();
  let cand = first.replace(/^[\s#>*\-•·\d.、]+/, '').replace(/[\[\]()（）#`*|]/g, '').trim();
  if (!cand) cand = s.replace(/[\[\]()（）#`*|]/g, '').trim();
  // 提炼出来的首句常带场景/过程前缀（「这次交接的验收也过了」），留着会被自己的
  //   判据再判一次不合格 ⇒ 在这里剥掉，保证**提炼结果一定落在合格区**（G9 合同）。
  const stripped = cand.replace(SCENE_HEAD_STRIP, '').trim();
  if (stripped.length >= 6) cand = stripped;
  return cutAt(cand, 24);
}

/**
 * 统一的标题净化（L1 的 scene_name / engram 的 title 都走这里）。
 *
 * @param {string} title   原始标题（可能是碎片 / ID / 英文 / 含 HTML）
 * @param {string} content 卡正文（提不出标题时从这里提炼）
 * @returns {string|null}  净化后的标题；**null = 这张卡不该存在，调用方必须丢弃**
 */
export function sanitizeTitle(title, content) {
  // ① 清洗类操作必须放在所有判据之前（先剥 HTML，再剥说话人前缀）
  let t = stripHtmlDeep(title).replace(SPEAKER_PREFIX, '');
  // 剥完若只剩零散符号（如 "</"）⇒ 视为无标题
  if (!/[\u4e00-\u9fffA-Za-z0-9]{2,}/.test(t)) t = '';

  // ② 合格 ⇒ 只做长度收敛
  if (isGoodTitle(t)) return cutAt(t, 24);

  // ③ 不合格 ⇒ 从正文首句提炼
  const d = deriveTitleFromContent(content);
  if (isGoodTitle(d)) return d;

  // ④ 正文也提不出（<6 字 / 无中文 / 仍是 ID）⇒ 宁缺毋滥
  return null;
}

export function normalizeL1(arr, opts) {
  const o = opts || {};
  const max = Number.isFinite(Number(o.maxItems)) ? Number(o.maxItems) : 4;
  const out = [];
  if (!Array.isArray(arr)) return out;
  for (const it of arr) {
    if (!it || typeof it !== 'object' || Array.isArray(it)) continue;

    // ① 字段别名
    let type = pick(it, ['type', 'kind', '类型', '类别', '记忆类型']).toLowerCase();
    let content = pick(it, ['content', '内容', '描述', '正文', 'text', '详情', '细节', 'memory', '记忆']);
    let scene = pick(it, ['scene_name', 'scene', '场景', '场景名', '情境']);
    let evidence = pick(it, ['evidence', '证据', '原文', '依据', '引用']);
    // [2026-10-22] 显式取 title —— 之前根本没读这个字段，下游只能拿 scene_name 当标题，
    //   于是所有卡都变成「我（AI）在和系统做xxx」。
    let title = pick(it, ['title', '标题', '名称', '主题']);
    let priority = Number(it.priority !== undefined ? it.priority : (it['优先级'] !== undefined ? it['优先级'] : NaN));

    // ② 字段全不认识 ⇒ 从"随便命名的值"里拼内容
    if (!content) {
      const pairs = allStrings(it);
      if (pairs.length === 0) continue;
      const skipKeys = /^(type|kind|类型|priority|优先级|layer|层|evidence|证据|scene|场景)$/i;
      const useful = pairs.filter((p) => !skipKeys.test(p[0]));
      const use = useful.length ? useful : pairs;
      // 优先把「像结论/事件」的长值当内容，短值当场景名
      use.sort((a, b) => b[1].length - a[1].length);
      content = use[0][1];
      if (!scene && use[1]) scene = use[1][1].slice(0, 40);
      if (!evidence && use[2]) evidence = use[2][1].slice(0, 40);
    }
    content = String(content || '').replace(/\s+/g, ' ').trim().slice(0, 400);
    if (content.length < 8) continue;

    // ③ type 归一（不认识就推断）
    let mapped = null;
    for (const [k, aliases] of Object.entries(TYPE_ALIASES)) {
      if (aliases.some((a) => type === a || type.includes(a))) { mapped = k; break; }
    }
    if (!mapped) mapped = inferType(content);

    if (!Number.isFinite(priority)) {
      priority = mapped === 'instruction' ? 85 : (mapped === 'persona' ? 70 : 65);
    }
    if (!scene) scene = content.slice(0, 30);

    // [2026-10-22 by Assistant · 实跑抓到「标题全是场景叙述」的根因就在这里]
    //   本函数原来只输出 scene_name，下游拿去当标题 ⇒ 全是「我（AI）在和系统做xxx」。
    //   现在显式输出 title：优先用 LLM 给的 title，缺失/是场景模板时从 content 提炼。
    // [2026-10-22 二次修正 · 实跑抓到 4 张卡全叫「超图记忆改造第13轮」]
    //   上面那条只挡「我（AI）在…」模板，但 LLM 还会用**场景式短语**当标题：
    //     「超图记忆改造第13轮」「关于 X 的讨论」「本次会话」
    //   这类标题没有信息量，且多张卡会撞名 ⇒ 一律改用 content 提炼。
    const SCENE_TPL2 = /^我（AI）在|^我在和|^AI正在|^正在和|^现在去|^接下来|第\s*\d+\s*轮|^关于.{0,12}(的|讨论|问题)|^本次|^这次|^本轮|^会话/;
    let outTitle = String(title || '').replace(/\s+/g, ' ').trim();

    // [2026-10-22 四次修正 · 实跑抓到 4 张卡全叫 "backfill"]
    //   LLM 把**会话名**当标题（sessionKey = "backfill"）。通用规则：
    //   若标题与 opts.sessionId/sessionKey 相同，或很短且不含具体名词 ⇒ 视为无效。
    const sid = String((o && (o.sessionId || o.sessionKey)) || '').trim().toLowerCase();
    const titleLow = outTitle.toLowerCase();
    // [2026-10-22 第22轮修正] 精确相等挡不住变体 ——
    //   实测生产产出 8 张标题是「会话：session-f7a52c5e-82df-...」（带「会话：」前缀）。
    //   改成**包含即无效**：标题里出现 session id（或其去掉 sess- 前缀的核心段）就算。
    const sidCore = sid.replace(/^sess-/, '');
    // [2026-10-22 第24轮修正] 截断版也出现过 ——
    //   实测标题是 session-<redacted>（少了尾部 6 字符）。
    //   所以不能只做整串包含，要用**前 20 位前缀**做包含判断。
    const sidPrefix = sidCore.slice(0, 20);
    const isSessionName = !!sid && (
      titleLow === sid
      || titleLow === sidCore
      || (sidPrefix.length >= 12 && titleLow.indexOf(sidPrefix) >= 0)
      || /^会话\s*[:：]\s*sess/i.test(outTitle)
    );
    // 标题太短且无具体名词（如 "backfill"、"record"、"note"）
    const tooVague = outTitle.length <= 12 && !/[\u4e00-\u9fff]/.test(outTitle);
    // [2026-10-22 第24轮] UUID/session 形态判定加强：
    //   除了标准 UUID（8-4-4-4-12），还要覆盖各种截断形态 ——
    //   实测生产出现过 session-<redacted>（尾部被切）。
    const looksLikeId = isIdLikeTitle(outTitle);
    // [2026-10-22] 过短且无具体名词也判无效（实测有「坏卡修复」这种 4 字标题）
    const tooShortVague = outTitle.length <= 6
      && !/[a-zA-Z]{3,}|[0-9]|进程|定时器|索引|游标|配置|参数|门槛|函数|模块|缓存|检索|注入|画像|重启|批次|报告/.test(outTitle);
    if (!outTitle || SCENE_TPL2.test(outTitle) || isSessionName || tooVague || looksLikeId || tooShortVague) {
      const firstClause = String(content || '').split(/[。！？\n；;]/)[0] || '';
      const cand = firstClause.replace(/^[\s#>*\-•·\d.、]+/, '').replace(/[\[\]()（）#`*|]/g, '').trim();
      // [2026-10-22] 20 字太短会把标题从词中间切断（实测：「将 EXTRACT_SYSTEM_PROMPT 中的 sce」）
      //   放宽到 32，并在断点处尽量停在标点/空格边界。
      if (cand.length >= 6) {
        let cut = cand.slice(0, 32);
        // 若切点在英文词中间，回退到上一个分隔符
        if (cand.length > 32) {
          const tail = cut.slice(-12);
          const sep = Math.max(tail.lastIndexOf(' '), tail.lastIndexOf('，'), tail.lastIndexOf('、'));
          if (sep > 0) cut = cut.slice(0, cut.length - (12 - sep)).trim();
        }
        outTitle = cut;
      } else outTitle = '';
    }
    // [2026-10-24 by Assistant · Round 28] 兜底标题不能硬切英文单词。
    //   实测 132 张残词标题：「工具schema缺ite」（缺 r）、「Cubism预乘Alph」（缺 a）、
    //   「recall与searc」、「canvas勿用inse」—— 都是 slice(0,16) 切在词中间造成的。
    if (!outTitle) outTitle = cutAtWord(String(content || ''), 16);

    out.push({
      type: mapped,
      title: outTitle.slice(0, 24),
      scene_name: String(scene).replace(/\s+/g, ' ').trim().slice(0, 60),
      content,
      priority: Math.round(priority),
      evidence: String(evidence || '').replace(/\s+/g, ' ').trim().slice(0, 60),
      _fp: sha1_16(mapped + '\u0000' + content),
    });
    if (out.length >= max) break;
  }
  return out;
}

const KIND_ALIASES = {
  fact: ['fact', '事实', '约定', '规律'],
  decision: ['decision', '决策', '方案', '决定'],
  event: ['event', '事件', '进展', '活动'],
  note: ['note', '笔记', '其它', '其他'],
};

/** 把 LLM 返回的任意数组归一化成蒸馏卡。 */
export function normalizeEngrams(arr, opts) {
  const o = opts || {};
  const max = Number.isFinite(Number(o.maxItems)) ? Number(o.maxItems) : 3;
  const out = [];
  if (!Array.isArray(arr)) return out;
  for (const it of arr) {
    if (!it || typeof it !== 'object' || Array.isArray(it)) continue;

    let kind = pick(it, ['kind', 'type', '类型', '类别']).toLowerCase();
    let layer = pick(it, ['layer', '层', '层级', '范围']).toLowerCase();
    let title = pick(it, ['title', '标题', '名称', '主题', '入口']);
    let summary = pick(it, ['summary', '摘要', '简述', '一句话']);
    let content = pick(it, ['content', '内容', '详情', '正文', '细节', '描述']);
    let causesOf = it.causesOf || it['因果'] || it['原因'] || [];

    if (!content && !summary) {
      const pairs = allStrings(it);
      if (!pairs.length) continue;
      pairs.sort((a, b) => b[1].length - a[1].length);
      content = pairs[0][1];
      if (!title && pairs[1]) title = pairs[1][1].slice(0, 20);
    }
    // 内容太短时用摘要补（实跑常见：模型给了一句话摘要但 content 只写了几个字）
    if (String(content).length < 8 && String(summary).length >= 8) content = summary;

    // [2026-10-22 第18轮] 蒸馏路径也要过质量闸门。
    //   实测 LLM 产出了「它其实命中了」「补测试并做最终验证」这类过程叙述卡。
    //   prompt 里写了「不要过程性」，但没有强制拦截——模型不听话就漏过去了。
    const PROC_NOISE = /^(它其实|它用的是|这让我|这没问题|这说明|那就是|补测试|做最终验证|收尾|先看|先验证|接下来|然后我|现在我|我一直在|AI[：:])/;
    // [2026-10-22] 词表要够宽 —— 实测「期七写入侧搬迁旧结论」这种**项目名**也是具体对象，
    //   但它不含任何技术术语，被误挡。加入期N/轮/阶段/搬迁/交接 等项目语义词。
    const CONCRETE = /([a-zA-Z]{3,}|[0-9]+|进程|定时器|优先级|索引|游标|配置|参数|阈值|门槛|函数|模块|接口|字段|路径|文件|缓存|注入|检索|提取|蒸馏|窗口|补跑|降级|画像|断言|测试|日志|报告|红队|审计|验收|期[一二三四五六七八九十\d]|阶段|轮次|搬迁|交接|改造|实现|方案|决定|约定)/;
    const probeText = String(title || "") + " " + String(content || "");
    if (PROC_NOISE.test(String(title || "").trim()) || PROC_NOISE.test(String(content || "").trim())) continue;
    // [2026-10-22 修正] decision/约定类不强制要求技术名词 ——
    //   「User明确：先把功能做好才可关旧插件」是有效约定，但它没有技术术语。
    //   这类靠"决策/约定"语义本身就有价值，不该被 CONCRETE 挡住。
    const kindNow = String(kind || '').toLowerCase();
    const isDecisionLike = /decision|约定|决策|规则|原则/.test(kindNow) || /约定|决定|明确|原则|规则/.test(probeText);
    if (!isDecisionLike && !CONCRETE.test(probeText)) continue;
    content = String(content || summary || '').replace(/\s+/g, ' ').trim().slice(0, 300);
    summary = String(summary || content).replace(/\s+/g, ' ').trim().slice(0, 80);
    // [2026-10-22 by Assistant · 实跑抓到「标题全是场景叙述」]
    //   LLM 曾把 scene_name 当标题用，产出 4 张一模一样的「我（AI）在和系统调试记忆召回机制」。
    //   这类标题对检索毫无区分度（4 张卡排序互相打架）。
    //   ⇒ 若标题命中「场景叙述模板」，**从 content 里重新提炼一个名词性标题**。
    // [2026-10-22 第19轮] **先剥 HTML** 再判其它 —— 否则 "</style>" 这种
    //   会先命中"有字母数字"的兜底，洗完之后反而留下 </ 残渣。
    //   顺序很重要：清洗类操作必须放在所有判据之前。
    {
      let t0 = String(title || '');
      for (let i = 0; i < 3; i++) {
        const before = t0;
        t0 = t0.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
        if (t0 === before) break;
      }
      // 剥完若只剩零散符号（如 "</"），视为无标题
      if (!/[\u4e00-\u9fffA-Za-z0-9]{2,}/.test(t0)) t0 = '';
      title = t0;
    }
    // [2026-10-22] 原标题是纯 HTML、且 content 也是纯 HTML ⇒ 整条丢弃（宁缺毋滥）。
    //   否则会被下面兜底成「对话片段」这种无信息量占位名。
    {
      const rawTitle = String(pick(it, ['title', '标题', '名称', '主题', '入口']) || '').trim();
      const rawContent = String(pick(it, ['content', '内容', '详情', '正文', '细节', '描述']) || '').trim();
      const isHtmlOnly = (s) => /<[^>]*>/.test(s) && !/[\u4e00-\u9fff]{2,}/.test(s.replace(/<[^>]*>/g, ''));
      if (!title && isHtmlOnly(rawTitle) && (!rawContent || isHtmlOnly(rawContent))) {
        continue;
      }
    }
    const SCENE_TPL = /^我（AI）在|^我在和|^AI正在|^正在和|^现在去|^接下来/;
    const looksScene = title && SCENE_TPL.test(String(title).trim());
    if (!title || looksScene) {
      const src = String(content || summary || '');
      // 从正文里取第一句有信息量的（去标点、限长）
      const firstClause = src.split(/[。！？\n；;]/)[0] || '';
      const candidate = firstClause.replace(/^[\s#>*\-•·\d.、]+/, '').replace(/[\[\]()（）#`*|]/g, '').trim();
      if (candidate.length >= 6) title = candidate.slice(0, 20);
    }
    title = String(title || summary).replace(/\s+/g, ' ').trim().slice(0, 24);
    // 纯符号 / 纯 HTML 标签 / 占位词的标题不可用（实跑教训：title="</div>"）。
    //   判据不能只看「有没有字母数字」——"</div>" 里就有 div 这几个字母。
    //   所以先剥标签再判：剩下必须是中文或成词，而不是英文标签名。
    const stripped = title.replace(/<[^>]*>/g, '').replace(/[^\u4e00-\u9fffA-Za-z0-9]/g, '').trim();
    const isTagWord = /^(div|span|style|html|body|br|p|td|tr|table|script|class|style)$/i.test(stripped);
    if (!/[\u4e00-\u9fff]/.test(stripped) && (stripped.length < 2 || isTagWord)) {
      title = String(summary || content).replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim().slice(0, 14);
    }
    if (!/[\u4e00-\u9fffA-Za-z0-9]/.test(title)) title = '对话片段';

    // [2026-10-22 第19轮] 兜底也要剥 HTML —— 实测有卡的标题是纯 "</style>"。
    //   上面第 232 行虽然剥了标签，但若 summary/content 也是 HTML，剥完还是空 ⇒ 留着标签。
    //   这里做最后一道：反复剥标签，剥完仍无意义就用 content 首句。
    {
      let t2 = String(title || '');
      for (let i = 0; i < 3; i++) {
        const before = t2;
        t2 = t2.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
        if (t2 === before) break;
      }
      if (!t2 || t2.length < 4 || !/[\u4e00-\u9fffA-Za-z0-9]/.test(t2)) {
        const fb = String(content || summary || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
        t2 = fb.length >= 6 ? fb.slice(0, 24) : '';
      }
      if (!t2) continue;   // 实在拿不到可用标题 ⇒ 这张卡不要（宁缺毋滥）
      title = t2;
    }
    // [2026-10-23 · 期8] 与 normalizeL1 共用同一道标题闸门（消灭双轨制）
    //   实测蒸馏侧漏了 16 张：会话：session-xxx / 裸 session-xxx / 「额度修复」这种 4 字泛称。
    // [2026-10-23 · 期8.3.2] 改成调用**统一的 sanitizeTitle**（判据只有一份）：
    //   原版只判 ID / 过短，漏了英文叙述（「Investigation of …」）这类形态；
    //   且提炼逻辑自己又写了一遍。现在与 L1 的 scene_name 走同一个函数。
    {
      const st = sanitizeTitle(title, String(content || summary || ''));
      if (!st) continue;   // 拿不到可用标题 ⇒ 整条丢弃（宁缺毋滥，与 L1 同口径）
      title = st;
    }

    if (!title || content.length < 8) continue;

    let mk = null;
    for (const [k, aliases] of Object.entries(KIND_ALIASES)) {
      if (aliases.some((a) => kind === a || kind.includes(a))) { mk = k; break; }
    }
    if (!mk) mk = 'note';

    if (!['global', 'project', 'session'].includes(layer)) {
      // 没给就按"跨项目通用 / 项目内"粗判
      layer = /(环境|工具|偏好|端口|路径|模型名)/.test(content) ? 'global' : 'project';
    }
    if (!Array.isArray(causesOf)) causesOf = [];

    // [2026-10-27 by Assistant · 第2步 arc_story 断线的真凶]
    //   病灶：这里是一份**字段白名单**，只挑 6 个字段往 out 里塞。
    //         模型在 distill 提示词里按要求产出了 arcStory，
    //         但这一行**没把它接住** ⇒ 到 distill 时 item.arcStory 恒 undefined
    //         ⇒ arc_story 永远是空串。实测 494 张 distill 卡，0 张有值。
    //   修法：把 arcStory / arc_story 一起透传（distill 里两个键都认）。
    //   兼容：两个键都没有 ⇒ 空串，走 distill 的 causes 兜底，行为与改动前一致。
    const __arc = String((it && (it.arcStory || it.arc_story)) || '').trim();
    out.push({
      kind: mk, layer, title, summary, content,
      causesOf: causesOf.map(String).slice(0, 2),
      ...(__arc ? { arcStory: __arc.slice(0, 160) } : {}),
    });
    if (out.length >= max) break;
  }
  return out;
}
