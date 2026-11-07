/**
 * activation-store.js —— 激活值的落盘、读取、多会话合并。**本期唯一写文件的地方**。
 * 依据：_team-v2/p4/DESIGN.md §1.3.3 / §1.3.4 / §1.3.5；红队 L1（schema + α=0.7 合并）。
 *
 * 铁律：
 *   ① **原子写**：tmp → JSON.parse 自校验 → 备份旧档 → rename。绝不直接覆写目标文件
 *      （engram-relay 目录里 3 个 engrams.jsonl.bak-* 就是历史撞坏写的证据）。
 *   ② **文件锁**：复用期2 的 lock.js（O_CREAT|O_EXCL + stale 清理），多会话并发不互相覆盖。
 *   ③ **合并顺序无关**：先按 lastUpdate 判新旧，再 EWMA 回放 ⇒ merge(A,B) ≡ merge(B,A)，可单测断言。
 *   ④ **只写自己的目录**：默认 <unified-memory>/working-memory/activation.json，
 *      **绝不写 engrams.jsonl / .memory-tencentdb / engram-relay**。
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, copyFileSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { acquireLock, releaseLock } from '../hypergraph/lock.js';
import { WM_DEFAULTS, WM_HARD, normalizeActivation } from './types.js';
import { dataPath } from '../paths.js';

// [2026-10-22 by Assistant · 路径统一] 记忆数据一律在 live；C: 只留诊断日志。
export const DEFAULT_WM_DIR = dataPath('working-memory');
export const ACTIVATION_FILE = 'activation.json';

/** 时间衰减：半衰期 halfLifeMs，做旧值折算（不做衰减时返回原值）。 */
export function decayedActivation(rec, now, halfLifeMs) {
  if (!rec) return 0;
  const a = clamp01(Number(rec.activation));
  if (!halfLifeMs || halfLifeMs <= 0) return a;
  const dt = Math.max(0, Number(now) - Number(rec.lastUpdate || 0));
  return a * Math.pow(0.5, dt / halfLifeMs);
}

/**
 * 单条合并：α 指数加权移动平均（α=0.7）。
 *   a' = α·incoming + (1-α)·decayed(prev)
 * 给 halfLifeMs 时旧值先按时间衰减（跨会话恢复用），不给则原值。
 */
export function mergeActivation(prev, incoming, now, alpha, halfLifeMs) {
  const al = clampAlpha(alpha);
  const inc = clamp01(Number(incoming));
  if (!prev) return round6(inc);
  const base = decayedActivation(prev, now, halfLifeMs);
  return round6(al * inc + (1 - al) * base);
}

/**
 * 整文件合并（**多会话并发写的核心**）：顺序无关、幂等。
 *
 * 规则：对每个 cardId，按 lastUpdate 判「新 / 旧」⇒ 旧值作 base、新值作 incoming 做一次 EWMA。
 *   持平（lastUpdate 相同）时用 activation 大者作 incoming，再持平按 cardId 无关的确定性规则，
 *   保证 merge(A,B) 与 merge(B,A) 逐字段一致（验收 D1）。
 */
export function mergeActivationFiles(a, b, now, alpha, halfLifeMs) {
  const fa = normalizeFile(a, alpha);
  const fb = normalizeFile(b, alpha);
  const ids = new Set([].concat(Object.keys(fa.records), Object.keys(fb.records)));
  const out = { version: WM_HARD.SCHEMA_VERSION, alpha: clampAlpha(alpha), updatedAt: Number(now) || Date.now(), records: {} };
  let merged = 0;
  for (const id of ids) {
    const ra = fa.records[id];
    const rb = fb.records[id];
    if (ra && !rb) { out.records[id] = cloneRec(ra); continue; }
    if (rb && !ra) { out.records[id] = cloneRec(rb); continue; }
    const older = isOlder(ra, rb) ? ra : rb;
    const newer = older === ra ? rb : ra;
    const val = mergeActivation(older, newer.activation, now, alpha, halfLifeMs);
    out.records[id] = {
      cardId: id,
      activation: val,
      lastUpdate: Math.max(Number(ra.lastUpdate) || 0, Number(rb.lastUpdate) || 0, 0),
      sourceSession: unionSessions(newer.sourceSession, older.sourceSession),
      hits: Math.max(Number(ra.hits) || 0, Number(rb.hits) || 0),
    };
    merged++;
  }
  out.updatedAt = Number(now) || Date.now();
  out._mergedRecords = merged;
  return out;
}

function isOlder(x, y) {
  const tx = Number(x && x.lastUpdate) || 0;
  const ty = Number(y && y.lastUpdate) || 0;
  if (tx !== ty) return tx < ty;
  // 持平：activation 小者视为「旧」（确定性，且与参数顺序无关）
  const ax = Number(x && x.activation) || 0;
  const ay = Number(y && y.activation) || 0;
  return ax <= ay;
}

function unionSessions(first, second) {
  const out = [];
  const seen = new Set();
  for (const list of [first, second]) {
    for (const s of (Array.isArray(list) ? list : [])) {
      const v = String(s);
      if (!v || seen.has(v)) continue;
      seen.add(v);
      out.push(v);
      if (out.length >= WM_DEFAULTS.activation.maxSessions) return out;
    }
  }
  return out;
}

function cloneRec(r) {
  return {
    cardId: r.cardId,
    activation: clamp01(Number(r.activation)),
    lastUpdate: Number(r.lastUpdate) || 0,
    sourceSession: Array.isArray(r.sourceSession) ? r.sourceSession.slice(0, WM_DEFAULTS.activation.maxSessions) : [],
    hits: Number(r.hits) || 0,
  };
}

function normalizeFile(f, alpha) {
  const src = f || {};
  const records = {};
  const raw = src.records && typeof src.records === 'object' ? src.records : {};
  for (const id of Object.keys(raw)) {
    const r = raw[id] || {};
    records[id] = {
      cardId: id,
      activation: clamp01(Number(r.activation)),
      lastUpdate: Number(r.lastUpdate) || 0,
      sourceSession: Array.isArray(r.sourceSession) ? r.sourceSession : [],
      hits: Number(r.hits) || 0,
    };
  }
  return { version: Number(src.version) || WM_HARD.SCHEMA_VERSION, alpha: clampAlpha(src.alpha === undefined ? alpha : src.alpha), updatedAt: Number(src.updatedAt) || 0, records };
}

function clampAlpha(a) { const n = Number(a); return Number.isFinite(n) && n > 0 && n <= 1 ? n : WM_DEFAULTS.activation.alpha; }
function clamp01(x) { if (!Number.isFinite(x)) return 0; return x < 0 ? 0 : x > 1 ? 1 : x; }
function round6(x) { return Math.round(x * 1e6) / 1e6; }

/**
 * 激活存储。构造即载入（不抛错：坏档自动降级为空档 + 打 warning）。
 *
 * @param {{dir?:string, alpha?:number, halfLifeMs?:number, maxRecords?:number, lockStaleMs?:number, logger?:object}} [opts]
 */
export function createActivationStore(opts) {
  const o = opts || {};
  const dir = o.dir || DEFAULT_WM_DIR;
  const alpha = o.alpha !== undefined ? o.alpha : WM_DEFAULTS.activation.alpha;
  const halfLifeMs = o.halfLifeMs !== undefined ? o.halfLifeMs : WM_DEFAULTS.activation.halfLifeMs;
  const maxRecords = o.maxRecords !== undefined ? o.maxRecords : WM_DEFAULTS.activation.maxRecords;
  const lockStaleMs = o.lockStaleMs !== undefined ? o.lockStaleMs : WM_DEFAULTS.activation.lockStaleMs;
  const logger = o.logger || null;

  const file = join(dir, ACTIVATION_FILE);
  const lockPath = join(dir, ACTIVATION_FILE + '.lock');

  let mem = emptyFile(alpha);
  const warnings = [];

  function emptyFile(al) {
    return { version: WM_HARD.SCHEMA_VERSION, alpha: clampAlpha(al), updatedAt: 0, records: {} };
  }

  function warn(code, detail) {
    warnings.push({ code, detail, at: Date.now() });
    try { logger && logger.miss && logger.miss({ level: 'wm-activation-' + code, reason: String(detail) }); } catch {}
  }

  /** 载入：目标坏 ⇒ 试 .bak；再坏 ⇒ 空档（绝不抛）。 */
  function load(now) {
    mem = emptyFile(alpha);
    const t = Number(now) || Date.now();
    const candidates = [file, file + '.bak'];
    for (const path of candidates) {
      if (!existsSync(path)) continue;
      let parsed = null;
      try {
        parsed = JSON.parse(readFileSync(path, 'utf8'));
      } catch (e) {
        warn('parse-failed', path + ': ' + String(e && e.message || e));
        continue;
      }
      if (!parsed || typeof parsed !== 'object' || !parsed.records) {
        warn('shape-invalid', path);
        continue;
      }
      if (Number(parsed.alpha) !== Number(clampAlpha(alpha))) {
        // α 不匹配：只告警，不拒绝加载（验收 D4）
        warn('alpha-mismatch', 'disk=' + parsed.alpha + ' mem=' + clampAlpha(alpha));
      }
      mem = normalizeFile(parsed, alpha);
      mem._loadedFrom = path;
      return mem;
    }
    mem._loadedFrom = null;
    return mem;
  }

  function get(cardId) { return mem.records[cardId]; }

  function entries() { return Object.keys(mem.records).map(function (k) { return mem.records[k]; }); }

  /** 单卡强化（EWMA + sourceSession LRU）。 */
  function reinforce(cardId, incoming, sessionId, now) {
    const id = String(cardId || '');
    if (!id) return undefined;
    const t = Number(now) || Date.now();
    const prev = mem.records[id];
    const val = mergeActivation(prev, incoming, t, alpha, undefined);
    const rec = {
      cardId: id,
      activation: val,
      lastUpdate: t,
      sourceSession: prev && Array.isArray(prev.sourceSession) ? prev.sourceSession.slice() : [],
      hits: (prev && Number(prev.hits) || 0) + 1,
    };
    if (sessionId) {
      const s = String(sessionId);
      rec.sourceSession = [s].concat(rec.sourceSession.filter(function (x) { return x !== s; })).slice(0, WM_DEFAULTS.activation.maxSessions);
    }
    mem.records[id] = rec;
    return rec;
  }

  function reinforceBatch(items, sessionId, now) {
    const t = Number(now) || Date.now();
    const out = [];
    for (const it of (items || [])) {
      if (!it || !it.cardId) continue;
      const inc = it.incoming !== undefined ? it.incoming : 1;
      out.push(reinforce(it.cardId, inc, sessionId, t));
    }
    return out;
  }

  /** 裁剪到 maxRecords：按 activation × 新鲜度 排序保留。 */
  function prune(now) {
    const t = Number(now) || Date.now();
    const ids = Object.keys(mem.records);
    if (ids.length <= maxRecords) return 0;
    const scored = ids.map(function (id) {
      const r = mem.records[id];
      const fresh = 1 / (1 + Math.max(0, t - (Number(r.lastUpdate) || 0)) / (24 * 3600 * 1000));
      return { id, s: (Number(r.activation) || 0) * 0.7 + fresh * 0.3 };
    });
    scored.sort(function (a, b) { return b.s - a.s; });
    let removed = 0;
    for (const x of scored.slice(maxRecords)) { delete mem.records[x.id]; removed++; }
    return removed;
  }

  /**
   * 原子落盘。
   * 步骤：① 取锁 ② 若磁盘比内存新 ⇒ 先合并（防后写覆盖先写）③ 写 tmp ④ 校验 ⑤ 备份旧档 ⑥ rename ⑦ 释放锁
   */
  function flush(now) {
    const t = Number(now) || Date.now();
    mkdirSync(dir, { recursive: true });
    let lock = null;
    try {
      lock = acquireLock(lockPath, { staleMs: lockStaleMs });
    } catch (e) {
      // 锁被同伴占着：本轮不写（不阻塞主流程），下次再写
      warn('lock-busy', String(e && e.message || e));
      return { path: file, bytes: 0, skipped: 'lock-busy' };
    }
    try {
      // ② 磁盘更新 ⇒ 合并（多会话并发保护）
      if (existsSync(file)) {
        try {
          const disk = JSON.parse(readFileSync(file, 'utf8'));
          const diskAt = Number(disk && disk.updatedAt) || 0;
          if (diskAt > (Number(mem.updatedAt) || 0)) {
            const merged = mergeActivationFiles(disk, mem, t, alpha, 0);
            delete merged._mergedRecords;
            mem = normalizeFile(merged, alpha);
          }
        } catch (e) { warn('merge-on-flush-skip', String(e && e.message || e)); }
      }

      const pruned = prune(t);
      mem.version = WM_HARD.SCHEMA_VERSION;
      mem.alpha = clampAlpha(alpha);
      mem.updatedAt = t;
      const payload = { version: mem.version, alpha: mem.alpha, updatedAt: mem.updatedAt, records: mem.records };

      const tmp = join(dir, ACTIVATION_FILE + '.tmp-' + process.pid + '-' + t);
      writeFileSync(tmp, JSON.stringify(payload), 'utf8');
      // ④ 自校验：解析不回来就当写失败，保留旧档
      let ok = false;
      try { const back = JSON.parse(readFileSync(tmp, 'utf8')); ok = !!back && typeof back === 'object' && !!back.records; } catch {}
      if (!ok) { try { unlinkSync(tmp); } catch {} ; warn('write-verify-failed', tmp); return { path: file, bytes: 0, skipped: 'verify-failed' }; }

      // ⑤ 旧档备份一代（读坏时兜底）
      if (existsSync(file)) { try { copyFileSync(file, file + '.bak'); } catch {} }
      // ⑥ 原子替换
      try { renameSync(tmp, file); }
      catch (e) {
        // Windows 上目标被占（防病毒/云同步扫描）⇒ 重试一次
        try { renameSync(tmp, file); } catch (e2) {
          try { unlinkSync(tmp); } catch {}
          warn('rename-failed', String(e2 && e2.message || e2));
          return { path: file, bytes: 0, skipped: 'rename-failed' };
        }
      }
      const bytes = statSync(file).size;
      return { path: file, bytes: bytes, pruned: pruned, records: Object.keys(payload.records).length };
    } finally {
      if (lock) { try { releaseLock(lockPath); } catch {} }
    }
  }

  return {
    dir, file, lockPath, alpha, halfLifeMs,
    load, get, entries, reinforce, reinforceBatch, prune, flush,
    warnings: function () { return warnings.slice(); },
    /** 只读视图（测试/调试用） */
    snapshot: function () { return { version: mem.version, alpha: mem.alpha, updatedAt: mem.updatedAt, records: Object.assign({}, mem.records) }; },
    size: function () { return Object.keys(mem.records).length; },
    /** 覆盖内存态（测试注入用，不落盘） */
    __setFile: function (f) { mem = normalizeFile(f, alpha); },
  };
}

export default { createActivationStore, mergeActivation, mergeActivationFiles, decayedActivation, DEFAULT_WM_DIR, ACTIVATION_FILE };
