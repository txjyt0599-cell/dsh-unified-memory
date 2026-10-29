/**
 * [2026-10-23 by Assistant · 白队补丁1 + 红队核心洞察]
 *
 * motifs（情境骨架）—— 名词实体管「是不是同一个东西」，motifs 管「是不是同一种经历」。
 *
 * User初心：「这个插件损坏了」→ 想起半年前另一个插件也这样坏过；
 *           「今天去溪头村徒步」→ 想起两年前重庆苍蝇馆子。
 *           **这两个例子里没有任何共同名词实体**，只有情境同构。
 *
 * 铁律（红队）：motifs 严禁出现具体专有名词，必须抽象为「现象模式 / 踩坑类型 / 情绪体验」。
 *
 * 白队补丁1：**绝不在实时检索链路上用 LLM**。这里是纯规则实现（零延迟零成本），
 *   可先在写入时同步算，也可以后续用便宜模型异步刷更好的版本。
 */

// ── 故障/排错类情境 ──
const FAULT_MOTIFS = [
  // [2026-10-23 修] 原正则太窄：'什么都没报' / '加载不出来' 这类最典型的静默失效都漏了
  [/静默(失效|失败|崩溃|退出)|(什么|啥|一点)(都)?(没|不)(报|提示|显示|反应)|没有报错|无报错|不吭声|悄悄(挂|死|停)|(加载|启动)不出|打不开|点了没反应/i, '组件静默失效'],
  [/被.*(杀|休眠|回收|终止)|杀掉|杀死|进程.*(没了|消失|退出)/i, '进程被回收'],
  [/权限|拒绝访问|access denied|permission/i, '权限陷阱'],
  [/路径|目录|中文路径|空格路径/i, '路径陷阱'],
  [/配置|config|yaml|json.*(格式|语法)/i, '配置陷阱'],
  [/缓存|stale|过期|不刷新/i, '缓存不一致'],
  [/重启|reload|热更(新|载)|没生效|still.*old/i, '改完没生效'],
  [/超时|timeout|卡住|hang|无响应/i, '超时无响应'],
  [/内存|OOM|溢出|爆显存/i, '资源耗尽'],
  [/版本|不兼容|incompatible|冲突/i, '版本不兼容'],
  [/索引|index.*(旧|落后|不同步)/i, '索引与数据不同步'],
  [/限流|429|rate.?limit|配额/i, '限流封顶'],
  [/降级|fallback|兜底/i, '降级兜底'],
];

// ── 认知/心情类情境 ──
const MOOD_MOTIFS = [
  [/顿悟|终于(明白|找到|知道)|原来|恍然大悟|找到了/i, '排错顿悟'],
  [/踩坑|坑|陷阱|翻车|上当/i, '踩坑经历'],
  [/死马当活马医|试试看|赌一把|没有别的办法/i, '死马当活马医'],
  [/白忙|没用|浪费|徒劳/i, '无效尝试'],
  [/折腾|来回|反复|又改回/i, '反复折腾'],
  [/没想到|意外|出乎意料/i, '意外发现'],
];

// ── 生活/体验类情境（User例子：「旅游」「看视频」）──
const LIFE_MOTIFS = [
  [/旅(游|行)|徒步|爬山|逛|景点|古镇|村/i, '旅途出行'],
  [/吃|美食|餐馆|苍蝇馆子|小吃|味道/i, '美食体验'],
  [/视(频|频)|电影|纪录片|看到.*(讲|说)/i, '影像触动'],
  [/震撼|绝了|好美|壮观|惊艳/i, '美感震撼'],
  [/狼狈|淋成|落汤鸡|惨|倒霉/i, '狼狈经历'],
  [/值得|不虚|难忘|记忆深刻/i, '值得铭记'],
  [/累|疲惫|走了.*(公里|小时)/i, '体力消耗'],
];

const ALL = [].concat(
  FAULT_MOTIFS.map(function (x) { return { re: x[0], motif: x[1], kind: 'fault' }; }),
  MOOD_MOTIFS.map(function (x) { return { re: x[0], motif: x[1], kind: 'mood' }; }),
  LIFE_MOTIFS.map(function (x) { return { re: x[0], motif: x[1], kind: 'life' }; })
);

/**
 * 从一段文本提取 0~3 个情境骨架。
 * @param {string} text  卡片的 title + content
 * @param {object} opts  { max: 3 }
 * @returns {string[]}   motifs 数组（可能为空 = 这张卡没有可抽象的情境）
 */
export function extractMotifs(text, opts) {
  const o = opts || {};
  const max = Number(o.max) || 3;
  const s = String(text || '');
  if (!s.trim()) return [];

  const found = [];
  const seen = new Set();
  for (const rule of ALL) {
    if (found.length >= max) break;
    if (seen.has(rule.motif)) continue;
    try {
      if (rule.re.test(s)) {
        found.push(rule.motif);
        seen.add(rule.motif);
      }
    } catch (e) {}
  }
  return found;
}

/** 判断一张卡是否值得有 motifs（太短的、纯流水账的没有情境） */
export function shouldHaveMotifs(text) {
  const s = String(text || '').trim();
  if (s.length < 12) return false;
  if (/^(好的|收到|继续|嗯|开始吧|可以)[。！]?$/.test(s)) return false;
  return true;
}

export default { extractMotifs, shouldHaveMotifs };


// ══════════════════════════════════════════════════════════════════
// [2026-10-23 by Assistant · 白队补丁1：LLM 版（异步离线，绝不在检索链路）
//
//   为什么规则法不够：
//     实测 3586 张卡，规则法产出 23 个 motif、1702 个标签，
//     但「配置陷阱」138 张卡、「改完没生效」152 张 —— **全成了超级节点**，
//     符合 deg 2~12 的只有 5 条，且那 5 条桥接的卡对语义完全不搭
//     （「美食体验」连到了桌宠 UI 和删模型）。
//     规则法只能看字面关键词，抓不到情境。
//
//   用法：写入 L1 时挂后台任务调本函数，结果固化进卡的 motifs 字段。
//        历史卡没刷不要紧 —— 闪回会退到 entities + 向量兜底。
// ══════════════════════════════════════════════════════════════════

export const MOTIF_SYSTEM_PROMPT = [
'你是记忆系统里负责抽象「情境骨架」的模块。',
'',
'给定一段记忆内容，从下面的【情境字典】里挑选 0~2 个最贴切的标签。',
'',
'## 铁律',
'1. **只能从字典里选**，一个字都不能改，不许自己造新词。',
'2. 选出的是「**这属于哪一类经历**」，不是「这件事具体是什么」。',
'3. 如果内容只是流水账、或与任何类别都不贴切，返回 []。',
'',
'## 情境字典（共 24 类）',
'【排错类】',
'- 静默失效：没报错、没反应、看起来正常但就是不工作',
'- 改完没生效：改了代码/配置但行为没变，通常是缓存或没重启',
'- 配置陷阱：配置文件语法/字段/格式写错',
'- 路径陷阱：路径含中文/空格/相对路径导致读不到',
'- 权限受阻：权限不足、拒绝访问',
'- 索引不同步：索引比数据旧、缓存与源不一致',
'- 资源耗尽：内存/显存/句柄爆了',
'- 版本冲突：版本不兼容、依赖打架',
'- 限流封顶：被限流、配额用尽、429',
'- 超时无响应：卡住、挂起、等不到返回',
'- 进程被回收：后台进程被系统杀掉/休眠回收',
'- 并发竞争：多进程/多线程争抢导致状态错乱',
'',
'【认知类】',
'- 排错顿悟：查了很久终于找到根因的那一刻',
'- 踩坑记录：踩了一个值得记住的坑',
'- 死马当活马医：没别的办法了试试看，结果成了',
'- 无效尝试：折腾半天没用的方向',
'- 判断失误：原先判断错了，后来纠正',
'- 反复折腾：来回改了很多次',
'',
'【协作类】',
'- 交接对齐：多方对接口径、确认理解一致',
'- 需求变更：目标中途改了',
'- 验收把关：检查是否真的达成',
'',
'【生活类】',
'- 旅途出行：去了某个地方、徒步、旅行',
'- 美食体验：吃了什么、哪家店',
'- 影像触动：看了视频/电影/纪录片',
'- 美的震撼：被景色或作品震到',
'- 狼狈经历：淋雨、出糗、倒霉',
'- 值得铭记：值得长期记住的体验',
'',
'## 输出',
'只输出 JSON 数组，元素必须**逐字来自上面字典**，最多 2 个。',
'例：["静默失效"] 或 ["配置陷阱","改行没生效"]',
'不符合任何一类就输出 []。不要解释。'
].join('\n');

/**
 * 用 LLM 提取 motifs（异步离线用，不要在检索链路里调）。
 * @param {object} ep        LLM 端点（resolveLlm 产物）
 * @param {string} text      卡片文本
 * @param {function} completeFn  complete(ep, system, user)
 * @returns {Promise<string[]>}
 */
export async function extractMotifsLLM(ep, text, completeFn) {
  const s = String(text || '').trim();
  if (!ep || !completeFn || s.length < 12) return [];
  let raw = null;
  try {
    raw = await completeFn(ep, MOTIF_SYSTEM_PROMPT, s.slice(0, 600));
  } catch (e) { return []; }
  if (!raw) return [];
  let arr = null;
  try {
    const m = String(raw).match(/\[[\s\S]*?\]/);
    if (m) arr = JSON.parse(m[0]);
  } catch (e) { return []; }
  if (!Array.isArray(arr)) return [];
  const out = [];
  const seen = new Set();
  for (const x of arr) {
    const v = String(x || '').trim().replace(/^["'\[]+|["'\]]+$/g, '');
    if (!v || v.length < 4 || v.length > 20) continue;
    if (seen.has(v)) continue;
    seen.add(v);
    out.push(v);
    if (out.length >= 2) break;
  }
  return out;
}
