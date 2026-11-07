/**
 * l0-cache.js —— L0 原话反查索引的「增量保鲜」
 * [2026-11-03 by Phoebe · P1-b（agy 红队口径）]
 *
 * ## 病灶（实测，不是推测）
 * working-memory.js:63-72 的 _l0Tried 让 l0IndexProvider 每个实例只被调一次：
 *   插件启动后新写的对话永远进不了索引 ⇒ 运行越久，能回查到的「刚才那句话」越少。
 * 且 _l0Tried 在**尝试之前**就置 true —— 首次失败会永久返回 null，
 * 这正是施工令明令禁止的「永久锁死 null」。
 *
 * ## 设计要点
 *  1. 按**文件签名**（size + mtimeMs + 文件名）判断变化，不是只记 lastSize。
 *  2. 只读**新增字节**；尾部半行留 carry，下次再拼，绝不对半行 JSON.parse。
 *  3. 追加以外的任何变化（size 变小 / 文件消失 / mtime 变了但 size 没变）
 *     ⇒ 整体全量重建。宁可慢一次，也不让索引与磁盘不一致。
 *  4. **绝不返回 null**：拿不到就保留旧索引并退避重试，禁用「试一次永久锁死」。
 *  5. 全量与增量共用 source.js 的 l0IngestText —— 同一份解析/去重/分桶语义，
 *     这是「增量与全量 100% 一致」的结构性保证。
 *  6. 暴露 builtAt / lastRefresh / lastError / stale / mode。
 *
 * ## 已知边界
 *  - JS 单线程且本刷新在单个同步任务内完成，读者看不到「半更新」。
 *  - _archive/ 下沉的分片不参与扫描（与 13 处读取点同口径）。
 */
import { statSync, openSync, readSync, closeSync, readFileSync } from 'node:fs';
import { listShardFiles } from '../shard-files.js';
import { l0IngestText } from './source.js';

let _state = null;   // { key, dirs, files: Map<path,{size,mtimeMs,offset}>, index, seenMsgId, builtAt, lastRefresh, lastError, refreshes, mode, builtMs }
let _lockUntil = 0;  // 退避重试：失败后到此时刻前不再尝试，但**不**永久放弃
let _backoffMs = 0;
let _lastGlobalError = null;   // 最近一次构建失败的错误（无 _state 时也能报出来）

const normDirs = (d) => {
  const a = Array.isArray(d) ? d : (d ? [d] : []);
  return a.map((x) => String(x || '')).filter(Boolean);
};

/**
 * 列文件 —— **必须走统一枚举器**，否则 _archive/ 里的分片会退出读视野。
 * [2026-11-03 by Phoebe · 红队第一批] 红队实测：轮转前 5 条，归档后只剩 1 条。
 * 根因就是这里原来只 readdir 一层 + endsWith('.jsonl')。
 */
function listFiles(dirs) {
  return listShardFiles(dirs).map((f) => ({ path: f.path, size: f.size, mtimeMs: f.mtimeMs, archived: f.archived }));
}

/** 从 offset 读到 EOF，返回 { complete: 可解析的完整行文本, nextOffset } */
function readTail(file, offset, size) {
  const len = size - offset;
  if (len <= 0) return { complete: '', nextOffset: offset };
  const fd = openSync(file, 'r');
  try {
    const buf = Buffer.allocUnsafe(len);
    const got = readSync(fd, buf, 0, len, offset);
    const slice = buf.subarray(0, got);
    const nl = slice.lastIndexOf(0x0A);          // 找最后一个换行
    if (nl < 0) return { complete: '', nextOffset: offset };   // 全是半行
    return { complete: slice.subarray(0, nl + 1).toString('utf8'), nextOffset: offset + nl + 1 };
  } finally { closeSync(fd); }
}

/**
 * 全量重建 —— **原子**：先在隔离状态里建好，成功了才替换 _state。
 *
 * [2026-11-03 by Phoebe · 红队第二批] 红队反例：存在读不了的文件时，
 *   旧实现 catch{continue} 静默跳过，却照样登记签名并把 lastError 置 null
 *   ⇒ 索引报 ready=true / stale=false，退避永不触发，那部分数据可能一直缺失。
 *
 * 新规则（红队口径）：
 *   ① 任何文件读取失败 ⇒ 本次重建失败：保留旧 _state、记 lastError、抛给调用方退避；
 *   ② 只有全部文件都成功才登记签名并替换状态；
 *   ③ 初始无索引时返回空 Map，但标记 ready=false / lastError，绝不冒充健康。
 */
function fullRebuild(dirs, key, t0) {
  const index = new Map();
  const target = { index, seenMsgId: new Set(), messages: 0 };
  const files = new Map();
  const failures = [];
  for (const f of listFiles(dirs)) {
    let raw = '';
    try { raw = readFileSync(f.path, 'utf8'); }
    catch (e) { failures.push({ path: f.path, error: e && e.message ? e.message : String(e) }); continue; }
    target.messages += l0IngestText(raw, target);
    const nl = raw.lastIndexOf('\n');
    files.set(f.path, { size: f.size, mtimeMs: f.mtimeMs, offset: nl >= 0 ? Buffer.byteLength(raw.slice(0, nl + 1), 'utf8') : 0 });
  }
  // 有任何文件读失败 ⇒ 不替换状态、不登记签名
  if (failures.length > 0) {
    const msg = 'unreadable ' + failures.length + ' file(s): '
      + failures.slice(0, 3).map((x) => x.path + ' => ' + x.error).join('; ');
    const err = new Error(msg);
    err.failures = failures;
    throw err;
  }
  for (const a of index.values()) a.sort((x, y) => x._ts - y._ts);
  _state = {
    key, dirs, files, index, seenMsgId: target.seenMsgId,
    builtAt: Date.now(), lastRefresh: Date.now(), lastError: null,
    refreshes: 0, mode: 'full', builtMs: Date.now() - t0, messages: target.messages,
    stale: false,
  };
  return _state;
}

/**
 * 取 L0 索引（带增量保鲜）。
 * @param {string|string[]} convDir 会话目录（一个或多个）
 * @param {{minRefreshMs?:number, now?:number, force?:boolean}} opts
 */
export function getL0IndexCached(convDir, opts) {
  const o = opts || {};
  const dirs = normDirs(convDir);
  const key = dirs.join('|');
  const now = Number.isFinite(o.now) ? o.now : Date.now();
  const minRefreshMs = Number.isFinite(o.minRefreshMs) ? o.minRefreshMs : 1000;
  const t0 = Date.now();

  // [2026-11-07 P2-3 · 红队修复] 空 dirs **必须返回空 Map**，不能把上一个数据根的索引
  //   当成"空调用的结果"回吐（那会让调用方拿到别处会话的数据）。
  if (!dirs.length) return new Map();

  // 退避期内：直接给旧索引（不返回 null）
  if (!o.force && now < _lockUntil && _state && _state.key === key) {
    _state.stale = true;
    return _state.index;
  }

  // 节流：太频繁就复用
  if (!o.force && _state && _state.key === key && (now - _state.lastRefresh) < minRefreshMs) {
    return _state.index;
  }

  try {
    // 首次 / 目录换了一套 ⇒ 全量
    if (!_state || _state.key !== key) {
      _backoffMs = 0; _lockUntil = 0;
      return fullRebuild(dirs, key, t0).index;
    }

    const live = listFiles(dirs);
    const liveMap = new Map(live.map((f) => [f.path, f]));

    // ① 文件消失 或 变短 ⇒ 无法安全增量 ⇒ 全量重建
    let mustFull = false;
    for (const [p, prev] of _state.files) {
      const cur = liveMap.get(p);
      if (!cur) { mustFull = true; break; }
      if (cur.size < prev.size) { mustFull = true; break; }
      // 长度没变但 mtime 变了 ⇒ 内容被改写（不是追加）⇒ 全量
      if (cur.size === prev.size && cur.mtimeMs !== prev.mtimeMs) { mustFull = true; break; }
    }
    if (mustFull) {
      _backoffMs = 0; _lockUntil = 0;
      const s = fullRebuild(dirs, key, t0);
      return s.index;
    }

    // ② 增量：只读新增字节
    const touched = new Set();
    let added = 0;
    let changed = false;
    for (const f of live) {
      const prev = _state.files.get(f.path);
      if (prev && f.size === prev.size && f.mtimeMs === prev.mtimeMs) continue;   // 没变
      changed = true;
      const offset = prev ? prev.offset : 0;
      const { complete, nextOffset } = readTail(f.path, offset, f.size);
      if (complete) {
        const target = { index: _state.index, seenMsgId: _state.seenMsgId, messages: 0 };
        added += l0IngestText(complete, target);
        // 记录本次可能被追加的桶，稍后重排
        for (const line of complete.split('\n')) {
          if (!line) continue;
          let ob; try { ob = JSON.parse(line); } catch { continue; }
          const sk = String(ob.sessionKey || ob.sessionId || '');
          let tsR = ob.timestamp !== undefined ? ob.timestamp : ob.recordedAt;
          let ts = typeof tsR === 'number' ? tsR : (tsR ? Date.parse(String(tsR)) : NaN);
          if (sk && Number.isFinite(ts)) touched.add(sk + '|' + Math.floor(ts / 1000));
        }
      }
      _state.files.set(f.path, { size: f.size, mtimeMs: f.mtimeMs, offset: nextOffset });
    }

    // 新出现的文件也要登记（上面循环已覆盖，因为 live 里有它、prev 为 undefined）

    if (changed) {
      for (const k of touched) {
        const a = _state.index.get(k);
        if (a && a.length > 1) a.sort((x, y) => x._ts - y._ts);
      }
      _state.refreshes += 1;
      _state.mode = added > 0 ? 'incremental' : 'scan-only';
      _state.lastError = null;
      _state.stale = false;
      _state.builtMs = Date.now() - t0;
    }
    _state.lastRefresh = now;
    _state.messages = (_state.messages || 0) + added;
    _backoffMs = 0; _lockUntil = 0;
    return _state.index;
  } catch (e) {
    // 失败：**保留旧索引**，记错，退避重试（绝不永久锁死、绝不返回 null）
    _state = _state || { key, dirs, files: new Map(), index: new Map(), seenMsgId: new Set(),
                         builtAt: 0, lastRefresh: 0, refreshes: 0, mode: 'error', messages: 0 };
    _state.lastError = e && e.message ? e.message : String(e);
    _lastGlobalError = _state.lastError;
    _state.stale = true;
    _backoffMs = Math.min(_backoffMs ? _backoffMs * 2 : 200, 30000);
    _lockUntil = now + _backoffMs;
    return _state.index;
  }
}

/** 统计 / 可观测性 */
export function l0CacheStats() {
  // [2026-11-03 by Phoebe · 红队第三批] 原来无索引时只返回 {ready:false}，
  //   缺 stale / lastError 字段 ⇒ 调用方（含部署探针）无法区分
  //   「还没建」和「建了但读失败」。红队要求：初始无索引也要标不可用。
  //   字段与正常态保持一致，值表示"尚未成功构建"。
  if (!_state) {
    return {
      ready: false, files: 0, buckets: 0, messages: 0,
      builtAt: 0, lastRefresh: 0, refreshes: 0, mode: 'none',
      lastError: _lastGlobalError || null, stale: true, builtMs: 0, backoffMs: _backoffMs,
    };
  }
  let buckets = 0, msgs = 0;
  for (const a of _state.index.values()) { buckets += 1; msgs += a.length; }
  // [2026-11-07 P2-3 · 红队修复] ready 必须表示「**有可用索引**」：
  //   首次全量成功才算 ready。首次失败时 catch 仍会创建一个占位 _state
  //   （builtAt=0 / mode='error'），旧实现只看 _state 是否存在 ⇒ 空索引也报 ready:true。
  //   现在：builtAt>0 且非 error 模式才算 ready。
  //   若已有旧的好索引、只是本轮增量失败 ⇒ builtAt>0 且 mode 仍为 full/incremental
  //   ⇒ ready 仍为 true，但 stale=true + lastError 会同时置位（调用方据此知道"陈旧"）。
  const ready = !!_state && _state.builtAt > 0 && _state.mode !== 'error';
  return {
    ready, key: _state.key, files: _state.files.size, buckets, messages: msgs,
    builtAt: _state.builtAt, lastRefresh: _state.lastRefresh, refreshes: _state.refreshes,
    mode: _state.mode, lastError: _state.lastError || null, stale: !!_state.stale,
    builtMs: _state.builtMs, backoffMs: _backoffMs,
  };
}

/** 测试用：清空（含全局错误，避免重置后统计还挂着旧错误） */
export function resetL0Cache() {
  _state = null; _lockUntil = 0; _backoffMs = 0; _lastGlobalError = null;
}
