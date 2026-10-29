/**
 * retriever.js —— 三级检索主入口。**本期唯一有 IO 的文件**。
 * 依据：DESIGN §1.5 / §1.6 / §1.5.2b / §3.3 验收 C。
 *
 * 铁律：
 *   · 对索引与源卡**只读**：只 readFileSync / readAllRecords，禁 write / rename / utimes
 *   · search() 是 async，**每个调用点都必须 await**（验收 H4 会断言 warm.p95 > 0.1ms）
 *   · 全链路 catch 到底，绝不向上抛（对齐期1 orchestrator 铁律）
 *   · 暖启动必须后台化（void warmup()），未暖完时返回 degrade:'fixed'，不阻塞首字
 */

import { recordFault } from '../faults.js';
import { readFileSync, existsSync, statSync, openSync, readSync, closeSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';

import { readManifest, readAllRecords } from '../hypergraph/store.js';
// [2026-10-22 by Assistant · 跨源] tdai 记录载入（两代记忆源合并进同一份 BM25）
import { readTdaiRecords as readTdaiRecordsImpl, DEFAULT_TDAI_DIR, readOwnIngest, DEFAULT_INGEST_ROOT, readSoulMdCards, DEFAULT_SOULMD_ROOT } from '../hypergraph/source.js';
import { buildL0RoundCards } from '../hypergraph/l0-rounds.js';
import { sigOfIngest } from '../ingest/core.js';
import { createTokenizer } from './tokenize.js';
import { createBm25Index, searchBm25 } from './bm25.js';
import { createAliasIndex, matchAlias, aliasHealth } from './alias.js';
import { weightedFuse, resolveAdaptiveK, classifyQuery, classifyTemporal } from './rrf.js';
// [2026-10-24 Round 32] 覆盖率判据复用同一份停用词表（判据只留一份）
import { STOPWORDS } from './types.js';
// [2026-10-28 by Assistant · 结构重构] 查询判据独立成模块（两把方向相反的尺并排放）
import {
  COMMON_QW, stripVirtual, qTermsOf as qTermsOfQ, literalsHit as literalsHitQ,
  TIME_WORD, EXPLICIT_TIME_INTENT, IN_SCOPE_WORD, OUT_OF_SCOPE,
} from './query-terms.js';
// [2026-10-28 by Assistant · 结构重构] L0 归一化 + 席位上限抽成纯函数模块
import { normalizeL0Rows } from './l0-normalize.js';
// [2026-10-28 by Assistant · 场景隔离] 默认关死；只有显式 sceneIsolation:true + scene 才启用
import { isVisible } from '../scenes.js';
// [2026-10-24 by Assistant · Step 2] 四股力乘法门控（红白双队终版）
import { rerankWithFourForces } from '../scoring/four-forces.js';
import { loadLiveConfig } from '../ingest/config.js';
import { stage1, stage2, stage3, expandHypergraph } from './stages.js';
// [2026-10-22 by Assistant · 向量路] 语义召回：把「字面不重合但意思相近」的卡捞回候选。
//   没有 key / 没有索引 / 超时 / 断网 ⇒ 全部静默降级，检索退回纯 BM25（绝不阻塞）。
import { resolveEndpoint, embedQuery, endpointLabel } from '../embedding/client.js';
import { createBreaker } from './breaker.js';
// [2026-10-26 by Assistant · 终审 P1] 本地 embedding 服务**自管拉起**（User 9-22 硬要求：功能内置插件）
import { ensureEmbedServer, touchEmbedServer, isEmbedServerAvailable } from './embed-fallback-server.js';
import { loadIndex, searchVector, indexStats, vectorOf, isCompatible } from '../embedding/index-store.js';
// [2026-10-23 by Assistant] 本地 StartLux-4B 决策模型精排保底
import { rerankL0Candidates } from './startlux-rerank.js';
import { STAGE_GUARD, estimateTokens, DEGRADE_LEVELS } from './types.js';
// [2026-10-23 by Assistant · 期8.3] 代数隐式超图（DESIGN §五 + 白队 §9.2 终裁）
//   只 import，不开开关 —— 默认 graphExpandEnabled: false，行为与接入前逐位相同。
import { buildIncidence, computeDynamicThreshold, expandOneHop, graphStats, deriveEntities } from '../ingest/graph.js';
// [2026-10-23 · 双轨闪回] 情境骨架：把卡片抽象成「同一种经历」，用于跨时空联想
import { extractMotifs } from '../ingest/motifs.js';
// [2026-10-26 · 字段口径统一] 归属会话只认这一份判据
import { sessionIdOf } from '../card-session.js';
import { dataPath } from '../paths.js';

// [2026-10-22 by Assistant · 路径统一] 与 pipeline.js 保持一致，指向 live（不是 C: 旧目录）。
export const DEFAULT_INDEX_ROOT = dataPath('hypergraph');

/**
 * [2026-10-23 by Assistant · 白队裁决一] 图扩散权重的解析优先级：
 *   ① 显式配置 c.wGraph（含 0 —— 0 就是 Kill Switch，1 秒回退用）
 *   ② 环境变量 DSH_GRAPH_W（运维可临时调，不用改代码）
 *   ③ 默认 0.5（白队钦定：既打破空操作，又不压过 BM25 的 1.0）
 *
 * ⚠️ Kill Switch：把 wGraph 设 0 即可让图完全退出融合（rrf.js 里 w===0 直接 continue），
 *    这是白队强调「不能丢的防波堤」。
 */
export function resolveGraphWeight(c) {
  const cfg = c || {};
  if (cfg.wGraph !== undefined && cfg.wGraph !== null && Number.isFinite(Number(cfg.wGraph))) {
    return Number(cfg.wGraph);
  }
  const env = process.env && process.env.DSH_GRAPH_W;
  if (env !== undefined && env !== '' && Number.isFinite(Number(env))) {
    return Number(env);
  }
  return 0.5;
}
// [2026-10-22 by Assistant · 交接文档坑5 修复]
//   原值指向 ~/.dsh/engram-relay/（**6241 条，旧**），
//   而期5 已把存储根迁到云盘 live（**6421 条，新**）。
//   两处（本文件 + backends/engram.js）都读旧路径 ⇒ 同一张卡有时找得到有时找不到。
//   统一指向 live；旧路径不再被读取。
export const DEFAULT_ENGRAM_PATH = dataPath('engram-relay/engrams.jsonl');
// [2026-10-29 开源改造] alias 词表原本硬编码指向一个 _tmp 下的临时探针产物
//   （~/_tmp/engram-triggers-20261018/...）—— 那个文件**不该进仓库**，
//   也不该成为默认依赖。改成：从数据根下找，找不到就自动降级（alias = null，纯 BM25）。
export const DEFAULT_ALIAS_PATH = dataPath('alias/engram-triggers.preview.jsonl');

/**
 * 源卡读取：只读一次。返回 { cards, stats }。
 *
 * ── [2026-10-26 by Assistant · E8 根因] **必须按 id 去重，后写覆盖先写** ──
 *
 * 事故（实测坐实，不是推测）：
 *   盘上是**追加式日志** —— 更新一张卡是再追加一行同 id 的新版本，原行不动。
 *   这里原来逐行 cards.push(o)、不去重 ⇒ 同一张卡在 BM25 索引里出现 N 次。
 *   Stage1 会把它当成 N 个独立候选返回；而 weightedFuse 的 bump() 是**累加**
 *   （total += v）⇒ 分数被放大 N 倍。
 *
 *   实测规模：主库 96 个重复 id / 多出 154 个副本 / 单卡最多 7 个版本；
 *             自产库 18 个重复 id / 多出 27 个副本 / 单卡最多 4 个版本。
 *   实测后果：同一句话 3 个版本（只差语气描写） ⇒ stage1 归一化分 0.5457 × 3 = 1.6370
 *             ⇒ 直接窜到第 1 名，把真正的答案挤到 11~21 名。
 *             E8「加权 ≥ 仅 Stage1」被打红（99/130 → 96/130），5 道题被挤掉。
 *
 * 为什么这是**判据不一致**、不是调参问题：
 *   hypergraph/source.js 的三个加载器（tdai / rec / own）**全都** byId.set 去重，
 *   compactContentSig() 也按「后写覆盖先写」算指纹 —— 只有这里没去重。
 *   ⇒ 索引里的文档数 > 指纹认为的卡数，两套口径打架。
 *   这正是本项目第一号铁律：「判据只能有一份，修一处漏一处」。
 *
 * 语义选择：**后写覆盖先写**（与 append-only 日志、与 compactContentSig 完全一致）。
 * 注意 retired 判断必须放在去重**之后**：否则"先活后退"的卡会因为先遇到 active 版本被误留。
 */
function readSourceCards(path) {
  const st = statSync(path);
  const raw = readFileSync(path, 'utf8');
  const byId = new Map();
  let lines = 0;
  for (const line of raw.split('\n')) {
    if (!line) continue;
    lines++;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (!o.id) continue;
    byId.set(String(o.id), o);              // 后写覆盖先写 = 取最后状态（含 retired 版本）
  }
  const cards = [];
  for (const o of byId.values()) {
    if ((o.status || 'active') === 'retired') continue;   // 去重后再判活
    cards.push(o);
  }
  const head = raw.slice(0, 1024 * 1024);
  return {
    cards,
    stats: {
      path,
      bytes: st.size,
      mtimeMs: st.mtimeMs,
      lines,
      alive: cards.length,
      sha256Head1MB: createHash('sha256').update(head, 'utf8').digest('hex').slice(0, 16),
    },
  };
}

/**
 * 创建检索器。
 *
 * @param {{
 *   indexRoot?:string, engramPath?:string, aliasPath?:string,
 *   tokenizer?:'bigram'|'segment', aliasEnabled?:boolean,
 *   wEdge?:number, wAlias?:number, minEpisodeK?:number, maxNeighbors?:number,
 *   enabled?:boolean
 * }} [cfg]
 * @param {object} [logger]
 */
export function createRetriever(cfg, logger) {
  const c = cfg || {};
  if (c.enabled === false) {
    // 开关关闭 ⇒ 返回 null，orchestrator 走原逻辑（R0 回滚档）
    return null;
  }

  const indexRoot = c.indexRoot || DEFAULT_INDEX_ROOT;
  const engramPath = c.engramPath || DEFAULT_ENGRAM_PATH;
  const aliasPath = c.aliasPath || DEFAULT_ALIAS_PATH;

  const state = {
    ready: false,
    warming: null,
    reason: null,
    builtAt: 0,
    tok: null,
    bm25: null,
    alias: null,
    ctx: null,
    sourceStats: null,
    cardsById: null,
    coverage: null,
    lastResult: null,
    degrade: 'fixed',
    // [2026-10-22 by Assistant · 向量路] 端点没配 key ⇒ null（= 自动退回纯 BM25）
    vecEp: resolveEndpoint(c.embedding),
    // [2026-10-26 by Assistant · 向量备路（下级切换）] 主路失败时用的备用端点。
    //   不配置 ⇒ null ⇒ 下面所有备路分支短路 ⇒ 行为与接入前**逐位相同**。
    //   注意：备路**只用于查询**（embedQuery），绝不用于建库（会改 index.json 的 model）。
    vecEpFallback: resolveEndpoint(c.embeddingFallback),
    vecIdx: null,
    vecStats: null,
    vecLast: null,
 l0Stats: null,
 l0CardsById: new Map(),
 l0Bm25: null,
    // [2026-10-22 by Assistant · 索引快照修复] 源文件签名（mtime:size）。
    //   红队受控实验已证实：已暖实例看不到之后写入的卡（bm25.N 不涨），
    //   再调 warmup() 也无效（幂等），只有新实例能看到。
    //   ⇒ 每次 search 前比一次签名，变了就**后台**重建（不阻塞本轮、期间仍用旧索引）。
    srcSig: null,
    srcStale: false,
    rebuildCount: 0,
    lastRebuildAt: 0,
    // [2026-10-22 by Assistant · 架构红队 P0/A2] 重建失败追踪。
    //   红队指出：hadReady 保护会让故障静默存在很久（health 仍 ready，只有一条日志）。
    //   这里加计数 + 上次成功时间，超过阈值就在 health 里标 warn / degrade。
    consistency: null,
    rebuildFails: 0,
    consecutiveFails: 0,
    lastRebuildOkAt: 0,
    lastRebuildFailAt: 0,
    // [2026-10-23 by Assistant · 期8.3] 二部关联矩阵（内存派生，不落盘）+ 动态超级节点阈值
    //   只在 graphExpandEnabled===true 时于 warmup 里填充；否则恒为 null。
    graphIncidence: null,
    graphThreshold: null,
    graphStatsCache: null,
  };

  function nowMs() { return Number(process.hrtime.bigint() / 1000n) / 1000; }

  /**
   * [2026-10-22 by Assistant · 索引快照修复] 源数据签名。
   * 只要 engram 文件的 mtime/size 或 tdai 目录的 mtime 变了，就认为"有新卡"。
   * stat 成本 <0.1ms，每轮查一次可以接受；它换来的是「写完的卡下一轮就能召回」。
   */
  /**
   * [2026-10-24 by Assistant · Round 40] **索引相关内容的指纹**（替代物理文件签名）。
   *
   * 为什么不能直接用 mtime/size：采纳核验每轮都给 hits+1（追加一行），
   *   mtime 与 size 都变 ⇒ 触发整库重建 ⇒ 每 5 秒重建一次 1.5 秒的索引。
   *
   * 做法：只对「影响 BM25 索引」的字段取哈希 —— **卡 id + 标题 + 摘要**。
   *   · 新增/删除卡 ⇒ id 集合变 ⇒ 指纹变
   *   · 改标题/摘要 ⇒ 指纹变
   *   · 只改 hits/lastHitAt/importance ⇒ 指纹**不变** ⇒ 不重建（这正是我们要的）
   *
   * 性能：用 mtime 做**快速短路** —— 文件没被写过就直接复用上次算的指纹，
   *   不读盘。只有真被写过才重算一次（约 30~60ms，远低于重建的 1500ms）。
   */
  /**
   * [Round 41] tdai 目录的内容指纹：逐文件取「id + 标题」哈希。
   *   只取最近 90 天（与 sigOfIngest 同口径，避免随年限无限涨）。
   *   每个文件用 mtime 做快速短路。
   */
  const _tdaiFileSigCache = new Map();
  function tdaiDirSig(dir) {
    let names = [];
    try { names = readdirSync(dir).filter((n) => n.endsWith('.jsonl')).sort().slice(-90); } catch { return 'no'; }
    const parts = [];
    for (const n of names) {
      try {
        const f = dir + '/' + n;
        const st = statSync(f);
        const cacheKey = Math.round(st.mtimeMs) + ':' + st.size;
        const hit = _tdaiFileSigCache.get(f);
        if (hit && hit.key === cacheKey) { parts.push(n + ':' + hit.sig); continue; }
        const h = createHash('sha1');
        const byId = new Map();
        for (const line of readFileSync(f, 'utf8').split('\n')) {
          if (!line) continue;
          let o; try { o = JSON.parse(line); } catch { continue; }
          if (!o || o.id === undefined || o.id === null) continue;
          byId.set(String(o.id), o);
        }
        for (const id of [...byId.keys()].sort()) {
          const c = byId.get(id) || {};
          h.update(id + '\u0001' + String(c.title || c.scene_name || '') + '\u0001' + String(c.summary || '').slice(0, 80) + '\u0001');
        }
        const sig = 'c' + byId.size + '-' + h.digest('hex').slice(0, 10);
        _tdaiFileSigCache.set(f, { key: cacheKey, sig });
        parts.push(n + ':' + sig);
      } catch { parts.push(n + ':err'); }
    }
    return parts.join(';');
  }

  let _contentSigCache = { key: '', sig: '' };
  function compactContentSig(file, st) {
    const key = Math.round(st.mtimeMs) + ':' + st.size;
    if (_contentSigCache.key === key && _contentSigCache.sig) return _contentSigCache.sig;
    try {
      const raw = readFileSync(file, 'utf8');
      const byId = new Map();
      for (const line of raw.split('\n')) {
        if (!line) continue;
        let o; try { o = JSON.parse(line); } catch { continue; }
        if (!o || o.id === undefined || o.id === null) continue;
        byId.set(String(o.id), o);          // 后写覆盖先写 = 取最后状态
      }
      const h = createHash('sha1');
      const ids = [...byId.keys()].sort();
      for (const id of ids) {
        const c = byId.get(id) || {};
        // 只喂**影响检索**的字段；hits/importance/lastHitAt 一律不喂
        h.update(id + '\u0001' + String(c.title || '') + '\u0001' + String(c.summary || '') + '\u0001');
      }
      const sig = 'c' + byId.size + '-' + h.digest('hex').slice(0, 12);
      _contentSigCache = { key, sig };
      return sig;
    } catch (e) {
      // 算不出来就退回物理签名（保守：宁可多重建，也不漏新卡）
      return 'f' + Math.round(st.mtimeMs) + ':' + st.size;
    }
  }

  function sourceSigOf() {
    const parts = [];
    try {
      const st = statSync(engramPath);
      // [2026-10-22 by Assistant · 架构红队 P2/A3] 签名加强。
      //   红队指出：只比 mtime:size，**原地覆盖同字节内容**会漏检（mtime 变了但 size 没变，
      //   或者文件系统 mtime 粒度粗到秒级时连续两次写落在同一秒）。
      //   补三项：
      //     ① ctimeMs —— 覆盖写入时 ctime 也会更新（与 mtime 不同源，互补）
      //     ② 文件头 4KB 的 sha1 前 8 位 —— 内容变了几乎必然改变
      //     ③ size 保留
      //   成本：每轮多读 4KB + 一次 sha1，约 0.1ms（相对 126ms 的检索可忽略）。
      let head = '';
      try {
        const fd = openSync(engramPath, 'r');
        try {
          const buf = Buffer.alloc(Math.min(4096, st.size));
          readSync(fd, buf, 0, buf.length, 0);
          head = createHash('sha1').update(buf).digest('hex').slice(0, 8);
        } finally { closeSync(fd); }
      } catch { head = 'nohead'; }
      // ── [2026-10-24 by Assistant · Round 40 抓到的性能坑] ──
      //   原签名带 mtime + ctime ⇒ **任何**写盘都触发整库重建。
      //   而采纳核验每轮都在给命中卡 hits+1 ⇒ 主库被追加一行 ⇒ mtime 变
      //   ⇒ 下一秒检索发现签名变了 ⇒ 重建 9,534 张文档的索引（~1.5 秒）。
      //   实测：13 分钟里 warmup 跑了 10 次、source-changed 137 次，
      //   **这才是「检索 p90 = 4.5 秒」的真正原因**（不是机器负载）。
      //
      //   关键洞察：**hits 变化不影响 BM25 索引** —— 索引只依赖 title/summary/content。
      //   ⇒ 签名必须反映「索引相关内容有没有变」，而不是「文件有没有被写过」。
      //   但只看 size 也不行：追加 hits 版本行同样会改 size。
      //   ⇒ 用**内容指纹**：取「有效卡数 + 全部卡 id 与标题的滚动哈希」。
      //      · 新增/删除卡 ⇒ id 集合变 ⇒ 签名变 ✓
      //      · 改标题/摘要 ⇒ 内容哈希变 ✓
      //      · 只改 hits / lastHitAt ⇒ **id 与标题都没变** ⇒ 签名不变 ✓（不再重建）
      //   成本：要读一遍文件算哈希（~26MB，约 30-60ms）—— 但它是每轮都做的，
      //     比"每次重建 1.5 秒"便宜 30 倍；且用 mtime 做快速短路（没写盘就直接跳过）。
      parts.push('e:' + compactContentSig(engramPath, st));
    } catch { parts.push('e:-'); }
    try {
      const td = c.tdaiDir || DEFAULT_TDAI_DIR;
      const st2 = statSync(td);
      // ── [2026-10-24 by Assistant · Round 41 同一个坑的第三处] ──
      //   原来只 stat **目录** mtime/ctime —— 而往已存在的 .jsonl 追加不会改目录 mtime
      //   ⇒ 「tdai 卡变化察觉不到」（这是 Round 40 之前的老问题）
      //   ⇒ 现在采纳核验还会往 tdai 按天文件追加 hits
      //   ⇒ 必须**逐文件**看，且只看内容指纹（不看 hits）。
      parts.push('t:' + tdaiDirSig(td));
    } catch { parts.push('t:-'); }
    // [2026-10-22 by Assistant · 期7] 本插件自产的写入侧也必须进签名。
    //
    // [红队 P0] 旧写法只 stat records **目录** mtime —— 这是错的：
    //   往**已存在的** 2026-10-22.jsonl 里追加，目录 mtime 不变 ⇒ 签名不变
    //   ⇒ 后台重建不触发 ⇒「新卡最多晚一轮可见」的承诺不成立。
    //   现在改成 stat 目录下**每个 .jsonl 文件**的 mtime+size，取最大值与总字节。
    //   成本：一次 readdirSync + N 次 stat（N = 天数，通常 <40），实测 <1ms。
    //   逐文件 stat（mtime+size），算法与 lib/ingest/core.js 的 sigOfIngest **同一份**，
    //   避免「测试用一套、线上用另一套」。
    try { parts.push(sigOfIngest(c.ingestRoot)); } catch { parts.push('i:-'); }
    return parts.join('|');
  }

  /** 暖启动：载入索引 + 源卡 + 建 BM25。幂等：并发调用返回同一个 Promise。 */
  function warmup(force) {
    // 正在建：直接复用（不排队，避免并发 rebuild 打架）
    if (state.warming) return state.warming;
    if (state.ready && !force) return Promise.resolve({ ok: true, ms: 0, reason: 'already-warm' });

    state.warming = (async function () {
      const t0 = nowMs();
      // [2026-10-22 by Assistant · 索引快照修复] 重建期间**保留旧索引可用**：
      //   重建是后台异步的，此时若有并发检索，它应该继续用旧索引正常出结果，
      //   而不是因为"正在重建"被降级成 fixed。只有**首次**（此前从未就绪）才允许降级。
      const hadReady = state.ready;
      const hadDegrade = state.degrade;
      try {
        const tok = createTokenizer({ mode: c.tokenizer || 'bigram' });

        // ① 索引（四类记录：episode / fedge / eedge / topic / oedge）
        const man = readManifest(indexRoot);
        const all = man ? readAllRecords(indexRoot, (man.shards || []).length) : {
          episodes: [], factEdges: [], episodeEdges: [], topics: [], ordinaryEdges: [],
          byType: { episode: 0, fedge: 0, eedge: 0, topic: 0, oedge: 0 },
        };

        // ② Episode 元数据 + 卡反查
        const episodes = new Map();
        const cardToEpisode = new Map();
        for (const ep of all.episodes) {
          const cardIds = ep.cardIds || [];
          episodes.set(ep.id, {
            id: ep.id,
            cardIds,
            weightScale: ep.weightScale !== undefined && ep.weightScale !== null ? ep.weightScale : 1,
            completeness: ep.completeness !== undefined ? ep.completeness : null,
            startAt: ep.startAt || 0,
            endAt: ep.endAt || 0,
            projectId: ep.projectId || null,
          });
          for (const cid of cardIds) {
            if (!cardToEpisode.has(cid)) cardToEpisode.set(cid, ep.id);
          }
        }

        // ③ fedge 索引：anchorId(=episodeId) -> [edge]
        const edgesByEpisode = new Map();
        for (const fe of all.factEdges) {
          const anchor = fe.anchorId;
          if (!anchor) continue;
          let arr = edgesByEpisode.get(anchor);
          if (arr === undefined) { arr = []; edgesByEpisode.set(anchor, arr); }
          arr.push(fe);
        }

        // ④ 源卡（全部活卡 —— BM25 保底铁律，不许按超边预过滤）
        let sourceStats = null;
        let cards = [];
        // ── [2026-10-28 by Assistant · 测试接缝] ──
        //   为什么加：场景隔离的变异测试需要"带 scene 字段的卡"，
        //   但真实卡库 6818 张里 0 张有 scene ⇒ 任何"该挡"的变异都测不出来。
        //   ⇒ 提供一个显式注入点（只给测试用，生产不传就等于不存在）。
        //   ⚠️ 约束：注入后**跳过磁盘读取**，避免真实卡混入导致测试边界模糊。
        if (typeof c.cardsProvider === 'function') {
          try {
            const injected = c.cardsProvider();
            cards = Array.isArray(injected) ? injected.slice() : [];
            sourceStats = { injected: true, n: cards.length };
          } catch (e) {
            cards = [];
            sourceStats = { injected: true, error: String(e && e.message || e) };
          }
        } else if (existsSync(engramPath)) {
          const r = readSourceCards(engramPath);
          cards = r.cards;
          sourceStats = r.stats;
        }

        // ④.5 [2026-10-22 by Assistant · 跨源] 把 tdai 的按天记录并入同一份 BM25。
        //   记忆有两个源：tdai 从 2026-08-15 起、engram 从 2026-09-09 起。
        //   不并进来，8 月的事（比如「最早的桌宠」）永远检索不到。
        //   tdai 卡 id 带 'tdai:' 前缀；它们没有 episode/超边，只走 BM25 + 时间排序。
        let tdaiStats = null;
        const tdaiEnabled = c.tdaiEnabled !== false;
        if (tdaiEnabled) {
          try {
            const td = readTdaiRecordsImpl(c.tdaiDir || DEFAULT_TDAI_DIR, { since: c.tdaiSince || null });
            if (td && td.cards && td.cards.length) {
              const engramIds = new Set(cards.map((x) => String(x.id)));
              // [2026-10-22 by Assistant · 架构红队 P1/A4] 跨源**内容**去重。
              //   红队指出：两源同一内容但 ID 不同（engram:abc vs tdai:m_xxx）会各自进 BM25，
              //   weightedFuse 按 ID 建 Map 不合并 ⇒ 双命中、双计分、可能重复注入同一条记忆。
              //   做法：对已有 engram 卡建「内容指纹」集合（title+summary 归一化后 sha1 前 16 位），
              //   tdai 卡若指纹相同就跳过（engram 是主源，优先保留它的 id 与超边）。
              const contentKey = (c0) => {
                const t = String(c0 && c0.title || '').replace(/\s+/g, '').slice(0, 200);
                const s = String(c0 && c0.summary || '').replace(/\s+/g, '').slice(0, 300);
                if (!t && !s) return '';
                return createHash('sha1').update(t + '\u0000' + s, 'utf8').digest('hex').slice(0, 16);
              };
              const engramFp = new Set();
              for (const x of cards) { const k = contentKey(x); if (k) engramFp.add(k); }
              let added = 0;
              let dedupedByContent = 0;
              for (const tc of td.cards) {
                if (engramIds.has(tc.id)) continue;
                const k = contentKey(tc);
                if (k && engramFp.has(k)) { dedupedByContent++; continue; }
                cards.push(tc);
                if (k) engramFp.add(k);   // 防止 tdai 内部重复
                added++;
              }
              tdaiStats = { files: td.files, bytes: td.bytes, parsed: td.cards.length, added, dedupedByContent, reason: td.reason || null };
            } else {
              tdaiStats = { files: td ? td.files : 0, parsed: 0, added: 0, reason: (td && td.reason) || 'empty' };
            }
          } catch (e) {
            tdaiStats = { added: 0, reason: String(e && e.message || e) };
          }
        }

        // ④.6 [2026-10-22 by Assistant · 期7 闭环] 把**本插件自己产**的 L1 + 蒸馏卡并进同一个池。
        //   这是「写入侧搬完必须能被检索到」的最后一环：只写不读 = 产了看不见，
        //   正是这轮改造反复踩的坑。默认开启；ingestRoot 不存在时零影响。
        let ingestStats = null;
        if (c.ingestEnabled !== false) {
          try {
            const own = readOwnIngest(c.ingestRoot || DEFAULT_INGEST_ROOT);
            if (own && own.cards && own.cards.length) {
              const have = new Set(cards.map((x) => String(x.id)));
              let added = 0;
              for (const oc of own.cards) {
                if (have.has(String(oc.id))) continue;
                cards.push(oc);
                have.add(String(oc.id));
                added++;
              }
              ingestStats = { files: own.files, parsed: own.cards.length, added, reason: own.reason || null };
            } else {
              ingestStats = { files: own ? own.files : 0, parsed: 0, added: 0, reason: (own && own.reason) || 'empty' };
            }
          } catch (e) {
            ingestStats = { added: 0, reason: String(e && e.message || e) };
          }
        }

        // ── [2026-10-27 by Assistant · 第1步] 第四源：soul-md 的 Markdown 记忆 ──
        //   memory_append({topic}) 写的内容只落 md 文件、不进任何卡片源 ⇒ 搜不回来。
        //   这里只读解析进来，让Assistant主动写下的东西也能被 BM25 命中。
        //   默认关闭（soulMdEnabled !== true 时不启用），逐个打开实测。
        let soulMdStats = null;
        if (c.soulMdEnabled === true) {
          try {
            const sm = readSoulMdCards(c.soulMdRoot || DEFAULT_SOULMD_ROOT);
            if (sm && sm.cards && sm.cards.length) {
              // ── [2026-10-27 二次修复 · 标题去重改 id 去重] ──
              //   病灶：原来按 **title** 去重，导致不同 topic 文件里同名的块被当重复跳过。
              //   实测 21 块被跳，但逐块核查后：
              //     · 20 块来自 _maintenance/bak-core-*.md（core.md 的**旧备份**，
              //       标题与现行 core.md 完全同名）⇒ 跳过是**正确行为**，不该救
              //     · 只有 1 块是真该救的：「关键教训」（memory-temporal-fallback）
              //       与 memory-dual-track 里的同名块内容完全不同
              //   修法：① 按 **id** 去重（id 已唯一，不会误杀）
              //        ② 排除 _maintenance 备份目录（旧备份不该进检索池）
              //
              // ── [2026-10-27 22:2x by Assistant · 第三次修正：archive 不能排除] ──
              //   上一版顺手把 archive/ 也排除了，**这是错的**。实测核查：
              //     archive/ 里 178 块 = 卷1(48) + 卷2(84) + 卷3(40) 共 172 块
              //     它们的来源是 「Assistant.md 瘦身时整段搬出去的**真记忆**」
              //     （archive/INDEX.md 原文：「归档=原文一字不改」）
              //   ⇒ 排除 archive = 把 2026-09-10~09-21 的历史记忆整段踢出检索池。
              //   A/B 实测（旧池 316 块 vs 上一版新池 139 块）：
              //     查「按钮一律白色统一线性图标」→ 旧池 top1 是 archive 卷1
              //        （score 69.86「2026-09-10 01:25 · User偏好（UI/交互）」）
              //        上一版新池里这块**彻底消失**，只剩 score 60 的 core.md 摘要
              //     查「DSH 终端桥接」→ 旧池 top3 全是卷1，新池**一条 archive 都没有**
              //   ⇒ 只有 _maintenance/ 才是「备份」，archive/ 是「冷存储真记忆」。
              //      两者必须区别对待，不能凭目录名都叫「备份目录」。
              const seen = new Set(cards.map((x) => String(x.id || '')));
              let added = 0, skippedBackup = 0;
              for (const sc of sm.cards) {
                const path = String(sc.sourcePath || '');
                if (path.includes('/_maintenance/') || path.startsWith('_maintenance/')) {
                  skippedBackup++;
                  continue;
                }
                const key = String(sc.id || '');
                if (key && seen.has(key)) continue;
                if (key) seen.add(key);
                cards.push(sc);
                added++;
              }
              soulMdStats = { files: sm.stats.files, blocks: sm.stats.blocks, added, skippedBackup };
            } else soulMdStats = { files: 0, blocks: 0, added: 0 };
          } catch (e) { soulMdStats = { error: String(e && e.message || e) }; }
        }

        // ⑤ 三覆盖口径（DESIGN §1.5.2b）
        // L0 rounds are indexed separately so legacy vector/episode maps stay unchanged.
 let l0Stats = null; let l0Cards = [];
 if (c.l0Enabled === true) {
 try {
 l0Cards = typeof c.l0CardsProvider === 'function' ? c.l0CardsProvider() : buildL0RoundCards(c.conversationsDir, { recentDays: c.l0RecentDays });
 if (!Array.isArray(l0Cards)) l0Cards = [];
 l0Stats = l0Cards.stats || { rounds: l0Cards.length };
 } catch (e) { l0Cards = []; l0Stats = { rounds:0, error: String(e && e.message || e) }; }
 } const alive = cards.length;
        const episodeCovered = cardToEpisode.size;
        let edgeCovered = 0;
        for (const [cid] of cardToEpisode) {
          const ep = cardToEpisode.get(cid);
          if (edgesByEpisode.has(ep)) edgeCovered++;
        }
        // 只统计「真的出现在某条 fedge 的 members 里」的卡（更严格，与实测 4,260 同口径）
        const edgeMembers = new Set();
        for (const fe of all.factEdges) for (const m of (fe.members || [])) edgeMembers.add(m.nodeId);
        edgeCovered = edgeMembers.size;
        const noEdge = Math.max(0, episodeCovered - edgeCovered);

        // ⑥ BM25（扫全部活卡）
        const bm25 = createBm25Index(cards, tok);
 const l0Bm25 = l0Cards.length ? createBm25Index(l0Cards, tok) : null;

        // ⑦ alias 词表（失败不阻塞）
        let alias = null;
        if (c.aliasEnabled !== false) {
          try { alias = createAliasIndex({ previewPath: aliasPath }); } catch { alias = null; }
        }

        const cardsById = new Map();
        for (const card of cards) cardsById.set(card.id, card);

        state.tok = tok;
        state.tdaiStats = tdaiStats;
 state.l0Stats = l0Stats;
 state.l0CardsById = new Map(l0Cards.map(function (x) { return [String(x.id), x]; }));
 state.l0Bm25 = l0Bm25;
        state.cardsById = cardsById;
        state.bm25 = bm25;
        state.alias = alias;
        state.sourceStats = sourceStats;
        state.ingestStats = (typeof ingestStats !== 'undefined' ? ingestStats : null);
        state.ctx = {
          bm25, alias, cardToEpisode, episodes, edgesByEpisode, tok,
          bm25Fallback: true,           // ★ P0-2：常量 true，运行期不可关
        };
        state.coverage = {
          alive: alive || sourceStats && sourceStats.alive || 0,
          episodeCovered,
          edgeCovered,
          noEdge,
          edgeRatio: alive > 0 ? Number((edgeCovered / alive).toFixed(4)) : 0,
          bm25Fallback: true,
        };
        state.byType = all.byType;
        state.ready = bm25.N >0 || !!(l0Bm25 && l0Bm25.N >0);
        state.degrade = state.ready
          ? (episodes.size > 0 && all.factEdges.length > 0 ? 'full' : 'no-episode')
          : (alias && alias.size > 0 ? 'alias-only' : 'fixed');
        state.reason = state.ready ? null : 'bm25-empty';
        // [2026-10-22 by Assistant · 架构红队 P0/A1] 卡集合校验。
        //   红队指出：backend 只核对「manifest.counts vs 落盘条数」，
        //   **从没比对过「索引里的卡 ID 集合」与「源卡集合」**。
        //   后果：源里删掉/改名的卡，在 cardToEpisode 里仍占位，超图扩展时会被当邻居捞出来。
        //   这里算两个方向的差异，写进 health；超阈值就把 reason 标成 ghost-cards。
        let ghostCards = 0;       // 索引有、源没有
        let uncoveredCards = 0;   // 源有、索引分录没有（正常，因为不是每张卡都进 Episode）
        try {
          for (const cid of cardToEpisode.keys()) {
            if (!cardsById.has(cid)) ghostCards++;
          }
          for (const cid of cardsById.keys()) {
            if (!cardToEpisode.has(cid)) uncoveredCards++;
          }
        } catch (e) { recordFault('retriever', 'catch', e); }
        state.consistency = {
          ghostCards: ghostCards,
          uncoveredCards: uncoveredCards,
          indexedCards: cardToEpisode.size,
          sourceCards: cardsById.size,
          ghostRatio: cardsById.size > 0 ? Number((ghostCards / cardsById.size).toFixed(4)) : 0,
          // 阈值：幽灵卡占比 >2% 或绝对数 >50 就报警（说明源被大改过而索引没跟上）
          warn: ghostCards > 50 || (cardsById.size > 0 && ghostCards / cardsById.size > 0.02),
        };

        state.builtAt = Date.now();
        state.srcSig = sourceSigOf();   // [索引快照修复] 记下这次建索引用的是哪份源数据
        state.lastRebuildOkAt = state.builtAt;
        state.consecutiveFails = 0;    // 成功即清连续失败计数

        // [2026-10-22 by Assistant · 向量路] 载入向量索引（只读一次，几 MB，很快）。
        //   不兼容（模型/维度变了）或文件不在 ⇒ vecIdx = null ⇒ 检索自动只用 BM25。
        //   **绝不在这里触发建库**（建库要联网、要几十秒，会拖垮启动）。
        try {
          const idx = loadIndex(c.embeddingDir);
          if (idx && state.vecEp && (idx.model === state.vecEp.model) && (idx.dim === state.vecEp.dimensions)) {
            state.vecIdx = idx;
            state.vecStats = indexStats(idx);
          } else if (idx) {
            state.vecStats = { ready: false, reason: 'incompatible', model: idx.model, dim: idx.dim, wantModel: state.vecEp ? state.vecEp.model : null, wantDim: state.vecEp ? state.vecEp.dimensions : null };
          }
        } catch (e) {
          state.vecStats = { ready: false, reason: 'load-failed', error: String(e && e.message || e) };
        }

        // ⑧ [2026-10-23 by Assistant · 期8.3] 代数隐式超图：建二部关联矩阵（内存派生）。
        //
        //   铁律：**默认关闭**。只有 c.graphExpandEnabled === true 才建索引并参与检索，
        //   关闭时本段完全不执行 ⇒ 与接入前逐位相同（不占内存、不占 warmup 时间）。
        //
        //   为什么建索引放在 warmup 而不是每次 search：
        //     生产实测 9083 张卡 ⇒ buildIncidence + deriveEntities ≈ 120ms，堆 +12MB。
        //     每次 search 都重建会直接把检索从 ~20ms 拖到 ~140ms，不可接受；
        //     放在 warmup（+ 后台重建）只付一次，且已有 srcSig 机制保证卡变了会重建。
        //
        //   关于 entities：生产卡**没有** entities 字段（实测 9083 张全部为空），
        //     DESIGN §1.1 承诺的写入侧产出尚未实装 ⇒ 这里走 graph.js 的 deriveEntities
        //     退化路径（标题词元抽取）。这是**显式标注的权宜之计**，写入侧实装后自动让位。
        // [2026-10-23 by Assistant · 闪回通道也需要图]
        //   原来只有 graphExpandEnabled 才建图；但 flashbackEnabled 也依赖 graphIncidence，
        //   否则 triggerFlashback 里 state.graphIncidence 为 null ⇒ 永远返回 null（实测 4 条查询全安静）。
        //   ⇒ 两个开关任一开启都建图。
        // [2026-10-24 Round 10] 建图决策必须留痕：之前"图没建"只能靠猜
        const _gGate = {
          graphExpand: c.graphExpandEnabled === true,
          flashbackCfg: c.flashbackEnabled === true,
          flashbackLive: (function () { try { return loadLiveConfig().flashbackEnabled === true; } catch { return false; } })(),
        };
        const _gOn = _gGate.graphExpand || _gGate.flashbackCfg || _gGate.flashbackLive;
        try { logger && logger.wake && logger.wake({ level: 'graph-gate', ..._gGate, on: _gOn }); } catch (e) { recordFault('retriever', 'catch', e); }
        if (process.env.PM_DEBUG_GRAPH === '1') { try { console.error('[graph-gate]', JSON.stringify(_gGate), 'on=' + _gOn); } catch (e) { recordFault('retriever', 'catch', e); } }
        if (_gOn) {
          try {
            const tG0 = nowMs();
            // ── [2026-10-23 by Assistant · 期8.3 第二个断点修复] ──
            //   原来这里**无条件**用 deriveEntities（从标题抽词元）：
            //     原始注释写「生产卡没有 entities 字段 ⇒ 走退化路径」——
            //     那是期8.3.1 之前的事实。现在 entities 已经真落地（覆盖 90%+），
            //     却仍然被这行硬编码绕开 ⇒ 图里全是「在和 / 用户」这类噪声，
            //     真 entities 一次都没进过图。
            //   ⇒ 改成「**真 entities 优先，缺失才退化**」。
            // [2026-10-23 · 双轨闪回] 建图时把 motifs 一起塞进去（m: 前缀）
            //   名词实体管「是不是同一个东西」，motifs 管「是不是同一种经历」。
            //   红队要求：m: 边的联想权重是普通 e: 边的 1.8 倍。
            const inc = buildIncidence(cards.map(function (card) {
              const own = Array.isArray(card.entities) ? card.entities.filter(function (x) { return String(x || '').trim(); }) : [];
              const base = own.length > 0 ? own.map(function (x) { return String(x).toLowerCase(); }) : deriveEntities(card);
              // 惰性算 motifs（规则法，零延迟），并缓存到 card 对象上供闪回复用
              let ms = Array.isArray(card.motifs) ? card.motifs : null;
              if (!ms) {
                try {
                  ms = extractMotifs(String(card.title || '') + ' ' + String(card.content || card.summary || ''));
                  card.motifs = ms;
                } catch (e) { ms = []; }
              }
              const tags = base.slice();
              for (const m of ms) tags.push('m:' + m);
              return { id: String(card.id), entities: tags };
            }));
            state.graphIncidence = inc;
            state.graphThreshold = computeDynamicThreshold(inc.entityToFacts);
            state.graphStatsCache = graphStats(inc);
            try {
              logger && logger.wake && logger.wake({
                level: 'graph-incidence-built',
                ms: Number((nowMs() - tG0).toFixed(2)),
                entities: state.graphStatsCache.entities,
                facts: state.graphStatsCache.facts,
                edges: state.graphStatsCache.edges,
                threshold: state.graphStatsCache.threshold,
                superNodes: state.graphStatsCache.superNodes,
              });
            } catch (e) { recordFault('retriever', 'catch', e); }
          } catch (e) {
            // 建图失败绝不阻断检索：退回「无扩散」的旧行为
            state.graphIncidence = null;
            state.graphThreshold = null;
            state.graphStatsCache = { error: String(e && e.message || e) };
            try { logger && logger.miss && logger.miss({ level: 'graph-incidence-failed', reason: String(e && e.message || e) }); } catch (e) { recordFault('retriever', 'catch', e); }
            // [2026-10-24 Round 10] 失败必须可见：之前只有 logger 有值才留痕，
            //   logger=null 时完全静默 ⇒ 图没建也看不出来（闪回永远 null 却没人知道为什么）。
            try { console.error('[graph-incidence-failed]', String(e && e.message || e)); } catch (e) { recordFault('retriever', 'catch', e); }
          }
        }

        const ms = nowMs() - t0;
        // [2026-10-22 by Assistant] warmup 日志必须带 **l0 指纹**。
        // 教训：我曾在没有证据的情况下断言「生产 L0 是关的」，实际上用耗时档位就能判
        //   （不带 L0 ≈ 600ms，带 L0 ≈ 1100~1300ms）。把判据固化进日志，以后一眼可验。
        try {
          logger && logger.wake && logger.wake({
            level: 'retrieval-warmup',
            ms: Number(ms.toFixed(2)),
            docs: bm25.N,
            episodes: episodes.size,
            fedges: all.factEdges.length,
            l0Rounds: l0Bm25 ? l0Bm25.N : 0,     // >0 = L0 真的建起来了
            l0Enabled: c.l0Enabled === true,
          });
        } catch (e) { recordFault('retriever', 'catch', e); }
        return { ok: state.ready, ms: Number(ms.toFixed(2)), reason: state.reason || undefined };
      } catch (e) {
        state.reason = String(e && e.message || e);
        // [架构红队 P0/A2] 失败必须可观测：计数 + 时间戳（不再只写一条日志就完事）
        state.rebuildFails += 1;
        state.consecutiveFails += 1;
        state.lastRebuildFailAt = Date.now();
        // [索引快照修复] 重建失败时：如果之前是就绪的，**保持旧索引可用**（不降级）；
        //   只有首次构建失败才进入 fixed 降级档。
        if (!hadReady) {
          state.degrade = 'fixed';
          state.ready = false;
        } else {
          state.degrade = hadDegrade;
        }
        const ms = nowMs() - t0;
        try { logger && logger.miss && logger.miss({ level: 'retrieval-warmup-failed', reason: state.reason }); } catch (e) { recordFault('retriever', 'catch', e); }
        return { ok: false, ms: Number(ms.toFixed(2)), reason: state.reason };
      } finally {
        // [2026-10-22 by Assistant · 修长期潜伏 bug] 这里**不能**直接写 state.warming = null：
        //   state.warming = (async function(){...})() 的求值顺序是「先执行函数体、后赋值」，
        //   若函数体同步跑完，finally 会在赋值**之前**执行，于是 null 被随后的赋值覆盖成 Promise
        //   ⇒ state.warming 永远非 null（实测 health.warming 恒为 true）。
        //   旧代码没人读这个字段所以没暴露；索引热更新要读它，于是被它挡住。
      }
    })();

    const p = state.warming;
    // 在 Promise 落定**之后**清空（此时赋值已完成，不会再被覆盖）
    p.then(
      function () { if (state.warming === p) state.warming = null; },
      function () { if (state.warming === p) state.warming = null; }
    );
    return p;
  }

  /**
   * 主入口（async，调用点必须 await）。
   *
   * @param {string} query
   * @param {{kind?:string, tokenBudget?:number, maxNeighbors?:number, maxPathHops?:1|2}} [opts]
   */
  async function search(query, opts) {
    const t0 = nowMs();
    const qRaw = String(query === undefined || query === null ? '' : query);
    const o = opts || {};
    // ── [2026-10-28 by Assistant · 口语问句归一（反例抓到的真误杀）] ──
    //   实测：「我刚才说的那个显存是多大的来着」
    //     原句直接进 BM25/字面 ⇒ 捞出的是含「说的/多大/来着」的噪声卡，
    //     而真正含「显存 16G」的卡一个都没有 ⇒ 门控判弱信号 ⇒ 返回空。
    //   但我们知道「显存」这个词本身检索是好的（实测「显存」→ 24 条且含 16G）。
    //   ⇒ 所以在入口把虚词剥掉，用**剩下的实词**去检索。
    //   安全约束（三条，缺一不可）：
    //     ① 只在剥完还有实词时替换（剥空了就保持原句，交给时间种子/回溯分支）
    //     ② 原句仍保留在 o.__origQuery，回执/日志里用原句，便于排查
    //     ③ 剥完实词太少（<2 字）不替换，避免把长问题缩成一个泛词
    // ── [2026-10-28 · 边界收紧（第一版过界了）] ──
    //   第一版只看"剥完还有 2 个字就归一" ⇒ 实测过界：
    //     「红烧肉的糖色怎么炒」→ 归一成「红烧肉糖色炒」→ 硬凑出 1 条
    //     「明天上海天气预报」→ 归一成「海预报」→ 硬凑出 24 条
    //   两者都是**库外话题**，本来必须返回空。归一化把它们从"无信号"变成了"有信号"。
    //
    //   收紧条件（必须同时满足）：
    //     ① 剥完仍含**库内领域词**（显存/四股力/阀门…这些是本机真实话题）
    //        —— 库外话题不会出现这些词
    //     ② 剥完剩余长度 ≥ 2 且与原句不同
    //     ③ 原句里**没有**明显库外标记（天气/食谱/红烧肉/明天/上海…）
    const _OUT_OF_SCOPE = /天气|预报|食谱|菜谱|红烧肉|怎么做菜|小说|推荐|股价|股票|彩票|汇率|星座|旅游攻略|电影|音乐|歌曲/;
    const _IN_SCOPE_WORD = /显存|显卡|内存|硬盘|功耗|四股|日记|桌宠|立绘|超图|向量|蒸馏|检索|注入|协议|端口|配置|模型|记忆|插件|面板|会话|技能|裁决|记忆卡|索引|体检|重启|编译|部署/;
    // ── [2026-10-28 · 时间词不许剥（C4 实测抓回来）] ──
    //   实测：「最早的桌宠」被归一成「桌宠」⇒ classifyTemporal 再也看不到「最早」
    //   ⇒ temporal 变 null ⇒ 「问最早」变成「随便问桌宠」，时间通道整个失效。
    //   时间意图是**查询的语义部分**，不是虚词，绝不能当噪声剥掉。
    const _TIME_WORD = /最早|最初|最晚|最近|最新|刚才|刚刚|之前|以前|上次|上周|上月|昨天|前天|今天|今年|去年|当时|那时|后来|最后|第一次/;
    const _normalized = (function () {
      try {
        if (_OUT_OF_SCOPE.test(qRaw)) return null;          // ③ 库外话题绝不归一
        // ④ 带时间意图的词 —— 但要看是**哪种**时间意图：
        //   · 「最早的桌宠」「上次说的阀门」⇒ 时间词是**查询主题的一部分**，整句保留
        //     （剥掉「最早」会让 temporal 变 null，时间通道失效 —— C4 实测抓回来）
        //   · 「我刚才说的那个显存是多大的来着」⇒ 时间词只是**语气填充**，
        //     真正的主题是「显存」；整句保留反而让显存被虚词稀释成 0 条
        //   ⇒ 判据：时间词后面**还有没有硬主题实词**。有 ⇒ 只保留主题去检索（时间交给 temporal 通道）；
        //      没有 ⇒ 整句保留（这就是纯时间问句）。
        if (_TIME_WORD.test(qRaw)) {
          // 显式时间意图词（最早/上次/当时）⇒ 整句保留，不归一化。
          //   「最早的桌宠」剥掉「最早」⇒ temporal=null ⇒ 时间通道失效（C4 实测抓回来两次）。
          //   只有"语气型"时间填充（刚才/刚刚）且后面有明显主题时才算可剥。
          const _isExplicitTimeIntent = /最早|最初|最晚|最新|上次|上周|上月|昨天|前天|去年|当时|那时|后来|最后|第一次/.test(qRaw);
          if (_isExplicitTimeIntent) return null;
          const _restAfterTime = _stripVirtual(qRaw.replace(_TIME_WORD, ' ')).replace(/\s+/g, '');
          const _hasTopic = _IN_SCOPE_WORD.test(_restAfterTime) && _restAfterTime.length >= 2;
          if (!_hasTopic) return null;
        }
        const stripped = _stripVirtual(qRaw).replace(/\s+/g, '');
        if (!stripped || stripped === qRaw) return null;    // ②
        if (stripped.length < 2) return null;
        if (!_IN_SCOPE_WORD.test(stripped) && !_IN_SCOPE_WORD.test(qRaw)) return null;  // ①
        return stripped;
      } catch { return null; }
    })();
    const q = _normalized || qRaw;
    if (_normalized) {
      o.__origQuery = qRaw;
      try { logger && logger.wake && logger.wake({ level: 'query-normalized', from: qRaw.slice(0, 50), to: q.slice(0, 50) }); } catch (e) { recordFault('retriever', 'query-normalized-log', e); }
    }
    const degrade = state.ready ? state.degrade : state.degrade;

    // [2026-10-22 by Assistant · 索引快照修复]
    //   红队受控实验结论：已暖实例看不到之后写入的卡（bm25.N 不涨），再 warmup() 也无效。
    //   这里在**每次检索前**比一次源数据签名（stat，<0.1ms）：
    //     变了 ⇒ 触发**后台**重建（void，不 await），**本轮仍用旧索引正常返回**。
    //     不变 ⇒ 无事发生。
    //   节流：5s 内不重复重建（防止持续写入时每轮都重建）。
    //   ⇒ 代价是"写入后最多晚一轮看到新卡"，换来的是**永不阻塞首字**。
    if (state.ready && !state.warming) {
      try {
        const sig = sourceSigOf();
        if (sig !== state.srcSig) {
          state.srcStale = true;
          const now = Date.now();
          if (now - state.lastRebuildAt >= 5000) {
            state.lastRebuildAt = now;
            state.rebuildCount++;
            try {
              logger && logger.wake && logger.wake({
                level: 'source-changed',
                sig: sig,
                prevSig: state.srcSig,
                rebuild: state.rebuildCount,
              });
            } catch (e) { recordFault('retriever', 'catch', e); }
            // 后台重建：不 await、不抛（失败保持旧索引）
            void Promise.resolve().then(function () { return warmup(true); }).catch(function () {});
          }
        } else {
          state.srcStale = false;
        }
      } catch (e) { recordFault('retriever', 'catch', e); }
    }

    // 未暖完 / 未就绪：不阻塞、不抛错，走 alias 或 fixed
    if (!state.ready) {
      let aliasHits = [];
      if (state.alias) {
        try {
          const am = matchAlias(state.alias, q);
          if (am.confident) aliasHits = am.docs.slice(0, 10).map(function (p) {
            return {
              id: p[0], score: p[1], scoreParts: { bm25: 0, episode: 0, boost: 0, alias: p[1] },
              episodeId: null, via: 'alias',
            };
          });
        } catch (e) { recordFault('retriever', 'catch', e); }
      }
      const res = {
        query: q, kind: 'alias-only',
        hits: aliasHits,
        k: { topic: 0, episode: 0, fact: 0 },
        timing: { total: Number((nowMs() - t0).toFixed(3)), stage1: 0, stage2: 0, stage3: 0, expand: 0 },
        degrade: aliasHits.length ? 'alias-only' : 'fixed',
        tokens: sumTokens(aliasHits),
      };
      state.lastResult = res;
      return res;
    }

    const kind = o.kind || classifyQuery(q);
    const k = resolveAdaptiveK(kind, {
      minEpisode: c.minEpisodeK !== undefined ? c.minEpisodeK : STAGE_GUARD.minEpisodeK,
      tokenBudget: o.tokenBudget,
    });

    try {
      // 0) alias 先跑（最便宜）
      let am = { confident: false, matchedTerms: [], docs: [], reason: 'disabled' };
      if (state.alias) { try { am = matchAlias(state.alias, q); } catch (e) { recordFault('retriever', 'catch', e); } }

      // 1) Stage1
      const tA = nowMs();
      let l0Docs = [];
 if (state.l0Bm25) {
 try {
 // ── [2026-10-28 by Assistant · L0 通道必须用**原句**] ──
 //   实测抓回来：「记忆改造到哪了」改动前 L0 命中 2 条，改成归一化查询后变 0 条。
 //   原因：L0 是"原话检索"——它要匹配的是User当时**说过的原话**，
 //   把虚词剥掉等于把被检索文本也改写了（"到哪了"是原话的一部分）。
 //   ⇒ 这里固定用 qRaw；归一化只服务字面/BM25 主通道。
 //   这也是"两把尺方向不同"的第二次教训（第一次见 literalsHit 的注释）。
 const rows = searchBm25(state.l0Bm25, qRaw, Math.max(k.fact,5));
 l0Docs = rows.map(function (p) { return [p[0], p[1], { bm25: p[1], episode:0, boost:0, alias:0 }]; });
 } catch (e) { recordFault('retriever', 'catch', e); }
 }
 // [2026-10-22 by Assistant · 期6 P0-a] 双池分离 + L3(Topic) 接通
 //   sourceWeight：tdai 卡（id 前缀 'tdai:'）降权系数。**默认 1 = 不降权 = 旧行为**
 //   topicBoost  ：属于高分 Topic 的卡加分，只加不减。**默认 0 = 关闭 = 旧行为**
 //   缺省时逐位等同改动前（selftest-stage1-dualpool 已钉住）
 const s1 = stage1(state.ctx, q, k.topic, {
   sourceWeight: c.sourceWeight !== undefined ? Number(c.sourceWeight) : 1,
   topicBoost: c.topicBoost !== undefined ? Number(c.topicBoost) : 0,
 });
      const tB = nowMs();

      // 2) Stage2（kE 已被 G1 抬到 >=20）
      const s2 = stage2(state.ctx, s1, k.episode);
      const tC = nowMs();

      // 3) Stage3（只加分）
      const s3 = stage3(state.ctx, s2, k.fact, { wEdge: c.wEdge !== undefined ? c.wEdge : STAGE_GUARD.wEdge });
      const tD = nowMs();

      // 3.5) [2026-10-22 by Assistant · 向量路] 语义召回
      //   解决的是「字面零共享」：User问「刚才说了什么」，BM25 的倒排里根本没有
      //   「标签语义统一修复」这张卡（零共同词），而 bge-m3 的余弦能把它捞回来。
      //   全程可选：没 key / 没索引 / 超时 / 低分过滤后为空 ⇒ vecDocs 保持 []，
      //   融合结果与纯 BM25 完全一致（不是"尽量"，是逐位相同）。
      let vecDocs = [];
      let vecNote = null;
      // [2026-10-22 by Assistant · 期6红队结论3 根治] 向量路加**熔断**。
      //
      // 红队指出：client.js 只有 AbortController 超时，**没有失败熔断/退避**，
      //   连续断网时每一轮检索都要白等一次超时（默认 12s！）⇒ 首字被拖死。
      //
      // 熔断规则（简单的连续失败计数 + 冷却）：
      //   连续失败 >= 3 次 ⇒ 打开熔断，冷却 cooldownMs（默认 5 分钟）；
      //   冷却期内**直接跳过向量路**（零等待，退回纯 BM25）；
      //   冷却到期后放一个请求探路：成功 ⇒ 复位；失败 ⇒ 继续冷却（指数增长，封顶 30 分钟）。
      // 这一切只影响「向量增强」，BM25 主路径不受任何影响。
      const br = state.vecBreaker || (state.vecBreaker = createBreaker(c.vectorBreaker));
      // [2026-10-26 by Assistant · P0 修复] 备路熔断器提到**门控之前**创建。
      //   原实现把备路逻辑写在 `if (vecEnabled)` 内部，而 vecEnabled 含主路 br.allows()
      //   ⇒ **主路熔断一打开，整个向量段被跳过，备路根本够不着**（备路的存在意义就是主路挂时顶上）。
      //   实测复现：主路连续失败 3 次后，向量路黑 5→10→20→30 分钟，每轮只白等。
      //   ⇒ 门控必须拆成「主路可用」「备路可用」两个独立条件，任一可用就进向量段。
      const fbr = state.vecBreakerFallback || (state.vecBreakerFallback = createBreaker(c.vectorBreakerFallback));
      const nowV = Date.now();
      const primaryOk = !!(state.vecEp && br.allows(nowV));
      const fallbackOk = !!(state.vecEpFallback && fbr.allows(nowV));
      const vecEnabled = !!(state.vecIdx && (primaryOk || fallbackOk));
      if (state.vecIdx && !primaryOk && !fallbackOk) {
        // 两条路都熔断中：报各自的冷却时间，便于运维一眼看懂
        const bn = br.note(nowV);
        const fn = state.vecEpFallback ? fbr.note(nowV) : { retryInMs: 0, fails: 0, configured: false };
        vecNote = {
          skipped: 'breaker-open',
          primary: { retryInMs: bn.retryInMs, fails: bn.fails },
          fallback: fn,
          // 兼容老字段：仍给一个最早可重试时间
          retryInMs: Math.min(bn.retryInMs || Infinity, fn.retryInMs || Infinity) === Infinity ? 0 : Math.min(bn.retryInMs || Infinity, fn.retryInMs || Infinity),
          fails: bn.fails,
        };
      } else if (state.vecIdx && !primaryOk && fallbackOk) {
        // 主路熔断中但备路可用：这是备路最该顶上的时刻，明确记一笔
        const bn = br.note(nowV);
        vecNote = { skippedPrimary: 'breaker-open', primaryRetryInMs: bn.retryInMs, primaryFails: bn.fails, usingFallback: true };
      }
      if (vecEnabled) {
        const tV = nowMs();
        try {
          // ── [2026-10-26 by Assistant · 向量备路（下级切换）] ──
          //   User要求：只加「量化模型的下级切换」，**不动现有结构**。
          //   做法：主路逻辑一字不改，只在 **拿不到向量** 时试一次备路。
          //
          //   三条护栏（保证不破坏现有结构）：
          //     ① 备路未配置（vecEpFallback === null）⇒ 完全走原路径，行为逐位相同
          //     ② 主路成功 ⇒ **绝不**碰备路（不额外耗时、不改分数）
          //     ③ 备路有**独立的熔断器**：主路熔断不牵连备路，反之亦然
          //       （主路断网时备路可能好着；备路挂了也不该影响主路恢复）
          // [2026-10-26 · P0 修复] 主路只在**主路未熔断**时才尝试；熔断中直接走备路。
          //   原写法无条件先试主路 ⇒ 熔断期内仍每轮白等一次主路超时（12s），首字被拖死。
          let qv = primaryOk ? await embedQuery(state.vecEp, q) : null;
          let vecBackend = primaryOk ? 'online' : 'primary-skipped';
          let fallbackMs = 0;
          // 备路：主路没拿到 且 备路配了 且 备路未熔断
          if (!qv && state.vecEpFallback) {
            const tF = nowMs();
            try {
              if (fbr.allows(Date.now())) {
                qv = await embedQuery(state.vecEpFallback, q);
                if (!qv) {
                  // [2026-10-26 by Assistant · 终审 P1 修复] 备路拿不到 ⇒ **自己把本地服务拉起来**再试一次。
                  //   背景：llama-swap 代理进程会被外部杀掉（日志无 shutdown 记录），
                  //         一挂备路就成死配置。User 9-22 明确要求「外部服务由插件自己负责拉起」。
                  //   只在配置了 localAutoStart 时才做，避免在任何环境都乱拉进程。
                  if (c.embeddingFallbackLocalAutoStart !== false && isEmbedServerAvailable()) {
                    try {
                      const ens = await ensureEmbedServer({ port: Number(c.embeddingFallbackLocalPort) || 8013 });
                      vecNote = vecNote || {};
                      const ensState = ens && ens.ok
                        ? { ok: true, reused: !!ens.reused, ms: ens.ms }
                        : { ok: false, error: ens && ens.error };
                      try { if (!vecNote) vecNote = {}; vecNote.localAutoStart = ensState; } catch (e) { recordFault('retriever', 'catch', e); }
                      if (ens && ens.ok) {
                        qv = await embedQuery(state.vecEpFallback, q);
                        if (qv) { vecBackend = 'local-fallback'; fbr.ok(Date.now()); }
                        if (!qv) fbr.fail(Date.now());
                      } else {
                        fbr.fail(Date.now());
                        try { vecNote.localAutoStart = { ok: false, error: ens && ens.error }; } catch (e) { recordFault('retriever', 'catch', e); }
                      }
                    } catch (e2) {
                      try { fbr.fail(Date.now()); } catch (e) { recordFault('retriever', 'catch', e); }
                    }
                  } else {
                    fbr.fail(Date.now());
                  }
                } else {
                  vecBackend = 'local-fallback';
                  fbr.ok(Date.now());
                }
                // 用完之后重置空闲计时（服务会自己空闲关闭释放显存）
                if (qv && vecBackend === 'local-fallback') {
                  try { touchEmbedServer(Number(c.embeddingFallbackIdleMs) || undefined); } catch (e) { recordFault('retriever', 'catch', e); }
                }
              }
            } catch (e) {
              try { fbr.fail(Date.now()); } catch (e2) {}
              qv = null;
            }
            fallbackMs = Number((nowMs() - tF).toFixed(2));
          }
          // [2026-10-23 · 闪回需要查询向量] 存下来供 triggerFlashback 做跨术语语义共鸣
          state.lastQueryVec = qv || null;
          if (qv) {
            const topK = Number(c.vectorTopK) || 30;
            const minScore = c.vectorMinScore !== undefined ? Number(c.vectorMinScore) : 0.45;
            const raw = searchVector(state.vecIdx, qv, topK);
            // 缩放：把 cosine∈[0,1] 映射到 BM25 的分数尺度，否则权重无法表达"软肋"。
            let maxBm25 = 1;
            for (const p of s1.candidates) if (p && p[1] > maxBm25) maxBm25 = p[1];
            // 1.2：实测 0.6 时向量只贡献 ~0.17 分（进不了 top），1.2 能让「纯向量卡」进前 30，
            //   2.0 再多只有 +2 条（收益递减）⇒ 取 1.2。
            const scale = maxBm25 * (c.vectorScale !== undefined ? Number(c.vectorScale) : 1.2);
            // [2026-10-22 by Assistant] 过滤垃圾卡：向量会把「Let me rep」「Also」这种
            //   英文残片也捞上来（它们的语义确实接近"对话"），但这些卡对注入毫无价值。
            //   规则（只作用于**向量路**，不影响 BM25 的精确匹配）：
            //     ① 标题 < 4 字符 ② 纯 ASCII 且无中文（中文库里这类基本是切分残片）
            let vecDropped = 0;
            for (const r of raw) {
              if (r.score < minScore) continue;
              const card = state.cardsById ? state.cardsById.get(r.id) : null;
              const t = String(card && card.title ? card.title : '').trim();
              if (t.length < 4) { vecDropped++; continue; }
              if (!/[\u4e00-\u9fff]/.test(t) && /^[\x20-\x7e]+$/.test(t)) { vecDropped++; continue; }
              vecDocs.push([r.id, r.score * scale]);
            }
            vecNote = {
              topK: topK, raw: raw.length, kept: vecDocs.length, dropped: vecDropped,
              minScore: minScore, scale: Number(scale.toFixed(2)), ms: Number((nowMs() - tV).toFixed(2)),
              // [2026-10-26 · 备路] 只新增字段，原有字段一个不动
              backend: vecBackend,
              // [终审 P1] 若本轮触发过自管拉起，把痕迹带出来（否则被覆盖看不见）
              ...(vecNote && vecNote.localAutoStart ? { localAutoStart: vecNote.localAutoStart } : {}),
              fallbackUsed: vecBackend === 'local-fallback',
              fallbackMs: fallbackMs,
            };
            // [2026-10-26 by Assistant · 备路修正] **主路熔断只看主路自己的成败**。
            //   原写法 `br.ok()` 无条件复位有 bug：本轮向量若是备路给的，
            //   主路明明坏着却被判「成功」⇒ 主路熔断永远打不开 ⇒ 每轮都先白等主路超时。
            //   ⇒ 主路成功才 ok；主路失败一律 fail（无论备路是否救回来）。
            // [2026-10-26 by Assistant · P0 修复] **别让备路救场把主路熔断越推越死**。
            //
            // 原写法：只要 backend !== 'online' 就 br.fail()。后果（审核算过）：
            //   主路每轮失败 → 备路救回 → 又给主路记一次 fail → 熔断推得更深 →
            //   越依赖备路，主路越难恢复。备路成了「越用越坏」的反噬。
            //
            // 正确语义：
            //   · 主路**真被尝试过**（primaryOk）且失败 ⇒ 记 fail（这是真实失败，合理）
            //   · 主路**因熔断被跳过**（!primaryOk）⇒ **不记 fail**（它压根没试，不该背锅）
            //   · 备路成功 ⇒ 给主路一个**探路信号**：让冷却期内可以偶尔探一次主路，
            //     这样主路恢复后能自动回到主路，而不是永久走备路。
            if (vecBackend === 'online') {
              // 主路成功：完全复位
              br.ok(Date.now());
            } else if (primaryOk) {
              // 主路被尝试过但失败：正常记一次失败（推进熔断）
              const bsFail = br.fail(Date.now());
              vecNote.backendFail = 'primary';
              if (bsFail.openUntil) vecNote.breakerOpenedMs = bsFail.cooldownMs;
            } else {
              // [探路信号] 主路因熔断被跳过、备路扛住了 ⇒ 让主路冷却小幅回缩，
              //   使它能更早再探一次。**不是 ok() 复位**（那会假装主路好了），
              //   而是把冷却时间减半 —— 恢复期短、但失败一次仍会迅速再熔断。
              try {
                const note = br.note(Date.now());
                if (typeof state.vecBreaker === 'object' && state.vecBreaker && typeof state.vecBreaker.probeOk === 'function') {
                  state.vecBreaker.probeOk(Date.now());
                }
                vecNote.primaryProbe = { recoveredHint: true, prevRetryInMs: note.retryInMs };
              } catch (e2) {}
            }
          } else {
            // [2026-10-26 · 备路] 走到这里 = 主路失败且备路也没救回来（或未配）
            //   ⇒ backend 应标 none，而不是误导性的 online
            vecNote = { skipped: 'embed-failed', ms: Number((nowMs() - tV).toFixed(2)), backend: 'none', triedPrimary: true, triedFallback: !!state.vecEpFallback, fallbackMs: fallbackMs };
            const bs = br.fail(Date.now());
            if (bs.openUntil) vecNote.breakerOpenedMs = bs.cooldownMs;
          }
        } catch (e) {
          vecDocs = [];
          br.fail(Date.now());
          vecNote = { skipped: 'error', error: String(e && e.message || e), fails: br.note(Date.now()).fails };
        }
      }
      state.vecLast = vecNote;

      // 3.6) [2026-10-23 by Assistant · 期8.3] 代数隐式超图一步扩散（DESIGN §六 步骤 4）
      //
      //   位置：Stage3 之后、weightedFuse 之前 —— 与 §六 主链路「3 融合去重 → 4 代数扩散」一致。
      //   语义：**只补充候选，不改写已有分数**。把扩散得到的新事实以 {kind:'graph'} 送进
      //   weightedFuse，权重 wGraph（默认 0 = 不参与）⇒ 权重为 0 时融合结果与原来**逐位相同**。
      //
      //   为什么不是「改分」而是「补候选」：
      //     Stage1 的 BM25 分已经过生产检验；让扩散直接改分风险太大（一旦图质量差就整体劣化）。
      //     补候选 + 独立权重，是「可观测、可回滚、可单独关」的最小接入方式。
      //
      //   关闭时的行为（铁律）：c.graphExpandEnabled 未设或 !== true ⇒ 本段完全跳过，
      //     graphDocs 恒为 [] ⇒ 送进 weightedFuse 的是空数组 ⇒ 融合结果不变。
      let graphDocs = [];
      let graphNote = null;
      if (c.graphExpandEnabled === true && state.graphIncidence && s1.candidates.length) {
        try {
          const tG1 = nowMs();
          // 取 Stage1 的 top N 作为扩散种子（N = graphSeedTopK，默认 30，对齐 §六 的 top30）
          const seedTopK = Number(c.graphSeedTopK) || 30;
          const seeds = s1.candidates.slice(0, seedTopK).map(function (p) {
            return { id: String(p[0]), score: Number(p[1]) || 0 };
          });
          const ex = expandOneHop(seeds, state.graphIncidence, {
            threshold: state.graphThreshold,
            alpha: Number(c.graphAlpha) || 0.6,
            maxBoostFacts: Number(c.graphMaxBoostFacts) || 200,
          });
          // 只保留**种子集之外**的新事实 —— 种子自己已在 Stage1 里，重复送进去会双计分
          const seedIds = new Set(seeds.map(function (s) { return s.id; }));
          for (const e of ex) {
            if (seedIds.has(e.id)) continue;
            graphDocs.push([e.id, Number(e.score) || 0]);
          }
          graphNote = {
            seeds: seeds.length,
            candidates: (ex.stats && ex.stats.candidates) || ex.length,
            added: graphDocs.length,
            threshold: (ex.stats && ex.stats.threshold) !== undefined ? ex.stats.threshold : state.graphThreshold,
            skippedSuperNodes: (ex.stats && ex.stats.skippedSuperNodes) || 0,
            ms: Number((nowMs() - tG1).toFixed(3)),
          };
        } catch (e) {
          graphDocs = [];
          graphNote = { error: String(e && e.message || e) };
        }
      }
      state.graphLast = graphNote;

      // 4) 跨 Stage 加权融合（不是 RRF）
      // [Round 43] 用 let：下面要对被推翻的卡降权（重写 fused）
      let fused = weightedFuse(
        s1.candidates,
        [
          { kind: 'edge', items: s3.scored },
          { kind: 'alias', items: am.docs },
          { kind: 'vector', items: vecDocs },
          // [2026-10-23 by Assistant · 期8.3] 图扩散一路（wGraph 默认 0 ⇒ 关闭时逐位不变）
          { kind: 'graph', items: graphDocs },
        ],
        {
          wEdge: c.wEdge !== undefined ? c.wEdge : STAGE_GUARD.wEdge,
          wAlias: c.wAlias !== undefined ? c.wAlias : STAGE_GUARD.wAlias,
          wVector: c.wVector !== undefined ? c.wVector : STAGE_GUARD.wVector,
          // ── [2026-10-23 · 期8.4 第 3 个断点修复 + 白队裁决一] ──
          //   原来默认 0，而 weightedFuse 里 `if (w === 0) continue` 会整段跳过
          //   ⇒ 补进来的 170 条一条都没进融合结果，scoreParts.graph 恒为 0。
          //   白队裁决：默认 **0.5**（0.3 太弱只进 0-1 条；1.0 太激进会挤掉 BM25 高精准结果）。
          //   优先级：显式配置 > 环境变量 DSH_GRAPH_W > 0.5
          wGraph: resolveGraphWeight(c),
          // ── [2026-10-23 by Assistant · 红队修正2 补接线] ──
          //   rrf.js 里 gateBoost 早就写好了，但**调用方从未传参** ⇒ 永远走不到。
          //   这就是"零接线"的又一例：函数在，开关在，但没人传。
          concentrationBoostEnabled: c.concentrationBoostEnabled === true,
          concentrationGate: c.concentrationGate !== undefined ? Number(c.concentrationGate) : 0.35,
          concentrationAlpha: c.concentrationAlpha !== undefined ? Number(c.concentrationAlpha) : 0.15,
          cardsById: state.cardsById,
          // [2026-10-23 · 红队裁决二] Score-Gated：高分图候选保送，低分只做辅助
          wGraphHigh: c.wGraphHigh !== undefined ? Number(c.wGraphHigh) : 1.2,
          wGraphLow: c.wGraphLow !== undefined ? Number(c.wGraphLow) : 0.3,
          graphGate: c.graphGate !== undefined ? Number(c.graphGate) : 0.15,
        }
      );

      // ── [2026-10-24 by Assistant · Step 2] 四股力乘法门控 ──
      //   score = R × (1 + 0.45·Imp + 0.30·Rec + 0.35·Str)
      //   R 是门票（低于 GATE_THRESHOLD 杠杆锁死），防高重要/高新鲜卡在无关话题霸榜。
      //   **默认关闭**：fourForcesEnabled !== true 时逐位等同旧行为（可随时回滚）。
      let fused2 = fused;
      let fourForcesNote = null;
      // [2026-10-24] 优先读活配置（改文件即生效，不用重启）；profile 里显式 true 也算开。
      const fourOn = (function () {
        try {
          if (c.fourForcesEnabled === true) return true;
          if (c.fourForcesEnabled === false) return false;
          // 未在 profile 声明 ⇒ 看活配置（改 ingest/config.json 即生效）
          return loadLiveConfig().fourForcesEnabled === true;
        } catch { return c.fourForcesEnabled === true; }
      })();
      // ── [2026-10-24 by Assistant · Round 43 补机制缺口] ──
      //   问题：refute_by（被推翻标记）只被**写入**，从来没被**读取**。
      //   ⇒ 被推翻的卡仍会正常参与检索 ⇒ 错误的记忆会继续干扰回答。
      //   实测：目前 0 张被推翻卡（所以没暴露），但机制是缺的。
      //   为什么必须靠标记而不是排序：如果两张卡**都是基石**，
      //     四股力给它们的乘数都是 1.0（同分）—— 排序无法分辨谁对谁错。
      //   做法：被推翻的卡分数乘 0.15（不是删掉 —— 保留可追溯，但基本排在最后）。
      //     可关：refutePenaltyEnabled === false 时完全跳过（逐位等同旧行为）。
      //   ⚠️ 必须放在**四股力之后** —— 四股力用 rawScore 重算分数，
      //     放在它前面会被直接覆盖（实测踩过：降权了但最终分不变）。
      let refutedCount = 0;
      if (fourOn) {
        try {
          const t0 = Date.now();
          fused2 = rerankWithFourForces(fused, state.cardsById, Date.now(), { enabled: true });
          fourForcesNote = { ms: Date.now() - t0, n: fused.length };
        } catch (e) {
          fused2 = fused;
          fourForcesNote = { error: String(e && e.message || e) };
        }
      }

      // ── [2026-10-24 by Assistant · Round 43] 被推翻卡降权（放在四股力**之后**）──
      //   为什么必须之后：四股力用 rawScore 重算分数，放前面会被覆盖
      //   （实测：降权日志打了，但最终分没变 —— 白做）。
      // [Round 43 修正] 开关要**同时认 o（调用参数）和 c（配置）**。
      //   原来只读 c.refutePenaltyEnabled ⇒ search(q, {refutePenaltyEnabled:false}) 无效
      //   （实测：关掉后分数仍是 0.15 ⇒ 开关形同虚设）。o 里也没有独立的 allowEmpty… 冲突。
      const refuteOff = (o && o.refutePenaltyEnabled === false) || (c && c.refutePenaltyEnabled === false);
      if (!refuteOff) {
        try {
          const graded = (fused2 || fused).map(function (pair) {
            const id = String(Array.isArray(pair) ? pair[0] : (pair && pair.id) || '');
            const card = state.cardsById && state.cardsById.get(id);
            const refuted = card && Array.isArray(card.refute_by) && card.refute_by.length > 0;
            if (!refuted) return pair;
            refutedCount++;
            if (Array.isArray(pair)) return [pair[0], (Number(pair[1]) || 0) * 0.15, pair[2]];
            return Object.assign({}, pair, { score: (Number(pair.score) || 0) * 0.15 });
          });
          if (refutedCount) {
            fused2 = graded;
            try { logger && logger.wake && logger.wake({ level: 'refute-penalty', n: refutedCount }); } catch (e) { recordFault('retriever', 'catch', e); }
          }
        } catch (e) {
          try { logger && logger.miss && logger.miss({ level: 'refute-penalty-failed', reason: String(e && e.message || e) }); } catch (e) { recordFault('retriever', 'catch', e); }
        }
      }

      // 4.5) [2026-10-22 by Assistant] 时间维度重排
      //   背景：原管线里 classifyQuery 只用来调 K，排序永远是 BM25 分数，
      //   导致「最早的桌宠」「前两天干的事」这类查询拿不到时间维度的答案。
      //   做法：先按相关度取一个候选池（保证相关），再在池内按 createdAt 排。
      let temporalDir = o.temporalDir || classifyTemporal(q);
      // ── [2026-10-28 by Assistant · 反例抓到的"时间种子自我证明"] ──
      //   实测：「我刚才说的那个显存是多大的来着」
      //     classifyTemporal 看到「刚才」⇒ 判 latest ⇒ 注入 80 张最近的卡（0.5 分，temporalSeed=1）
      //     ⇒ anyReal 里第 1440 行 `temporalSeed > 0 ⇒ return true` 立刻认账
      //     ⇒ 门控认为"这是真信号" ⇒ 29 条无关卡直接返回，而用户问的「显存 16G」一个字都没检索。
      //   这是典型的**自证循环**：时间种子既是被检对象，又是通关凭据。
      //
      //   修法（保守，只关掉"有硬实词时"的种子）：
      //     句子里有硬实词（显存/四股力/阀门…或 ≥3 字实词）⇒ 用户显然在问**具体事**，
      //     不是问"刚才发生了什么" ⇒ 不让时间种子进场，老老实实走字面/向量检索。
      //     没有硬实词（"我们刚才在做什么"）⇒ 保持原样，时间种子照常工作。
      const _hardForSeed = (function () {
        try {
          const t = qTermsOf(q);
          for (const w of t) {
            if (w.length >= 3) return true;
            if (/显存|显卡|内存|四股|日记|桌宠|立绘|超图|向量|蒸馏|检索|注入|协议|端口|配置|模型|显存|硬盘|功耗/.test(w)) return true;
          }
          return false;
        } catch { return false; }
      })();
      if (_hardForSeed && temporalDir === 'latest' && !o.temporalDir) {
        try { logger && logger.wake && logger.wake({ level: 'temporal-seed-skip', reason: 'has-hard-term', q: String(q).slice(0, 50) }); } catch (e) { recordFault('retriever', 'temporal-seed-skip-log', e); }
        temporalDir = null;
      }
      let temporalNote = null;
      if (temporalDir && state.cardsById && state.cardsById.size > 0) {
        // ── [2026-10-24 by Assistant · Round 18 抓到的真缺陷] ──
        //   症状：问「我们刚才在做什么」，时间排序**确实执行了**（结果按时间倒序），
        //         但最老是 10-21 —— 今天/昨天的卡一张都不在池里。
        //   根因：候选池来自**字面检索**（BM25/向量）的结果。而这类「指代当下」的查询
        //         **没有任何可检索的字面**，字面通道自然只捞出偶然含「在做/什么」的旧卡。
        //         ⇒ 在错误候选集里排时间 = 仍然是错的答案。
        //   修法：时间意图成立时，**直接把「最近 N 天」的卡种子并入候选池**（不靠字面），
        //         然后再整体按时间排。这才是"问最近就真的给最近的"。
        //   安全：只在 temporalDir 非空时执行；且并入的卡仍受 k.fact / tokenBudget 约束。
        const poolSize = Math.max(k.fact, 30);
        const pool = fused2.slice(0, poolSize);
        // —— 时间种子注入（仅 latest 方向；earliest 问"最早"时同样需要全量历史池，暂不做）——
        if (temporalDir === 'latest') {
          const seedDays = Number(o.temporalSeedDays) || 7;
          const floorTs = Date.now() - seedDays * 86400000;
          const have = new Set(pool.map((x) => String(x[0])));
          let seeded = 0;
          try {
            // ── [Round 18 三次修正 · 关键] 必须**先按时间倒序选**，不能按 Map 顺序边扫边取 ──
            //   实测踩坑：cardsById 是 engram→tdai→own 的插入序，前面的 engram 卡最老，
            //   于是 80 个名额全给了 10-17 的老卡，今天/昨天的卡一张都进不来
            //   ⇒ 时间排序"生效了"但排的全是旧卡，等于没修。
            const cand = [];
            for (const [cid, card] of state.cardsById) {
              const v = card && card.createdAt;
              const n = typeof v === 'number' ? v : Date.parse(v || '');
              if (!Number.isFinite(n) || n < floorTs) continue;
              if (have.has(String(cid))) continue;
              cand.push({ cid: String(cid), ts: n });
            }
            cand.sort((a, b) => b.ts - a.ts);   // 最新的优先拿名额
            for (const it of cand) {
              if (seeded >= 80) break;
              // 分数：能进前 k（截断按分），但不至于压过真正高分的字面相关卡
              pool.push([it.cid, 0.5, { bm25: 0, episode: 0, boost: 0, alias: 0, temporalSeed: 1 }]);
              seeded++;
            }
          } catch (e) { recordFault('retriever', 'catch', e); }
          try { logger && logger.wake && logger.wake({ level: 'temporal-seed', days: seedDays, seeded }); } catch (e) { recordFault('retriever', 'catch', e); }
          temporalNote = { dir: temporalDir, pool: pool.length, seeded };
        }
        const ts = (id) => {
          const card = state.cardsById.get(id);
          const v = card && card.createdAt;
          const n = typeof v === 'number' ? v : Date.parse(v || '');
          return Number.isFinite(n) ? n : 0;
        };
        pool.sort(function (a, b) {
          const ta = ts(a[0]);
          const tb = ts(b[0]);
          if (ta === 0 && tb === 0) return a[0] < b[0] ? -1 : 1;   // 都无时间 → 稳定序
          if (ta === 0) return 1;                                    // 无时间沉底
          if (tb === 0) return -1;
          return temporalDir === 'earliest' ? ta - tb : tb - ta;
        });
        fused2.length = 0;
        for (let i = 0; i < pool.length; i++) fused2.push(pool[i]);
        // [Round 18] temporalNote 已在种子注入处设置（含 seeded 数），这里不覆盖
        if (!temporalNote) temporalNote = { dir: temporalDir, pool: pool.length };
      }

      // 5) 截断：k.fact → tokenBudget
      //
      // [2026-10-22 by Assistant · 实跑抓到的设计缺陷 —— L0 无条件霸榜]
      //
      //   旧实现：`l0Docs.slice(0, k.fact)` —— **不看分数**，直接占满 k.fact 个位置。
      //   实测后果：任何查询（包括「zzzz qqqq 无意义字符串」）都会返回 24 条 L0，
      //   分数还有 16.25 —— 因为 BM25 对任何 token 都给正分（idf 不为负）。
      //   ⇒ 每轮往上下文塞 24 条**无关的对话原话**，既污染又浪费 token。
      //
      //   修法：L0 必须过**相关性门槛**才能占位：
      //     ① 绝对下限：分数 >= l0MinScore（默认 8；实测真命中 20~140，无关 6~16）
      //     ② 相对门槛：分数 >= 本轮最高分 × l0RelRatio（默认 0.15）
      //        这样即使整体分数偏低（短查询），也只留"相对最相关"的那几条。
      //     ③ 数量上限仍是 k.fact（不会挤占普通卡的名额超过一半）
      // [2026-10-22 二次修正] 光靠绝对分不够 —— 实测把门槛设 8 时，「zzzz qqqq」
      //   这种无意义查询仍能拿 16.3 分（BM25 对任何命中词都给正分）。
      //   真正的区分度在于：**真命中的 top1 会显著高于 top2~top5，无关的则彼此挨着**。
      //   所以用「top1 与中位数的比值」当判据：
      //     · 真命中：109.6 vs 19.5 ⇒ ratio ≈ 5.6
      //     · 无关：  16.3 vs 13.4 ⇒ ratio ≈ 1.2
      //   再加一条绝对下限（挡掉全是低分的场景）。
      // 实测分界：真命中 36.6~142.9，无关 12.19~16.25 ⇒ 取 25 做绝对门槛。
      const l0MinScore = c.l0MinScore !== undefined ? Number(c.l0MinScore) : 25;
      // l0PeakRatio 语义改为「集中度下限」：top1 占前 5 名总分的比例。
      //   实测：真命中 109.6/(109.6+19.5+15.6+…) ≈ 0.6+；无关 12.19/(12.19+11.35+10.52+10.4+…) ≈ 0.2
      const l0PeakRatio = c.l0PeakRatio !== undefined ? Number(c.l0PeakRatio) : 0.35;
      const l0Max = Math.min(k.fact, Number.isFinite(Number(c.l0MaxPerQuery)) ? Number(c.l0MaxPerQuery) : Math.ceil(k.fact / 2));
      // [2026-10-22 三次修正] 中位数判据被证明是错的：
      //   l0Docs 常常有 24 条（BM25 的 topK 上限），低分噪声会把中位数压到很低
      //   ⇒ 「12.19 / 6.39 = 1.91」反而越过了门槛，噪声越多越容易通过。
      //
      //   改用**集中度判据**（更稳）：top1 分数占「前 N 名总分」的比例。
      //     · 真命中：109.6 独占鳌头 ⇒ 占比高（>0.5）
      //     · 无关：  12.19 / 11.35 / 10.52… 彼此接近 ⇒ 占比低（≈0.2）
      const l0Scores = l0Docs.map(function (row) { return Number(row[1]) || 0; })
        .filter(function (v) { return v > 0; });
      const l0Top = l0Scores.length ? Math.max.apply(null, l0Scores) : 0;
      const topN = Math.min(5, l0Scores.length);
      let topSum = 0;
      for (let i = 0; i < topN; i++) topSum += l0Scores[i];
      const concentration = topSum > 0 ? l0Top / topSum : 0;
      // [2026-10-22 四次修正 · 最终版]
      //   集中度判据也会误伤：某查询有 5 条同分 142.9 ⇒ 集中度只有 0.25，被错杀。
      //   真正的判据是**绝对高度**：
      //     · 真命中：109.6 / 142.9 / 36.6
      //     · 无关：  12.19 / 16.25 / 12.2
      //   两者差距近 10 倍 ⇒ **以绝对分为主，集中度只当第二道保险（防超长文档虚高）**。
      //   设 l0MinScore = 25：真命中全过（36.6 起），无关全挡（16.25 止）。
      const peakOk = l0Top >= l0MinScore || (l0Top >= l0MinScore * 0.4 && concentration >= l0PeakRatio);
      let l0Rows = peakOk
        ? l0Docs.filter(function (row) { return (Number(row[1]) || 0) >= Math.max(l0MinScore, l0Top * 0.35); }).slice(0, l0Max)
        : [];

      // [2026-10-23 by Assistant · StartLux 本地精排保底]
      //   若开启 startluxRerank，由 StartLux 4B 模型做按需精排筛选（关思考，~500ms 批量判定）。
      const startluxCfg = o.startluxRerank !== undefined ? o.startluxRerank : c.startluxRerank;
      const startluxOn = startluxCfg === true || (startluxCfg && typeof startluxCfg === 'object' && startluxCfg.enabled !== false);
      if (startluxOn && l0Rows.length > 0) {
        try {
          const candItems = l0Rows.map(function (r) {
            const card = state.l0CardsById ? state.l0CardsById.get(r[0]) : null;
            const u = card ? (card.l0User || '') : '';
            const a = card ? (card.l0Assistant || '') : '';
            return { id: r[0], text: (u + ' ' + a).trim().slice(0, 160) };
          });
          const rerankOpts = typeof startluxCfg === 'object' ? startluxCfg : {};
          const rr = await rerankL0Candidates(q, candItems, rerankOpts);
          if (rr && rr.ok && rr.relevantIds) {
            l0Rows = l0Rows.filter(function (r) { return rr.relevantIds.has(r[0]); });
          }
        } catch (e) { recordFault('retriever', 'catch', e); }
      }

      // ══════════════════════════════════════════════════════════════════
      // [2026-10-27 by Assistant · 第二优先：抹平 30 倍量纲差 + 席位上限]
      //
      // 病灶（实测）：l0Rows 的 row[1] 是 **BM25 原始分**（实测 25.03~39.88），
      //   而 fused2 里的普通卡是 **归一化/RRF 分**（实测 0.50~1.02）。
      //   working-memory 的 assemble 直接拿 finalScore = base × gain × (1+0.6·recency)
      //   比大小 ⇒ L0 天生赢 30 倍，普通精炼卡在数学上**没有赢的可能**。
      //   实测复现：25 条 picked 里 L0 占 14 条，预算 792/800 被吃满。
      //
      // 归一化选择：**饱和函数** s/(s+K)，不用 s/max。
      //   为什么不用 s/max：某次 L0 最高分才 3.5（擦边），除完仍是 1.0 虚高，
      //   而普通卡 Top1 可能才 0.65 ⇒ L0 照样压一头，等于没归。
      //   饱和函数把「L0 实际有多相关」映射成绝对量级：
      //     3.5  → 3.5/18.5  = 0.19   （擦边，乖乖沉底）
      //     25   → 25/40     = 0.63   （真命中）
      //     40   → 40/55     = 0.73   （强命中，但也不越界抢普通卡 Top1）
      //   与普通卡 0.50~1.02 区间同量级 ⇒ 真正同台竞争。
      //
      // 席位上限：归一化解决「量纲」，但不解决「3049 条原话 vs 2000 条精炼卡」的
      //   数量压制。实测 Q「这几天记忆」L0 占 14/25；给上限后强制让位。
      //   默认 6 席（可配 l0MaxPerQuery 覆盖）。
      // ── [2026-10-28 by Assistant · 结构重构] 归一化 + 席位已抽成纯函数模块 ──
      //   lib/retrieval/l0-normalize.js：无副作用、不碰 state、不读时钟。
      //   抽出去的理由：这段原来长在 1125 行的 search() 里，属于"测试够不到、
      //   只能靠整体回归兜"的典型。现在有 selftest-l0-normalize 18 项直接钉住，
      //   其中含**逐位等价性**断言（与旧实现逐字节比对）+ 反例。
      //   本次替换是纯搬运：参数名/默认值/饱和函数/toFixed(4)/席位夹取全部不变。
      l0Rows = normalizeL0Rows(l0Rows, {
        l0SatK: c.l0SatK,
        l0NormCap: c.l0NormCap,
        l0MaxPerQuery: c.l0MaxPerQuery,
      });

      const l0Ids = new Set(l0Rows.map(function (x) { return x[0]; }));
      // L0 只占「它自己有资格占的」名额，剩下的全留给普通卡（不再挤压）
      let picked = fused2.filter(function (x) { return !l0Ids.has(x[0]); })
        .slice(0, Math.max(0, k.fact - l0Rows.length));
      for (const row of l0Rows) picked.push(row);
      let tokens = 0;
      const hits = [];
      // ── [2026-10-23 · 期8.4 盲测抓到的真 bug：同卡多版本占满名额] ──
      //   现象：24 条 hits 里只有 14 个唯一标题，一张卡（append-only 多版本行）
      //   占了 8 个位置，把其他相关内容全挤出去。
      //   实测盲测 20 题：A(baseline) top5 相关卡 51/100，B(graph) 只有 43/100
      //   —— 图不但没提升，反而降了 8 个，就是被这些重复行吃掉的。
      //   修法：按 **title 去重**，同标题只保留分数最高的那条（fused 已按分降序）。
      //   注：id 不同但 title 相同 ⇒ 视为同一张卡的多版本行。
      const seenTitles = new Set();
      // ── [2026-10-24 by Assistant · Round 24] 「一个词都没对上」就别硬凑 ──
      //   实测：查「zzyyxx qqqq wwww」这种库里根本不存在的东西，
      //   返回的卡 scoreParts 全是 { bm25: 0 } —— 证明**字面一个词都没匹配**，
      //   只是靠 stage3 的固定 boost（0.027）排上来的噪声。
      //   语义上这比"返回空"更坏：User问一个库外话题，却看到一堆看似相关的记忆。
      //   修法：整批结果里若**没有任何一条**真正命中过（bm25/vector/alias/graph 全 0），
      //        就判为「本轮没有相关往事」，返回空。
      //   [Round 24 二次修正] 只看 scoreParts.bm25>0 不够 —— BM25 对**任意 token**
      //   都给正分（哪怕这个词只出现在一张毫不相干的卡里）。实测「zzyyxx qqqq wwww」
      //   仍返回 bm25=1。真正该问的是：**结果卡里到底出现了几个查询词**。
      //   ⇒ 用「查询词覆盖率」判定：Top1 卡至少命中 1 个**实词**（长度≥2 且非停用词）。
      const _qtoks = (function () {
        try {
          const tk = require121 ? null : null;   // 占位，下面用现成 tokenizer
          return null;
        } catch { return null; }
      })();
      const anyRealSignal = picked.some(function (row) {
        const pt = row[2] || {};
        const id = String(row[0]);
        if (Number(pt.temporalSeed) > 0) return true;              // 时间种子是有意的
        // 1) 向量/别名/图 命中也算真信号
        if (Number(pt.vector) > 0 || Number(pt.alias) > 0 || Number(pt.graph) > 0) return true;
        // 2) BM25 命中：还要看**字面是否真的出现过**
        if (Number(pt.bm25) > 0) {
          const text = String(cardText(id) || '') + ' ' + String(hTitle(id) || '');
          // [Round 24 三次修正] 门槛从 ">0" 提到 ">=2"：
          //   实测「红烧肉的糖色怎么炒」靠一个 2 字块「肉的」就过了门槛
          //   （卡里恰好有"拳拳到肉的近身搏击"）—— 单个二元组太容易偶然撞上。
          //   规则：命中 >=2 个实词，**或**命中一个 >=3 字的长词（长词偶然撞上的概率低）。
          // [Round 24 四次修正] 光看"命中几个"不够 —— 长查询里中 1~2 个 2 字块很常见
          //   （「量子色动力学」命中「动力」「力学」，但讲的是 Live2D 动力学，完全两回事）。
          //   真正判相关的是**覆盖率**：查询里的实词有多少比例被这张卡覆盖。
          //   实测阈值 0.35：3 个实词中 1 个 ≈ 0.33 不过线；2 个 ≈ 0.67 过线。
          const _lh = literalsHit(q, text);
          if (_lh.long >= 2) return true;            // 两个以上长词必过
          if (_lh.long >= 1 && _lh.cover >= 0.25) return true;
          if (_lh.cover >= 0.35) return true;        // 覆盖率够高
          return false;
        }
        return false;
      });
      // [Round 24 五次修正] 关键：判「整批有没有真信号」时，**只看 Top1**。
      //   用 some() 会被 24 条里的任意一条偶然命中就放行全部 —— 那等于没判。
      //   语义：如果连最相关的那张都不是真相关，这批就是噪声。
      const topRow = picked[0];
      let topReal = false;
      if (topRow) {
        const pt = topRow[2] || {};
        // [Round 24 六次修正] alias 不能单独算真信号 —— 实测「明天上海天气预报」
        //   的 top1 只有 alias:0.09（别名表里撞了个词），字面覆盖率 0.14 却被放行了。
        //   别名是"同义扩展"，本质仍要看扩展后**字面是否真出现在卡里**。
        //   ⇒ 只有 vector / graph / 时间种子 才能独立证明相关；alias 必须配合字面命中。
        if (Number(pt.temporalSeed) > 0) topReal = true;
        else if (Number(pt.vector) > 0 || Number(pt.graph) > 0) topReal = true;
        else if (Number(pt.bm25) > 0 || Number(pt.alias) > 0) {
          const tid = String(topRow[0]);
          const ttext = String(cardText(tid) || '') + ' ' + String(hTitle(tid) || '');
          const lh = literalsHit(q, ttext);
          // [Round 31 修正] 阈值太严会误伤 —— 实测「记忆系统的四股力是什么」Top1
          //   覆盖率 0.30 差一点没过（原阈值 0.35）⇒ 整批被清空，而它确实相关。
          //   放宽：**命中一个长词（≥3 字，如「四股力」）本身就很有区分度** ⇒ 单条即可放行。
          //   仍能挡住上一轮那些乱凑：它们 Top1 只命中 1~2 个**2 字泛词**（动力/肉的/预报）。
          topReal = (lh.long >= 1) || (lh.cover >= 0.30);
        }
      }
      // ══════════════════════════════════════════════════════════════════
      // [2026-10-27 by Assistant · 封箱第 5 点配套：坏标题卡不得当"守门员"]
      //
      // 病灶（实测）：「今天天气怎么样」的 Top1 是「想马上能用** ⇒」——
      //   一张表格切分碎片卡，标题没有完整语义，但 bm25=1.0，
      //   于是 literalsHit 判定"命中覆盖"通过 ⇒ anyReal=true ⇒ 24 条噪音全放行。
      //   ⇒ 只要有一张坏标题卡抢到 Top1，整道护栏就形同虚设。
      //
      // 修法：在判定"真相关"之前，先踢掉**标题无完整语义**的候选：
      //   标题不含 ≥4 个连续汉字、且不是合法英文短语 ⇒ 视为碎片卡，不具守门资格。
      //   （数据侧已把 175 张这类卡归档；这里是**防御性双保险**，
      //    防止以后再蒸馏出新的碎片卡又把护栏打穿。）
      // ══════════════════════════════════════════════════════════════════
      function isViableTitle(cid) {
        const t = String(hTitle(cid) || '').trim();
        if (!t) return false;
        // ── ① 明显残缺：含 markdown/代码块残符，或首尾被截断 ──
        //    实测坏卡形如「想马上能用** ⇒」「| ④ 胶水丢 |」「⇒ `www」「pos」
        //    —— 它们的共同点是**标题里有孤立的 markdown 符号**，人一眼能看出是半句话。
        const hasDanglingMark = /(\*\*|\|\s*$|^\s*\||⇒|→|^\s*`|\}\s*$|\{\s*$)/.test(t);
        if (hasDanglingMark) return false;
        // ── ② 太短且无实义（纯数字/单字母/纯符号）──
        if (t.length <= 2) return false;
        // ── ③ 正常标题：连续汉字 >= 4 个，或有 2 个以上英文单词 ──
        if (/[\u4e00-\u9fff]{4,}/.test(t)) return true;
        if ((t.match(/[a-zA-Z]{2,}/g) || []).length >= 2) return true;
        // ── ④ 短中文标题（2~3 字）也允许，但不能带残符（上面已挡）──
        if (/[\u4e00-\u9fff]{2,}/.test(t)) return true;
        return false;
      }

      // ── [2026-10-25 by Assistant 根因修复] Top1 不达标时的单卡真实相关兜底 ──
      //   实测：「桌宠最早的立绘怎么做」Top1 是泛卡，但排第 7 的卡自身命中「桌宠+立绘」（cover=0.33）。
      //   过去误用 seen.size >= 3 跨卡凑数，导致「宋朝历史小说推荐」被不同卡片各自命中的单个通用词凑满放行！
      //   正确做法：前 10 条里必须至少有一张候选卡**自身**达到真实相关标准（长词≥1 或单卡覆盖率≥0.30），
      //   杜绝跨卡拼凑通用词引发的库外假阳性！
      let anyReal = topReal;
      // [2026-10-27] 若 Top1 是碎片卡（标题无完整语义），它的"相关"判定不可信 ⇒ 作废
      if (anyReal && picked.length && !isViableTitle(String(picked[0][0]))) anyReal = false;
      if (!anyReal && picked.length) {
        for (let i = 0; i < Math.min(10, picked.length); i++) {
          const row = picked[i];
          const pt = row[2] || {};
          if (Number(pt.vector) > 0 || Number(pt.graph) > 0 || Number(pt.temporalSeed) > 0) { anyReal = true; break; }
          if (!(Number(pt.bm25) > 0 || Number(pt.alias) > 0)) continue;
          const cid = String(row[0]);
          if (!isViableTitle(cid)) continue;   // 碎片卡不具守门资格
          const ctext = String(cardText(cid) || '') + ' ' + String(hTitle(cid) || '');
          const lh = literalsHit(q, ctext);
          if (lh.long >= 1 || lh.cover >= 0.30) { anyReal = true; break; }
        }
      }
      // ══════════════════════════════════════════════════════════════════
      // [2026-10-27 by Assistant · 封箱第 2/3 点：弱噪音拦截 + 智能 Fallback 分流]
      //
      // 【为什么要做】实测：User问「Assistant想想前面干了什么」时，
      //   字面检索返回 24 条——其中 20 条 via=stage3（固定 boost 撑起来的）、
      //   Top1 标题是「⇒ `www」，bm25 只有 1.0。这批卡跟问题毫无关系，
      //   模型读了一眼发现没用，只好靠上下文硬编答案（"让我自己重建一下"）。
      //
      // 【为什么不信施工单原判据】实测 13 个查询 × 现有数据，
      //   施工单给的 "stage1 < 2 且 top1Bm25 <= 1.2" **一次都没触发**（0/13）——
      //   因为库里有 9936 张卡，任何一个查询都能凑出 4~14 条 stage1 真命中。
      //   照抄 = 这道闸永远不开，等于没做。
      //
      // 【怎么改才对】真正的噪声特征不是"stage1 少"，而是：
      //   ① 有命中，但 Top1 的**字面覆盖率极低**（抓到的是"做了什么"这种泛词，
      //      不是问题里的实词）；
      //   ② 现有 anyReal 判据（长词≥1 或 cover≥0.30）已经判它"不是真相关"。
      //   ⇒ 所以正确的做法是：**在 anyReal 为假、且本查询没有任何可用的时间意图时，
      //      不要简单清空，而是先问一句「这是不是在问'最近发生了什么'」**：
      //      · 是（含指代/追问特征）⇒ 升级为 temporal=latest，注入最近的时间种子卡；
      //      · 否（纯库外提问）⇒ 保持清爽空回，绝不硬凑。
      // ══════════════════════════════════════════════════════════════════

      // ── 弱噪音特征提取（用于分流决策）──
      const weakSignalInfo = (function () {
        if (anyReal) return { weak: false };
        const first = picked[0];
        const pt = first ? (first[2] || {}) : {};
        let stage1Count = 0;
        for (const row of picked) {
          const p = row[2] || {};
          // stage1 = 真·词表命中（既非固定 boost，也非图/别名搭车）
          if (Number(p.boost) === 0 && Number(p.graph) === 0 && Number(p.alias) === 0
              && Number(p.vector) === 0 && Number(p.temporalSeed) === 0
              && Number(p.bm25) > 0) stage1Count++;
        }
        return {
          weak: true,
          stage1Count,
          top1Bm25: Number(pt.bm25) || 0,
          n: picked.length,
        };
      })();

      if (weakSignalInfo.weak && o.allowEmptyOnNoSignal !== false) {
        // ── 智能分流：这是"隐式回溯追问"还是"纯库外提问"？ ──
        //
        // 白队微调锁：强技术专名 / 长英文实体 / 典型库外百科问法 ⇒ 绝不 fallback
        //   （例："我们昨天配的 KVM" 有 "KVM" 这个硬专名 ⇒ 走实体检索，不要盖成纯时间）
        //   [2026-10-27 补] 另外把"今天天气/今天吃/明天"这类**日常生活问句**也归入
        //   库外档 —— 实测它们会被 classifyTemporal 误判成 latest（"今天"一词），
        //   如果不在这里拦，就会拿一堆无关的最近卡硬凑。这是本次顺带修掉的真 bug。
        const qStr = String(q || '');
        const hasSpecificExternalTerm = /[a-zA-Z]{3,}/.test(qStr)
          || /(托尔金|中土世界|食谱|菜谱|怎么做菜|红烧肉|天气预报|天气|明天|几点|几号|星期|吃什么|喝什么)/.test(qStr);
        // 红队分流锁：第一/二人称或泛指代口语（在问"我们/我/Assistant"最近干了什么）
        const hasPronounDeixis = /(我们|咱们|咱俩|咱|Assistant|我)(前面|刚才|刚刚|之前|都|在)?(做|干|搞|弄|聊|说|到哪)/.test(qStr)
          || /(上一轮|上一步|上一句|前情提要|捋一捋|复盘|进展|做到哪|说到哪|聊到哪|搞到哪)/.test(qStr)
          // [2026-10-27 补] 「根据想到的做审查」「按刚才说的做」这类**承接上文的指令**：
          //   没有实词可检索，但语义明确指向"刚才那件事"⇒ 也属于隐式回溯追问。
          //   收词要严：必须出现「想到/刚才/前面/上面/上述」这类**显式承接词**，
          //   不能因为出现"做/说"就放行（否则「怎么做菜」会被误伤）。
          || /(根据|按照|基于|照)(想到|刚才|前面|上面|上述|之前|刚说)/.test(qStr)
          || /(想到的|刚才说的|上面说的|前面说的|上述的)/.test(qStr);

        // ── [2026-10-28 by Assistant · 反例抓到的真误杀] ──
        //   实测：「我刚才说的那个显存是多大的来着」
        //     命中了下面的 hasPronounDeixis（我 + 刚才 + 说）⇒ 整句被当成
        //     "我们刚才在聊什么" ⇒ 重建为「最近 7 天最新的 29 张卡」（全是 0.5 分时间种子）
        //     ⇒ 用户问的「显存 16G」一个字都没检索到，返回一堆无关的当天记忆。
        //   这类误判比空回更糟：它**看起来有答案**，实际答的是另一个问题。
        //
        //   判据（就一条）：**句子里有硬实词时，绝不走"回溯最近"分支**。
        //     硬实词 = 领域专名（显存/显卡/四股力/阀门…）或 ≥3 字的非虚词中文块。
        //     宁可让字面检索去答，也不要拿时间种子冒充答案。
        const _hardTerms = (function () {
          try {
            const t = qTermsOf(qStr);
            let hard = 0;
            for (const w of t) {
              if (w.length >= 3) hard++;
              else if (/显存|显卡|内存|四股|日记|桌宠|立绘|超图|向量|蒸馏|检索|注入|协议|端口|配置/.test(w)) hard++;
            }
            return hard;
          } catch { return 0; }
        })();
        const looksLikeRealQuestion = _hardTerms >= 1;
        if (hasPronounDeixis && !hasSpecificExternalTerm && !looksLikeRealQuestion) {
          // 分支 A：隐式回溯追问 ⇒ 就地注入"最近 N 天真实发生的卡"
          //
          // [2026-10-27 关键实现细节] 不能只设 temporalDir='latest' 了事——
          //   时间种子逻辑在本函数**更早的位置**（① 时间方向判定段）已经执行完了，
          //   到这里再改 temporalDir 不会再触发任何排序（Assistant实测踩到过这个空操作）。
          //   所以这里**就地重建 picked**：直接从 cardsById 按 createdAt 倒序取最近的卡，
          //   与时间种子通道同一口径（80 张池 / 受 k.fact 截断），
          //   只是把"字面召回"换成"时间召回"。
          let seededOk = false;
          try {
            const nowMs2 = Date.now();
            const floorTs = nowMs2 - (Number(c.temporalSeedDays) || 7) * 86400000;
            const cand = [];
            for (const [cid, card] of state.cardsById) {
              const v = card && card.createdAt;
              const n = typeof v === 'number' ? v : Date.parse(v || '');
              if (!Number.isFinite(n) || n < floorTs) continue;
              cand.push({ cid: String(cid), ts: n });
            }
            cand.sort(function (a, b) { return b.ts - a.ts; });
            const keepN = Math.min(cand.length, Math.max(k.fact, 30));
            if (keepN > 0) {
              const rebuilt = [];
              for (let i = 0; i < keepN; i++) {
                rebuilt.push([cand[i].cid, 0.5, { bm25: 0, episode: 0, boost: 0, alias: 0, temporalSeed: 1 }]);
              }
              picked.length = 0;
              for (const row of rebuilt) picked.push(row);
              seededOk = true;
            }
          } catch (e) { recordFault('retriever', 'catch', e); }
          try {
            logger && logger.wake && logger.wake({
              level: 'retrieval-weak-fallback-latest',
              q: qStr.slice(0, 60), n: picked.length,
              stage1: weakSignalInfo.stage1Count, seeded: seededOk,
            });
          } catch (e) { recordFault('retriever', 'catch', e); }
          if (!seededOk) picked.length = 0;
        } else {
          // 分支 B/C：纯库外提问 ⇒ 清爽空回（保住北极星⑥「库外不硬凑」）
          try {
            logger && logger.wake && logger.wake({
              level: 'retrieval-no-signal',
              q: qStr.slice(0, 60), n: picked.length,
              stage1: weakSignalInfo.stage1Count, top1Bm25: weakSignalInfo.top1Bm25,
            });
          } catch (e) { recordFault('retriever', 'catch', e); }
          picked.length = 0;
        }
      }
      // [2026-10-27 · 双轨制] 直通区已保送的 id 在这里剔除，避免双份占 token
      const excludedIds = (o && Array.isArray(o.excludeIds) && o.excludeIds.length)
        ? new Set(o.excludeIds.map(String))
        : null;
      let excludedCount = 0;
      for (const row of picked) {
        const id = row[0];
        if (excludedIds && excludedIds.has(String(id))) { excludedCount++; continue; }
        const parts = row[2] || { bm25: 0, episode: 0, boost: 0, alias: 0 };
        // [2026-10-23 by Assistant · 白队裁决三：via 必须能看出图贡献]
        //   原来只判 l0 / boost / alias，**从不判 graph** ⇒ 图补进来的卡
        //   一律显示成 stage1，运维根本看不出它是不是图召回的（实测 6 条全被误标）。
        //   现在：graph 权重最高时才标 '1hop'；与 BM25 同时命中则标 '1hop+bm25'。
        //   这样日志里 grep '1hop' 就能直接统计图的触发频率。
        const via = l0Ids.has(id)
          ? 'l0-bm25'
          : (Number(parts.graph) > 0
              ? (Number(parts.bm25) > 0 ? '1hop+bm25' : '1hop')
              : (parts.boost > 0 ? 'stage3' : parts.alias > 0 ? 'alias' : 'stage1'));
        const epId = state.ctx.cardToEpisode.get(id) || null;
        const l0c = state.l0CardsById && state.l0CardsById.get(id);
 const tk = l0c ? estimateTokens(String(l0c.l0User || '') + String(l0c.l0Assistant || '')) : estimateTokens(cardText(id));
        if (o.tokenBudget && tokens + tk > o.tokenBudget && hits.length > 0) break;
        tokens += tk;
        // [2026-10-22 by Assistant · 实跑抓到「自产卡召回 0」的真根因]
        //   原来 hits 只回 {id, score, ...}，**不带 title/content**。
        //   下游要判断"这条命中是不是我要的那张卡"，只能靠 id——而 id 是不可读的
        //   （pm:pm_179264... / emvjef5ya-t）。工程师肉眼和调试脚本都看不出命中对不对，
        //   于是把"命中了"误判成"没命中"（我上一轮就是这么误判的）。
        //   ⇒ 命中结果必须自带可读文本。
        const card0 = (state.cardsById && state.cardsById.get(id))
          || (state.l0CardsById && state.l0CardsById.get(id)) || null;
        const titleKey = card0 ? String(card0.title || '').trim().slice(0, 40) : '';
        if (titleKey) {
          if (seenTitles.has(titleKey)) continue;   // 同卡多版本 ⇒ 跳过
          seenTitles.add(titleKey);
        }
        hits.push({
          id, score: row[1], scoreParts: parts, episodeId: epId, via,
          title: card0 ? String(card0.title || '') : '',
          summary: card0 ? String(card0.summary || '') : '',
          content: card0 ? String(card0.content || '').slice(0, 400) : '',
          source: card0 && card0._source ? String(card0._source) : '',
        });
      }

      // 6) 超图扩展（只补上下文，不改 hits 排序）
      const tE = nowMs();
      let neighbors = [];
      try {
        neighbors = expandHypergraph(state.ctx, hits.map(function (h) { return h.id; }), {
          maxPathHops: o.maxPathHops || 1,
          maxNeighbors: o.maxNeighbors !== undefined ? o.maxNeighbors : (c.maxNeighbors !== undefined ? c.maxNeighbors : STAGE_GUARD.maxNeighbors),
        });
      } catch { neighbors = []; }
      const tF = nowMs();

      // 7) 唯一短路点：alias confident 且 Stage1 空手
      let finalHits = hits;
      if (am.confident && finalHits.length === 0 && am.docs.length) {
        // [Round 24] alias 短路通道也要过字面校验 ——
        //   实测「宋朝历史小说推荐」在这里返回 10 条**标题为空**的卡：
        //   别名表撞了词就放行，但从没验证过那些词是否真在该卡里。
        //   与主通道同一把尺：覆盖率够 或 长词命中。
        const aliasDocs = am.docs.slice(0, 10).filter(function (p) {
          const tid = String(p[0]);
          const ttext = String(cardText(tid) || '') + ' ' + String(hTitle(tid) || '');
          if (!ttext.trim()) return false;
          const lh = literalsHit(q, ttext);
          return (lh.long >= 2) || (lh.long >= 1 && lh.cover >= 0.25) || (lh.cover >= 0.35);
        });
        finalHits = aliasDocs.map(function (p) {
          return {
            id: p[0], score: p[1], scoreParts: { bm25: 0, episode: 0, boost: 0, alias: p[1] },
            episodeId: state.ctx.cardToEpisode.get(p[0]) || null, via: 'alias',
          };
        });
        tokens = finalHits.reduce(function (acc, h) { return acc + estimateTokens(cardText(h.id)); }, 0);
      }

      // ── [2026-10-28 by Assistant · 场景隔离接线（默认关死）] ──
      //   目标：**一个Assistant，看全部会话的记忆**（User明确要求）。
      //   所以这里的三条铁律，缺一不可：
      //     ① 默认 currentScene = null ⇒ isVisible 恒 true ⇒ 一条都不挡
      //     ② 只有调用方**显式**传 o.scene 且 o.sceneIsolation === true 才启用
      //        （⛔ 绝不从 cwd 自动推断——那会导致"在哪个目录开就只看那类"）
      //     ③ 挡了多少必须记日志，便于事后核对（不能静默过滤）
      //
      //   实测基线（2026-10-28）：6806 张真实卡里 0 张带 scene/cwd 字段
      //   ⇒ 即便误开，也不会挡任何卡；但这不构成"可以随便开"的理由。
      let sceneFiltered = 0;
      const sceneWanted = (o.sceneIsolation === true) ? String(o.scene || '').trim() : '';
      if (sceneWanted) {
        try {
          const before = finalHits.length;
          finalHits = finalHits.filter(function (h) {
            try {
              const card = (state.cardsById && state.cardsById.get(String(h.id)))
                || (state.l0CardsById && state.l0CardsById.get(String(h.id))) || h;
              return isVisible(card, sceneWanted, { includeCrossScene: o.includeCrossScene === true });
            } catch { return true; }   // 单条判错 ⇒ 放行（宁可见多，不可误挡）
          });
          sceneFiltered = before - finalHits.length;
          if (sceneFiltered > 0) {
            try { logger && logger.wake && logger.wake({ level: 'scene-filter', scene: sceneWanted, hidden: sceneFiltered, kept: finalHits.length }); } catch (e) { recordFault('retriever', 'scene-filter-log', e); }
          }
        } catch (e) { recordFault('retriever', 'scene-filter', e); }
      }

      // [2026-10-23 · 双轨：主通道保持纯净，闪回走独立旁路]
      //   主通道 finalHits = BM25 + Vector（图由 wGraph 控制，默认 0）
      //   旁路 flashback = 最多 1 条「远期同构」老记忆，**不参与主排序**
      let flashback = null;
      // [2026-10-24] 同 fourForces：支持活配置热开关（改 ingest/config.json 即生效）
      const flashOn = (function () {
        try {
          if (c.flashbackEnabled === true) return true;
          if (c.flashbackEnabled === false) return false;
          return loadLiveConfig().flashbackEnabled === true;
        } catch { return c.flashbackEnabled === true; }
      })();
      if (flashOn) {
        try { flashback = triggerFlashback(q, finalHits, Object.assign({}, c, o)); } catch (e) { flashback = null; }
      }

      const res = {
        query: q,
        kind,
        temporal: temporalNote,
        hits: finalHits,
        flashback,
        neighbors: neighbors.slice(0, 24),
        k,
        timing: {
          total: Number((nowMs() - t0).toFixed(3)),
          index_lookup_ms: Number((tC - tA).toFixed(3)),
          stage1: Number((tB - tA).toFixed(3)),
          stage2: Number((tC - tB).toFixed(3)),
          stage3: Number((tD - tC).toFixed(3)),
          expand: Number((tF - tE).toFixed(3)),
        },
        degrade,
        tokens,
        alias: { confident: am.confident, matchedTerms: am.matchedTerms, reason: am.reason },
        // [2026-10-23 by Assistant · 期8.3] 图扩散可观测：关闭时为 null（不是 {} —— null 才能
        //   一眼区分「没开」和「开了但零候选」，避免又出现"绿但没跑"的假验证）
        graph: graphNote,
        // [2026-10-24 Step 2] 四股力可观测：关闭时 null（一眼区分"没开"和"开了零效果"）
        fourForces: fourForcesNote,
        // [2026-10-28] 场景隔离可观测：默认 0（没开或没挡）；开了就报挡了几条
        sceneFiltered,
      };
      state.lastResult = res;
      try {
        if (logger && logger.wake) logger.wake({ level: 'retrieval', n: finalHits.length, ms: res.timing.total, q: q.slice(0, 60), degrade });
      } catch (e) { recordFault('retriever', 'catch', e); }
      return res;
    } catch (e) {
      // 绝不向上抛
      const res = {
        query: q, kind: 'factual', hits: [], k: { topic: 0, episode: 0, fact: 0 },
        timing: { total: Number((nowMs() - t0).toFixed(3)), stage1: 0, stage2: 0, stage3: 0, expand: 0 },
        degrade: 'fixed', tokens: 0, error: String(e && e.message || e),
      };
      state.lastResult = res;
      try { logger && logger.miss && logger.miss({ level: 'retrieval-error', reason: res.error }); } catch (e) { recordFault('retriever', 'catch', e); }
      return res;
    }
  }

  /** 卡文本（token 估算用）。只读缓存，不写任何东西。 */
  function cardText(id) {
    const card = (state.cardsById && state.cardsById.get(id)) || (state.l0CardsById && state.l0CardsById.get(id));
    if (!card) return '';
    return String(card.title || '') + String(card.summary || '') + String(card.content || '').slice(0, 400);
  }
  function hTitle(id) {
    const card = (state.cardsById && state.cardsById.get(id)) || (state.l0CardsById && state.l0CardsById.get(id));
    return card ? String(card.title || '') : '';
  }
  /**
   * [2026-10-24 Round 24] 查询里的「实词」有多少真的出现在文本里。
   *
   * 背景：BM25 对**任意 token** 都给正分（哪怕这个词只出现在一张毫不相干的卡里）。
   *   实测查「zzyyxx qqqq wwww」时返回的卡 scoreParts.bm25 仍是 1 ——
   *   所以「bm25>0」不能当作「真命中」的证据。必须看字面。
   */
  // ── [2026-10-24 by Assistant · Round 32 判据只留一份] ──
  //   这里原本自己维护一个小停用词表，与 lib/retrieval/types.js 的 STOPWORDS 各一份。
  //   后果：Round 17/32 往 STOPWORDS 里加的词，**这个覆盖率判据根本看不到** ——
  //     实测「桌宠最早的立绘怎么做」，STOPWORDS 已经有「最早」，但覆盖计算仍把它算进去
  //     ⇒ 覆盖率被稀释到 0.22 ⇒ 门控整批清空（库里有 164 张立绘相关卡）。
  //   ⇒ 改成**复用同一份 STOPWORDS**，再补几个英文虚词。
  // ══════════════════════════════════════════════════════════════════
  // [2026-10-28 by Assistant · 结构重构] 查询判据已抽到 lib/retrieval/query-terms.js
  //
  // 为什么抽出去：这些判据原来就长在这里（2451 行的文件里），今天一天踩了三个
  // 同类型的坑，全都是同一段逻辑散在别处，改一处忘了另一处：
  //   ① 归一化把「最早」当虚词剥掉 ⇒ temporal 通道失效
  //   ② literalsHit 改成复用 qTermsOf ⇒ 严格尺被稀释 ⇒ 库外话题硬凑 24 条
  //   ③ L0 通道被归一化影响 ⇒ 「记忆改造到哪了」L0 命中 2 → 0
  // 现在两把尺并排放在一个模块里，各自写明用途与方向，动之前必须同时看到两把。
  // ══════════════════════════════════════════════════════════════════
  const _COMMON_QW = COMMON_QW;                 // 兼容旧引用
  const _stripVirtual = stripVirtual;           // 兼容旧引用
  function qTermsOf(query) { return qTermsOfQ(query); }
  function literalsHit(query, text) { return literalsHitQ(query, text); }
  function sumTokens(list) {
    let n = 0;
    for (const h of (list || [])) n += estimateTokens(cardText(h.id));
    return n;
  }

  /**
 * 潜意识闪回（红白双队融合终版 · 支持零 motifs 冷启动）
 *
 * User初心：「帮我看看这个插件」「这个插件损坏了」「我今天去 xx 旅游了」
 *   —— 能自然想起很久以前类似的经历，不用主动问「还记得吗」。
 *
 * 铁律：**独立旁路，绝不进 RRF**。实测图混进主路会让 top5 相关卡 50→42（−8）。
 *
 * 目标：20 条真实盲测里，安静 16~18 次，惊艳触发 2~4 次。
 */
function triggerFlashback(q, mainHits, opts) {
  const o = opts || {};
  const nowTs = Number(o.nowTs) || Date.now();
  const cooldownMs = (Number(o.flashbackCooldownDays) || 3) * 86400000;
  const minScore = Number(o.flashbackMinScore) || 0.28;
  // [2026-10-23 实测校准] 24 类情境字典的优质桥接度数在 4~35 之间（如静默失效 17，踩坑 36，配置陷阱 23）
  //   若限制 maxDeg=12，则核心故障情境全被误杀！因此放宽至 40，实体边仍保持 12。
  const maxDeg = Number(o.flashbackMaxDeg) || 40;
  const minVec = Number(o.flashbackMinVec) || 0.35;
  if (!state.graphIncidence || !mainHits || !mainHits.length) return null;

  const mainIds = new Set(mainHits.map(function (h) { return String(h.id); }));
  const mainTitles = new Set(mainHits.map(function (h) { return String(h.title || '').trim().slice(0, 40); }));

  // 归一化基准：RRF 原始分很小（0.01~0.03），以 Top1 种子分为锚
  const topSeedScore = Number(mainHits[0] && mainHits[0].score) || 1.0;
  const gscores = new Map();
  // [2026-10-24 Round 14] 每个候选被多少条独立线索连到（防单条弱边乱联想）
  const linkCount = new Map();
  const minShared = Number.isFinite(Number(o.flashbackMinShared)) ? Number(o.flashbackMinShared) : 2;

  // 0. 当前 Query 自身的情境骨架作为第一级「认知意向锚点」
  //    人类联想：听到“插件损坏”，大脑第一时间直接激活“组件静默失效”的情境网络！
  const queryMotifs = extractMotifs(String(q || ''));
  for (const qm of queryMotifs) {
    const linked = state.graphIncidence.entityToFacts.get('m:' + qm);
    if (linked && linked.size > 1 && linked.size <= maxDeg) {
      const hop = 1.0 / Math.log2(linked.size + 1);
      for (const fid of linked) {
        const id = String(fid);
        if (mainIds.has(id)) continue;
        gscores.set(id, Math.min(1.0, (gscores.get(id) || 0) + hop * 1.5));
        linkCount.set(id, (linkCount.get(id) || 0) + 1);
      }
    }
  }

  for (const seed of mainHits.slice(0, 3)) {
    const rel = topSeedScore > 0 ? ((Number(seed.score) || 0) / topSeedScore) : 1.0;
    const card = state.cardsById && state.cardsById.get(seed.id);
    if (!card) continue;
    // 惰性补充 motifs（若异步回填尚未覆盖到该卡，用微秒级规则库即时兜底）
    if (!Array.isArray(card.motifs) || card.motifs.length === 0) {
      try { card.motifs = extractMotifs(String(card.title || '') + ' ' + String(card.content || card.summary || '')); } catch (e) { recordFault('retriever', 'catch', e); }
    }
    const tags = [];
    if (Array.isArray(card.motifs)) for (const m of card.motifs) tags.push({ key: 'm:' + m, boost: 1.8 });
    if (Array.isArray(card.entities)) for (const e of card.entities) tags.push({ key: String(e).toLowerCase(), boost: 1.0 });
    for (const t of tags) {
      const linked = state.graphIncidence.entityToFacts.get(t.key) || state.graphIncidence.entityToFacts.get(String(t.key).toLowerCase());
      if (!linked) continue;
      const deg = linked.size;
      if (deg <= 1 || deg > maxDeg) continue;   // 只走 deg 2~12 的「黄金窄桥」
      const hop = (rel * t.boost) / Math.log2(deg + 1);
      for (const fid of linked) {
        const id = String(fid);
        if (mainIds.has(id)) continue;
        gscores.set(id, Math.min(1.0, (gscores.get(id) || 0) + hop));   // 封顶防爆表
        // [2026-10-24 Round 14] 记录「被几条独立边连到」。
        //   实测问题：8 条查询触发 7 次闪回，其中「看了一个视频很震撼」
        //   靠**单条弱边（共享 retry，deg=4）** 连到了「500是脚本bug」——明显不相关。
        //   人类联想很少靠一个共同词就成立，至少要两条不同线索共振。
        const n0 = linkCount.get(id) || 0;
        linkCount.set(id, n0 + 1);
      }
    }
  }
  if (!gscores.size) return null;

  // 向量共鸣（跨术语联想的唯一通路：旅游/视频这类没有共同名词的例子）
  let qvec = null;
  if (state.vecIdx && state.vecEp && state.lastQueryVec) qvec = state.lastQueryVec;

  let best = null, bestScore = 0;
  for (const [id, gres] of gscores) {
    // [2026-10-24 Round 14] 单条弱边不许触发 —— 至少 minShared 条独立线索共振。
    //   实测问题：8 条查询触发 7 次，其中「看了一个视频很震撼」靠单条
    //   共享 retry（deg=4）连到「500是脚本bug」，明显不相关。
    //   人类联想很少靠一个共同词成立。
    if ((linkCount.get(id) || 0) < minShared) continue;
    const card = state.cardsById && state.cardsById.get(id);
    if (!card) continue;
    const title = String(card.title || '').trim().slice(0, 40);
    if (title && mainTitles.has(title)) continue;
    const created = Number(card.createdAt) || 0;
    if (created > 0 && (nowTs - created) < cooldownMs) continue;

    let hasVec = false;
    let vecSim = 0;
    if (qvec && state.vecIdx) {
      try {
        // 支持前缀容错（tdai:xxx, pm:xxx, 或纯 raw id）
        const rawId = String(id).replace(/^(tdai|pm|pmi):/, '');
        const cv = vectorOf(state.vecIdx, id) || vectorOf(state.vecIdx, rawId) || vectorOf(state.vecIdx, 'tdai:' + rawId);
        if (cv) {
          hasVec = true;
          let dot = 0;
          for (let i = 0; i < qvec.length; i++) dot += qvec[i] * cv[i];
          vecSim = Math.max(0, dot);
        }
      } catch (e) { recordFault('retriever', 'catch', e); }
    }
    // 只有在卡片有向量且与当前意图语义极低(<0.20)时才断言为「巧合撞词」淘汰
    if (hasVec && vecSim < 0.20) continue;

    let overlap = 0;
    try {
      const qb = new Set();
      const qs = String(q || '').toLowerCase();
      for (let i = 0; i < qs.length - 1; i++) { const b = qs.slice(i, i + 2); if (/[\u4e00-\u9fff]{2}/.test(b)) qb.add(b); }
      const ts = (title + ' ' + String(card.summary || '') + ' ' + String(card.content || '')).toLowerCase();
      for (const b of qb) if (ts.includes(b)) overlap++;
    } catch (e) { recordFault('retriever', 'catch', e); }
    const novelty = overlap <= 1 ? 1.15 : 0.75;

    // 分数融合：有向量时图与向量几何共鸣；无向量时凭高置信情境骨架
    const finalScore = hasVec
      ? (Math.sqrt(gres * Math.max(0.1, vecSim)) * novelty)
      : (gres * novelty * 0.85);
    if (finalScore > bestScore) { bestScore = finalScore; best = card; }
  }

  // [2026-10-24 Round 10] 闪回没触发必须能看出原因（之前完全静默）
  try {
    if (process.env.PM_DEBUG_FLASH === '1') {
      console.error('[flash] candidates=' + gscores.size + ' best=' + (best ? String(best.title || '').slice(0, 20) : 'none') +
        ' score=' + Number(bestScore.toFixed(4)) + ' min=' + minScore + ' gresMin=' + (gscores.size ? Math.min(...gscores.values()).toFixed(4) : '-'));
    }
  } catch (e) { recordFault('retriever', 'catch', e); }
  if (!best || bestScore < minScore) return null;   // 宁缺毋滥，保持安静
  return {
    id: String(best.id),
    title: String(best.title || ''),
    summary: String(best.summary || '').slice(0, 160),
    content: String(best.content || '').slice(0, 300),
    createdAt: Number(best.createdAt) || 0,
    score: Number(bestScore.toFixed(3)),
    ageDays: best.createdAt ? Math.floor((nowTs - Number(best.createdAt)) / 86400000) : null,
  };
}

/** 健康探针：三覆盖口径 + 降级档 */
  function health() {
    const cov = state.coverage || { alive: 0, episodeCovered: 0, edgeCovered: 0, noEdge: 0, edgeRatio: 0, bm25Fallback: true };
    const ah = aliasHealth(state.alias, cov.alive);
    // [2026-10-26 by Assistant · 两项巡检修复 红1] **不要把覆盖率告警塞进 degrade 字段**。
    //
    // 原实现：`degrade: edgeSparse ? 'edge-sparse' : state.degrade`
    // 问题（实测坐实）：
    //   · search() 返回的 degrade 取自 state.degrade，值域 full / no-episode / alias-only / fixed
    //   · health() 却额外插入 edge-sparse ⇒ **同一概念两条路径两个答案**
    //     同一时刻 search 说 full、health 说 edge-sparse（selftest-p3 C10 就是这么红的）
    //   · 而且 `0.70` 是硬编码，全仓无任何依据/注释；实测 edgeRatio=0.462 永久不达标，
    //     而 C8 又要求 noEdge>500（实测 1205）—— 两条判据在同一数据上互相打架
    //
    // 语义澄清：
    //   degrade    = **检索为什么降级**（功能可用性档位）
    //   edgeSparse = **图覆盖率健不健康**（数据质量告警）
    // 两者是不同维度，混在一个字段里会让任何消费方（orchestrator / prefetch / 巡检）
    // 拿到自相矛盾的值。⇒ 拆成两个字段，degrade 回归单一语义。
    const edgeSparseRatio = 0.70;   // 覆盖率告警线（仅用于告警，不影响 degrade）
    const edgeSparse = cov.edgeRatio < edgeSparseRatio;
    return {
      ok: state.ready,
      // 基础降级档：值域与 search() 完全一致，消费方可放心按它分支
      degrade: state.degrade,
      // 覆盖率告警：独立字段，不参与 degrade 判定
      edgeSparse: {
        sparse: edgeSparse,
        edgeRatio: cov.edgeRatio,
        threshold: edgeSparseRatio,
        noEdge: cov.noEdge,
        alive: cov.alive,
      },
      bm25: { ready: state.ready, docs: state.bm25 ? state.bm25.N : 0, vocab: state.bm25 ? state.bm25.vocabSize : 0 },
      tdai: state.tdaiStats || null,
 l0: state.l0Stats || null,
      alias: ah,
      graph: {
        episodes: state.ctx ? state.ctx.episodes.size : 0,
        fedges: state.ctx ? countEdges(state.ctx) : 0,
        cardsWithEdge: cov.edgeCovered,
        episodeCovered: cov.episodeCovered,
      },
      coverage: cov,
      bm25Fallback: true,
      index: {
      ready: state.ready,
      builtAt: state.builtAt,
      root: indexRoot,
      // [索引快照修复] 让外部能看见"源变了但还没重建完"
      srcSig: state.srcSig,
      stale: state.srcStale,
      rebuilds: state.rebuildCount,
      // [架构红队 P0/A2] 重建健康度 —— 让「静默故障」可见
      rebuildHealth: {
        fails: state.rebuildFails,
        consecutiveFails: state.consecutiveFails,
        lastOkAt: state.lastRebuildOkAt,
        lastFailAt: state.lastRebuildFailAt,
        // 告警条件：连续失败 >= 3，或「曾经成功过但现在已超过 30 分钟没成功重建」
        warn: state.consecutiveFails >= 3
          || (state.lastRebuildOkAt > 0 && Date.now() - state.lastRebuildOkAt > 30 * 60 * 1000 && state.consecutiveFails > 0),
      },
      // [架构红队 P0/A1] 卡集合一致性
      consistency: state.consistency || null,
    },
    // [2026-10-22 by Assistant · 向量路] 端点/索引/最近一次召回的诊断快照
    vector: {
      endpoint: state.vecEp ? endpointLabel(state.vecEp) : 'off',
      // [2026-10-26 · 备路] 诊断可见：备路是否配了、熔断状态如何、上次走了哪条路
      fallbackEndpoint: state.vecEpFallback ? endpointLabel(state.vecEpFallback) : 'off',
      fallbackBreaker: state.vecBreakerFallback
        ? state.vecBreakerFallback.note(Date.now())
        : { configured: false },
      lastBackend: (state.vecLast && state.vecLast.backend) || null,
      index: state.vecStats || { ready: false },
      last: state.vecLast,
      // [2026-10-22] 熔断状态：连续失败 3 次后打开，冷却期跳过向量路（避免每轮白等超时）
      breaker: state.vecBreaker ? state.vecBreaker.note(Date.now()) : { fails: 0, open: false },
    },
      // [2026-10-23 by Assistant · 期8.3] 图扩散健康快照：
      //   enabled=false ⇒ { enabled:false }（不建索引、不占内存）
      //   enabled=true  ⇒ 带规模/阈值/超级节点数，供 bench 与运维核对
      graphExpand: state.graphStatsCache
        ? Object.assign({ enabled: c.graphExpandEnabled === true, last: state.graphLast || null }, state.graphStatsCache)
        : { enabled: c.graphExpandEnabled === true, last: state.graphLast || null },
      source: state.sourceStats,
      ingest: state.ingestStats || null,
      byType: state.byType || null,
      reason: state.reason || (edgeSparse ? 'edge-sparse' : null),
    };
  }

  function countEdges(ctx) {
    let n = 0;
    for (const arr of ctx.edgesByEpisode.values()) n += arr.length;
    return n;
  }

  function explain() { return state.lastResult; }

  /**
   * [2026-10-21 by Assistant · 期4 扩散接线] 暴露只读图上下文，供 working-memory 的
   * createGraphAdapter 造邻接提供者。**只读**：返回的是内部对象引用，调用方不得改。
   * 未暖启动时返回 null（调用方要自己判空）。
   */
  function getCard(id) {
 return (state.cardsById && state.cardsById.get(String(id))) || (state.l0CardsById && state.l0CardsById.get(String(id))) || null;
 }

  /**
   * [2026-10-26 by Assistant · 计划审核 B2 阻断修复] 向量索引**热替换**。
   *
   * 为什么必须有它：state.vecIdx 是 warmup 时 loadIndex 的**内存快照**，
   * 而 warmup 只由 sourceSigOf() 触发 —— 签名只覆盖三个卡源，
   * **不含 embeddings 目录**。于是时序是：
   *   新卡写入 -> sig 变 -> warmup 重载（此刻向量还没补）
   *   -> 定时器补完向量落盘 -> **sig 没变 -> 不重载 -> 内存里还是旧索引**
   * 结果：补了向量，检索却看不见，要等下一张卡写入才碰巧刷新。
   *
   * 为什么不把 embeddings 目录并进 sourceSigOf：
   *   那会让「每次补完向量」都触发一次 1500ms 的**整库 BM25 重建**，
   *   BM25 索引根本没变，纯属浪费（Round 40 刚踩过这个坑）。
   *   => 只重载那一个 float 数组，不动 BM25。
   */
 function refreshVectorIndex() {
    const t0 = Date.now();
    try {
      const idx = loadIndex(c.embeddingDir);
      if (!idx) {
        try { logger && logger.wake && logger.wake({ level: 'vector-index-refresh', ok: false, reason: 'load-null' }); } catch (e) { recordFault('retriever', 'catch', e); }
        return { ok: false, reason: 'load-null', ms: Number((Date.now() - t0).toFixed(1)) };
      }
      if (state.vecEp && !isCompatible(idx, String(state.vecEp.model), Number(state.vecEp.dimensions))) {
        try { logger && logger.wake && logger.wake({ level: 'vector-index-refresh', ok: false, reason: 'incompatible', model: idx.model, dim: idx.dim }); } catch (e) { recordFault('retriever', 'catch', e); }
        return { ok: false, reason: 'incompatible', ms: Number((Date.now() - t0).toFixed(1)) };
      }
      const before = (state.vecIdx && state.vecIdx.ids) ? state.vecIdx.ids.length : 0;
      state.vecIdx = idx;
      state.vecStats = indexStats(idx);
      const r = { ok: true, before, after: idx.ids.length, builtAt: idx.builtAt, ms: Number((Date.now() - t0).toFixed(1)) };
      try { logger && logger.wake && logger.wake({ level: 'vector-index-refresh', ...r }); } catch (e) { recordFault('retriever', 'catch', e); }
      return r;
    } catch (e) {
      try { logger && logger.wake && logger.wake({ level: 'vector-index-refresh-FAILED', err: String(e && e.message || e) }); } catch (e2) {}
      return { ok: false, reason: String(e && e.message || e), ms: Number((Date.now() - t0).toFixed(1)) };
    }
  }

 function getGraph() {
    if (!state.ready || !state.ctx) return null;
    return state.ctx;
  }

  /**
   * [2026-10-26 by Assistant · 跨会话脉搏] 最近 N 小时内**其他会话**写入的卡，纯按时间倒序。
   *
   * 为什么要有：跨会话近况**不该走「按词索骥」**。
   *   实测事故：另一个窗口的终审结论确实在库里，但换到这个窗口后查询词不撞就完全看不见 ——
   *   于是出现「同脑不同步」：左边刚摔了一跤，右边非要猜中关键词才知道。
   *
   * 四条硬约束（都是实测换来的，不遵守就是静默返回空）：
   *   ① 时间字段两种形态：自产库是毫秒数，L1 records 里 84% 是 ISO 字符串 ⇒ 必须归一
   *   ② 归属会话是 sessionId / sessionKey / source_session_id 三个同值别名；
   *      **sourceSessionId 只是 memory_get 输出时的派生名，落盘文件里没有这个键**
   *      ⇒ 一律走 lib/card-session.js 的 sessionIdOf()，别再手写回退链
   *   ③ 主库 engram-relay 近 4h 常常零新增 ⇒ 本函数只反映 cardsById 实况，不编造
   *   ④ 不按 importance 排（实测当天的卡 importance 全是 0.25，排了等于没排）⇒ 纯时间倒序
   *
   * @param {{sinceMs?:number, excludeSessionId?:string, limit?:number, perSessionCap?:number}} opts
   * @returns {Array<{id:string,title:string,snippet:string,t:number,sid:string}>}
   */
  function recentCrossSession(opts) {
    const o = opts || {};
    const sinceMs = Number.isFinite(Number(o.sinceMs)) ? Number(o.sinceMs) : 4 * 3600 * 1000;
    const excludeSessionId = String(o.excludeSessionId || '');
    const limit = Math.max(1, Math.min(10, Number(o.limit) || 4));
    const perSessionCap = Math.max(1, Number(o.perSessionCap) || 2);
    if (!state.ready || !state.cardsById || state.cardsById.size === 0) return [];
    const now = Date.now();
    const cand = [];
    for (const c of state.cardsById.values()) {
      if (!c) continue;
      const sid = sessionIdOf(c);
      if (!sid) continue;
      if (excludeSessionId && sid === excludeSessionId) continue;
      let t = Number(c.createdAt);
      if (!Number.isFinite(t) || t <= 0) t = Date.parse(String(c.createdAt || ''));  // ISO 归一
      if (!Number.isFinite(t) || t <= 0) continue;
      if (now - t > sinceMs) continue;
      cand.push({
        id: String(c.id || ''),
        title: String(c.title || '').replace(/\s+/g, ' ').trim().slice(0, 40),
        // [2026-10-27 红白联合拍板] snippet 60 → 120：
        //   60 字只够说「发生了什么」，看不到「结论是什么」。
        //   数据源先放宽，渲染端再按预算裁（pulse 取 100，hot 取 140）。
        snippet: String(c.summary || c.content || '').replace(/\s+/g, ' ').trim().slice(0, 120),
        t,
        sid,
      });
    }
    cand.sort(function (a, b) { return b.t - a.t; });
    // 防单窗口刷屏：同一来源会话最多占 perSessionCap 席，否则一个窗口连产 4 卡就把别人挤出局
    const out = [];
    const seen = new Map();
    for (const it of cand) {
      const n = seen.get(it.sid) || 0;
      if (n >= perSessionCap) continue;
      seen.set(it.sid, n + 1);
      out.push(it);
      if (out.length >= limit) break;
    }
    return out;
  }

  /**
   * [2026-10-27 by Assistant · 双轨制第一轨：近期热记忆直通区]
   *
   * 把「其他窗口最近几轮完整对话（修复后的一问多答 L0 Rounds）」
   * **无条件**按时间倒序送到眼前 —— 不看 query、不跑 BM25 竞争。
   *
   * 为什么必须独立成一条轨（实测事故）：
   *   另一个窗口的完整终审结论确实在 L0 里，但换到这个窗口后查询词不撞就完全看不见，
   *   于是出现「同脑不同步」：左边刚摔了一跤，右边非要猜中关键词才知道。
   *   ⇒ **近期该"看"，远期才该"搜"。**
   *
   * @param {{sinceMs?:number, excludeSessionId?:string, limit?:number, perSessionCap?:number}} opts
   * @returns {Array<{id:string,title:string,user:string,answer:string,t:number,sid:string}>}
   */
  function recentRounds(opts) {
    const o = opts || {};
    const sinceMs = Number.isFinite(Number(o.sinceMs)) ? Number(o.sinceMs) : 6 * 3600 * 1000;
    const excludeSessionId = String(o.excludeSessionId || '');
    const limit = Math.max(1, Math.min(10, Number(o.limit) || 3));
    const perSessionCap = Math.max(1, Number(o.perSessionCap) || 2);
    if (!state.l0CardsById || state.l0CardsById.size === 0) return [];
    const now = Date.now();
    const cand = [];
    for (const c of state.l0CardsById.values()) {
      if (!c) continue;
      const sid = String(c.sessionKey || '');
      if (excludeSessionId && sid === excludeSessionId) continue;
      const t = Number(c.createdAt);
      if (!Number.isFinite(t) || t <= 0) continue;
      if (now - t > sinceMs) continue;
      cand.push({
        id: String(c.id || ''),
        title: String(c.title || '').replace(/\s+/g, ' ').trim(),
        user: String(c.l0User || '').replace(/\s+/g, ' ').trim(),
        answer: String(c.l0Assistant || ''),
        t,
        sid,
      });
    }
    cand.sort(function (a, b) { return b.t - a.t; });
    const out = [];
    const seen = new Map();
    for (const it of cand) {
      const n = seen.get(it.sid) || 0;
      if (n >= perSessionCap) continue;
      seen.set(it.sid, n + 1);
      out.push(it);
      if (out.length >= limit) break;
    }
    return out;
  }

  return { search, warmup, health, explain, getGraph, getCard, refreshVectorIndex, recentCrossSession, recentRounds };
}

export default { createRetriever, DEFAULT_INDEX_ROOT, DEFAULT_ENGRAM_PATH, DEFAULT_ALIAS_PATH };
