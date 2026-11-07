/**
 * hypergraph/auto-refresh.js —— 索引自动保鲜（治本，不是定时全量乱刷）
 * [2026-10-22 by Assistant · 坑6 根治]
 *
 * 问题（交接文档 §四 坑6）：
 *   `manifest.builtAt` 16:45，而 `engrams.jsonl` 21:53 —— 索引比数据旧 5 小时。
 *   并且会出现 ghostCards（索引里有、源里没有）。**没有自动重建机制**。
 *   表现：新写的卡要等重启/手动 rebuild 才看得见，检索到的是旧标题/空摘要。
 *
 * 为什么不「定时全量重建」：
 *   全量 rebuild 实测 231ms，虽然不慢，但每 N 分钟无条件重建会：
 *     ① 无谓写盘（17 个分片 + 全局文件，2.4MB 反复覆写）
 *     ② 与检索线程抢 IO，可能让首字变慢
 *     ③ 把「数据真的变了」这个信号淹没掉（永远无法判断索引是否落后）
 *
 * 正确做法（本文件）：
 *   **只在源数据真的变了时才重建**——
 *     ① 计算源签名：engram 文件 (mtime+size) + tdai records 目录 (mtime+size) + 参数常量
 *     ② 与上次记录在内存里的签名比对；相同 ⇒ 什么都不做（零成本）
 *     ③ 不同 ⇒ 触发 buildAndPersist（内部有落盘锁 + 增量分片规划 planRebuild，
 *        只会重写脏片，不是全量）
 *     ④ 重建成功才更新签名；失败则保留旧签名 ⇒ 下一轮自动重试（不会静默放弃）
 *
 * 另外提供一个独立的"体检/自愈"入口 `ensureFresh({force})`，
 *   让User/下一个会话可以一条命令确认索引是否落后并立刻重建。
 */
import { statSync, existsSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { buildAndPersist } from './pipeline.js';
import { readManifest } from './store.js';

/** 参与签名计算的参数（任何一项变了都必须重建，否则索引与建图规则不符） */
const PARAM_KEYS = [
  'windowTurns', 'gapMs', 'capCards', 'tauUpdate', 'tauWeak', 'capEpisodes', 'episodesPerShard',
];

/**
 * 源签名：源文件/目录的 (mtimeMs, size) + 建图参数。
 * 刻意**不读文件内容**（25MB 的 jsonl 每轮读一遍太重），
 * 用 mtime+size 已足以发现"追加/改写"；如果是原地等长改写，mtime 也会变。
 */
export function sourceSignature({ source, tdaiDir, opts }) {
  const parts = [];
  const push = (label, p) => {
    try {
      if (!existsSync(p)) { parts.push(label + ':-'); return; }
      const st = statSync(p);
      parts.push(label + ':' + Math.round(st.mtimeMs) + ':' + st.size);
    } catch { parts.push(label + ':-'); }
  };
  push('engram', source);
  push('tdai', tdaiDir);

  const p = {};
  for (const k of PARAM_KEYS) if (opts && opts[k] !== undefined) p[k] = opts[k];
  parts.push('params:' + JSON.stringify(p));
  return createHash('sha1').update(parts.join('|'), 'utf8').digest('hex').slice(0, 16);
}

/** 索引侧签名：manifest 里记的 builtAt + 源指纹（若当初记录了） */
export function indexSignature(indexRoot) {
  try {
    const man = readManifest(indexRoot);
    if (!man) return null;
    return {
      // builtAt 是 ISO 字符串（manifest 里存的是 toISOString()），
      // 这里统一成毫秒数，避免调用方拿到两种类型还要各自判断。
      builtAt: typeof man.builtAt === 'number' ? man.builtAt : (Date.parse(String(man.builtAt || '')) || 0),
      schemaVersion: man.schemaVersion,
      shardCount: (man.shards || []).length,
      counts: man.counts || {},
    };
  } catch { return null; }
}

/**
 * 创建自动保鲜器。
 * @param {object} p
 * @param {string} p.indexRoot  索引根
 * @param {string} p.source     engrams.jsonl 路径
 * @param {string} p.tdaiDir    tdai records 目录
 * @param {number} p.intervalMs 轮询间隔（默认 10 分钟）
 * @param {boolean} p.enabled
 * @param {object} p.logger
 */
export function createAutoRefresh(p) {
  const cfg = p || {};
  const indexRoot = cfg.indexRoot;
  const source = cfg.source;
  const tdaiDir = cfg.tdaiDir;
  const intervalMs = Math.max(60000, Number(cfg.intervalMs) || 600000);
  const enabled = cfg.enabled !== false;
  const logger = cfg.logger || null;
  const buildOpts = cfg.buildOpts || {};

  const state = {
    enabled,
    indexRoot,
    source,
    lastSig: null,
    lastRunAt: 0,
    lastOkAt: 0,
    lastError: null,
    runs: 0,
    rebuilds: 0,
    skipped: 0,
    lastReport: null,
  };

  const sig = () => sourceSignature({ source, tdaiDir, opts: buildOpts });

  /** 立即检查并按需重建。force=true 无条件重建。 */
  function ensureFresh(opts) {
    const o = opts || {};
    if (!enabled && !o.force) return { ok: true, action: 'disabled' };
    const t0 = Date.now();
    state.runs++;
    state.lastRunAt = t0;
    try {
      const cur = sig();
      if (!o.force && cur === state.lastSig) {
        state.skipped++;
        return { ok: true, action: 'unchanged', sig: cur };
      }
      const rep = buildAndPersist({ root: indexRoot, source, ...buildOpts });
      // 只有成功才更新签名；失败保留旧值 ⇒ 下一轮自动重试
      state.lastSig = cur;
      state.lastOkAt = Date.now();
      state.rebuilds++;
      state.lastReport = {
        ms: Date.now() - t0,
        reason: rep.reason,
        full: rep.full,
        shards: rep.shards,
        counts: rep.manifest && rep.manifest.counts,
      };
      try { logger && logger.wake && logger.wake({ level: 'hypergraph-auto-refresh', ...state.lastReport }); } catch {}
      return { ok: true, action: 'rebuilt', sig: cur, report: state.lastReport };
    } catch (e) {
      state.lastError = String((e && e.message) || e);
      try { logger && logger.miss && logger.miss({ level: 'hypergraph-auto-refresh-failed', reason: state.lastError }); } catch {}
      return { ok: false, action: 'failed', reason: state.lastError };
    }
  }

  let timer = null;
  /** 启动轮询（unref：不阻止进程退出） */
  function start() {
    if (!enabled || timer) return;
    // 启动后先等一个间隔再跑：避免和暖启动抢时间（检索首字优先）
    timer = setInterval(() => { try { ensureFresh(); } catch {} }, intervalMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
  }
  function stop() { try { if (timer) clearInterval(timer); } catch {} timer = null; }

  return {
    ensureFresh,
    start,
    stop,
    get intervalMs() { return intervalMs; },
    status() {
      const idx = indexSignature(indexRoot);
      let curSig = null;
      try { curSig = sig(); } catch {}
      return {
        enabled, indexRoot, intervalMs,
        indexBuiltAt: idx && idx.builtAt ? new Date(idx.builtAt).toISOString() : null,
        indexBuiltAtMs: idx ? idx.builtAt : 0,
        indexCounts: idx && idx.counts,
        sourceSig: curSig,
        lastRebuiltSig: state.lastSig,
        stale: !!(curSig && state.lastSig && curSig !== state.lastSig),
        lastRunAt: state.lastRunAt ? new Date(state.lastRunAt).toISOString() : null,
        lastOkAt: state.lastOkAt ? new Date(state.lastOkAt).toISOString() : null,
        runs: state.runs, rebuilds: state.rebuilds, skipped: state.skipped,
        lastError: state.lastError,
        lastReport: state.lastReport,
      };
    },
  };
}
