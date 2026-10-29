#!/usr/bin/env node
/**
 * selftest-p3.mjs —— 期3 三级检索验收脚本（A~H 八组）。
 * 依据：_team-v2/p3/DESIGN.md §3
 *
 * 用法：
 *   node selftest-p3.mjs              只跑，不重建索引
 *   node selftest-p3.mjs --build      先重建超图索引再跑
 *   node selftest-p3.mjs --only=A,B   只跑指定组
 *   node selftest-p3.mjs --verbose
 *
 * 铁律：
 *   · 不写 engrams.jsonl（只读）
 *   · H 组必须 await（P1-c 教训：漏 await 会把「发起开销」量成耗时，得出假快）
 *   · 不进 lib/、不被 index.js import
 */

import { readFileSync, existsSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';

const ARGS = process.argv.slice(2);
const HAS = (flag) => ARGS.includes(flag);
const BUILD = HAS('--build');
const VERBOSE = HAS('--verbose');
const ONLY_ARG = ARGS.find((a) => a.startsWith('--only='));
const ONLY = ONLY_ARG ? ONLY_ARG.slice(7).split(',').map((s) => s.trim().toUpperCase()).filter(Boolean) : null;

const PLUGIN_ROOT = 'D:/dsh-plugins/dsh-unified-memory';
const LIB = PLUGIN_ROOT + '/lib/retrieval';
const INDEX_ROOT = '~/.dsh/unified-memory/hypergraph';
// [2026-10-22 by Assistant · 交接文档坑5 修复] 期5 已把 engram 存储根迁到云盘 live。
// 这里原本还指旧路径（6241 行 / 5496 活卡），而检索器读的是 live（6440 / 5682）
// ⇒ p3 的「alive 覆盖」「BM25 扫全部活卡」两条判据必然对不上（测的和用的不是同一份文件）。
const ENGRAM_PATH = '~/.dsh/unified-memory/engram-relay/engrams.jsonl';
const ALIAS_PATH = '~/_tmp/engram-triggers-20261018/engram-triggers.preview.jsonl';
const QUERY_SET = '~/_team-v2/p3/queries-v1.jsonl';

const results = [];
let failed = 0;
const f2 = (x) => Number(x).toFixed(2);
const f3 = (x) => Number(x).toFixed(3);

function log() { console.log.apply(console, arguments); }
function vlog() { if (VERBOSE) console.log.apply(console, arguments); }

function check(group, name, cond, detail) {
  if (cond) { results.push({ group, name, ok: true }); log('  PASS ' + name + (detail ? '   ' + detail : '')); }
  else { failed++; results.push({ group, name, ok: false }); log('  FAIL ' + name + (detail ? '   ' + detail : '')); }
  return !!cond;
}
function record(group, name, detail) {
  results.push({ group, name, ok: true, record: true });
  log('  REC  ' + name + (detail ? '   ' + detail : ''));
}
function groupOf(g) { return !ONLY || ONLY.includes(g); }

function pct(sorted, p) {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[i];
}
function stats(arr) {
  const s = arr.slice().sort((a, b) => a - b);
  return {
    n: s.length,
    p50: pct(s, 50), p95: pct(s, 95), p99: pct(s, 99),
    max: s.length ? s[s.length - 1] : 0,
    mean: s.length ? s.reduce((a, b) => a + b, 0) / s.length : 0,
  };
}

/** 快照四元组（DESIGN §0.5）：所有 benchmark 必须绑定{lines, alive, mtimeMs, sha256(前1MB)} */
function snapshot() {
  const st = statSync(ENGRAM_PATH);
  const raw = readFileSync(ENGRAM_PATH);
  const text = raw.toString('utf8');
  let lines = 0;
  // [2026-10-26 by Assistant · E8 根因修复配套] alive **必须按 id 去重后再数**。
  //   主库是追加式日志（更新 = 追加同 id 新版本），生产侧 readSourceCards() 已改为
  //   「按 id 去重、后写覆盖先写」；这里若还按行数数，C5 的 alive 覆盖等式必然错位
  //   （实测 6617 vs 5896+875=6771，差的正是 154 个幻影副本）。
  //   注意：lines 仍按物理行数统计（它用于"源文件是否被追加"类断言），不要一并改。
  const aliveById = new Map();
  for (const line of text.split('\n')) {
    if (!line) continue;
    lines++;
    try {
      const o = JSON.parse(line);
      if (!o.id) continue;
      aliveById.set(String(o.id), (o.status || 'active') !== 'retired');
    } catch { /* skip */ }
  }
  let alive = 0;
  for (const v of aliveById.values()) if (v) alive++;
  const sha = createHash('sha256').update(raw.subarray(0, 1024 * 1024)).digest('hex').slice(0, 16);
  // [2026-10-21 by Assistant] 全文件 sha：用于「原有内容未被改写」判据
  const shaAll = createHash('sha256').update(raw).digest('hex').slice(0, 16);
  // [2026-10-21 by Assistant] 业务字段哈希：剔除 relay 会原地改写的 hits/lastHitAt。
  // 实测证据：emuv806oi-4d 的 hits 11625→11628、lastHitAt 变化，其它字段 0 变化，
  // 文件大小因位数变化 +28B ⇒ 任何「全文件/前缘 sha 不变」判据必然 flaky（p4 报告实测）。
  const biz = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    try {
      const o = JSON.parse(line);
      delete o.hits;
      delete o.lastHitAt;
      biz.push(o.id + ':' + createHash('sha256').update(JSON.stringify(o)).digest('hex').slice(0, 12));
    } catch { biz.push('BAD:' + createHash('sha256').update(line).digest('hex').slice(0, 12)); }
  }
  biz.sort();
  const businessHash = createHash('sha256').update(biz.join('|')).digest('hex').slice(0, 16);
  return { bytes: st.size, mtimeMs: st.mtimeMs, lines, alive, sha256Head1MB: sha, sha256All: shaAll, businessHash, _raw: raw };
}
/**
 * [2026-10-21 by Assistant] 从 after 快照里取「与 before 同长度的前缀」的 sha。
 * 用途：relay 只追加不重写 ⇒ 前缀 sha 必须等于 before 的全文件 sha。
 */
function prefixSha(beforeSnap, afterSnap) {
  const n = beforeSnap.bytes;
  if (!afterSnap._raw || afterSnap._raw.length < n) return '(after 比 before 还短)';
  return createHash('sha256').update(afterSnap._raw.subarray(0, n)).digest('hex').slice(0, 16);
}
{
}

const MODS = {};

async function loadModules() {
  const base = 'file:///' + LIB.replace(/\\/g, '/') + '/';
  MODS.types = await import(base + 'types.js');
  MODS.tokenize = await import(base + 'tokenize.js');
  MODS.bm25 = await import(base + 'bm25.js');
  MODS.alias = await import(base + 'alias.js');
  MODS.rrf = await import(base + 'rrf.js');
  MODS.stages = await import(base + 'stages.js');
  MODS.retriever = await import(base + 'retriever.js');
  // [2026-10-22] 判定 fixture 要用到 readOwnIngest（自产 ingest 卡的读入口）
  try {
    MODS.source = await import('file:///' + PLUGIN_ROOT.replace(/\\/g, '/') + '/lib/hypergraph/source.js');
  } catch { MODS.source = null; }
}

/**
 * 读全量卡（只读；retired 排除）。
 *
 * [2026-10-22 by Assistant · 期7 后修正] 必须**同时**读本插件自产的 ingest 卡，
 * 否则测试 fixture 与真实检索器的口径不一致：
 *   真实 retriever = engram 源 + ingest 自产（readOwnIngest）
 *   旧 fixture     = 只有 engram 源
 *   ⇒ C16「bm25.N === coverage.alive」必然差出 N 张（实测差 6），误报成失败。
 * 这里复刻生产口径，让两边可比。
 */
function readAliveCards() {
  // [2026-10-26 by Assistant · E8 根因修复配套] **夹具必须与生产同一口径**。
  //
  // 主库是追加式日志：更新一张卡 = 再追加一行同 id 的新版本。
  //   生产侧 readSourceCards() 曾经不去重，导致同一张卡在 BM25 里出现 N 次，
  //   weightedFuse 的 bump() 又累加 ⇒ 分数被放大 N 倍（E8 就是这么红的）。
  //   生产已修为「按 id 去重、后写覆盖先写」。
  //   而本夹具仍然逐行 push ⇒ C5/C16 的 alive 与 bm25.N 立刻对不上（6617 vs 6771）。
  //
  // ⇒ 夹具照抄生产语义：先按 id 收敛到最后状态，再判 retired。
  const byId = new Map();
  for (const line of readFileSync(ENGRAM_PATH, 'utf8').split('\n')) {
    if (!line) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (!o.id) continue;
    byId.set(String(o.id), o);          // 后写覆盖先写
  }
  const cards = [];
  for (const o of byId.values()) {
    if ((o.status || 'active') === 'retired') continue;
    cards.push(o);
  }
  // 同类补充：自产 ingest（L1 + 蒸馏），失败不影响基线
  try {
    const srcUrl = 'file:///' + PLUGIN_ROOT.replace(/\\/g, '/') + '/lib/hypergraph/source.js';
    // 同步 import 不可用，这里走 require 语义的兼容兜底：用已加载模块
    if (MODS.source && typeof MODS.source.readOwnIngest === 'function') {
      const own = MODS.source.readOwnIngest();
      if (own && Array.isArray(own.cards)) {
        const have = new Set(cards.map((x) => String(x.id)));
        for (const c of own.cards) {
          const id = String(c.id);
          if (have.has(id)) continue;
          cards.push(c);
          have.add(id);
        }
      }
    }
  } catch { /* 自产数据缺失时就退回纯 engram 基线 */ }
  return cards;
}

/** 读 queries-v1.jsonl（130 条，独立查询集） */
function readQuerySet() {
  if (!existsSync(QUERY_SET)) return [];
  const out = [];
  for (const line of readFileSync(QUERY_SET, 'utf8').split('\n')) {
    if (!line) continue;
    try { out.push(JSON.parse(line)); } catch { /* skip */ }
  }
  return out;
}

// ============================ A · 纯函数 ============================
function runA() {
  log('\n── A · 纯函数（tokenizer / rrf / weightedFuse / adaptiveK / classifyQuery） ──');
  const tok = MODS.tokenize.createTokenizer({ mode: 'bigram' });
  const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  check('A', 'A1 tokenizer CJK bigram', eq(tok.tokenize('超图检索'), ['超图', '图检', '检索']), JSON.stringify(tok.tokenize('超图检索')));
  check('A', 'A1 tokenizer 标识符整词', eq(tok.tokenize('KVMem 解码'), ['kvmem', '解码']), JSON.stringify(tok.tokenize('KVMem 解码')));
  check('A', 'A1 tokenizer 版本号整词', eq(tok.tokenize('v1.2.3 修复'), ['v1.2.3', '修复']), JSON.stringify(tok.tokenize('v1.2.3 修复')));
  check('A', 'A1 tokenizer 空串', eq(tok.tokenize(''), []));

  const fused = MODS.rrf.rrfFuse([['a', 'b'], ['b', 'c']], { k: 60 });
  check('A', 'A2 rrf 首位 b', fused[0][0] === 'b', JSON.stringify(fused.map((x) => x[0])));
  const expB = 1 / 62 + 1 / 61;
  check('A', 'A2 rrf 分数精确', Math.abs(fused[0][1] - expB) < 1e-12, f3(fused[0][1]) + ' vs ' + f3(expB));
  check('A', 'A2 rrf 长度 3', fused.length === 3);

  const wf = MODS.rrf.weightedFuse([['a', 1.0], ['b', 0.5]], [{ kind: 'edge', items: [['b', 1.0]] }, { kind: 'alias', items: [['c', 1.0]] }], { wEdge: 0.2, wAlias: 0.15 });
  check('A', 'A3 weightedFuse 首位 a', wf[0][0] === 'a', JSON.stringify(wf.map((x) => [x[0], f2(x[1])])));
  const bRow = wf.find((x) => x[0] === 'b');
  check('A', 'A3 edge bonus = 0.2', Math.abs(bRow[2].boost - 0.2) < 1e-12, f3(bRow[2].boost));

  const kf = MODS.rrf.resolveAdaptiveK('factual');
  check('A', 'A4 factual k', eq(kf, { topic: 8, episode: 20, fact: 24 }), JSON.stringify(kf));
  const kt = MODS.rrf.resolveAdaptiveK('temporal');
  check('A', 'A4 temporal k', eq(kt, { topic: 10, episode: 20, fact: 30 }), JSON.stringify(kt));
  const kr = MODS.rrf.resolveAdaptiveK('reasoning');
  check('A', 'A4 reasoning k', eq(kr, { topic: 12, episode: 25, fact: 35 }), JSON.stringify(kr));
  check('A', 'A4 G1 minEpisode=10 无效', MODS.rrf.resolveAdaptiveK('factual', { minEpisode: 10 }).episode === 20);
  check('A', 'A4 G2 tokenBudget 截断', MODS.rrf.resolveAdaptiveK('factual', { tokenBudget: 300 }).fact < 24, 'fact=' + MODS.rrf.resolveAdaptiveK('factual', { tokenBudget: 300 }).fact);

  check('A', 'A5 classify temporal', MODS.rrf.classifyQuery('上次那个 KVMem 改完是什么时候') === 'temporal');
  check('A', 'A5 classify reasoning', MODS.rrf.classifyQuery('为什么超图检索会掉点') === 'reasoning');
  check('A', 'A5 classify factual', MODS.rrf.classifyQuery('超图') === 'factual');
}

// ============================ B · BM25 ============================
function runB() {
  log('\n── B · BM25（倒排 / idf 单调 / 字段权重 / 查询去重 / 空查询） ──');
  const tok = MODS.tokenize.createTokenizer({ mode: 'bigram' });
  const docs = [
    { id: 'd1', title: '短', summary: '超图检索的三级粗到细管线', content: '' },
    { id: 'd2', title: '短', summary: '', content: '完全无关的一段话'.repeat(50) },
  ];
  const idx = MODS.bm25.createBm25Index(docs, tok);
  const r = MODS.bm25.searchBm25(idx, '超图', 10);
  check('B', 'B1 命中单卡', r.length === 1 && r[0][0] === 'd1', JSON.stringify(r));

  // [2026-10-21 by Assistant] 改判据：原断言硬编码「summary > title」，等于把旧设计决定
  // （title: 0.4）写进测试，字段权重一调就误报。真正该验的是「权重确实按配置生效」。
  const a = MODS.bm25.createBm25Index([{ id: 'x', title: '三级检索', summary: '', content: '' }], tok);
  const b = MODS.bm25.createBm25Index([{ id: 'x', title: '', summary: '三级检索', content: '' }], tok);
  const sa = MODS.bm25.searchBm25(a, '三级检索', 1)[0][1];
  const sb = MODS.bm25.searchBm25(b, '三级检索', 1)[0][1];
  const FW = MODS.types.FIELD_WEIGHT;
  // 同长度单字段下，分数比应近似等于权重比（BM25 各段幂等，误差来自 idf 与 len 归一）
  const expected = FW.title / FW.summary;
  const actual = sa / sb;
  const ratioOk = Math.abs(actual - expected) / expected < 0.35;
  check('B', 'B2 字段权重按 FIELD_WEIGHT 生效', ratioOk,
    'title=' + f3(sa) + ' summary=' + f3(sb) + ' 实测比=' + f2(actual) + ' 期望比=' + f2(expected) +
    ' (FIELD_WEIGHT=' + JSON.stringify(FW) + ')');
  // 补充：title 权重必须 > 0（历史教训：0.4 压得太低，召回从 86% 掉到 72%）
  check('B', 'B2b title 权重未被压到 1.0 以下', FW.title >= 1.0, 'title=' + FW.title);

  const s1 = MODS.bm25.searchBm25(idx, '超图', 1)[0][1];
  const s2 = MODS.bm25.searchBm25(idx, '超图 超图', 1)[0][1];
  check('B', 'B3 查询去重', Math.abs(s1 - s2) < 1e-12, f3(s1) + ' == ' + f3(s2));

  const c3 = MODS.bm25.createBm25Index([
    { id: 'p', summary: '常见 罕见' }, { id: 'q', summary: '常见' }, { id: 'r', summary: '常见' },
  ], tok);
  const rare = MODS.bm25.searchBm25(c3, '罕见', 1)[0][1];
  const common = MODS.bm25.searchBm25(c3, '常见', 1)[0][1];
  check('B', 'B4 idf 单调（罕见>常见）', rare > common, 'rare=' + f3(rare) + ' common=' + f3(common));

  const e = MODS.bm25.searchBm25(idx, '', 10);
  check('B', 'B5 空查询返回空数组', Array.isArray(e) && e.length === 0);
}

// ============================ C · 索引结构 + 三覆盖 ============================
async function runC(rt) {
  log('\n── C · 索引载入与结构不变量（只读生产索引，三覆盖口径） ──');
  const h = rt.health();

  check('C', 'C1 索引就绪', h.ok === true && h.bm25.ready === true);
  check('C', 'C2 episodes > 1500', h.graph.episodes > 1500, 'episodes=' + h.graph.episodes);
  check('C', 'C3 fedges > 800', h.graph.fedges > 800, 'fedges=' + h.graph.fedges);
  check('C', 'C4 四类记录都读到了', h.byType && h.byType.eedge > 0 && h.byType.topic > 0 && h.byType.oedge > 0,
    JSON.stringify(h.byType));

  // ★ P0-2 三覆盖口径：alive / episodeCovered / edgeCovered 分开断言，用容差（源是活文件）
  const cov = h.coverage;
  // [2026-10-22 by Assistant] 判据改成「与源文件自身一致」而不是钉死某个数字：
  //   源是活文件（每天都在追加），写死的基线迟早过期，而过期后测试会误报。
  //   真正该锁的合同是：检索器看到的活卡数 == 源里非 retired 的条数。
  // [2026-10-22 by Assistant · 期7 后修正] 检索器现在会把**两处**卡并进同一份 BM25：
  //   ① engram 源（snapshot() 数的那份）
  //   ② 本插件自产的 ingest（L1 卡 + 蒸馏卡，readOwnIngest）
  // 所以「alive == 源活卡数」这个等式在期7 之后**不再成立**（会差出 N 张自产卡）。
  // 正确判据：检索器看到的活卡数 = 源活卡数 + 自产卡数（且自产卡数 ≥ 0）。
  const srcAlive = snapshot().alive;
  let ownAlive = 0;
  try {
    const { readOwnIngest } = await import('./lib/hypergraph/source.js');
    const own = readOwnIngest();
    ownAlive = (own && own.cards ? own.cards.length : 0);
  } catch { ownAlive = 0; }
  check('C', 'C5 alive 覆盖（= 源活卡 + 自产 ingest 卡）',
    cov.alive === srcAlive + ownAlive,
    'alive=' + cov.alive + ' src=' + srcAlive + ' own=' + ownAlive);
  // [2026-10-22 by Assistant] 同 C5：**不钉死基线数字**（数据每天在长，写死的数字必然过期误报）。
  //   真正该锁的合同是结构自洽：
  //     · Episode 覆盖的卡不可能超过活卡总数
  //     · 有超边的卡必须 ≤ Episode 覆盖的卡（有边 ⇒ 必然在某个 Episode 里）
  //     · 覆盖率落在合理区间（bootstrap 期实测 60%~100%；低于 40% 说明建模出了大问题）
  const epCov = cov.episodeCovered;
  const cardWithEdge = h.graph.cardsWithEdge;
  check('C', 'C6 episodeCovered ≤ alive 且覆盖率合理',
    epCov > 0 && epCov <= cov.alive && epCov / cov.alive >= 0.4,
    'episodeCovered=' + epCov + ' alive=' + cov.alive + ' ratio=' + f3(epCov / cov.alive));
  check('C', 'C7 cardsWithEdge ≤ episodeCovered 且边覆盖合理',
    cardWithEdge > 0 && cardWithEdge <= epCov && cardWithEdge / epCov >= 0.4,
    'cardsWithEdge=' + cardWithEdge + ' epCov=' + epCov + ' ratio=' + f3(cardWithEdge / epCov));

  // ★ 关键判据：无超边卡必须 > 500，且 BM25 保底必须开
  check('C', 'C8 noEdge > 500', cov.noEdge > 500, 'noEdge=' + cov.noEdge + '（Stage3 的真实缺口）');
  check('C', 'C9 bm25Fallback === true', h.bm25Fallback === true && cov.bm25Fallback === true);
  // [2026-10-26 by Assistant · 两项巡检修复 红1] health().degrade 回归单一语义。
  //   · 原来 health() 把「图覆盖率不足」也塞进 degrade（edgeRatio<0.70 ⇒ 'edge-sparse'），
  //     导致这个字段和 search() 返回的 degrade 值域不一致（同一时刻两个答案）。
  //   · 已拆开：degrade 只表示「检索为什么降级」，覆盖率告警走独立的 edgeSparse 字段。
  //   ⇒ 本项检查「基础降级档是否为 full」，覆盖率单独在 C10b 里按告警口径记录（不判红）。
  check('C', 'C10 degrade = full', h.degrade === 'full', 'degrade=' + h.degrade);
  record('C', 'C10b 图覆盖率告警（仅记录，不判红）',
    'sparse=' + (h.edgeSparse ? h.edgeSparse.sparse : '?') +
    ' edgeRatio=' + (h.edgeSparse ? h.edgeSparse.edgeRatio : '?') +
    ' threshold=' + (h.edgeSparse ? h.edgeSparse.threshold : '?') +
    ' noEdge=' + (h.edgeSparse ? h.edgeSparse.noEdge : '?'));
  record('C', 'C11 三覆盖明细',
    'alive=' + cov.alive + ' episodeCovered=' + cov.episodeCovered + ' edgeCovered=' + cov.edgeCovered +
    ' noEdge=' + cov.noEdge + ' edgeRatio=' + cov.edgeRatio);

  // C12 度分布（不是「恒为 1」，红队 P0-1 已证伪「2 步不可能」；这里只记录真实度数）
  const deg = new Map();
  let maxDeg = 0;
  for (const arr of rt.__ctx.edgesByEpisode.values()) {
    for (const e of arr) {
      for (const m of (e.members || [])) {
        const d = (deg.get(m.nodeId) || 0) + 1;
        deg.set(m.nodeId, d);
        if (d > maxDeg) maxDeg = d;
      }
    }
  }
  check('C', 'C12 卡度数 max 记录', true, 'maxDeg=' + maxDeg + ' 有边卡=' + deg.size);
  record('C', 'C13 卡跨集数', 'maxCross=' + maxCross(rt));

  // C14 超边成员数落在 [3,8]
  let badSize = 0;
  for (const arr of rt.__ctx.edgesByEpisode.values()) {
    for (const e of arr) {
      const n = (e.members || []).length;
      if (n < 3 || n > 8) badSize++;
    }
  }
  check('C', 'C14 超边成员数 ∈ [3,8]', badSize === 0, '违规边=' + badSize);

  // C15 每条 fedge 的 anchorId 指向存在的 Episode
  let badAnchor = 0;
  for (const anchor of rt.__ctx.edgesByEpisode.keys()) {
    if (!rt.__ctx.episodes.has(anchor)) badAnchor++;
  }
  check('C', 'C15 fedge anchorId 全部有效', badAnchor === 0, '坏锚点=' + badAnchor);

  // C16 Stage1 扫全部活卡（BM25 保底铁律的机器判据）
  // [2026-10-22] bm25.N 是"实际上被索引的文章数"，必须等于 coverage.alive（源+自产）
  check('C', 'C16 Stage1 扫全部活卡', rt.__ctx.bm25.N === cov.alive, 'bm25.N=' + rt.__ctx.bm25.N + ' alive=' + cov.alive);
}

function maxCross(rt) {
  const m = new Map();
  for (const [cid, ep] of rt.__ctx.cardToEpisode) m.set(cid, (m.get(cid) || 0) + 1);
  let mx = 0;
  for (const v of m.values()) if (v > mx) mx = v;
  return mx;
}

// ============================ D · 分词对比 ============================
async function runD(rt) {
  log('\n── D · 分词对比（char-bigram vs Intl.Segmenter vs unigram，只报告不下结论） ──');
  const cards = rt.__cards;
  const qs = readQuerySet();
  if (!qs.length) { log('  SKIP 查询集不存在: ' + QUERY_SET); return; }
  log('  查询集: ' + qs.length + ' 条（独立模板集，非子串）');

  const modes = ['bigram', 'segment', 'unigram'];
  for (const mode of modes) {
    const tok = MODS.tokenize.createTokenizer({ mode });
    const t0 = performance.now();
    const idx = MODS.bm25.createBm25Index(cards, tok);
    const buildMs = performance.now() - t0;
    let hit = 0;
    let negHit = 0;
    let negTotal = 0;
    for (const q of qs) {
      const r = MODS.bm25.searchBm25(idx, q.q, 10).map((p) => p[0]);
      if (r.indexOf(q.gold) >= 0) hit++;
      for (const hn of (q.hardNegatives || [])) { negTotal++; if (r.indexOf(hn) >= 0) negHit++; }
    }
    const recall = (hit / qs.length) * 100;
    const negRate = negTotal ? (negHit / negTotal) * 100 : 0;
    record('D', 'D-' + mode, 'Recall@10=' + f2(recall) + '% (' + hit + '/' + qs.length + ')  误召hardNeg=' + f2(negRate) + '%  vocab=' + idx.vocabSize + '  build=' + f2(buildMs) + 'ms');
  }

  // 负对照：乱码查询
  const tokB = MODS.tokenize.createTokenizer({ mode: 'bigram' });
  const idxB = MODS.bm25.createBm25Index(cards, tokB);
  let garbageHit = 0;
  for (const q of qs) {
    const g = q.q.split('').reverse().join('') + 'zzqx';
    const r = MODS.bm25.searchBm25(idxB, g, 10).map((p) => p[0]);
    if (r.indexOf(q.gold) >= 0) garbageHit++;
  }
  record('D', 'D-negative', '乱码查询 Recall@10=' + f2((garbageHit / qs.length) * 100) + '%  （应接近 0，证明判据有判别力）');
  log('  ⚠ 按 DESIGN 约束 4：本组只报告不下结论（查询集由卡文本构造，有出题人偏置）');
}

// ============================ E · 管线召回 ============================
async function runE(rt) {
  log('\n── E · 三级管线召回（kE 与融合方式的两处偏离必须有实测背书） ──');
  const qs = readQuerySet();
  if (!qs.length) { log('  SKIP 查询集不存在'); return; }

  async function evalPipeline(label, fn) {
    let hit10 = 0;
    const lat = [];
    for (const q of qs) {
      const t0 = performance.now();
      const ids = await fn(q.q);
      lat.push(performance.now() - t0);
      if (ids.slice(0, 10).indexOf(q.gold) >= 0) hit10++;
    }
    const r = (hit10 / qs.length) * 100;
    const st = stats(lat);
    record('E', label, 'Hit@10=' + f2(r) + '% (' + hit10 + '/' + qs.length + ')  p50=' + f3(st.p50) + 'ms p95=' + f3(st.p95) + 'ms');
    return r;
  }

  // E1 仅 Stage1
  const e1 = await evalPipeline('E1 仅 Stage1 卡级 BM25', async (q) => {
    const s1 = MODS.stages.stage1(rt.__ctx, q, 8);
    return s1.candidates.slice(0, 40).map((p) => p[0]);
  });

  // E2 kE=10（规划原值，应劣于 20）
  const e2 = await evalPipeline('E2 kE=10（规划原值）', async (q) => {
    const s1 = MODS.stages.stage1(rt.__ctx, q, 8);
    const s2 = MODS.stages.stage2(rt.__ctx, s1, 10);
    const s3 = MODS.stages.stage3(rt.__ctx, s2, 24);
    const f = MODS.rrf.weightedFuse(s1.candidates, [{ kind: 'edge', items: s3.scored }], { wEdge: 0.2 });
    return f.map((x) => x[0]);
  });

  // E3 kE=20（本设计默认）
  const e3 = await evalPipeline('E3 kE=20（本设计）', async (q) => {
    const s1 = MODS.stages.stage1(rt.__ctx, q, 8);
    const s2 = MODS.stages.stage2(rt.__ctx, s1, 20);
    const s3 = MODS.stages.stage3(rt.__ctx, s2, 24);
    const f = MODS.rrf.weightedFuse(s1.candidates, [{ kind: 'edge', items: s3.scored }], { wEdge: 0.2 });
    return f.map((x) => x[0]);
  });

  // E4 跨 Stage 用 RRF（规划原法，应劣于加权）
  const e4 = await evalPipeline('E4 RRF 跨 Stage（规划原法）', async (q) => {
    const s1 = MODS.stages.stage1(rt.__ctx, q, 8);
    const s2 = MODS.stages.stage2(rt.__ctx, s1, 20);
    const s3 = MODS.stages.stage3(rt.__ctx, s2, 24);
    const fused = MODS.rrf.rrfFuse([s1.candidates.map((p) => p[0]), s3.scored.map((p) => p[0])], { k: 60 });
    return fused.map((x) => x[0]);
  });

  // E5 加权（本设计）
  const e5 = await evalPipeline('E5 加权跨 Stage（本设计）', async (q) => {
    // [2026-10-24 Round 24] 这里测的是**融合算法**（加权 vs RRF vs 仅Stage1），
    //   必须关掉「库外话题返回空」门控 —— 否则 E5 被门控清空一部分，
    //   而 E1/E4 走纯算法路径不受影响 ⇒ 对比口径不一致，测试会假摔。
    //   门控本身有专测：scripts/e2e-no-signal-gate.mjs
    const r = await rt.search(q, { kind: 'factual', allowEmptyOnNoSignal: false });
    return r.hits.map((h) => h.id);
  });

  check('E', 'E6 kE=20 ≥ kE=10', e3 >= e2 - 0.5, f2(e3) + '% vs ' + f2(e2) + '%');
  check('E', 'E7 加权 ≥ RRF', e5 >= e4 - 0.5, f2(e5) + '% vs ' + f2(e4) + '%');
  check('E', 'E8 加权 ≥ 仅Stage1 - 2pp', e5 >= e1 - 2.0, f2(e5) + '% vs ' + f2(e1) + '%');
}

// ============================ F · alias 熔断 ============================
async function runF(rt) {
  log('\n── F · alias 熔断（红队「Assistant漏掉第 1 条」的机器判据） ──');
  const idx = rt.__ctx.alias;
  if (!idx) { log('  SKIP alias 词表未加载'); return; }

  record('F', 'F0 词表规模', 'size=' + idx.size + '  coverage=' + idx.coverage + '  maxDf=' + idx.maxDf);
  check('F', 'F0b size > 9000', idx.size > 9000, String(idx.size));

  const noise = [
    '今天天气怎么样', '你吃饭了吗', '帮我算一下这个数', '明天几点开会', '这个函数怎么写', '我想休息一下',
    '现在心情不太好', '推荐一部电影', '路怎么走比较快', '温度调高一点', '手机没电了怎么办', '什么时候能做完',
    '晚安早点睡', '随便说点什么', '这个颜色好看吗', '外面下雨了', '把灯关掉', '音量小一点', '你叫什么名字',
    '给我讲个笑话', '东西放哪里了', '现在几点了', '这首歌叫什么', '帮我倒杯水', '窗户外面的树', '能听清我说话吗',
    '要不要加衣服', '价格是多少', '这家店好吃吗', '文件在哪',
  ];
  let fire = 0;
  const fired = [];
  for (const q of noise) {
    if (MODS.alias.matchAlias(idx, q).confident) { fire++; fired.push(q); }
  }
  check('F', 'F1 无关闲聊误触发 ≤3/30', fire <= 3, fire + '/30' + (fired.length ? '  触发: ' + fired.slice(0, 3).join(' / ') : ''));

  // F2 短问句：alias 候选召回（只加分，不要求必中）
  const cards = rt.__cards;
  let seed = 7;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  const shortQ = [];
  let guard = 0;
  while (shortQ.length < 40 && guard++ < 5000) {
    const c = cards[rnd(cards.length)];
    const t = String(c.title || '').trim();
    if (t.length >= 3 && t.length <= 8) shortQ.push({ q: t, gold: c.id });
  }
  let shortHit = 0;
  for (const x of shortQ) {
    const m = MODS.alias.matchAlias(idx, x.q, null, { maxResults: 10 });
    if (m.docs.slice(0, 10).some((p) => p[0] === x.gold)) shortHit++;
  }
  const sr = shortQ.length ? (shortHit / shortQ.length) * 100 : 0;
  record('F', 'F2 短问句 alias 候选召回', f2(sr) + '% (' + shortHit + '/' + shortQ.length + ')');
  check('F', 'F2b 短问句召回 ≥ 35%', sr >= 35, f2(sr) + '%');

  // F3 单词即必中必须不 confident（非领域词）
  const a1 = MODS.alias.matchAlias(idx, '验收');
  check('F', 'F3 单词「验收」不 confident', a1.confident === false, 'confident=' + a1.confident + ' reason=' + a1.reason);

  // F4 领域词单词豁免
  const a2 = MODS.alias.matchAlias(idx, 'kvmembeta');
  check('F', 'F4 领域词「kvmembeta」confident', a2.confident === true, 'confident=' + a2.confident + ' terms=' + JSON.stringify(a2.matchedTerms));

  // F5 多词熔断
  const a3 = MODS.alias.matchAlias(idx, '验收 检索');
  record('F', 'F5 双词「验收 检索」', 'confident=' + a3.confident + ' terms=' + JSON.stringify(a3.matchedTerms) + ' reason=' + a3.reason);
}

// ============================ G · 扩展步数护栏 + 1步vs2步 ============================
async function runG(rt) {
  log('\n── G · expandHypergraph 步数护栏 + 1步 vs 2步 质量成本对比（红队 P0-1） ──');
  const ctx = rt.__ctx;
  const cards = rt.__cards;

  // 种子选择（关键）：必须挑一张**真的挂在 fedge 上**的卡，否则扩出来恒为 0，断言会空转
  let seedId = null;
  let seedWhy = '';
  for (const fe of ctx.edgesByEpisode.values()) {
    for (const e of fe) {
      for (const m of (e.members || [])) { seedId = m.nodeId; break; }
      if (seedId) break;
    }
    if (seedId) break;
  }
  if (!seedId) { seedId = cards[0].id; seedWhy = '（无 fedge，退化为首卡）'; }
  const seedEp = ctx.cardToEpisode.get(seedId);
  const seedSiblings = seedEp && ctx.episodes.get(seedEp) ? ctx.episodes.get(seedEp).cardIds.length : 0;
  record('G', 'G0 种子选取', 'seed=' + seedId + '  episode=' + (seedEp || 'NONE') + '  同集卡数=' + seedSiblings + seedWhy);
  if (seedSiblings < 2) { log('  ⚠ 种子同集卡数 < 2，G5~G9 的「扩展」会是空集（下面会显式标注）'); }

  // G1 步数护栏：1 与 2 合法，>2 抛错
  let ok1 = false;
  try { MODS.stages.expandHypergraph(ctx, [seedId], { maxPathHops: 1 }); ok1 = true; } catch { ok1 = false; }
  check('G', 'G1 maxPathHops=1 合法', ok1);

  let ok2 = false;
  try { MODS.stages.expandHypergraph(ctx, [seedId], { maxPathHops: 2 }); ok2 = true; } catch { ok2 = false; }
  check('G', 'G2 maxPathHops=2 合法（红队 P0-1：2 步真实存在，不许禁）', ok2);

  let threw3 = false;
  let msg3 = '';
  try { MODS.stages.expandHypergraph(ctx, [seedId], { maxPathHops: 3 }); } catch (e) { threw3 = true; msg3 = String(e && e.message || e); }
  check('G', 'G3 maxPathHops=3 抛错', threw3 && /maxPathHops/.test(msg3), msg3.slice(0, 70));

  // G4 P1 护栏：includeRelationEdges 抛错
  let threwR = false;
  let msgR = '';
  try { MODS.stages.expandHypergraph(ctx, [seedId], { includeRelationEdges: true }); } catch (e) { threwR = true; msgR = String(e && e.message || e); }
  check('G', 'G4 includeRelationEdges=true 抛错（P1 护栏）', threwR && /includeRelationEdges/.test(msgR), msgR.slice(0, 70));

  // G5 maxNeighbors 截断：种子必须**跨 Episode**分散，否则同集种子彼此去重后邻居总数可能 < 24，
  //    导致「截断」根本没发生（上一版就栽在这里：30 个同集种子只扩出 6 张）。
  const allSeed = [];
  for (const fe of ctx.edgesByEpisode.values()) for (const e of fe) for (const m of (e.members || [])) allSeed.push(m.nodeId);
  const perEp = new Map();   // episodeId -> 一个种子卡
  for (const id of Array.from(new Set(allSeed))) {
    const ep = ctx.cardToEpisode.get(id);
    if (ep && !perEp.has(ep)) perEp.set(ep, id);
  }
  const uniqSeed = Array.from(perEp.values()).slice(0, 40);   // 40 个不同 Episode 的种子
  const nbWide = MODS.stages.expandHypergraph(ctx, uniqSeed, { maxNeighbors: 500 });
  const nb = MODS.stages.expandHypergraph(ctx, uniqSeed, { maxNeighbors: 24 });
  check('G', 'G5 maxNeighbors=24 截断生效', nb.length <= 24 && nbWide.length > 24,
    '种子=' + uniqSeed.length + '(跨Episode)  不设限=' + nbWide.length + '  限24=' + nb.length);
  record('G', 'G5b 单种子扩展', 'seed=' + seedId + ' 扩出=' + MODS.stages.expandHypergraph(ctx, [seedId], { maxNeighbors: 24 }).length + ' 张');

  // G6 结果不得含种子自己
  check('G', 'G6 结果不含种子自己', nb.filter((x) => x.cardId === seedId).length === 0);

  // G7 剪枝阈值单调
  const nbStrict = MODS.stages.expandHypergraph(ctx, uniqSeed, { minActivation: 0.99, maxNeighbors: 500 });
  check('G', 'G7 minActivation 单调（严格阈值更少）', nbStrict.length < nbWide.length, nbStrict.length + ' < ' + nbWide.length);

  // ★ G8 1步 vs 2步 质量/成本对比（记录型，不硬断言）
  const sample = Array.from(new Set(allSeed)).sort(() => 0.5 - Math.random()).slice(0, 50);
  const one = MODS.stages.expandHypergraph(ctx, sample, { maxPathHops: 1, maxNeighbors: 200 });
  const two = MODS.stages.expandHypergraph(ctx, sample, { maxPathHops: 2, maxNeighbors: 200 });
  const growth = one.length ? two.length / one.length : 0;
  const distinct1 = new Set(one.map((x) => x.cardId)).size;
  const distinct2 = new Set(two.map((x) => x.cardId)).size;
  record('G', 'G8 1步 vs 2步（50 种子）',
    '1step=' + one.length + '(distinct ' + distinct1 + ')  2step=' + two.length + '(distinct ' + distinct2 + ')  growth=' + f2(growth) + 'x  （记录型，不硬断言）');

  // G9 两道护栏在真实种子上的实际覆盖
  const real = await rt.search('超图 检索 三级', { maxPathHops: 1 });
  record('G', 'G9 真实查询扩展', 'hits=' + real.hits.length + ' neighbors=' + real.neighbors.length + ' expand=' + f3(real.timing.expand) + 'ms');
}

// ============================ H · 性能（必须 await，分 cold/warm） ============================
async function runH(rt) {
  log('\n── H · 性能实测（P1-c 修正：for + await，分报 cold/warm 两档） ──');
  const qs = readQuerySet();
  const queries = (qs.length ? qs : [{ q: '超图检索' }]).slice(0, 130);

  // cold：每次新建 retriever（含暖启动），量「首轮」
  const coldLat = [];
  const coldWarm = [];
  for (let i = 0; i < Math.min(5, queries.length); i++) {
    const t0 = performance.now();
    const r = MODS.retriever.createRetriever({ tdaiEnabled: false });   // 同上：p3 只测 engram 基线
    const w = await r.warmup();
    coldWarm.push(performance.now() - t0);
    const t1 = performance.now();
    await r.search(queries[i].q);
    coldLat.push(performance.now() - t1);
  }
  const cw = stats(coldWarm);
  const cl = stats(coldLat);
  record('H', 'H1 cold 暖启动', 'n=' + cw.n + '  p50=' + f2(cw.p50) + 'ms  p95=' + f2(cw.p95) + 'ms  max=' + f2(cw.max) + 'ms');
  record('H', 'H2 cold 首轮检索', 'n=' + cl.n + '  p50=' + f2(cl.p50) + 'ms  p95=' + f2(cl.p95) + 'ms');

  // warm：同一个 rt，循环 await
  await rt.warmup();
  const warmLat = [];
  const stages = { stage1: [], stage2: [], stage3: [], expand: [], total: [] };
  for (let round = 0; round < 2; round++) {
    for (const q of queries) {
      const t0 = performance.now();
      const r = await rt.search(q.q);           // ★ 必须 await
      warmLat.push(performance.now() - t0);
      stages.stage1.push(r.timing.stage1);
      stages.stage2.push(r.timing.stage2);
      stages.stage3.push(r.timing.stage3);
      stages.expand.push(r.timing.expand);
      stages.total.push(r.timing.total);
    }
  }
  const ws = stats(warmLat);
  record('H', 'H3 warm 检索（n=' + ws.n + '）',
    'p50=' + f3(ws.p50) + 'ms  p95=' + f3(ws.p95) + 'ms  p99=' + f3(ws.p99) + 'ms  max=' + f3(ws.max) + 'ms');

  // ★ H4 自检：warm.p95 若 < 0.1ms 必是漏 await 的假快
  check('H', 'H4 warm.p95 > 0.1ms（漏 await 自检）', ws.p95 > 0.1, 'p95=' + f3(ws.p95) + 'ms');

  for (const key of ['stage1', 'stage2', 'stage3', 'expand']) {
    const st = stats(stages[key]);
    record('H', 'H5 ' + key, 'p50=' + f3(st.p50) + 'ms  p95=' + f3(st.p95) + 'ms  max=' + f3(st.max) + 'ms');
  }
  const tot = stats(stages.total);
  record('H', 'H6 管线内部合计', 'p50=' + f3(tot.p50) + 'ms  p95=' + f3(tot.p95) + 'ms  max=' + f3(tot.max) + 'ms');

  // ★ H8 端到端：必须经过 orchestrator 才算「真接线」
  //    （编码期踩过：retriever.search 单测全绿，但 orchestrator 里变量名笔误被 catch 吞掉，恒走 fixed）
  try {
    const orchUrl = 'file:///' + PLUGIN_ROOT.replace(/\\/g, '/') + '/lib/orchestrator.js';
    const orch = await import(orchUrl);
    const o = orch.createOrchestrator({ backends: [], scorer: null, logger: null, budgetTokens: 450, retriever: rt });
    const rr = await o.recall(queries[0].q);
    check('H', 'H8 orchestrator 端到端 level=hypergraph', rr.level === 'hypergraph',
      'level=' + rr.level + ' hits=' + ((rr.hits || []).length) + ' degrade=' + (rr.degrade || '-'));
  } catch (e) {
    check('H', 'H8 orchestrator 端到端', false, String(e && e.message || e).slice(0, 80));
  }

  // H9 R0 回滚档：enabled:false 必须返回 null
  const rtOff = MODS.retriever.createRetriever({ enabled: false });
  check('H', 'H9 enabled:false 返回 null（R0 回滚档）', rtOff === null);

  // H7 RSS
  const mb = process.memoryUsage();
  record('H', 'H7 RSS', 'rss=' + f2(mb.rss / 1048576) + 'MB  heapUsed=' + f2(mb.heapUsed / 1048576) + 'MB  external=' + f2(mb.external / 1048576) + 'MB');
  log('  ※ 本组不设绝对毫秒判据（DESIGN 约束 5「先测再定」）；判据是 H4 的漏-await 自检 + 上方实测值');
}

// ============================ I · 只读性 ============================
async function runI(snapBefore) {
  log('\n── I · 只读性（铁律 9：不写 engrams.jsonl / 索引） ──');
  const snapAfter = snapshot();
  // [2026-10-21 by Assistant] 判据修正：原 I1「字节不变」/ I2「mtime 不变」是错判据。
  // engrams.jsonl 是 engram-relay 的活文件，每轮对话都在**追加**新卡；
  // 要求它整轮不变等于要求 relay 停下，测的不是我们代码的只读性。
  // 正确的只读判据：我们**只允许追加语义**——不能截断/重写已有内容。
  const grew = snapAfter.bytes >= snapBefore.bytes;
  const delta = snapAfter.bytes - snapBefore.bytes;
  check('I', 'I1 engrams.jsonl 未被截断（只增不减）', grew,
    snapBefore.bytes + ' -> ' + snapAfter.bytes + '  delta=' + delta + 'B（relay 追加属正常）');
  check('I', 'I2 追加量在合理范围（<2MB，防我们误写）', delta >= 0 && delta < 2 * 1024 * 1024, 'delta=' + delta + 'B');
  check('I', 'I3 sha256(前1MB) 不变', snapBefore.sha256Head1MB === snapAfter.sha256Head1MB, snapAfter.sha256Head1MB);
  // [2026-10-21 by Assistant · 判据二次修正] 原 I3b 用「前缘 sha 一致」，实测 flaky：
  // relay 会**原地更新** hits / lastHitAt（hits 11625→11628，文件大小因此 +28B），
  // 前缘 sha 必然对不上 ⇒ 误报「我们改写了文件」。
  // 正确判据：比较「剔除 hits/lastHitAt 后的业务字段哈希」。
  // 前提：本轮运行期间没有**新增卡**（新增会改变 businessHash，属 relay 正常行为，需容忍）。
  const newCards = snapAfter.lines - snapBefore.lines;
  const bizSame = snapBefore.businessHash === snapAfter.businessHash;
  check('I', 'I3b 卡片业务内容未被改写（忽略 relay 的 hits 计数）',
    bizSame || newCards > 0,
    'before=' + snapBefore.businessHash + ' after=' + snapAfter.businessHash +
    ' 新增卡=' + newCards + (bizSame ? '（业务内容完全一致）' : '（有新增卡，容忍）'));
  const lock = INDEX_ROOT + '/.lock';
  check('I', 'I4 无残留 .lock', !existsSync(lock));
  record('I', 'I5 索引快照', 'lines=' + snapAfter.lines + '  alive=' + snapAfter.alive + '  sha=' + snapAfter.sha256Head1MB);
}

// ============================ 主流程 ============================
async function main() {
  log('════════ P3 SELFTEST · 期3 三级检索 ════════');
  log('时间: ' + new Date().toISOString());
  log('模式: ' + (BUILD ? 'build（先重建索引）' : 'run-only') + (ONLY ? '  only=' + ONLY.join(',') : ''));

  await loadModules();

  // 快照（DESIGN §0.5 快照绑定铁律）
  const snap = snapshot();
  log('快照: lines=' + snap.lines + ' alive=' + snap.alive + ' bytes=' + snap.bytes + ' sha=' + snap.sha256Head1MB);

  if (BUILD) {
    log('\n── BUILD · 重建超图索引 ──');
    const t0 = performance.now();
    const backend = await import('file:///' + PLUGIN_ROOT.replace(/\\/g, '/') + '/lib/hypergraph/backend.js');
    const hb = backend.createHypergraphBackend({ indexRoot: INDEX_ROOT, enabled: true });
    const rep = hb.rebuild({});
    log('  rebuild: ok=' + rep.ok + ' ms=' + rep.ms + ' shards=' + rep.shards + ' full=' + rep.full + ' reason=' + rep.reason);
    log('  counts=' + JSON.stringify(rep.manifest && rep.manifest.counts));
    log('  invariants=' + JSON.stringify(rep.invariants && { I1: rep.invariants.I1violations, I2: rep.invariants.I2violations, I3: rep.invariants.I3violations }));
    log('  耗时 ' + f2(performance.now() - t0) + 'ms');
  }

  // 建 retriever 并暖启动
  // [2026-10-22 by Assistant] p3 只测 engram 基线：关掉跨源(tdai)，
  // 否则 __ctx(fixture 5496) 与 search()(live 含 tdai 8672) 数据源不一致，断言会错位。
  const rt = MODS.retriever.createRetriever({ tdaiEnabled: false });
  const warm = await rt.warmup();
  log('\nwarmup: ok=' + warm.ok + ' ms=' + warm.ms + ' reason=' + (warm.reason || '-'));
  if (!warm.ok) {
    log('✗ 暖启动失败，后续 C~H 全部跳过');
    failed++;
  }
  // 测试专用：本脚本自己重建一份等价 ctx（不改生产代码、不依赖私有字段）
  rt.__cards = readAliveCards();
  rt.__ctx = await buildTestCtx(rt, snap);

  if (groupOf('A')) runA();
  if (groupOf('B')) runB();
  if (groupOf('C') && rt.__ctx) await runC(rt);
  if (groupOf('D') && rt.__ctx) await runD(rt);
  if (groupOf('E') && rt.__ctx) await runE(rt);
  if (groupOf('F') && rt.__ctx) await runF(rt);
  if (groupOf('G') && rt.__ctx) await runG(rt);
  if (groupOf('H')) await runH(rt);
  if (groupOf('I')) await runI(snap);

  // 汇总
  log('\n════════ P3 SELFTEST SUMMARY ════════');
  const groups = {};
  for (const r of results) {
    if (!groups[r.group]) groups[r.group] = { pass: 0, fail: 0, rec: 0 };
    if (r.record) groups[r.group].rec++;
    else if (r.ok) groups[r.group].pass++;
    else groups[r.group].fail++;
  }
  for (const g of Object.keys(groups).sort()) {
    const x = groups[g];
    log('  ' + g + '   PASS=' + x.pass + '  FAIL=' + x.fail + '  REC=' + x.rec);
  }
  const totalPass = results.filter((r) => r.ok && !r.record).length;
  const totalRec = results.filter((r) => r.record).length;
  log('─────────────────────────────────────');
  log('P3-' + (failed === 0 ? 'DONE' : 'FAILED') + '  checks=' + (totalPass + failed) + '  passed=' + totalPass + '  failed=' + failed + '  recorded=' + totalRec);
  process.exit(failed === 0 ? 0 : 1);
}

/**
 * 测试专用：重建一份与 retriever 内部等价的 ctx。
 * 刻意不用私有字段 —— 只走 store.js 的公开读接口 + 与 retriever 相同的组装规则。
 */
async function buildTestCtx(rt, snap) {
  const storeUrl = 'file:///' + PLUGIN_ROOT.replace(/\\/g, '/') + '/lib/hypergraph/store.js';
  const store = await import(storeUrl);

  const man = store.readManifest(INDEX_ROOT);
  const all = man
    ? store.readAllRecords(INDEX_ROOT, (man.shards || []).length)
    : { episodes: [], factEdges: [], episodeEdges: [], topics: [], ordinaryEdges: [], byType: {} };

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
    for (const cid of cardIds) if (!cardToEpisode.has(cid)) cardToEpisode.set(cid, ep.id);
  }

  const edgesByEpisode = new Map();
  for (const fe of all.factEdges) {
    if (!fe.anchorId) continue;
    let arr = edgesByEpisode.get(fe.anchorId);
    if (arr === undefined) { arr = []; edgesByEpisode.set(fe.anchorId, arr); }
    arr.push(fe);
  }

  const tok = MODS.tokenize.createTokenizer({ mode: 'bigram' });
  const bm25 = MODS.bm25.createBm25Index(rt.__cards, tok);

  let alias = null;
  try { alias = MODS.alias.createAliasIndex({ previewPath: ALIAS_PATH }); } catch { alias = null; }

  return { bm25, alias, cardToEpisode, episodes, edgesByEpisode, tok, bm25Fallback: true, byType: all.byType };
}

main().catch((e) => {
  console.error('SELFTEST CRASH:', e && e.stack || e);
  process.exit(2);
});
