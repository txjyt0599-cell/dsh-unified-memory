/**
 * lib/memory/card-locator.js —— **唯一**的「卡 id → 磁盘真实文件/行」定位器
 * [2026-11-06 by Phoebe · 红队 P0-2]
 *
 * 病灶（红队实测）：
 *   1) 检索层 id 带前缀（pm:pm_xxx / pmi:pmi_xxx / tdai:xxx），磁盘原文 id 不带
 *      或前缀不同 ⇒ tools.js / adoption.js 用 card.id 直读磁盘永远读不到 ⇒
 *      回退成 `Object.assign({}, card, patch)` 的投影对象整卡覆盖 ⇒ 丢字段 + 复制身份。
 *   2) resolveCardTargetFile 只按 createdAt 猜 `YYYY-MM-DD.jsonl`，不知道分片
 *      （-0001.jsonl）和 _archive，猜错文件 ⇒ 读不到 ⇒ 同上。
 *
 * 本模块把所有 id 比较收敛到 toRawId 一处，并把「候选文件」按前缀枚举
 * （活跃 + 归档，经 shard-files 统一口径），彻底消除两处各猜一套的漂移。
 *
 * 铁律：写回必须用本模块返回的 file/row，绝不把展示用前缀 id 写回磁盘原文。
 */
import { existsSync, readdirSync, readFileSync, statSync, openSync, closeSync, writeSync, renameSync, unlinkSync, mkdirSync } from 'node:fs';
import { dataPath } from '../paths.js';
import { listShardFiles } from '../shard-files.js';
// [2026-11-06 · 独立复审终审 F2] 改为本模块自带的**原子**跨进程锁（不依赖核里带 TOCTOU 的 acquireLock）

/** 展示 id → 磁盘原始 id（去掉检索前缀）。所有 id 比较必须走这里。 */
export function toRawId(id) {
  let s = String(id === undefined || id === null ? '' : id);
  if (s.startsWith('pmi:')) s = s.slice(4);
  else if (s.startsWith('pm:')) s = s.slice(3);
  else if (s.startsWith('tdai:')) s = s.slice(5);
  // 双前缀兜底（pmi:pmi_xxx / pm:pm_xxx 再剥一层）
  s = s.replace(/^(pmi:|pm:|tdai:)/, '');
  return s;
}

function fileContainsId(file, wantRaw) {
  try {
    if (!existsSync(file)) return null;
    const raw = readFileSync(file, 'utf8');
    // [红队 P0-2] append-only 日志里同一 id 可能有多条版本行；有的历史版本行是**局部 patch**
    //   （只带 hits 等少数字段）。若只取最后一行，会丢掉更早版本行里的 type/priority 等字段。
    //   这里按「逐条 Object.assign 折叠」重建该卡的**完整最新态**（后写覆盖先写，缺失字段向上继承），
    //   这样读改写永远不会把老字段写丢。对健康数据（每行都是全量）等价于取最后一行。
    let acc = null;
    for (const line of raw.split('\n')) {
      if (!line) continue;
      let o; try { o = JSON.parse(line); } catch { continue; }
      if (o && toRawId(o.id) === wantRaw) acc = acc ? Object.assign({}, acc, o) : Object.assign({}, o);
    }
    return acc;
  } catch { return null; }
}

/** 某目录下（含 _archive）所有 .jsonl；可选只留某前缀（如 engrams） */
function filesInDir(dir, prefix) {
  const out = [];
  for (const d of [dir, dir + '/_archive']) {
    let names = [];
    try { names = readdirSync(d); } catch { continue; }
    for (const n of names) {
      if (!n.endsWith('.jsonl')) continue;
      if (prefix && !n.startsWith(prefix)) continue;
      out.push(d + '/' + n);
    }
  }
  return out;
}

/** 按 id 前缀枚举候选文件（活跃 + 归档），去重。card.sourcePath 优先。 */
export function candidateFiles(card, id) {
  const cid = String(id !== undefined ? id : (card && card.id) || '');
  const files = [];
  if (card && card.sourcePath && existsSync(card.sourcePath)) files.push(String(card.sourcePath));
  try {
    if (cid.startsWith('pm:')) {
      for (const f of listShardFiles(dataPath('ingest/records'))) files.push(f.path);
    } else if (cid.startsWith('pmi:')) {
      for (const f of filesInDir(dataPath('ingest'), 'engrams')) files.push(f);
    } else if (cid.startsWith('tdai:')) {
      for (const f of listShardFiles(dataPath('memory-tencentdb/memory-tdai/records'))) files.push(f.path);
    } else {
      for (const f of filesInDir(dataPath('engram-relay'), 'engrams')) files.push(f);
    }
  } catch { /* 枚举失败按空处理，外层 fail-closed */ }
  return [...new Set(files)];
}

/**
 * 定位一张卡的磁盘原文：返回 { file, row, rawId } 或 null（fail-closed）。
 * @param {object} card  卡片对象（可带 sourcePath）
 * @param {string} [id]  覆盖 id（缺省用 card.id）
 */
function mtimeOf(file) { try { return statSync(file).mtimeMs; } catch { return 0; } }

/**
 * [独立复审 R2-2] 在给定文件清单里折叠同一 raw id 的版本行。
 * global=true：跨文件收集全部版本，按**卡级版本时间戳**升序折叠（后写覆盖、缺失字段继承），
 *   写入目标取版本最高者所在文件（仅当所有行都无时间戳时才退回文件 mtime）
 *   ⇒ 修复「同 ID 跨分片/主文件重复、只取首个命中写到较旧文件」。
 * global=false：按清单顺序返回首个含该 id 的文件（单文件内已折叠）。
 * 供 locateCard 与行为测试共用（测试可传任意临时文件清单）。
 */
// [独立复审终审 F3] 卡的版本顺序必须用**卡自身时间戳**，不能用整文件 mtime
//   （同文件里别的卡一追加，mtime 就变，会把旧卡误判成最新）。
function rowVersion(row) {
  if (!row) return 0;
  const cand = [row.updatedAt, row.updated_at, row.lastHitAt, row.refutedAt, row.axiomRevokedAt, row.createdAt, row.eventTs];
  let v = 0;
  for (const x of cand) {
    const n = typeof x === 'string' ? Date.parse(x) : Number(x);
    if (Number.isFinite(n) && n > v) v = n;
  }
  return v;
}

export function foldRowsAcrossFiles(wantRaw, files, global) {
  const matches = [];
  for (const f of files) {
    if (!f) continue;
    const row = fileContainsId(f, wantRaw);
    if (!row) continue;
    if (!global) return { file: f, row, rawId: wantRaw };
    matches.push({ file: f, row, v: rowVersion(row), mtime: mtimeOf(f) });
  }
  if (!matches.length) return null;
  const anyV = matches.some((m) => m.v > 0);
  matches.sort((a, b) => {
    if (anyV && a.v !== b.v) return a.v - b.v;          // 有卡级版本就按版本升序
    if (a.mtime !== b.mtime) return a.mtime - b.mtime;  // 全无版本才退回文件 mtime
    return String(a.file) < String(b.file) ? -1 : 1;
  });
  let folded = null;
  const primary = matches[matches.length - 1].file;      // 版本/时刻最高者为主
  for (const m of matches) folded = folded ? Object.assign({}, folded, m.row) : Object.assign({}, m.row);
  return { file: primary, row: folded, rawId: wantRaw, files: matches.map((x) => x.file) };
}

/**
 * 定位一张卡的磁盘原文：返回 { file, row, rawId, files? } 或 null（fail-closed）。
 * @param {object} card  卡片对象（可带 sourcePath）
 * @param {string|object} [id]  覆盖 id，或 opts 对象 { global?:boolean }
 * @param {object} [opts] { global?:boolean }
 *
 * opts.global === true（工具写回用，用户触发、频次低）：
 *   枚举**全部候选文件**，收集同一 raw id 的所有版本行，跨文件按**卡级版本时间戳**升序折叠，
 *   取版本最高者所在文件为写入目标（全无时间戳才退回文件 mtime）⇒ 修复「历史旧 bug 造成的
 *   同 ID 跨分片/主文件重复、只取首个命中文件导致写到较旧文件」的问题（独立复审 R2-2 / 终审 F3）。
 * 默认（adoption 每轮用，靠 sourcePath 快路径保持 O(1)）：
 *   sourcePath 命中即返回；否则枚举取首个命中文件（单文件内已折叠）。
 */
export function locateCard(card, id, opts) {
  let overrideId = id;
  let o = opts;
  if (id && typeof id === 'object') { o = id; overrideId = undefined; }
  const cid = String(overrideId !== undefined ? overrideId : (card && card.id) || '');
  if (!cid) return null;
  const wantRaw = toRawId(cid);
  if (!wantRaw) return null;
  const cands = candidateFiles(card, cid);   // candidateFiles 首项即 card.sourcePath（若存在）
  if (o && o.global === true) return foldRowsAcrossFiles(wantRaw, cands, true);
  return foldRowsAcrossFiles(wantRaw, cands, false);
}

/** 同步 sleep（仅用于等锁的重试，极短） */
function sleepSync(ms) { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch {} }

function readLockFile(file) { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; } }

/** 原子独占创建：openSync(...,'wx') 只有一个进程能成功（修复 F2 首次创建 TOCTOU） */
function tryCreateExclusive(file, obj) {
  try { const fd = openSync(file, 'wx'); writeSync(fd, JSON.stringify(obj)); closeSync(fd); return true; }
  catch { return false; }
}

/**
 * [独立复审终审 F2] 以「卡 raw id」为粒度的**原子**跨进程写锁：
 *   · 首次创建用 openSync('wx')（原子，只有一个创建者成功）；
 *   · stale 抢占先把旧锁原子 rename 到唯一 quarantine（只有一个进程能搬走），再原子创建新锁；
 *   · 释放前校验 token，只删自己的锁。
 * 返回 fn() 的返回；等不到锁返回 { ok:false, reason:'lock-busy' }（调用方据此如实失败，不谎报成功）。
 */
export function withCardLock(cardOrId, fn) {
  const raw = toRawId(cardOrId && cardOrId.id !== undefined ? cardOrId.id : cardOrId) || 'anon';
  const name = 'cardwrite-' + raw.replace(/[^A-Za-z0-9_.-]/g, '_').slice(-60);
  const dir = dataPath('ingest');
  try { mkdirSync(dir, { recursive: true }); } catch {}
  const file = dir + '/.lock-' + name;
  const token = process.pid + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  const TTL = 60000;
  let acquired = false;
  for (let i = 0; i < 80 && !acquired; i++) {
    if (!existsSync(file)) {
      if (tryCreateExclusive(file, { pid: process.pid, at: Date.now(), token, name })) { acquired = true; break; }
      sleepSync(5); continue;
    }
    const h = readLockFile(file);
    const at = Number(h && h.at) || 0;
    if (at && Date.now() - at < TTL) { sleepSync(10); continue; }   // 活锁，等它释放
    // 陈旧锁：原子搬走（唯一 quarantine 名，只有一个进程 rename 成功）后再原子创建
    const q = file + '.old-' + token;
    try { renameSync(file, q); } catch { sleepSync(10); continue; }
    try { unlinkSync(q); } catch {}
    if (tryCreateExclusive(file, { pid: process.pid, at: Date.now(), token, name })) { acquired = true; break; }
  }
  if (!acquired) return { ok: false, reason: 'lock-busy' };
  const cur = readLockFile(file);
  if (!cur || cur.token !== token) return { ok: false, reason: 'lock-lost' };   // 被别人抢了，不冒充
  try { return fn(); }
  finally {
    const c = readLockFile(file);
    if (c && c.token === token) { try { unlinkSync(file); } catch {} }
  }
}
