/**
 * lib/retrieval/time-window.js —— 时间窗口解析（总纲 v2 §2）
 *
 * [2026-11-03 by Phoebe]
 *   病灶：classifyTemporal() 只返回方向（earliest/latest/null），不返回窗口；
 *         种子天数写死 seedDays=7 ⇒ 「上个月」「去年」全被当成「最近7天」。
 *   修法：把时间词解析成 { lo, hi }（天为单位，lo < age <= hi），
 *         让检索层能按窗口硬过滤。
 *
 * 设计约束（来自原型 proto-timewindow2.mjs 实测）：
 *   1. 最长优先匹配 —— 「最早期」要整体当时间词，不能只剥「最早」留下「期」
 *   2. 中文数字要转 —— 「三天前」的「三」→ 3
 *   3. 绝对日期跨年 —— M月D日 若算出未来则退上一年
 *   4. 纯函数，无副作用，不读全局状态
 */

const DAY_MS = 86400000;

/** 中文数字 → 阿拉伯数字（够用即可，不做任意大数解析） */
const CN_NUM = {
  一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
  十一: 11, 十二: 12, 十三: 13, 十四: 14, 十五: 15, 十六: 16, 十七: 17, 十八: 18, 十九: 19,
  二十: 20, 二十一: 21, 二十二: 22, 二十三: 23, 二十四: 24, 二十五: 25,
  三十: 30, 三十六: 36, 四十: 40, 五十: 50, 六十: 60, 七十: 70, 八十: 80, 九十: 90,
};

function toNum(s) {
  const t = String(s || '').trim();
  if (!t) return null;
  if (/^\d+$/.test(t)) return Number(t);
  if (Object.prototype.hasOwnProperty.call(CN_NUM, t)) return CN_NUM[t];
  return null;
}

/**
 * 时间词剥离表 —— **必须最长优先**，否则「最早期」会被「最早」先吃掉留下「期」。
 * 按字符串长度从长到短排序后拼成大正则（一次性 replace，避免多轮互相污染）。
 */
const STRIP_WORDS = [
  // 长的先
  '很久以前', '头一回', '第一天', '第一次', '刚开始', '最开头',
  '上上个月', '上上星期', '上上礼拜', '上上周',
  '半个月前', '半年前', '大半年前',
  '这个星期', '这个礼拜', '这个月', '本月', '这周', '本周',
  '上个星期', '上个礼拜', '上个月', '上月', '上星期', '上礼拜', '上周',
  '大前天', '前天', '昨天', '昨日', '今天', '今日', '今儿',
  '刚才', '刚刚', '刚刚才',
  '最早期', '最早', '最初', '最久', '以前', '之前', '当时', '那时候', '那会儿',
  '最近', '最新', '近期', '这几天', '这两天', '这几日', '这段时间',
  '去年', '上一年', '今年', '前年',
  '时候', '那天', '那几天', '那次', '那回',
];
// 长 → 短，保证「最早期」在「最早」之前被吃
STRIP_WORDS.sort((a, b) => b.length - a.length);
const STRIP_RE = new RegExp(STRIP_WORDS.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g');

/** 相对量词正则（N天前 / N周前 / N个月前），单独处理因为要取数字 */
const RE_N_DAY = /(\d+|[一二两三四五六七八九十]+)\s*天\s*(?:以)?前/;
const RE_N_WEEK = /(\d+|[一二两三四五六七八九十]+)\s*(?:个)?(?:周|星期|礼拜)\s*(?:以)?前/;
const RE_N_MONTH = /(\d+|[一二两三四五六七八九十]+)\s*个?月\s*(?:以)?前/;
const RE_ABS_ISO = /(\d{4})[-\/.](\d{1,2})[-/.](\d{1,2})/;
const RE_ABS_CN = /(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]/;

/**
 * 解析时间窗口。
 * @param {string} q      查询原文
 * @param {number} [nowMs] 基准时间（默认 Date.now()，便于测试注入）
 * @returns {{lo:number, hi:number, label:string, abs:boolean}|null}
 *          lo < ageDays <= hi（天）。null = 没有时间窗口意图。
 */
/**
 * [2026-11-06 by Phoebe · 红队 P1-3] 绝对日期返回**自然日**窗口 [dayStart, nextDayStart)。
 * 病灶：旧法把窗口设成「当天0点 ± 0.5 天」⇒ 实际覆盖 [前一天中午, 当天中午)，
 *   下午查询会选错半天（11月3号 23:00 落在窗外、11月2号 13:00 反落窗内）。
 * 修法：直接算本地时区 dayStart 与 nextDayStart 的时间戳，换算成 age 区间，不做天数四舍五入。
 *   age = (NOW - t)/DAY；t∈[dayStart, nextDayStart) ⇒ age∈((NOW-next)/DAY, (NOW-day)/DAY]。
 */
function absDayWindow(y, mo, dd, NOW) {
  const dayStart = new Date(y, mo - 1, dd).getTime();
  if (!Number.isFinite(dayStart)) return null;
  const nextStart = new Date(y, mo - 1, dd + 1).getTime();   // Date 自动处理月末/闰日/跨月
  if (!Number.isFinite(nextStart)) return null;
  const lo = (NOW - nextStart) / DAY_MS;
  const hi = (NOW - dayStart) / DAY_MS;
  return { lo, hi, label: '某日', abs: true };
}

export function parseTimeWindow(q, nowMs) {
  const s = String(q || '');
  if (!s) return null;
  const NOW = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();
  const mk = (lo, hi, label, abs) => ({
    lo: Math.round(Math.max(0, lo) * 100) / 100,
    hi: Math.round(hi * 100) / 100,
    label: String(label || ''),
    abs: !!abs,
  });

  // ── 1. 绝对日期（优先级最高：「11月3号」比「最近」更具体）──
  let m = s.match(RE_ABS_ISO);
  if (m) {
    const w = absDayWindow(Number(m[1]), Number(m[2]), Number(m[3]), NOW);
    if (w && w.hi >= -0.5) return w;   // 不是明显未来（允许当天边缘±半天）
  }
  m = s.match(RE_ABS_CN);
  if (m) {
    const y = new Date(NOW).getFullYear();
    let w = absDayWindow(y, Number(m[1]), Number(m[2]), NOW);
    if (!w) return null;
    // 跨年：若整天落在未来（0点比现在晚超半天），退回上一年
    if (w.hi < -0.5) w = absDayWindow(y - 1, Number(m[1]), Number(m[2]), NOW);
    if (w && w.hi >= -0.5) return w;
  }

  // ── 2. 相对量词（N天前 / N周前 / N个月前）──
  m = s.match(RE_N_DAY);
  if (m) {
    const n = toNum(m[1]);
    if (n != null && n >= 0) return mk(n, n + 1, n + '天前');
  }
  m = s.match(RE_N_WEEK);
  if (m) {
    const n = toNum(m[1]);
    if (n != null && n >= 0) return mk(n * 7, (n + 1) * 7, n + '周前');
  }
  m = s.match(RE_N_MONTH);
  if (m) {
    const n = toNum(m[1]);
    if (n != null && n >= 0) return mk(n * 30, (n + 1) * 30, n + '个月前');
  }

  // ── 3. 固定词（同样最长优先：「上上周」必须在「上周」之前判）──
  if (/半个月前/.test(s)) return mk(15, 16, '半个月前');
  if (/半年前|大半年前/.test(s)) return mk(180, 181, '半年前');
  if (/上上个月/.test(s)) return mk(60, 90, '上上个月');
  if (/上上(周|星期|礼拜)/.test(s)) return mk(14, 21, '上上周');
  if (/(上个月|上月)/.test(s)) return mk(30, 60, '上个月');
  if (/(这个月|本月)/.test(s)) return mk(0, 30, '这个月');
  if (/(上个星期|上个礼拜|上星期|上礼拜|上周)/.test(s)) return mk(7, 14, '上周');
  if (/(这个星期|这个礼拜|这周|本周)/.test(s)) return mk(0, 7, '这周');
  if (/大前天/.test(s)) return mk(3, 4, '大前天');
  if (/前天/.test(s)) return mk(2, 3, '前天');
  if (/(昨天|昨日)/.test(s)) return mk(1, 2, '昨天');
  if (/(今天|今日|今儿)/.test(s)) return mk(0, 1, '今天');
  if (/(刚才|刚刚)/.test(s)) return mk(0, 0.25, '刚才');
  if (/(去年|上一年)/.test(s)) return mk(365, 730, '去年');
  if (/(这几天|这两天|这几日|这段时间|最近|最新|近期)/.test(s)) return mk(0, 7, '最近');
  if (/(很久以前|最早期|最早|最初|最久|头一回|第一次|刚开始|最开头|老早)/.test(s)) return mk(0, 1e9, '最早期');
  return null;
}

/**
 * 剥离时间词，得到「纯主题」。
 * @returns {string} 剥离后的残句（可能为空）
 */
export function stripTimeWords(q) {
  let s = String(q || '');
  if (!s) return '';
  // 绝对日期先整体去掉
  s = s.replace(RE_ABS_ISO, ' ');
  s = s.replace(RE_ABS_CN, ' ');
  // 相对量词整体去掉（连数字一起）
  s = s.replace(/(\d+|[一二两三四五六七八九十]+)\s*天\s*(?:以)?前/g, ' ');
  s = s.replace(/(\d+|[一二两三四五六七八九十]+)\s*(?:个)?(?:周|星期|礼拜)\s*(?:以)?前/g, ' ');
  s = s.replace(/(\d+|[一二两三四五六七八九十]+)\s*个?月\s*(?:以)?前/g, ' ');
  // 固定词（最长优先一次性替换）
  s = s.replace(STRIP_RE, ' ');
  // 清掉纯语气虚词与标点
  s = s.replace(/[的了吗呢吧啊呀嘛哦噢诶欸诶、，。！？,.!?；;：:\s]+/g, ' ').trim();
  // 清掉残留的指示代词 / 量词（「那个L0零召回」→「L0零召回」）
  s = s.replace(/^(?:那个|这个|那些|这些|那次|那回|那件|这件)\s*/g, '');
  s = s.replace(/\s+(?:那个|这个|那些|这些|那次|那回|那件|这件)$/g, '');
  return s.trim();
}

/** 纯虚词 / 纯提问套话（剥离后只剩这些 ⇒ 纯时间问句） */
const FILLER_RE = /^(?:我们|咱们|咱|我|你|他|她|它|Assistant|User|都|还|又|在|是|有|和|跟|给|把|被|让|那个|这个|那些|这些|那|这|什么|啥|干什么|做什么|做了啥|干了什么|干了啥|做什么了|聊什么|聊了什么|聊聊|聊|说说|说|做|干|搞|弄|到哪|在哪|哪儿|哪里|怎么样|怎么|怎样|如何|哪|哪了|哪儿了|情况|事情|事儿|事|一下|来着|过|了|的|吗|呢|吧|啊|呀|嘛|哦|噢|嗯|一起|都干了|都做了|都聊了|都说了)+$/;

/**
 * 判断剥离后的残句是否「纯时间问句」（没有可检索的主题）。
 * @param {string} topic stripTimeWords() 的返回值
 */
export function isPureTimeQuery(topic) {
  const t = String(topic || '').replace(/\s+/g, '');
  if (!t) return true;                    // 「昨天」「上周」—— 空 ⇒ 纯时间
  if (t.length <= 1) return true;         // 单个字没有检索意义
  return FILLER_RE.test(t);
}

/**
 * 卡片年龄（天）。优先 eventTs（真实事件时间），退化到 createdAt。
 * ⚠️ 不受 eventTsEnabled 开关影响 —— 这是本函数自身的口径：
 *    「有 eventTs 就用 eventTs，没有才用 createdAt」，这本身就比只用 createdAt 更准。
 *    若要严格回到旧口径，调用方传 { preferEventTs: false }。
 * @param {object} card
 * @param {number} nowMs
 * @param {{preferEventTs?: boolean}} [opts]
 */
export function ageDaysOf(card, nowMs, opts) {
  const NOW = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();
  if (!card) return Infinity;
  const prefer = !opts || opts.preferEventTs !== false;
  if (prefer) {
    const e = Number(card.eventTs);
    if (Number.isFinite(e) && e > 0) return (NOW - e) / DAY_MS;
  }
  const v = card.createdAt;
  let n = 0;
  if (typeof v === 'number') n = v;
  else if (typeof v === 'string' && v) n = Date.parse(v);
  if (!Number.isFinite(n) || n <= 0) return Infinity;
  return (NOW - n) / DAY_MS;
}

/** hits 封顶：防单张高 hits 卡在窗口内固定霸榜（与 strengthOf 同口径思路） */
const HITS_CAP = 50;

/**
 * 窗口内排序权重（纯时间问句用）。
 * 原型实测：按时间倒序全是 L0 轮次/视频卡噪声（imp 0.25~0.30）；
 *          按 prominence 才捞出「真正干的事」。
 */
export function prominenceOf(card) {
  if (!card) return 0;
  const imp = Number(card.importance);
  const hits = Number(card.hits);
  const title = String(card.title || '');
  const impScore = (Number.isFinite(imp) ? imp : 0) * 10;
  const hitScore = Math.log1p(Math.min(Number.isFinite(hits) ? hits : 0, HITS_CAP)) * 3;
  const titleScore = title.length >= 6 ? 2 : 0;
  return impScore + hitScore + titleScore;
}

export default { parseTimeWindow, stripTimeWords, isPureTimeQuery, ageDaysOf, prominenceOf };
