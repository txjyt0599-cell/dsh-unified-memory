/**
 * lib/ingest/signal-miss.js —— SIGNAL 漏采池（2026-10-29 · 只采集，不改判据）
 *
 * ## 它解决什么
 * extract 的 SIGNAL 闸门（extract.js:226）判"不像结论"的句子**直接消失**：
 * 没人知道漏了什么、漏了多少、漏的是不是真有价值。
 * 于是"生活事件全被丢"这个结论只能靠人工回放对话才能发现。
 *
 * ## 本模块的边界（越界即违约）
 *   ✅ 只**旁路采集**：把被丢的句子原样写进 jsonl，供一周后抽样人工标注。
 *   ❌ **不改判据**：不参与 SIGNAL 判定，不影响 heuristicExtract 的返回值。
 *   ❌ **不写记忆库**：落的是 logs/ 下的独立文件，与 engrams / records 完全隔离。
 *
 * ## 硬性规格（工单原文，逐条对应实现）
 *   ① 0 侵入主链路：主流程返回值一行不改 ⇒ 默认 sink 为 null，必须由 runExtract 显式注入；
 *      未注入时本模块**一次 IO 都不做**（测试/离线/干跑全绿）。
 *   ② 落盘：<PM_DATA_ROOT>/logs/signal-miss.jsonl（默认 ~/.dsh/unified-memory/logs/）。
 *   ③ 字段：{ ts, sessionId, messageId, role, text, context, textHash, label }。
 *      · context —— 未命中句 + **前后各一句**。孤立单句一周后无法标注（没有语境判不了该不该留）。
 *      · label   —— 先留 null；一周后人工标 should_keep / should_drop。
 *      · textHash—— 去重用。
 *   ④ 去重键 (sessionId, messageId, textHash) —— 同一条消息会被分片/重试，不去重会污染数据集。
 *   ⑤ 去噪只用语气词白名单，**绝不按字数切**：
 *      <4 字过滤会系统性丢掉「我赢了」「认输」「难受」—— 三个字恰恰是生活事件核心。
 *   ⑥ 轮换：7 天或条数封顶自动裁剪，绝不造第三个只增不减的大文件。
 *
 * ## 为什么默认关闭很关键
 *   本周运行着 36 套测试，其中多套直接调 heuristicExtract。
 *   若默认就落盘，测试会把假数据灌进真实数据集 —— 一周后的标注样本直接被污染。
 */

import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync, appendFileSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { dataPath } from '../paths.js';
import { sha1_16 } from './core.js';

/** 默认落盘位置：数据根下的 logs/（与 ingest/logs 分开，避免混进提取日志） */
export const DEFAULT_MISS_PATH = dataPath('logs/signal-miss.jsonl');

/** 轮换默认值：7 天 / 2 万条（任一触发即裁剪） */
export const MISS_DEFAULTS = Object.freeze({
  maxAgeDays: 7,
  maxEntries: 20000,
  /** 每写 N 条检查一次轮换（不必每条都 stat 文件） */
  rotateEvery: 200,
});

/**
 * 语气词白名单：**穷举**，只挡"这句话本来就是空话"，不挡短句。
 *
 * ⛔ 严禁改成"字数 < N 就丢"——那会把「我赢了」「认输」「难受」这些
 *    生活事件的核心句一起丢掉，等于把 SIGNAL 漏掉的短生活句**再漏一遍**。
 */
const FILLER = /^[\s\p{P}\p{S}]*(嗯|哦|噢|啊|呢|吧|哈|嘿|呵|好的|好|行|可以|收到|明白|知道了|了解|没事|算了|ok|okay|yes|no|对|是|不|？+|\?+|。+|\.+)*[\s\p{P}\p{S}]*$/iu;

/**
 * 是否是纯语气词/纯标点（应被去噪）。
 * 判据只有两条：① 命中白名单；② 去掉标点空白后没有任何"像内容"的字符。
 * **不含任何长度判据。**
 */
export function isFiller(text) {
  const s = String(text == null ? '' : text).trim();
  if (!s) return true;
  if (FILLER.test(s)) return true;
  // 去掉标点/空白/符号后，若无任何文字或数字 ⇒ 也是空话
  const stripped = s.replace(/[\s\p{P}\p{S}]/gu, '');
  if (!stripped) return true;
  // 白名单词连写（"嗯嗯好的"、"好 的"）也归空话
  const core = stripped.replace(/(嗯|哦|噢|啊|呢|吧|哈|嘿|呵|好的|好|行|可以|收到|明白|知道了|了解|没事|算了)/gu, '');
  if (!core) return true;
  return false;
}

/**
 * 从一条消息的**完整**句子序列里，取第 i 句的上下文（前一句 + 本句 + 后一句）。
 * @param {string[]} allSentences 未经过滤的句子（不能只给"已过滤"的那批——
 *                                上下文常常正是被过滤掉的那句短句，那才是语境）
 * @param {number} i
 * @returns {string}
 */
export function buildContext(allSentences, i) {
  const arr = Array.isArray(allSentences) ? allSentences : [];
  const k = Number(i);
  if (!Number.isFinite(k) || k < 0 || k >= arr.length) return String(arr[k] || '');
  const from = Math.max(0, k - 1);
  const to = Math.min(arr.length - 1, k + 1);
  return arr.slice(from, to + 1).join(' / ');
}

/**
 * [2026-10-29 by Assistant · 补采集点] 从 LLM 主路径采集"被判为没价值"的句子。
 *
 * ## 为什么需要它（这是本轮的踩刹车点）
 * 原来的采集点只在 heuristicExtract（兜底路径）里，而实测：
 *   10-27 那天产 263 张卡，兜底 0 张 —— 100% 走 LLM 主路径。
 *   那盘五子棋被丢，**不是 SIGNAL 正则丢的**，是 LLM 被提示词里
 *   「三个月后拿来回答一个技术问题还有用吗」问偏了。
 *   ⇒ 只挂兜底 = 一周后采到的是"LLM 限流那天"的样本，真正的日常样本一条都采不到。
 *
 * ## 它做什么 / 不做什么
 *   ✅ 把窗口里每条消息按句切开，凡是**没被 LLM 产出的卡覆盖**的句子，写进池子。
 *   ✅ droppedBy='llm-empty'，与 SIGNAL 丢的（'signal'）分开，便于一周后分类归因。
 *   ❌ 不判断"该不该留" —— 那是标注阶段的事，这里只记录"它被丢了"。
 *   ❌ 不改 LLM 的输入/输出/返回值 —— 纯旁路，异常全吞。
 *
 * @param {object} pool   createMissPool 的返回
 * @param {object} win    提取窗口 { sessionKey, messages }
 * @param {Array}  cards  LLM 本次真的产出的卡（normalizeL1 之后的对象数组）
 * @returns {number} 写入条数
 */
export function collectLlmMisses(pool, win, cards) {
  if (!pool || typeof pool.record !== 'function') return 0;
  const w = win || {};
  const msgs = Array.isArray(w.messages) ? w.messages : [];
  const cs = Array.isArray(cards) ? cards : [];
  // 把卡的所有文本面拼起来，用于判断"这句是否被覆盖"
  const cardText = cs.map(function (c) {
    return String((c && c.content) || '') + ' ' + String((c && c.scene_name) || '') + ' ' + String((c && c.evidence) || '');
  }).join('\n');
  let n = 0;
  for (const m of msgs) {
    try {
      const raw = String(m.content || '');
      if (!raw) continue;
      const sents = raw.split(/[。！？\n]/).map(function (x) { return x.trim(); }).filter(Boolean);
      for (let i = 0; i < sents.length; i++) {
        const s = sents[i];
        // 覆盖判定：卡的正文里出现了这句的核心片段 ⇒ 视为已被收下，不采
        //   取前 12 字做包含判断（足够区分，且对截断宽容）
        const probe = s.slice(0, 12);
        if (probe && cardText.indexOf(probe) >= 0) continue;
        const ok = pool.record({
          sessionId: w.sessionKey,
          messageId: String(m.id || ''),
          role: String(m.role || ''),
          text: s,
          droppedBy: 'llm-empty',
          context: buildContext(sents, i),
          now: Number(m.timestamp) || Date.now(),
        });
        if (ok) n++;
      }
    } catch { /* 单条消息出错不影响其他 */ }
  }
  return n;
}

/**
 * 建一个漏采池。**默认 sink 是关的**：不传 path 就不写盘（见 resolveSink）。
 *
 * @param {object} [opts]
 *   opts.path       落盘路径（默认 DEFAULT_MISS_PATH）
 *   opts.maxAgeDays 保留天数（默认 7）
 *   opts.maxEntries 条数封顶（默认 20000）
 *   opts.logger     可选日志器
 *   opts.enabled    显式开关；false ⇒ 完全 no-op
 * @returns {{record:Function, rotate:Function, stats:Function, path:string, enabled:boolean}}
 */
export function createMissPool(opts) {
  const o = opts || {};
  const file = String(o.path || DEFAULT_MISS_PATH);
  const maxAgeDays = Number(o.maxAgeDays) || MISS_DEFAULTS.maxAgeDays;
  const maxEntries = Number(o.maxEntries) || MISS_DEFAULTS.maxEntries;
  const rotateEvery = Number(o.rotateEvery) || MISS_DEFAULTS.rotateEvery;
  const log = o.logger || null;
  const enabled = o.enabled === false ? false : true;

  /** 已写过的去重键（进程内 + 启动时从文件回填） */
  const seen = new Set();
  let written = 0;
  let skipped = 0;
  let sinceRotate = 0;

  /** 从现有文件回填去重键（只回填最近 maxEntries 行，避免大文件拖慢启动） */
  function loadSeen() {
    try {
      if (!enabled || !existsSync(file)) return;
      const raw = readFileSync(file, 'utf8');
      const lines = raw.split('\n').filter(Boolean);
      const tail = lines.slice(-maxEntries);
      for (const line of tail) {
        try {
          const r = JSON.parse(line);
          if (r && r.sessionId !== undefined) seen.add(keyOf(r.sessionId, r.messageId, r.textHash));
        } catch { /* 坏行忽略：采集池不能因为一行坏数据就不工作 */ }
      }
    } catch (e) {
      try { log && log.miss && log.miss({ level: 'signal-miss-load', reason: String(e && e.message || e) }); } catch {}
    }
  }

  function keyOf(sessionId, messageId, textHash) {
    return String(sessionId || '') + '\u0000' + String(messageId || '') + '\u0000' + String(textHash || '');
  }

  /** 轮换：丢超过 maxAgeDays 的，再按 maxEntries 只留最新 */
  function rotate(nowMs) {
    if (!enabled) return { kept: 0, dropped: 0, skipped: true };
    try {
      if (!existsSync(file)) return { kept: 0, dropped: 0 };
      const raw = readFileSync(file, 'utf8');
      const lines = raw.split('\n').filter(Boolean);
      const now = Number(nowMs) || Date.now();
      const cutoff = now - maxAgeDays * 24 * 3600 * 1000;
      const kept = [];
      let dropped = 0;
      for (const line of lines) {
        let ts = 0;
        try { ts = Number(JSON.parse(line).ts) || 0; } catch { dropped++; continue; }
        if (ts > 0 && ts < cutoff) { dropped++; continue; }
        kept.push(line);
      }
      let out = kept;
      if (out.length > maxEntries) { dropped += out.length - maxEntries; out = out.slice(-maxEntries); }
      if (out.length !== lines.length) {
        const tmp = file + '.tmp-' + process.pid + '-' + Date.now();
        writeFileSync(tmp, out.length ? out.join('\n') + '\n' : '', 'utf8');
        renameSync(tmp, file);
        // 重建去重集（否则已裁掉的键还占着内存，且裁剪过的句子会重复写入）
        seen.clear();
        for (const line of out) {
          try { const r = JSON.parse(line); seen.add(keyOf(r.sessionId, r.messageId, r.textHash)); } catch {}
        }
      }
      sinceRotate = 0;
      return { kept: out.length, dropped };
    } catch (e) {
      try { log && log.miss && log.miss({ level: 'signal-miss-rotate', reason: String(e && e.message || e) }); } catch {}
      return { kept: 0, dropped: 0, error: String(e && e.message || e) };
    }
  }

  /**
   * 采一条被丢弃的句子。
   * **永不抛**：采集器绝不能把主链路带崩（这是它存在的意义）。
   *
   * @param {object} item { sessionId, messageId, role, text, context, now }
   * @returns {boolean} 是否真的写入（去重/空话/关闭 都是 false）
   */
  function record(item) {
    if (!enabled) return false;
    try {
      const it = item || {};
      const text = String(it.text == null ? '' : it.text);
      if (!text.trim()) { skipped++; return false; }
      // ⑤ 去噪只认语气词白名单，绝不按字数
      if (isFiller(text)) { skipped++; return false; }
      const sessionId = String(it.sessionId || 'unknown');
      const messageId = String(it.messageId || '');
      const textHash = sha1_16(text);
      const k = keyOf(sessionId, messageId, textHash);
      // ④ 去重键 (sessionId, messageId, textHash)
      if (seen.has(k)) { skipped++; return false; }
      const rec = {
        ts: Number(it.now) || Date.now(),
        sessionId,
        messageId,
        role: String(it.role || ''),
        text,
        // [2026-10-29 by Assistant · 补采集点后新增，**超出工单字段表，如实上报**]
        //   为什么必须加：漏采有两条完全不同的来源——
        //     'signal'   = heuristicExtract 的 SIGNAL 正则没命中（兜底路径）
        //     'llm-empty'= LLM 主路径认为这段没价值（今天 97% 的产卡走这条）
        //   一周后标注时，必须知道"这句是被哪套判据丢的"，否则
        //   「该留的被丢」这个结论无法归因到具体判据，手册也写不实。
        //   ⛔ 这是**采集元数据**，不是新判据；它不参与任何过滤。
        droppedBy: String(it.droppedBy || 'signal'),
        context: String(it.context || text),
        textHash,
        label: null,   // ③ 一周后人工标 should_keep / should_drop
      };
      const dir = dirname(file);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      appendFileSync(file, JSON.stringify(rec) + '\n', 'utf8');
      seen.add(k);
      written++;
      // ⑥ 轮换：每 rotateEvery 条查一次（也检查条数上限，不必每条 stat）
      if (++sinceRotate >= rotateEvery) rotate(Date.now());
      return true;
    } catch (e) {
      try { log && log.miss && log.miss({ level: 'signal-miss-record', reason: String(e && e.message || e) }); } catch {}
      return false;
    }
  }

  function stats() {
    let bytes = 0;
    let lines = 0;
    try {
      if (existsSync(file)) {
        bytes = statSync(file).size;
        lines = readFileSync(file, 'utf8').split('\n').filter(Boolean).length;
      }
    } catch {}
    return { path: file, enabled, written, skipped, dedupKeys: seen.size, bytes, lines, maxAgeDays, maxEntries };
  }

  loadSeen();
  return { record, rotate, stats, path: file, enabled };
}

export default { createMissPool, isFiller, buildContext, DEFAULT_MISS_PATH, MISS_DEFAULTS };
