/**
 * [2026-11-06 by Phoebe · L1(pm)–L2(pmi) 同源关系 · 读时计算]
 *
 * ── 为什么要有这个文件 ──
 * 原本 distill 落盘时就算 promotedFrom（L2 读过哪些 L1），但那是个写入侧字段，
 * 一旦写卡时刻 records/ 里还没有对应的 pm 卡，写进去就是空。实测 81 张有该字段的卡
 * 非空率为 0，且其中大量是"当时空、现在能匹配"。
 *
 * 结论：**关系是客观存在的（消息 id 交集 1686 个），只是不该在写入侧一次性定格。**
 * 所以这里改成读时计算 —— 永远最新、零落盘、零污染。
 *
 * ── 关键纠正（红队 argon2 Q3） ──
 * 之前Assistant用 bigram 相似度去判断"pm 和 pmi 是否互补"，得出"82% 完全无关"的错误结论。
 * 那是拿**查重的尺子**去量**语义关系**。正确口径是：
 *   · 同源（共享 source_message_ids）+ 字面高度重合 (≥0.7) ⇒ **duplicate** 冗余冲突
 *   · 同源 + 字面低重合 (<0.7)                       ⇒ **complement** 真互补
 *     典型：L2 记"现象/结论/闭环"，L1 记"根因/参数/原子操作"
 *   · 不同源                                          ⇒ **unrelated**
 * 本模块把这三类**分开命名**，避免再次混淆。
 *
 * ── 铁律 ──
 *   · **纯只读**：不写任何文件，不修改传入对象
 *   · 任何异常一律降级为"无关系"，绝不影响检索主链路
 *   · 模块级缓存 60s（与 readPromotableL1 同口径），避免每张卡都全量扫 records/
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { listShardFiles } from '../shard-files.js';

// ── 判据口径（2026-11-06，经 659 个同源对实测 + 8 个区间样本人工核对后定）──
//
//   【重要】Assistant一度想用 bigram 相似度再分「互补 / 同窗异事」，实测证明**分不开**：
//     样本 sim=0.055 —— 「写 loopback_network=1 放行」 vs 「从 NapCat 取凭证注入」 ⇒ 无关
//     样本 sim=0.094 —— 「黑名单生效拦 icbc」 vs 「权限模型从白名单改黑名单」 ⇒ 真互补
//     样本 sim=0.161 —— 「cookie 没设过期丢登录态」 vs 「有效期设 7 天」   ⇒ 真互补
//     样本 sim=0.111 —— 「测试卡已写入磁盘」 vs 「测试卡因缺技术名词被过滤」⇒ 无关
//   同一区间里既有真互补又有无关 ⇒ **这个指标测的不是"语义互补"**，加刻度也没用。
//
//   所以本模块只做**能 100% 确定的判定**，不硬分自己分不清的：
//     · 同源（共享 source_message_ids）  —— 完全客观
//     · 其中字面 sim >= 0.7 的判 duplicate  —— 同一事实说两遍（冗余冲突，该折叠）
//     · 其余同源的判 linked               —— **只陈述"同源"这个事实，不宣称互补**
//
//   给后续消费方留的口径：要折叠就只看 duplicate；要做父子关联就看 linked；
//   "互补"属于语义判断，不在本层硬编。
export const DUPLICATE_SIM = 0.7;   // >= 0.7 ⇒ 同一事实说了两遍（冗余冲突）
/** 索引缓存时长，与 readPromotableL1 一致 */
const CACHE_TTL_MS = 60000;
/** 单张 L2 最多返回几个 L1 关联，防字段膨胀 */
const MAX_LINKS = 8;

const _cache = { at: 0, dir: '', index: null };

/**
 * 把一个 records 目录扫成 messageId → [pmId] 的反查表。
 * @param {string} recordsDir  ingest/records 绝对路径
 * @returns {{ byMsg: Map<string,string[]>, pmIds: Set<string>, cards: number, ms: number }}
 */
export function buildSourceIndex(recordsDir) {
  const t0 = Date.now();
  const dir = String(recordsDir || '');
  const empty = { byMsg: new Map(), pmIds: new Set(), cards: 0, ms: 0 };
  try {
    if (!dir || !existsSync(dir)) return empty;
    const now = Date.now();
    if (_cache.index && _cache.dir === dir && now - _cache.at < CACHE_TTL_MS) {
      return _cache.index;
    }

    // [2026-11-07 P2-4 · 红队修复] 必须用 listShardFiles 返回的 **f.path** 读文件。
    //   原来只取 f.name 再从 dir 根拼路径 ⇒ 归档（_archive/ 下沉）分片的正确路径被丢掉，
    //   那些卡直接读不到（静默丢失）。现在优先用 f.path；只有拿不到 path 时才退回拼 name。
    let filePaths = [];
    try {
      filePaths = listShardFiles(dir).map((f) => {
        if (f && f.path) return String(f.path);
        const nm = f && f.name ? f.name : String(f);
        return dir + '/' + nm;
      });
    } catch {
      filePaths = readdirSync(dir).filter((n) => n.endsWith('.jsonl')).map((n) => dir + '/' + n);
    }

    const byMsg = new Map();
    const pmIds = new Set();
    const seen = new Map();   // pmId → card（last-wins，与 readCards 口径一致）

    for (const f of filePaths) {
      let text = '';
      try { text = readFileSync(f, 'utf8'); } catch { continue; }
      for (const line of text.split(/\r?\n/)) {
        if (!line) continue;
        let o; try { o = JSON.parse(line); } catch { continue; }
        const id = String((o && o.id) || '');
        if (!id || !/^pm[:_]/.test(id)) continue;
        if (!String(o.content || '').trim()) continue;   // 正文空的残行不算
        seen.set(id, o);
      }
    }
    for (const [id, o] of seen) {
      pmIds.add(id);
      const arr = Array.isArray(o.source_message_ids) ? o.source_message_ids : [];
      for (const m of arr) {
        const k = String(m || '');
        if (!k) continue;
        if (!byMsg.has(k)) byMsg.set(k, []);
        const list = byMsg.get(k);
        if (list[list.length - 1] !== id) list.push(id);
      }
    }

    const index = { byMsg, pmIds, cards: pmIds.size, ms: Date.now() - t0 };
    _cache.at = now; _cache.dir = dir; _cache.index = index;
    return index;
  } catch { return empty; }
}

/**
 * 用**已经在内存里的** L1 卡建索引（不读磁盘）。
 *
 * [2026-11-06 晚 · 红队 argon2 二轮] 为什么加这个：
 *   readOwnIngest 的步骤① 本来就把 records/ 全读进内存了，如果 relatedL1 再调
 *   buildSourceIndex(recordsDir) 会把同一目录从磁盘重读 + 再 JSON.parse 一遍
 *   （实测白花 90ms）。传内存卡进来 ⇒ 额外 IO = 0ms。
 *
 * @param {Map<string,object>|Array<object>} cards  pmId(剥过前缀) → card，或卡数组
 * @returns {{ byMsg: Map<string,string[]>, pmIds: Set<string>, cards: number, ms: number }}
 */
export function buildSourceIndexFromCards(cards) {
  const t0 = Date.now();
  const empty = { byMsg: new Map(), pmIds: new Set(), cards: 0, ms: 0 };
  try {
    if (!cards) return empty;
    const iter = cards instanceof Map
      ? cards.entries()
      : (Array.isArray(cards) ? cards.map((c) => [String((c && c.id) || ''), c]) : null);
    if (!iter) return empty;

    const byMsg = new Map();
    const pmIds = new Set();
    for (const [key, o] of iter) {
      const id = String(key || (o && o.id) || '');
      if (!id || !/^pm[:_]/.test(id)) continue;
      if (!String((o && o.content) || '').trim()) continue;   // 与 buildSourceIndex 同口径
      pmIds.add(id);
      const arr = Array.isArray(o && o.source_message_ids) ? o.source_message_ids : [];
      for (const m of arr) {
        const k = String(m || '');
        if (!k) continue;
        if (!byMsg.has(k)) byMsg.set(k, []);
        const list = byMsg.get(k);
        if (list[list.length - 1] !== id) list.push(id);
      }
    }
    return { byMsg, pmIds, cards: pmIds.size, ms: Date.now() - t0 };
  } catch { return empty; }
}

/**
 * 找出一张 L2 卡的同源 L1 卡。
 * @param {object} l2Card  至少含 source_message_ids
 * @param {object} index   buildSourceIndex / buildSourceIndexFromCards 的返回值
 * @returns {{ pmIds: string[], sharedMsgIds: string[] }}
 */
export function findL1OfL2(l2Card, index) {
  const out = { pmIds: [], sharedMsgIds: [] };
  try {
    if (!l2Card || !index || !index.byMsg) return out;
    const msgs = Array.isArray(l2Card.source_message_ids) ? l2Card.source_message_ids : [];
    if (!msgs.length) return out;
    const hit = new Set();
    const shared = [];
    for (const m of msgs) {
      const k = String(m || '');
      if (!k) continue;
      const list = index.byMsg.get(k);
      if (!list || !list.length) continue;
      shared.push(k);
      for (const id of list) {
        hit.add(id);
        if (hit.size >= MAX_LINKS) break;
      }
      if (hit.size >= MAX_LINKS) break;
    }
    out.pmIds = Array.from(hit);
    out.sharedMsgIds = shared;
    return out;
  } catch { return out; }
}

/** 2-gram 集合（去空白 + 小写），与本仓 bigramOverlap 同口径 */
function bigramSet(s) {
  const t = String(s || '').replace(/\s+/g, '').toLowerCase();
  const r = new Set();
  for (let i = 0; i < t.length - 1; i++) r.add(t.slice(i, i + 2));
  return r;
}

/** a 相对于 b 的 2-gram 覆盖率（分母是 a 的大小） */
export function bigramCoverage(a, b) {
  const A = bigramSet(a);
  if (!A.size) return 0;
  const B = typeof b === 'object' && b instanceof Set ? b : bigramSet(b);
  if (!B.size) return 0;
  let n = 0;
  for (const g of A) if (B.has(g)) n++;
  return n / A.size;
}

/**
 * 判定一张 L2 与一张 L1 的关系。**只给能确定的三档，不硬分"互补"。**
 * @returns {{ relation:'duplicate'|'linked'|'unrelated', sim:number }}
 *   duplicate = 同源 + 字面 sim>=0.7 —— 同一事实说了两遍（冗余冲突，可安全折叠）
 *   linked    = 同源 + sim<0.7      —— 出自同一段对话，**仅陈述同源事实，不宣称互补**
 *   unrelated = 不同源
 *
 * 为什么不给 complement 档：实测同一 sim 区间里既有真互补（0.094 / 0.161）
 * 又有完全无关（0.055 / 0.111），bigram 分不开。与其给个会误导下游的标签，
 * 不如诚实地说"这两个只共享来源，具体关系需要语义判断"。
 */
export function classifyRelation(l2Card, pmCard, sharedMsgIds) {
  try {
    const shared = Array.isArray(sharedMsgIds) ? sharedMsgIds : [];
    if (!shared.length) return { relation: 'unrelated', sim: 0 };
    if (!l2Card || !pmCard) return { relation: 'unrelated', sim: 0 };
    const sim = bigramCoverage(
      String(l2Card.title || '') + ' ' + String(l2Card.content || ''),
      String(pmCard.title || '') + ' ' + String(pmCard.content || ''),
    );
    if (sim >= DUPLICATE_SIM) return { relation: 'duplicate', sim };
    return { relation: 'linked', sim };
  } catch { return { relation: 'unrelated', sim: 0 }; }
}

/** 测试用：清缓存 */
export function _clearCache() { _cache.at = 0; _cache.dir = ''; _cache.index = null; }
