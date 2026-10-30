import { readFileSync, statSync, readdirSync, existsSync } from 'node:fs';
// [2026-10-24 Step 5] 标题清洗：挡住 HTML 碎片/代码块当标题（注入里出现过 "- [卡] </style>"）
import { cleanTitle, isDirtyTitle, betterTdaiTitle } from '../ingest/title-clean.js';
// [2026-10-28 by Assistant · 老红项] 读侧统一出口补"合不合格"判据（cleanTitle 只管去脏）
import { isGoodTitle, sanitizeTitle } from '../ingest/normalize.js';
// [2026-10-24 Round 21] 标题去重（同标题多卡补差异点，让检索可区分）
import { dedupeTitles } from './dedupe-titles.mjs';
// [2026-10-24 Round 33] tdai 卡缺 importance 时当场算（与 L1/蒸馏同一套规则）
import { scoreImportance } from '../scoring/importance.js';
// [2026-10-24 Round 35] entities 缺失时补抽（与写入侧同一套规则）
import { extractEntities } from '../ingest/entities.js';
import { dataPath, dshHome, normalize } from '../paths.js';

/**
 * [2026-10-24 by Assistant · Round 35] **统一补全函数** —— 卡片字段缺了就当场算。
 *
 * 为什么要有它：importance 这个坑踩了四次（engram 回填 / L1 写入 / 蒸馏 / tdai），
 *   entities 又是一次（tdai 3176 张全空）。根因都是**在每个构造路径各修一遍**，
 *   修一处漏两处。
 * ⇒ 改成：三个数据源读出来后，**统一过一遍这个函数**。幂等、只读内存、不动磁盘。
 *
 * 补什么：
 *   · importance 缺失或等于基础分 0.25（早期占位值）⇒ 重算
 *   · is_axiom 未标记 ⇒ 跟着重算结果补
 *   · entities 为空且正文够长 ⇒ 用同一套规则抽（供超图/联想用）
 */
function enrichCard(c) {
  try {
    if (!c || typeof c !== 'object') return c;
    const content = String(c.content || '');
    if (!content.trim()) return c;              // 空内容不算脏，跳过

    let out = c;
    // ① importance / is_axiom 收紧与去伪存真（白队终审治理）
    //   过去由于规则宽松，导致 15%（1400+张）卡片被误标基石，大量工单/实验卡永不衰减。
    //   这里用收紧后的 scoreImportance 重新核定：排除工单/尝试/驳回等临时记录，
    //   真正将基石卡纯度收敛至物理公理与永久铁律（~3.8%）。
    const imp = Number(c.importance);
    const s = scoreImportance({
      title: String(c.title || ''),
      summary: String(c.summary || '').slice(0, 100),
      content,
      role: 'user',
      is_axiom: c.is_axiom === true,
      importance: Number.isFinite(imp) ? imp : undefined,
    });
    out = Object.assign({}, out, {
      importance: Number.isFinite(imp) && imp !== 0.25 ? imp : s.importance,
      is_axiom: s.is_axiom,
    });
    // ② entities（空且正文够长才补）
    if ((!Array.isArray(out.entities) || out.entities.length === 0) && content.length >= 12) {
      try {
        const ents = extractEntities({ title: String(out.title || ''), scene_name: String(out.title || ''), content });
        if (Array.isArray(ents) && ents.length) out = Object.assign({}, out, { entities: ents });
      } catch (e) { /* 抽不出就算了，不影响主流程 */ }
    }
    return out;
  } catch (e) { return c; }
}

/** engrams.jsonl 只读载入（铁律：绝不写） */
// [2026-10-22 by Assistant · 路径修复] 期5 已迁到云盘 live 目录。
// 原来的旧路径会让 cardMap / retriever 读到 6.5 小时前的旧数据（实测 mtime 差 10:47 vs 17:22），
// 表现就是「检索到新卡，但注入里显示旧标题/空摘要」。
export const DEFAULT_ENGRAM_PATH = dataPath('engram-relay/engrams.jsonl');

/**
 * [2026-10-22 by Assistant · 红队 P1 修复] 原注释说"读卡一律 LWW"，但这里确实**没有**做：
 *   它把每一行都 push 进 cards，eleven 只做 status 过滤 ⇒ 一张卡被「退役」后，
 *   它的旧 active 行仍然留在 cards 里（只是 alive 里没有），而 cardMap 用的是 alive，
 *   所以"看上去对"；但 all 的语义是错的（同 id 出现多次、含已退役的历史版本）。
 *   更糟的是：如果一张卡先 retired 后又 refreshed（追加新版本），旧 active 行会盖住新状态。
 *   现在一律按 id 取**最后一条**，last-write-wins 真正成立。
 */
export function readCards(file = DEFAULT_ENGRAM_PATH) {
  const st = statSync(file);
  const raw = readFileSync(file, 'utf8');
  const rawLines = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    rawLines.push(o);
  }
  const byId = new Map();
  for (const o of rawLines) {
    if (!o || o.id === undefined || o.id === null) continue;
    byId.set(String(o.id), o);
  }
  // [2026-10-24 Step 5] 读盘时统一清洗标题（存量 22 张是 HTML 碎片）。
  //   只在**内存对象**上改，不动磁盘 —— 读侧止血，写侧靠 distill 以后就干净了。
  // [2026-10-24 Step 5] 读盘时**无条件**过一遍 cleanTitle（幂等且便宜）。
  //   只改内存对象、不动磁盘 —— 读侧止血；写侧靠 distill 以后产的卡本身就干净。
  const cards = Array.from(byId.values()).map(function (c) {
    try {
      if (!c || typeof c !== 'object') return c;
      const body = String(c.content || c.summary || '');
      const clean = finalizeTitle(String(c.title || ''), body);
      // ── [2026-10-28 by Assistant · 老红项：2 张标题不合格] ──
      //   实测根因：cleanTitle 只负责"去脏"（HTML/框线/符号），**不判断合不合格**。
      //   ⇒ 「（无标题）」和半句「但它能成立」原样通过，在体检里挂了很久。
      //   为什么修在读侧：写侧有三条产卡路径（启发式 / LLM / 兜底），
      //   历史事故显示"只修一处漏两处"已经出过三次；读侧出口只有这一处，
      //   且 cleanTitle 的注释本来就写着"读盘时无条件过一遍"。
      //
      //   处理顺序（保守，宁可用正文首句也不用脏标题）：
      //     ① 清洗后合格 ⇒ 用清洗结果
      //     ② 不合格 ⇒ 从正文提炼（sanitizeTitle 内部同口径：剥 HTML → 首句 → 判合格）
      //     ③ 还不行 ⇒ 保留清洗结果原样（绝不伪造标题，让体检继续红着比造假好）
      let finalTitle = clean;
      try {
        if (!isGoodTitle(finalTitle)) {
          const derived = sanitizeTitle(finalTitle, body);
          if (derived && isGoodTitle(derived)) finalTitle = derived;
        }
      } catch { /* 提炼失败就维持清洗结果 */ }
      if (finalTitle === c.title) return c;
      return Object.assign({}, c, { title: finalTitle });
    } catch { return c; }
  });
  // [2026-10-24 Round 21] 标题去重：481 个标题被多张卡共用（最多 26 张）。
  //   不是真冗余（content 各异），而是**标题太粗承载不了细节** ——
  //   检索时只看到「修复粒子视效」×26，分不清哪条是混合模式、哪条是 bloom 不生效。
  //   这里给同标题的卡补一句内容差异点，让它可区分。只改内存，不动磁盘。
  let cardsOut = cards;
  try { cardsOut = dedupeTitles(cards); } catch { cardsOut = cards; }
  // [Round 33] 统一出口兜底：有正文却缺 importance 的，在这里补算（幂等、只读内存）
  cardsOut = cardsOut.map(enrichCard);
  const alive = cardsOut.filter(c => c.status !== 'retired');
  return {
    all: cardsOut, alive,
    bytes: st.size, mtime: st.mtimeMs,
    lines: rawLines.length,      // 原始行数（含历史版本），排查用
    cards: cards.length,         // 去重后的卡数
  };
}

/**
 * [2026-10-22 by Assistant · 跨源检索] 载入 tdai 的按天 jsonl 记录。
 *
 * 背景：记忆有两个源——tdai（2026-08-15 起，从 OpenClaw 移植）和 engram（2026-09-09 起，自研）。
 * unified-memory 原先只读 engram，导致 8 月的记忆（最早桌宠那些）永远检索不到。
 * 这里把 tdai 的记录转成与 engram 卡同构的 { id, title, summary, content, createdAt }，
 * 让 BM25 与时间排序能一并覆盖两代数据。
 *
 * 铁律：**只读**，绝不写 tdai 任何文件。
 * id 一律加 'tdai:' 前缀，避免与 engram 卡 id 冲突。
 */
// [2026-10-22] 期5 已迁到云盘 live 目录；旧路径只读残留、不再更新。
export const DEFAULT_TDAI_DIR = dataPath('memory-tencentdb/memory-tdai/records');

/**
 * [2026-10-22 by Assistant] tdai 的 kind → 与 engram 同域的 layer。
 *
 * 为什么需要：tdai 卡原本没有 layer 字段，渲染时被兜底成 'global'——
 * 那是**假值**，让「标签位置」混进三套不可比的值（存储层 / 假层 / 工作记忆档位）。
 * 映射后所有卡的 label 都在 global|project|session 这一个域内，语义可比、不再靠猜。
 *
 * - persona（人设）  → global   ：跨会话长期
 * - instruction（指令）→ global   ：跨会话长期
 * - episodic（事件）  → project  ：项目级
 */
/**
 * [2026-10-22 by Assistant · 架构红队 P3/A5] 统一 tdai 时间解析。
 *
 * 规则：
 *   ① 数字 ⇒ 当作 epoch ms 直接用
 *   ② 字符串**带明确时区**（Z / +08:00 / -05:00）⇒ 交给 Date.parse（它认）
 *   ③ 字符串**不带时区**（"2026-10-21 17:22:16" / "2026-10-21T17:22:16"）⇒
 *      **按 UTC+8 解释**（tdai 数据是中国时区产生），而不是按运行环境本地时区。
 *      这是红队指出的错位风险点：同一批数据在 UTC 机器和 +08 机器上会排到不同位置。
 *   ④ 解析失败 ⇒ 回退到按天目录名的 T00:00:00Z
 *
 * tzOffsetHours 可配置（默认 8）。想改成别的时区传这个参数即可。
 */
export function parseTdaiTime(raw, day, tzOffsetHours) {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  const s = String(raw === undefined || raw === null ? '' : raw).trim();
  const offset = Number.isFinite(Number(tzOffsetHours)) ? Number(tzOffsetHours) : 8;
  if (s !== '') {
    // ② 带明确时区
    if (/[Zz]$/.test(s) || /[+-]\d{2}:?\d{2}$/.test(s)) {
      const t = Date.parse(s);
      if (Number.isFinite(t)) return t;
    }
    // ③ 不带时区 ⇒ 按 UTC+offset 解释
    const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/);
    if (m) {
      const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6] || 0));
      return t - offset * 3600 * 1000;
    }
    // 只有日期
    const d = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (d) {
      const t = Date.UTC(Number(d[1]), Number(d[2]) - 1, Number(d[3]));
      return t - offset * 3600 * 1000;
    }
  }
  const fb = Date.parse(String(day || '') + 'T00:00:00Z');
  return Number.isFinite(fb) ? fb : 0;
}

export const KIND_TO_LAYER = {
  persona: 'global',
  instruction: 'global',
  episodic: 'project',
};

export function readTdaiRecords(dir = DEFAULT_TDAI_DIR, opts = {}) {
  // [架构红队 A5] 无时区字符串按这个偏移解释（默认 +8）
  const tzOffsetHours = opts.tzOffsetHours !== undefined ? opts.tzOffsetHours : 8;
  const out = [];
  let bytes = 0;
  let files = [];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort();
  } catch (e) {
    return { cards: [], files: 0, bytes: 0, reason: String(e && e.message || e) };
  }
  // since: 只载入 >= 该日期的文件（'YYYY-MM-DD'）。默认全量。
  const since = opts.since ? String(opts.since) : null;
  const until = opts.until ? String(opts.until) : null;
  for (const f of files) {
    const day = f.replace(/\.jsonl$/, '');
    if (since && day < since) continue;
    if (until && day > until) continue;
    const p = dir + '/' + f;
    let raw;
    try { raw = readFileSync(p, 'utf8'); } catch { continue; }
    bytes += raw.length;
    for (const line of raw.split('\n')) {
      if (!line) continue;
      let o;
      try { o = JSON.parse(line); } catch { continue; }
      const content = String(o.content || '').trim();
      if (!content) continue;
      const ct = o.createdAt !== undefined ? o.createdAt : (o.timestamps && o.timestamps.createdAt);
      // [2026-10-22 by Assistant · 架构红队 P3/A5] 时间解析统一。
      //   红队指出：tdai 的 createdAt 若是**无时区**字符串（如 "2026-10-21 17:22:16"），
      //   Date.parse 会按**运行环境本地时区**解释，而回退分支显式用 Z（UTC）
      //   ⇒ 同一批数据可能出现跨源错位（同一天的记录排在差 8 小时的位置）。
      //   这里改成：无时区标识的一律按 UTC+8（数据来源时区）解释，可用 tzOffsetHours 覆盖。
      const n = parseTdaiTime(ct, day, tzOffsetHours);
      const kind = o.type || 'unknown';
      out.push({
        id: 'tdai:' + String(o.id || (day + ':' + out.length)),
        // [2026-10-22] 同上：title 优先，scene_name 只是后备
        // [2026-10-24 Round 16] tdai 有 60% 是「我（AI）和用户讨论XXX」这类模板标题 ——
        //   信息量几乎为零。用 betterTdaiTitle 从 content 提炼一句能自足的，提炼不出就保留原样。
        title: (function () {
          const raw = String(o.title || o.scene_name || kind);
          const better = betterTdaiTitle(raw, content);
          return finalizeTitle(better || raw, content);
        })(),
        summary: content.slice(0, 100),
        content,
        createdAt: Number.isFinite(n) ? n : Date.parse(day + 'T00:00:00Z'),
        // [2026-10-22 by Assistant · 标签语义统一] tdai 没有 layer 概念，若不给就会在渲染时
        //   被 budget.js 的 String(e.layer || 'global') 兜底成假『global』——
        //   同一个标签位置混进「存储层 / 假层 / 档位」三套不可比的值。
        //   这里按 kind 映射到与 engram 同域的 layer，让标签语义可比。
        layer: KIND_TO_LAYER[kind] || 'project',
        _source: 'tdai',
        _kind: kind,
        _kindRaw: kind,
        source_message_ids: Array.isArray(o.source_message_ids) ? o.source_message_ids.slice() : [],
        sessionId: String(o.sessionKey || o.sessionId || ''),
        // [2026-10-23 by Assistant] 补齐 tdai 历史卡片透传
        entities: Array.isArray(o.entities) ? o.entities.slice() : [],
        motifs: Array.isArray(o.motifs) ? o.motifs.slice() : [],
        // [2026-10-24 Step 2] 四股力需要这四样；不透传 ⇒ 乘法门控永远拿不到
        // ── [2026-10-24 by Assistant · Round 33 第四个"只修一处"] ──
        //   原来写 `Number.isFinite(...) ? ... : undefined`，
        //   而 tdai 原始数据**根本没有 importance 字段**（3176 张全 undefined）
        //   ⇒ 写成 undefined = 等于没写 ⇒ 四股力对 tdai 卡永远走兜底值。
        //   同类坑第四次：engram 回填了、L1 写入接了、蒸馏接了，**tdai 漏了**。
        //   修法：缺失时**当场用同一套规则算**（纯规则，不调 LLM），而不是留空。
        // [Round 33 二次修正] 不能只看"有没有值" ——
        //   tdai 原始数据里其实**存着一个 0.25**（那是早期批量写入的占位值，
        //   不是真打分）。所以 `Number.isFinite(v)` 为真 ⇒ 直接返回旧值 ⇒ 重算逻辑形同虚设。
        //   判据改成：**只有"看起来像真打过分"的值才信**。
        //   怎么判断？0.25 恰好是基础分（无任何信号时的值）⇒ 若它等于 0.25，
        //   大概率是占位/未打分，重新算一遍更准（真流水账重算后仍是 0.25，不吃亏）。
        importance: (function () {
          const v = Number(o.importance);
          if (Number.isFinite(v) && v !== 0.25) return v;
          try {
            return scoreImportance({ title: String(o.title || ''), summary: content.slice(0, 100), content: content, role: 'user' }).importance;
          } catch (e) { return 0.25; }
        })(),
        is_axiom: (function () {
          if (o.is_axiom === true) return true;
          try {
            return scoreImportance({ title: String(o.title || ''), summary: content.slice(0, 100), content: content, role: 'user' }).is_axiom === true;
          } catch (e) { return false; }
        })(),
        hits: Number(o.hits) || 0,
        lastHitAt: o.lastHitAt || null,
        refute_by: Array.isArray(o.refute_by) ? o.refute_by.slice() : [],
      });
    }
  }
  // [Round 21] tdai 卡也有大量同标题（1849/3176）—— 在这里补差异点
  let out2 = out;
  try { out2 = dedupeTitles(out); } catch { out2 = out; }
  // [Round 33 三次修正] **统一出口兜底** —— 不要在每条构造路径上各修一遍
  //   （这个坑已经踩了四次：engram 回填、L1 写入、蒸馏、tdai）。
  //   规则：只要有正文却缺 importance，就在这里补算一次。幂等、只读内存。
  out2 = out2.map(enrichCard);
  return { cards: out2, files: files.length, bytes };
}

/** Parse tdai L1 source_message_ids into the L0 session/time locator. */
export function parseSourceMessageId(sid) {
 const m = String(sid || '').match(/^l0_(.+)_(\d{13})_(\d+)_([0-9a-f]+)$/i);
 return m ? { sessionKey: m[1], ts: Number(m[2]), seq: Number(m[3]), hash: m[4] } : null;
}

/**
 * Build a read-only L0 index once; keys are sessionKey|second bucket.
 *
 * [2026-10-27 by Assistant · 双目录活水] convDir 支持字符串或数组（多目录合并）。
 *   与 l0-rounds.js 同一口径：按消息 id 去重，避免 10-22 这种两目录都有的日子重复计数。
 */
export function buildL0Index(convDir, opts = {}) {
 const index = new Map(); let files =0; let messages =0;
 const dirs = Array.isArray(convDir)
   ? convDir.map(function (x) { return String(x || ''); }).filter(Boolean)
   : (String(convDir || '') ? [String(convDir)] : []);
 if (!dirs.length) return index;
 const seenMsgId = new Set();
 for (const dir of dirs) {
 let names = [];
 try { names = readdirSync(dir).filter(f => f.endsWith('.jsonl')).sort(); } catch { continue; }
 for (const name of names) {
 let raw; try { raw = readFileSync(dir + '/' + name, 'utf8'); } catch { continue; }
 files++;
 for (const line of raw.split('\n')) {
 if (!line) continue; let o; try { o = JSON.parse(line); } catch { continue; }
 const sessionKey = String(o.sessionKey || o.sessionId || '');
 // [复核 P1] 兼容 ISO 字符串：Number("2026-10-21T...") 会 NaN ⇒ 整条消息被跳过
 let tsRaw = o.timestamp !== undefined ? o.timestamp : o.recordedAt;
 let ts = typeof tsRaw === 'number' ? tsRaw : (tsRaw ? Date.parse(String(tsRaw)) : NaN);
 if (!sessionKey || !Number.isFinite(ts)) continue;
 // [2026-10-27 · 去重口径修正] 唯一键 = id + 时间戳（不是单 id）
 //   实测：单 id 去重会把 107427 条误杀到 40688 条——同模板消息在不同时刻是不同事件。
 //   只有 (id, ts) 完全相同才是跨目录重复拷贝。
 const mid = String(o.id || '');
 if (mid) {
   const dedupeKey = mid + '|' + String(ts);
   if (seenMsgId.has(dedupeKey)) continue;
   seenMsgId.add(dedupeKey);
 }
 const msg = Object.assign({}, o, { _ts: ts, _sessionKey: sessionKey });
 const key = sessionKey + '|' + Math.floor(ts /1000);
 let a = index.get(key); if (!a) index.set(key, a = []); a.push(msg); messages++;
 }
 }
 }
 for (const a of index.values()) a.sort((x, y) => x._ts - y._ts);
 Object.defineProperty(index, 'stats', { value: { files, messages }, enumerable: false });
 return index;
}

/** Find nearest user and assistant messages within the configured window. */
export function lookupRound(l0Index, sessionKey, ts, opts = {}) {
 if (!l0Index || !sessionKey || !Number.isFinite(Number(ts))) return null;
 const windowMs = opts.windowMs === undefined ?1000 : Math.max(0, Number(opts.windowMs));
 const target = Number(ts); const base = Math.floor(target /1000); const all = [];
 for (let b = base -1; b <= base +1; b++) {
 const a = l0Index.get(String(sessionKey) + '|' + b); if (a) all.push(...a);
 }
 // [2026-10-22 by Assistant · 复核 P1 修复] 轮次配对。
 //   旧实现：user 和 assistant **各自**取最近 ⇒ 两条 user 间隔 <1s 时，
 //   可能拼出「A 的提问 + B 的回答」，把两轮串成一轮。
 //   新实现：先锚定最近的 user，再取**该 user 之后**最近的 assistant（超出 assistantWindow 就不要）。
 const inWin = all.filter(m => Math.abs(m._ts - target) <= windowMs);
 const users = inWin.filter(m => String(m.role || '').toLowerCase() === 'user')
   .sort((a, b) => Math.abs(a._ts - target) - Math.abs(b._ts - target));
 const user = users[0] || null;
 let assistant = null;
 if (user) {
   const aWin = opts.assistantWindowMs === undefined ? Math.max(windowMs * 10, 60000) : Math.max(0, Number(opts.assistantWindowMs));
   const after = all.filter(m => String(m.role || '').toLowerCase() === 'assistant'
     && m._ts >= user._ts && m._ts - user._ts <= aWin);
   if (after.length) {
     after.sort((x, y) => x._ts - y._ts);
     // 若两条 user 之间夹了 assistant，取「下一条 user 之前」的那条
     const nextUser = all.filter(m => String(m.role || '').toLowerCase() === 'user' && m._ts > user._ts)
       .sort((x, y) => x._ts - y._ts)[0];
     const limit = nextUser ? nextUser._ts : Infinity;
     const bounded = after.filter(m => m._ts < limit);
     // 下一条 user 已经截断当前轮且其前没有 assistant：不要跨轮回退。
 assistant = bounded[0] || null;
   }
 } else {
   // 没有 user 时退回「最近 assistant」（容错）
   assistant = inWin.filter(m => String(m.role || '').toLowerCase() === 'assistant')
     .sort((a, b) => Math.abs(a._ts - target) - Math.abs(b._ts - target))[0] || null;
 }
 return user || assistant ? { user, assistant } : null;
}


/**
 * [2026-10-22 by Assistant · 期7 闭环] 读**本插件自己产**的数据（ingest/ 下）。
 *
 * 为什么必须有这一步：期7 的 A/B/C 只是「能写」，写完必须能被检索到，
 * 否则就是「产了但看不见」——正是这一整轮改造反复踩的坑。
 * 这里把两份自产数据统一成与 engram/tdai 同构的卡：
 *   · ingest/records/*.jsonl     ← 7-B L1 提取（id 前缀 pm:）
 *   · ingest/engrams.jsonl       ← 7-C 蒸馏（id 前缀 pmi:）
 * 只读，不写；目录不存在就返回空（迁移期未启用时零影响）。
 */
/**
 * ══════════════════════════════════════════════════════════════════
 * [2026-10-27 by Assistant · 第1步 接通 memory_append 断线]
 *
 * 【病灶】memory_append({topic}) 由 dsh-soul-md 提供，写的是 **Markdown**
 *   （.dsh/soul-md/memory/<卡名>/core.md 与 topics/*.md），
 *   而 unified-memory 的检索池只读 engrams.jsonl 三源。
 *   ⇒ Assistant主动写下的感悟/实验/教训，**只落盘、永远搜不回来**，只能 memory_read 按名字直读。
 *   实测：搜 "timeline-discipline" / "normify-usage" 均 0 命中，而文件确实存在。
 *
 * 【修法】只读第四源：解析 soul-md 的 md 文件，把每个 "## 标题 + 正文块" 映射成一张卡。
 *   ① 绝不写 soul-md 的文件（它是第三方插件 0.8.4，改了升级就冲突）
 *   ② 每块只取 heading + 首行摘要（正文前 240 字），避免几百条大卡稀释检索
 *   ③ eventTs 取 md 里 heading 解析出的日期时间（memory_append 写入时带的真实时间）
 *
 * 【开关】默认关闭（soulMdEnabled !== true 时不启用），逐个打开实测。
 * ══════════════════════════════════════════════════════════════════
 */
export const DEFAULT_SOULMD_ROOT = normalize(dshHome() + '/soul-md/memory');

/** 从 "## 2026-10-27 13:58 — section" 这样的 heading 里解析出毫秒时间戳 */
function parseHeadingTs(line) {
  const m = String(line || '').match(/^#{1,6}\s+(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})/);
  if (!m) return null;
  const [, y, mo, d, h, mi] = m;
  const t = Date.parse(y + '-' + mo + '-' + d + 'T' + h + ':' + mi + ':00+08:00');
  return Number.isFinite(t) ? t : null;
}

/**
 * 读 soul-md 记忆，切成「每块一张卡」。
 * @param {string} root soul-md memory 根目录
 * @param {{scope?:string}} [opts]
 * @returns {{cards:Array, stats:object}}
 */
export function readSoulMdCards(root = DEFAULT_SOULMD_ROOT, opts = {}) {
  const out = [];
  const stats = { files: 0, blocks: 0, skipped: 0, root };
  if (!existsSync(root)) return { cards: out, stats };

  const walk = (dir, depth) => {
    if (depth > 3) return;
    let entries = [];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = dir + '/' + e.name;
      if (e.isDirectory()) { walk(p, depth + 1); continue; }
      if (!/\.md$/i.test(e.name)) continue;
      // 跳过备份文件
      if (/\.bak/i.test(e.name)) { stats.skipped++; continue; }
      let raw = '';
      try { raw = readFileSync(p, 'utf8'); } catch { continue; }
      stats.files++;
      // [2026-10-27 · 时间兜底] 手写章节（如 "## 0 · 铁律与User偏好"）没有日期，
      //   用文件 mtime 兜底。虽不精确到块，但比 Date.now() 接近真相。
      let fileMtime = 0;
      try { fileMtime = Math.floor(statSync(p).mtimeMs); } catch {}
      const rel = p.slice(root.length + 1).replace(/\\/g, '/');
      const scope = rel.split('/')[0] || 'global';

      // 按 "## " 二级标题切块（memory_append 每块都是 "## YYYY-MM-DD HH:MM — section"）
      const lines = raw.split(/\r?\n/);
      let cur = null;
      // ── [2026-10-27 by Assistant · 修 seq 恒为 0 的致命 bug] ──
      //   病灶：原来每次遇到新标题都 `cur = { …, seq: 0 }` —— **永远从 0 开始**。
      //   后果：同一文件内所有块共用同一个 id ⇒ 检索层按 id「后写覆盖先写」，
      //         实测 327 块只有 31 个唯一 id，**296 块（90.5%）读不回来**。
      //         最挤的 archive/Assistant-卷2 有 84 块挤在 1 个 id 上。
      //   修法：用文件级计数器 blockSeq，每 flush 一次 +1，作为 id 后缀。
      let blockSeq = 0;
      const flush = () => {
        if (!cur) return;
        const body = cur.body.join('\n').trim();
        if (!body) { cur = null; return; }
        const heading = cur.heading || '';
        const ts = parseHeadingTs(heading) || cur.tsHint || fileMtime || 0;
        // 摘要：去掉标题行，取第一段有内容的文字
        const firstLine = body.split(/\r?\n/).map((s) => s.trim())
          .find((s) => s && !/^#{1,6}\s/.test(s) && !/^<!--/.test(s)) || '';
        // [2026-10-27 · 可检索性修复] 块标题是中文（如「三种时间源」），
        //   而 topic 名（如 timeline-discipline）只活在文件路径里。
        //   不把它并进可搜文本，用户按 topic 名就永远搜不到 —— 实测确实 0 命中。
        //   解法：summary 尾部带 "｜topic:<name>"，让 BM25 能命中 topic 名。
        const topicKey = rel.replace(/\.md$/i, '').replace(/^.*\//, '');
        const summary = (firstLine.replace(/^[-*>]\s*/, '').replace(/\s+/g, ' ').slice(0, 200)
          + ' ｜topic:' + topicKey).trim();
        const titleText = heading.replace(/^#{1,6}\s*/, '').replace(/—/g, '·').trim();
        out.push({
          id: 'soulmd:' + rel.replace(/\.md$/i, '') + ':' + (blockSeq++),
          kind: 'note',
          layer: 'global',
          title: (titleText || ('soul-md · ' + rel)).slice(0, 120),
          summary,
          content: body.slice(0, 2000),
          importance: 0.6,
          is_axiom: false,
          hits: 0,
          createdAt: ts || Date.now(),
          eventTs: ts || 0,                 // 真实写入时间（memory_append 带的）
          updatedAt: new Date(ts || Date.now()).toISOString(),
          status: 'active',
          _source: 'soulmd',
          sourcePath: rel,
          scope,
          sessionId: null,
          sessionKey: null,
        });
        stats.blocks++;
        cur = null;
      };
      for (const line of lines) {
        if (/^#{1,6}\s/.test(line)) { flush(); cur = { heading: line, body: [], seq: 0 }; }
        else if (cur) cur.body.push(line);
      }
      flush();
    }
  };
  walk(root, 0);
  return { cards: out, stats };
}

export const DEFAULT_INGEST_ROOT = dataPath('ingest');

const L1_TYPE_TO_LAYER = { persona: 'global', instruction: 'global', episodic: 'project' };

/**
 * 统一的"读侧标题定稿"入口（2026-10-28 · 老红项修）。
 *
 * ## 为什么要它
 * 体检「标题全部合格」长期红着 2 张：`（无标题）` 和半句 `但它能成立`。
 * 追下去发现根因不是判据错，而是**判据没被执行**：
 *   · `cleanTitle()` 只负责去脏（HTML/框线/符号），**不判断合不合格**；
 *   · 而读侧有 4 处各自调 cleanTitle（源卡 / tdai / L1 records / engrams），
 *     没有任何一处补 isGoodTitle。
 * ⇒ 「判据只有一份」不够，还得「接缝只有一个」，否则修一处漏三处
 *   （本项目历史上已因此出过三次事故）。
 *
 * ## 处理顺序（保守，宁可用正文首句也不伪造）
 *   ① 清洗合格        ⇒ 用清洗结果
 *   ② 清洗不合格      ⇒ 从正文提炼（sanitizeTitle，内部同口径）
 *   ③ 提炼也不合格    ⇒ 原样返回清洗结果（让体检继续红，绝不编一个假标题）
 *
 * @param {string} rawTitle 原始标题（可能是 scene_name / tag_title / 脏碎片）
 * @param {string} body     正文（提炼时用）
 * @returns {string} 定稿标题
 */
export function finalizeTitle(rawTitle, body) {
  const b = String(body || '');
  let t = cleanTitle(String(rawTitle || ''), b);
  try {
    if (!isGoodTitle(t)) {
      const d = sanitizeTitle(t, b);
      if (d && isGoodTitle(d)) t = d;
    }
  } catch { /* 提炼失败维持清洗结果 */ }
  return t;
}

export function readOwnIngest(root = DEFAULT_INGEST_ROOT) {
  const base = String(root || DEFAULT_INGEST_ROOT).replace(/[\\/]+$/, '');
  const out = [];
  let files = 0;
  let reason = null;

  // ① 7-B：L1 记录
  const recDir = base + '/records';
  try {
    const names = readdirSync(recDir).filter((f) => f.endsWith('.jsonl')).sort();
    for (const name of names) {
      const day = name.slice(0, 10);
      let raw = '';
      try { raw = readFileSync(recDir + '/' + name, 'utf8'); } catch { continue; }
      files++;
      const recById = new Map();
      const recsThisFile = [];
      for (const line of raw.split('\n')) {
        if (!line) continue;
        let rec; try { rec = JSON.parse(line); } catch { continue; }
        // [2026-10-23 by Assistant · 期8.3.1] L1 records 与 engrams 同构：**追加式日志**。
        //   期8.3.1 的 entities 回填就是按「追加同名同 id 的新版本行」写的
        //   （与 distill.js 的 retireLines 同一手法）。若不按 id 取最后一条，
        //   同一张卡会被数两次 ⇒ selftest-p3 的 C5（alive = 源活卡 + 自产卡）必然对不上。
        //   这里与下方 engrams 分支的 byId 口径保持一致。
        const rawId = String(rec.id || '').replace(/^pm:/, '');
        const canonKey = rawId || (day + ':' + recsThisFile.length);
        recById.set(canonKey, rec);
        recsThisFile.push(rec);
        continue;
      }
      for (const [canonKey, rec] of recById.entries()) {
        const content = String(rec.content || '').trim();
        if (!content) continue;
        const t = parseTdaiTime(rec.createdAt, day, 8);
        const type = String(rec.type || 'episodic');
        out.push({
          id: 'pm:' + canonKey,
          // [2026-10-22 by Assistant] 优先用 title —— scene_name 是「我（AI）在和xxx做xxx」
          //   那种场景叙述，把它当标题会让所有卡长得一模一样（实测 4 张完全相同）。
          title: finalizeTitle(String(rec.title || rec.scene_name || type), content),
          summary: content.slice(0, 100),
          content,
          createdAt: Number.isFinite(t) ? t : Date.parse(day + 'T00:00:00Z') || 0,
          layer: L1_TYPE_TO_LAYER[type] || 'project',
          _source: 'ingest-l1',
          _kind: type,
          source_message_ids: Array.isArray(rec.source_message_ids) ? rec.source_message_ids.slice() : [],
          sessionId: String(rec.sessionKey || rec.sessionId || ''),
          // [2026-10-23 by Assistant · 期8.3 致命断点修复]
          //   期8.3.1 已经把 entities 写进磁盘了，但这里构造卡对象时**没带出来**
          //   ⇒ buildIncidence 拿到空数组 ⇒ graphStats 显示 entities:0 / edges:0
          //   ⇒ 代数隐式超图建的是**空图**，expandOneHop 一个邻居都扩不出来。
          //   这一行是整条链路的关键接缝。
          entities: Array.isArray(rec.entities) ? rec.entities.slice() : [],
          // [2026-10-23 by Assistant · 同一个坑，提前避开]
          //   motifs 是「情境骨架」，双轨闪回靠它做跨时空联想。
          //   上次 entities 就是漏在这一个字段上导致整张图是空的，这次不重犯。
          motifs: Array.isArray(rec.motifs) ? rec.motifs.slice() : [],
          // [2026-10-24 Step 2] 四股力字段透传
          importance: Number.isFinite(Number(rec.importance)) ? Number(rec.importance) : undefined,
          is_axiom: rec.is_axiom === true,
          hits: Number(rec.hits) || 0,
          lastHitAt: rec.lastHitAt || null,
          refute_by: Array.isArray(rec.refute_by) ? rec.refute_by.slice() : [],
        });
      }
    }
  } catch (e) { reason = reason || String(e && e.message || e); }

  // ② 7-C：蒸馏卡
  //
  // [2026-10-22 by Assistant · 自测抓到] engrams.jsonl 是**追加式**日志：
  //   同一张卡"退役"时是再追加一行 {id, status:'retired'}，而不是改写原行。
  //   所以必须「按 id 取最后一条」，否则先读到 active 行就把退役卡又放出来了
  //   （自测 F4 正是这么抓到的）。
  try {
    const p = base + '/engrams.jsonl';
    if (existsSync(p)) {
      const raw = readFileSync(p, 'utf8');
      files++;
      const byId = new Map();
      for (const line of raw.split('\n')) {
        if (!line) continue;
        let c; try { c = JSON.parse(line); } catch { continue; }
        if (!c || !c.id) continue;
        // [2026-10-25 根因修复] 归一化去重 key（前缀统一去掉 pmi:）
        //   防止同一张卡因存盘时带或不带 pmi: 前缀而被当作两个 key
        //   进而产生同名重复卡挤掉 C5 的数量断言
        const canonKey = String(c.id).replace(/^pmi:/, '');
        byId.set(canonKey, c);      // 后写覆盖先写 = 最后状态生效
      }
      for (const c of byId.values()) {
        if ((c.status || 'active') === 'retired') continue;
        // [2026-10-24] 标题清洗（存量卡里 22 张是 HTML 碎片，注入时很难看）
        const title = finalizeTitle(String(c.title || ''), String(c.content || c.summary || ''));
        const summary = String(c.summary || '').trim();
        if (!title && !summary) continue;
        out.push({
          id: 'pmi:' + String(c.id).replace(/^pmi:/, ''),
          title, summary,
          content: String(c.content || summary),
          createdAt: Number(c.createdAt) || 0,
          layer: String(c.layer || 'global'),
          _source: 'ingest-engram',
          _kind: String(c.kind || 'note'),
          causes: Array.isArray(c.causes) ? c.causes.slice() : [],
          source_message_ids: [],
          sessionId: String(c.sessionKey || c.sessionId || ''),
          // [2026-10-23] 同 L1 分支：entities 必须透传，否则超图读不到
          entities: Array.isArray(c.entities) ? c.entities.slice() : [],
          motifs: Array.isArray(c.motifs) ? c.motifs.slice() : [],
          // [2026-10-24 Step 2] 四股力字段透传（缺这几样，乘法门控等于空转）
          importance: Number.isFinite(Number(c.importance)) ? Number(c.importance) : undefined,
          is_axiom: c.is_axiom === true,
          hits: Number(c.hits) || 0,
          lastHitAt: c.lastHitAt || null,
          refute_by: Array.isArray(c.refute_by) ? c.refute_by.slice() : [],
        });
      }
    }
  } catch (e) { reason = reason || String(e && e.message || e); }

  // [Round 33 四次修正] 自产卡也走统一兜底 —— 不要在每条构造路径各修一遍
  //   （这个坑踩了四次：engram 回填、L1 写入、蒸馏、tdai，现在加上自产出口）
  const outBig = out.map(enrichCard);
  return { cards: outBig, files, reason };
}
