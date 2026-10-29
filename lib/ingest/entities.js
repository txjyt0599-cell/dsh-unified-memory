/**
 * ingest/entities.js —— 期8.3.1：写入侧实体抽取（规则法，零 LLM 开销）
 * [2026-10-23 by Assistant · 期8.3.1]
 *
 * 为什么单独成文件：
 *   ① extract.js（L1）与 distill.js（engram）两条写入路径必须用**同一套规则**，
 *      否则两库实体口径漂移 ⇒ 超图二部图左右两边不可比。
 *   ② scripts/backfill-entities.mjs（存量回填）要复用同一函数，做到
 *      「新卡自产」与「旧卡回填」逐位一致。
 *
 * 设计约束（来自 Lead 派单）：
 *   · 不额外调 LLM（写入侧已经花过一次钱了，蒸馏是高频路径）
 *   · 小写归一、长度 2~20
 *   · 去掉纯停用词与纯数字
 *   · 优先技术名词 / 工具名 / 参数名 / 错误码
 *   · 不收「在和」「用户」这类泛词
 *
 * 与 graph.js 的 deriveEntities 的关系：
 *   deriveEntities 是**退化路径**——卡上没有 entities 时才从标题滑窗抽词元，
 *   会产出「在和」「用户」这类噪声。本模块是**正路**，产出即写入卡字段。
 *   本文件**不 import graph.js、不改 graph.js**（铁律：别人的成果）。
 *
 * 关闭时逐位等同现状：本模块只产出 string[]，调用方不写就是没影响；
 *   extract/distill 里始终写（无开关），因为写字段是纯增量、向后兼容。
 */
import { readFileSync, existsSync, statSync } from 'node:fs';
import { dataPath } from '../paths.js';

export const DEFAULT_ENTITIES_CONFIG_PATH = dataPath('ingest/entities.json');

/** 默认旋钮：全部保守，改之前先看 selftest-ingest.mjs 的 ENT-* 用例。 */
export const DEFAULT_ENTITIES = {
  enabled: true,          // 总闸：false ⇒ extractEntities 永远返回 []
  maxEntities: 12,        // 单卡最多收几个
  minAscii: 3,            // ASCII 术语最短长度
  maxLen: 20,             // 实体最长长度（派单硬要求 2~20）
  techLexicon: true,      // 是否启用中文技术词表
  slideWindow: false,      // 中文 bigram 滑窗（默认关，见 extractEntities ⑥ 的实测说明）
  paths: true,            // 是否抽路径
  errorCodes: true,       // 是否抽错误码
};

// ── 停用词 ────────────────────────────────────────────────────────
// 中文泛词：deriveEntities 滑窗噪声的主要来源（「在和」「用户」「这个」「我们」…）。
// 收词原则：只在**对话连接成分**上收，不收可能是真术语的词（如「缓存」「管道」）。
const STOP_ZH = new Set([
  '在和', '用户', '我们', '你们', '他们', '她们', '它们', '自己', '这个', '那个',
  '这些', '那些', '这样', '那样', '如何', '什么', '为什么', '怎么', '怎样', '可以',
  '不能', '没有', '已经', '还是', '但是', '因为', '所以', '如果', '虽然', '然后',
  '而且', '并且', '或者', '于是', '就是', '不是', '可能', '应该', '需要', '觉得',
  '认为', '知道', '看到', '发现', '出现', '存在', '进行', '完成', '开始', '结束',
  '一下', '一直', '一点', '一些', '一般', '非常', '特别', '真的', '确实', '当然',
  '现在', '目前', '之前', '之后', '当时', '后来', '时候', '问题', '情况', '事情',
  '东西', '方式', '方法', '内容', '结果', '过程', '部分', '地方', '时间', '时候',
  'User', 'Assistant', '助手', '回答', '提问', '对话', '会话', '消息', '说明', '介绍',
  '关于', '对于', '通过', '根据', '按照', '由于', '为了', '以及', '等等', '其他',
  '上面', '下面', '里面', '外面', '前面', '后面', '中间', '左右', '前后', '同时',
  '还有', '再有', '另外', '其次', '首先', '最后', '总之', '例如', '比如', '尤其',
]);

// 英文泛词（ASCII 抽取后的过滤）
const STOP_EN = new Set([
  'the', 'and', 'for', 'you', 'are', 'was', 'were', 'this', 'that', 'with',
  'from', 'have', 'has', 'had', 'not', 'but', 'can', 'will', 'would', 'should',
  'could', 'get', 'got', 'set', 'put', 'use', 'used', 'using', 'make', 'made',
  'see', 'saw', 'say', 'said', 'now', 'then', 'than', 'here', 'there', 'when',
  'what', 'how', 'why', 'who', 'all', 'any', 'some', 'out', 'into', 'over',
  'them', 'they', 'their', 'his', 'her', 'its', 'our', 'your', 'mine', 'yes',
  'not', 'null', 'true', 'false', 'undefined', 'nan', 'inf',
]);

/**
 * 中文技术词表 —— 白名单式命中。
 * 为什么用词表而不是分词：不许引第三方依赖 ⇒ 没有词典、没有 jieba。
 *   中文串滑窗会造出大量伪词（「在和」「户喜」），度惩罚压得住噪声但语义质量差。
 *   折中：**词表命中优先**，词表命中的词直接收；未命中的中文串再走 2~4 字滑窗，
 *   但滑窗结果必须过 STOP_ZH 且必须**在卡里出现 ≥2 次**才收（压一次性噪声）。
 */
const TECH_ZH = [
  // ── 本仓库 / 本项目专有名词 ──
  '超图', '二部图', '度惩罚', '扩散', '关联矩阵', '入射矩阵', '事实卡', '实体',
  '隐式超图', '代数超图', '阈值', '噪声', '召回', '检索', '蒸馏', '提取', '捕获',
  '写入侧', '检索侧', '回填', '游标', '去重', '指纹', '置信度', '权重', '排序',
  '衰减', '合并', '退役', '状态机', '判决', '阻断', '干扰', '滑窗', '词元',
  // ── 记忆/存储 ──
  '记忆', '缓存', '索引', '分片', '快照', '备份', '归档', '迁移', '持久化',
  '落盘', '回滚', '版本', '日志', '游标', '并发', '锁', '原子写',
  // ── 系统与硬件 ──
  '显存', '内存', '显卡', '驱动', '编译', '编译器', '内核', '进程', '线程',
  '定时器', '端口', '服务', '守护进程', '优先级', '调度', '中断', '溢出',
  '并发数', '线程数', '批处理', '批处理脚本', '注册表', '环境变量', '路径',
  '软链接', '硬链接', '目录', '文件', '磁盘', '分区', '文件系统',
  // ── AI / 模型 ──
  '模型', '推理', '量化', '微调', '提示词', '嵌入', '向量', '分词', '词表',
  '注意力', '采样', '温度', '上下文', '窗口', '令牌', '上下文长度',
  '显卡驱动', '算力', '算力平台', '算子', '算子库',
  // ── 工程概念 ──
  '配置', '参数', '开关', '闸门', '铁律', '契约', '接口', '依赖', '模块',
  '插件', '钩子', '回调', '异步', '同步', '队列', '缓冲', '栈', '堆',
  '错误码', '异常', '崩溃', '超时', '重试', '降级', '熔断', '限流', '超时重传',
  '自测', '基准', '基准测试', '回归', '覆盖率', '命中率', '准确率', '召回率',
  '验收', '审计', '复核', '派单', '看板', '任务', '子任务',
  // ── 领域词表示例（使用者按自己的领域替换）──
  '领域词A', '领域词B', '领域词C',
  '规程', '巡检', '机组', '水库', '水位', '流量', '压力', '温度', '水质',
  '除盐', '离子交换', '树脂', '泵', '电机', '开关柜', '母线', '继电保护',
];

// ── 正则 ──────────────────────────────────────────────────────────
// 路径：Windows（D:... / D:/...）、POSIX（/usr/...）、相对（lib/ingest/x.js）
const RE_PATH = /(?:[A-Za-z]:)?[\/](?:[w.-一-龥]+[\/])+[w.-一-龥]+/g;
const RE_PATH_SEG = /[w.-]+/g;
// 错误码：0x 开头 / E 大写前缀 / HTTP 数字 / HRESULT-ish
const RE_ERRCODE = /(?:0x[0-9a-fA-F]{2,}|E[A-Z_]{2,}|[A-Z]{2,}_[A-Z_]{2,}|(?:hip|HIP|cuda|CUDA|rocm|ROCm)?Error[A-Za-z]*|HSA_STATUS_[A-Z_]+)/g;
// ASCII 术语：含点/下划线/短横的标识符
const RE_ASCII = /[A-Za-z][A-Za-z0-9._-]{2,}/g;
// 版本号：v1.2.3 / 8.3 / 1024（纯数字不收，但带点的版本号收）
const RE_VERSION = /[A-Za-z][A-Za-z0-9]*[-_]?d+(?:.d+)+|v?d+.d+(?:.d+)*/g;
// 连续中文串
const RE_CJK = /[一-龥]{2,}/g;

// ── 配置读取（按 mtime 缓存，与 config.js 同一套路）────────────────
let _cache = { path: '', mtime: -1, value: null };

export function loadEntitiesConfig(path) {
  const p = String(path || DEFAULT_ENTITIES_CONFIG_PATH);
  try {
    if (!existsSync(p)) return Object.assign({}, DEFAULT_ENTITIES);
    const st = statSync(p);
    if (_cache.path === p && _cache.mtime === st.mtimeMs && _cache.value) return _cache.value;
    let raw = {};
    try { raw = JSON.parse(readFileSync(p, 'utf8')); } catch { raw = {}; }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) raw = {};
    const merged = Object.assign({}, DEFAULT_ENTITIES, raw);
    _cache = { path: p, mtime: st.mtimeMs, value: merged };
    return merged;
  } catch {
    return Object.assign({}, DEFAULT_ENTITIES);
  }
}

/** 小写归一（与 graph.js normEntity 同口径：trim + toLowerCase） */
function norm(s) {
  // [2026-10-23 实测补丁] 先剥掉首尾的中英文标点再归一：
  //   路径正则会把句末的句号一起吞进去，产出 "d:/tmp/build.log。" 这种脏实体
  //   （实测抓到）。strip 后再做长度/停用词判断，避免脏值挤占名额。
  return String(s === undefined || s === null ? '' : s)
    .replace(/^[\s\u3000.,;:!?，。；：！？、)\]}'"]+/, '')
    .replace(/[\s\u3000.,;:!?，。；：！？、)\]}'"]+$/, '')
    .trim().toLowerCase();
}

function isPureNum(s) {
  return /^d+$/.test(s);
}

/**
 * 抽取实体（核心）。
 *
 * 优先级：路径 > 错误码 > 版本号 > ASCII 术语 > 中文技术词表 > 中文高频滑窗
 * 为什么这么排：越靠前的信号**区分度越高、噪声越低**。前四类是硬信号
 * （出现即大概率是真术语），最后两类是软信号（要过词频门槛）。
 *
 * @param {{title?:string,summary?:string,content?:string,scene_name?:string}} card
 * @param {Partial<typeof DEFAULT_ENTITIES>} [opts]
 * @returns {string[]} 已小写归一、去重、按「信号强度」排序
 */
export function extractEntities(card, opts) {
  const cfg = Object.assign({}, DEFAULT_ENTITIES, loadEntitiesConfig(), opts || {});
  if (cfg.enabled === false) return [];
  const c = card || {};
  const text = [c.title, c.summary, c.content, c.scene_name]
    .map((v) => String(v === undefined || v === null ? '' : v))
    .join('\n');
  if (!text.trim()) return [];

  const score = new Map();     // entity -> 信号强度（越大越靠前）
  const freq = new Map();      // 中文滑窗用的出现次数

  const bump = (e, w) => {
    const n = norm(e);
    if (!n) return;
    if (n.length < 2 || n.length > cfg.maxLen) return;
    if (isPureNum(n)) return;                 // 纯数字：派单明确去掉
    if (STOP_EN.has(n)) return;
    if (STOP_ZH.has(n)) return;
    score.set(n, (score.get(n) || 0) + w);
  };

  // ① 路径（权重最高：一个路径几乎唯一标识一处代码/数据）
  if (cfg.paths) {
    const paths = text.match(RE_PATH) || [];
    for (const p of paths) {
      // 路径整体太长（>maxLen）就退到「末段文件名」，避免整条长路径当实体
      if (p.length <= cfg.maxLen) { bump(p, 6); continue; }
      const segs = p.match(RE_PATH_SEG) || [];
      const tail = segs[segs.length - 1];
      if (tail && tail.length >= 2) bump(tail, 5);
    }
  }

  // ② 错误码
  if (cfg.errorCodes) {
    const codes = text.match(RE_ERRCODE) || [];
    for (const e of codes) bump(e, 5);
  }

  // ③ 版本号（v1.2.3 / 8.3 这类带点的才收，纯数字不收）
  const vers = text.match(RE_VERSION) || [];
  for (const v of vers) bump(v, 4);

  // ④ ASCII 术语（英文标识符 / 工具名 / 参数名）
  const ascii = text.match(RE_ASCII) || [];
  for (const w of ascii) {
    if (w.length < cfg.minAscii) continue;
    // 全大写且长度 ≥4 的疑似常量（MAX_JOBS）加权重
    const isConst = /^[A-Z0-9_]+$/.test(w) && w.length >= 4;
    bump(w, isConst ? 4 : 3);
  }

  // ⑤ 中文技术词表（白名单，权重高）
  if (cfg.techLexicon) {
    for (const t of TECH_ZH) {
      if (text.indexOf(t) >= 0) bump(t, 5);
    }
  }

  // ⑥ 中文滑窗：仅 2 字（bigram），且全文出现 ≥3 次，且**最多补 4 个**。
  //    [2026-10-23 实测修订] 初版是 2~4 字窗 + ≥2 次，dry-run 一跑就露馅：
  //      「且无自动」「制已根治」「动重建机」「数据旧且」这类**跨词边界的伪词**
  //      占满了 12 个名额 —— 它们只是碰巧重复，不是术语。
  //    收紧三处：长度锁 2 字（3/4 字窗跨边界概率大得多）、频次门槛 ≥3、
  //    名额封顶 4 个 ⇒ 硬信号（路径/错误码/版本号/英文标识符/技术词表）永远优先。
  if (cfg.slideWindow === true) {
  const SLIDE_MIN_FREQ = 3;
  const SLIDE_MAX_TAKE = 4;
  const cjkRuns = text.match(RE_CJK) || [];
  for (const run of cjkRuns) {
    for (let i = 0; i + 2 <= run.length; i++) {
      const w = run.slice(i, i + 2);
      if (STOP_ZH.has(w)) continue;
      freq.set(w, (freq.get(w) || 0) + 1);
    }
  }
  const slides = Array.from(freq.entries())
    .filter((e) => e[1] >= SLIDE_MIN_FREQ && !score.has(e[0]))
    .sort((a, b) => (b[1] - a[1]) || (a[0] < b[0] ? -1 : 1))
    .slice(0, SLIDE_MAX_TAKE);
  for (const e of slides) score.set(e[0], 1);   // 软信号，权重最低
  }

  // 排序：信号强度降序 → 长度降序（长词信息量更大） → 字典序（稳定）
  const out = Array.from(score.entries()).sort((a, b) => {
    if (b[1] !== a[1]) return b[1] - a[1];
    if (b[0].length !== a[0].length) return b[0].length - a[0].length;
    return a[0] < b[0] ? -1 : 1;
  }).map((x) => x[0]);

  return out.slice(0, cfg.maxEntities);
}

/** 给自测/回填用：同一张卡跑 N 次的平均耗时（毫秒） */
export function benchExtractEntities(cards, iterations) {
  const n = Math.max(1, Number(iterations) || 20);
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < n; i++) for (const c of cards) extractEntities(c);
  const t1 = process.hrtime.bigint();
  return Number(t1 - t0) / 1e6;
}

export default { extractEntities, loadEntitiesConfig, benchExtractEntities, DEFAULT_ENTITIES, DEFAULT_ENTITIES_CONFIG_PATH };
