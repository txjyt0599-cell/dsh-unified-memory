#!/usr/bin/env node
/**
 * scripts/bench-p8.mjs —— 期8 对抗基准（白队钦定的 Case 1 / Case 2 / Case 3）
 * [2026-10-23 by Assistant]
 *
 * 白队原话：
 *   「别急着往库里灌数据，先去跑 Case 1（跨环境假性推翻）和 Case 2（多轮拉锯战）。
 *     跑完拿 Trace 日志来，我们看数据说话。」
 *
 * 本脚本只读 + 内存演算，不写任何生产数据（除 --write 显式指定）。
 */
import {
  judgeConflict, filterEngrams, detectQueryScopes,
  inferSourceWeight, normalizeEngramV2, STATUS, SOURCE_WEIGHTS,
} from '../lib/ingest/belief.js';
import { createConsolidation } from '../lib/ingest/consolidate.js';
// [2026-10-23 by Assistant · 期8.3] 代数隐式超图（Case 3 主体）
import {
  buildIncidence, computeDynamicThreshold, expandOneHop, graphStats,
  MAX_EDGE_ABS, ALPHA,
} from '../lib/ingest/graph.js';
import { createBm25Index, searchBm25 } from '../lib/retrieval/bm25.js';
import { createTokenizer } from '../lib/retrieval/tokenize.js';

const results = [];
let fail = 0;

function check(group, name, ok, detail) {
  results.push({ group, name, ok: !!ok, detail });
  if (!ok) fail++;
  console.log((ok ? '  PASS ' : '  FAIL ') + name + (detail !== undefined && detail !== '' ? '   ' + detail : ''));
}

// ═══════════════════════════════════════════════════════════════
// Case 1 · 跨环境条件分裂（检验 scope_tags 与假性推翻）
//
// 白队判据：
//   ① 问「MTP 能用吗」⇒ 必须同时召回 A 和 B，各带环境前缀
//   ② A 绝不能标 refuted
//   ③ 问「Arch 下 MTP 怎样」⇒ A 权重衰减到 0
// ═══════════════════════════════════════════════════════════════
console.log('\n═══ Case 1 · 跨环境条件分裂 ═══');
{
  const T = 1792667400000;

  // 动作 1：周一 Ubuntu 测 MTP 正常
  const egA = normalizeEngramV2({
    id: 'egA',
    claim: 'MTP 可用',
    scope_tags: ['ubuntu'],
    confidence: inferSourceWeight({ role: 'user', text: '周一在 Ubuntu 下测过 MTP，运行正常。' }),
    createdAt: T,
    updatedAt: T,
  });

  // 动作 2：周三 Arch 测 MTP 直接 OOM
  const egB = normalizeEngramV2({
    id: 'egB',
    claim: 'MTP 不兼容',
    scope_tags: ['arch'],
    confidence: inferSourceWeight({ role: 'user', text: '周三在 Arch 下测 MTP 直接 OOM 报错。' }),
    createdAt: T + 2 * 86400000,
    updatedAt: T + 2 * 86400000,
  });

  const verdict = judgeConflict(egB, egA);
  check('Case1', 'C1-1 环境不同 ⇒ 判决为 fork（而非 refute）',
    verdict.action === 'fork', 'action=' + verdict.action + ' reason=' + verdict.reason);
  check('Case1', 'C1-2 A 不被标 refuted', verdict.oldStatus !== STATUS.REFUTED, 'oldStatus=' + verdict.oldStatus);
  check('Case1', 'C1-3 双方均为 scoped_active',
    verdict.newStatus === STATUS.SCOPED_ACTIVE && verdict.oldStatus === STATUS.SCOPED_ACTIVE);

  // 应用判决
  egA.status = verdict.oldStatus;
  egB.status = verdict.newStatus;
  const pool = [egA, egB];

  // 动作 3：问「MTP 能用吗」（未指定环境）
  const scopes1 = detectQueryScopes('MTP 能用吗');
  const got1 = filterEngrams(pool, { mode: 'default', scopes: scopes1 });
  check('Case1', 'C1-4 不指定环境 ⇒ 双召回 A+B', got1.length === 2, 'n=' + got1.length);
  check('Case1', 'C1-5 召回项各带环境前缀',
    got1.every((x) => Array.isArray(x.scope_tags) && x.scope_tags.length > 0),
    JSON.stringify(got1.map((x) => x.scope_tags)));

  // 动作 4：问「Arch 下 MTP 怎样」
  const scopes2 = detectQueryScopes('Arch 下 MTP 怎样');
  const got2 = filterEngrams(pool, { mode: 'default', scopes: scopes2 });
  const hasA = got2.some((x) => x.id === 'egA');
  const hasB = got2.some((x) => x.id === 'egB');
  check('Case1', 'C1-6 指定 Arch ⇒ 只出 B', hasB && !hasA, 'ids=' + JSON.stringify(got2.map((x) => x.id)));
  check('Case1', 'C1-7 环境识别正确', scopes2.includes('arch'), JSON.stringify(scopes2));
}

// ═══════════════════════════════════════════════════════════════
// Case 2 · 多轮拉锯与冷却期（检验 Consolidation Window）
//
// 白队判据：
//   ① Session 未结束时，只有旧 Engram 生效，新结论在 tentative_override
//   ② 归档时只写入一条最终态「废弃 A 方案」
//   ③ 中间两次反复写进 trace
//   ④ 检索不出现「救」与「废弃」震荡
// ═══════════════════════════════════════════════════════════════
console.log('\n═══ Case 2 · 多轮拉锯与冷却期 ═══');
{
  let clock = 1792667400000;
  const now = () => clock;
  const committed = [];
  const cons = createConsolidation({ now, idleMs: 30 * 60 * 1000, onCommit: (e) => committed.push(e) });

  const SID = 'session-case2';
  const KEY = 'A方案';

  // 动作 1：放弃 A 方案
  cons.stage(SID, { engram_key: KEY, title: '放弃 A 方案', claim: '放弃 A 方案', confidence: 0.6, scope_tags: ['global'] });
  check('Case2', 'C2-1 暂存后落盘数为 0', committed.length === 0, 'committed=' + committed.length);

  // 动作 2：+3 轮，打个补丁还能救
  clock += 3 * 60000;
  cons.stage(SID, { engram_key: KEY, title: 'A 方案打补丁可用', claim: 'A 方案打补丁还能救', confidence: 0.6, scope_tags: ['global'] });

  // 动作 3：+5 轮，彻底废弃
  clock += 5 * 60000;
  cons.stage(SID, { engram_key: KEY, title: '彻底废弃 A 方案', claim: '彻底废弃 A 方案', confidence: 0.6, scope_tags: ['global'] });

  check('Case2', 'C2-2 三次横跳期间落盘仍为 0', committed.length === 0, 'committed=' + committed.length);
  check('Case2', 'C2-3 pending 只有 1 个 key（覆盖生效）', cons.pendingCount(SID) === 1,
    'pending=' + cons.pendingCount(SID));

  // 动作 4：归档
  const arch = cons.archive(SID, { reason: 'manual' });
  check('Case2', 'C2-4 归档只写 1 条最终态', arch.committed === 1, 'committed=' + arch.committed);
  const finalE = committed[0];
  check('Case2', 'C2-5 最终态是「彻底废弃」', /彻底废弃/.test(String(finalE && finalE.claim || '')), String(finalE && finalE.claim || ''));
  check('Case2', 'C2-6 trace 记录了中间的「放弃」和「救」',
    /放弃/.test(String(finalE.trace || '')) && /救/.test(String(finalE.trace || '')),
    JSON.stringify(String(finalE.trace || '')));
  check('Case2', 'C2-7 落盘后 is_tentative=false', finalE.is_tentative === false);
  check('Case2', 'C2-8 不再有 pending', cons.pendingCount(SID) === 0);

  // 动作 5：检索不震荡 —— 池里只有一条终态，不存在「救」与「废弃」并存
  const pool = filterEngrams(committed.concat([]), { mode: 'default', scopes: [] });
  const conflicting = pool.filter((e) => /救/.test(String(e.claim || '')));
  check('Case2', 'C2-9 检索池无「救」这条并存结论', conflicting.length === 0, 'n=' + conflicting.length);

  // 追加：闲置超时自动归档
  const clock2 = clock + 31 * 60000;
  const cons2 = createConsolidation({ now: () => clock2, idleMs: 30 * 60 * 1000, onCommit: () => {} });
  check('Case2', 'C2-10 闲置阈值是 30 分钟（不是 5 分钟）', cons2.snapshot().idleMs === 30 * 60 * 1000,
    'idleMs=' + cons2.snapshot().idleMs);
}

// ═══════════════════════════════════════════════════════════════
// Case 3 · 反向干扰与度惩罚（期8.3 完整二部图实装）
//
// 白队判据（DESIGN §七 Case 3 逐字）：
//   ① 注入 100 条含「Windows」「显卡」的无关长文本
//   ② 注入 1 条「ROCm 编译报错解决方案」
//   ③ 问「Windows 显卡编译报错怎么办」⇒ D_v^{-1} 压死 windows/显卡，ROCm 排 top1
// ═══════════════════════════════════════════════════════════════
console.log('\n═══ Case 3 · 反向干扰与度惩罚（8.3 完整二部图）═══');

/** 构造 Case 3 数据集：100 条噪声 + 1 条精准事实 */
function buildCase3Facts() {
  const facts = [];
  for (let i = 0; i < 100; i++) {
    facts.push({
      id: 'noise' + i,
      title: 'Windows 显卡驱动笔记 ' + i,
      summary: 'Windows 下的显卡驱动维护记录',
      content: '在 Windows 系统上更新显卡驱动，显卡控制面板设置，显示器色彩校准，'
        + '显卡温度监控，DirectX 版本检查，Windows 更新补丁，显卡风扇转速调节，'
        + '多显示器扩展桌面配置，显卡功耗限制与性能模式切换。记录编号 ' + i + '。',
      entities: ['windows', '显卡'],
    });
  }
  facts.push({
    id: 'rocm1',
    title: 'ROCm 编译报错处理',
    summary: 'ROCm 编译报错需限制并发数',
    content: 'ROCm 编译报错，需设置 MAX_JOBS=2 避免显存溢出。',
    entities: ['rocm', '编译报错', '显存'],
  });
  return facts;
}

const C3_QUERY = 'Windows 显卡编译报错怎么办';
const c3Facts = buildCase3Facts();

// ── ① 建关联 + 统计（真实耗时，hrtime 纳秒级）─────────────────────
const tBuild0 = process.hrtime.bigint();
const c3Inc = buildIncidence(c3Facts);
const tBuild1 = process.hrtime.bigint();
const c3Threshold = computeDynamicThreshold(c3Inc.entityToFacts);
const tBuild2 = process.hrtime.bigint();
const c3Stats = graphStats(c3Inc);

const msBuild = Number(tBuild1 - tBuild0) / 1e6;
const msThreshold = Number(tBuild2 - tBuild1) / 1e6;

console.log('  · 规模: facts=' + c3Stats.facts + '  entities=' + c3Stats.entities
  + '  edges=' + c3Stats.edges + '  maxDeg=' + c3Stats.maxDeg
  + '  P99Deg=' + c3Stats.p99Deg + '  threshold=' + c3Stats.threshold);
console.log('  · 内存估算: ' + c3Stats.edges + ' 边 × 16B(2 指针) ≈ '
  + (c3Stats.edges * 16 / 1024).toFixed(1) + ' KB');
console.log('  · buildIncidence: ' + msBuild.toFixed(4) + ' ms'
  + '   computeDynamicThreshold: ' + msThreshold.toFixed(4) + ' ms');

check('Case3', 'C3-1 关联矩阵规模正确（101 事实 / 5 实体 / 203 边）',
  c3Stats.facts === 101 && c3Stats.entities === 5 && c3Stats.edges === 203,
  JSON.stringify(c3Stats));
check('Case3', 'C3-2 实体小写归一生效（Windows → windows）',
  c3Inc.entityToFacts.has('windows') && !c3Inc.entityToFacts.has('Windows'),
  'keys=' + JSON.stringify(Array.from(c3Inc.entityToFacts.keys())));
check('Case3', 'C3-3 动态阈值 = max(100, P99)',
  c3Threshold === Math.max(MAX_EDGE_ABS, c3Stats.p99Deg) && c3Threshold === 100,
  'threshold=' + c3Threshold + ' p99=' + c3Stats.p99Deg);
check('Case3', 'C3-4 高频实体 deg=100（windows / 显卡）',
  c3Inc.entityToFacts.get('windows').size === 100 && c3Inc.entityToFacts.get('显卡').size === 100,
  'windows=' + c3Inc.entityToFacts.get('windows').size + ' 显卡=' + c3Inc.entityToFacts.get('显卡').size);
check('Case3', 'C3-5 低频实体 deg=1（rocm / 编译报错 / 显存）',
  c3Inc.entityToFacts.get('rocm').size === 1 && c3Inc.entityToFacts.get('编译报错').size === 1,
  'rocm=' + c3Inc.entityToFacts.get('rocm').size);

// ── ② 主断言：ROCm 必须 top1 ────────────────────────────────────
const c3Tok = createTokenizer({ mode: 'bigram' });
const c3Bm = createBm25Index(c3Facts, c3Tok);
const c3Rows = searchBm25(c3Bm, C3_QUERY, 24);
const c3Seeds = c3Rows.map((r) => ({ id: r[0], score: r[1] }));

const tExp0 = process.hrtime.bigint();
const c3Exp = expandOneHop(c3Seeds, c3Inc, { threshold: c3Threshold });
const tExp1 = process.hrtime.bigint();
const msExpand = Number(tExp1 - tExp0) / 1e6;
const msTotal = msBuild + msThreshold + msExpand;

console.log('  · expandOneHop: ' + msExpand.toFixed(4) + ' ms   '
  + '合计(build+threshold+expand): ' + msTotal.toFixed(4) + ' ms');
console.log('  · BM25 top3: ' + c3Rows.slice(0, 3).map((r) => r[0] + ':' + Number(r[1]).toFixed(2)).join(' | '));
console.log('  · 扩散 top3: ' + c3Exp.slice(0, 3).map((e) => e.id + ':' + e.score.toFixed(3)).join(' | '));

const c3Rank = c3Exp.findIndex((e) => e.id === 'rocm1');
check('Case3', 'C3-6 ★ROCm 精准事实排在 top1', c3Rank === 0,
  'rank=' + c3Rank + ' top1=' + (c3Exp[0] && c3Exp[0].id) + ' score=' + (c3Exp[0] && c3Exp[0].score.toFixed(3)));

// 度惩罚的直接证据：windows/显卡 的单次贡献被压到 1/100
const c3ExpStats = c3Exp.stats || {};
console.log('  · 扩散统计: ' + JSON.stringify(c3ExpStats));

// ── ③ 反例（对照实验）：关掉度惩罚后是否还能区分 ──────────────────
// 这条不是"通过/失败"，是**实测记录**：用来证明本基准到底有没有区分度。
// Assistant的原则：不许拿一个平凡通过的断言冒充能力验证。
function expandWithoutPenalty(seeds, incidence, alpha) {
  const boost = new Map();
  const seedScore = new Map(seeds.map((s) => [String(s.id), Number(s.score) || 0]));
  for (const s of seeds) {
    const ents = incidence.factToEntities.get(String(s.id)) || [];
    for (const ent of ents) {
      const bucket = incidence.entityToFacts.get(ent);
      if (!bucket) continue;
      for (const fid of bucket) {          // 无 1/deg，且无超级节点截断
        if (fid === String(s.id)) continue;
        boost.set(fid, (boost.get(fid) || 0) + (Number(s.score) || 0));
      }
    }
  }
  let mx = 0; for (const v of boost.values()) if (v > mx) mx = v;
  const out = [];
  for (const e of boost) {
    const base = seedScore.has(e[0]) ? seedScore.get(e[0]) : 0;
    out.push({ id: e[0], score: alpha * base + (1 - alpha) * (e[1] / (mx || 1)) });
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}
const c3Bad = expandWithoutPenalty(c3Seeds, c3Inc, ALPHA);
const c3BadRank = c3Bad.findIndex((e) => e.id === 'rocm1');
console.log('  · [对照] 关掉度惩罚后 ROCm rank=' + c3BadRank
  + '（若同样=0，说明本数据集下 BM25 的 IDF 已单独完成任务，'
  + '度惩罚未被真正检验 —— 见下方 C3-7 的纯图对照实验）');

// ── ④ 纯图对照实验：剥离 BM25，单独检验 D_v^{-1} ────────────────
// 上面主断言之所以平凡，是因为 BM25 的 IDF 与度惩罚在数学上同源（都是逆文档频率）。
// 要真正检验 D_v^{-1}，必须让候选的**原始分完全相同**，只靠图结构分胜负。
{
  const g = [];
  g.push({ id: 'S', entities: ['rocm', 'windows'] });      // 种子
  g.push({ id: 'XviaLowDeg', entities: ['rocm'] });         // 经低频实体 rocm(deg=2) 到达
  g.push({ id: 'YviaHighDeg', entities: ['windows'] });     // 经高频实体 windows 到达
  for (let i = 0; i < 100; i++) g.push({ id: 'gw' + i, entities: ['windows'] });
  const inc2 = buildIncidence(g);
  const th2 = computeDynamicThreshold(inc2.entityToFacts);
  // 种子给相同分 ⇒ 排除原始分干扰
  const ex2 = expandOneHop([{ id: 'S', score: 1 }], inc2, { threshold: th2, alpha: 0 });
  const bx = ex2.find((e) => e.id === 'XviaLowDeg');
  const by = ex2.find((e) => e.id === 'YviaHighDeg');
  const degLow = inc2.entityToFacts.get('rocm').size;
  const degHigh = inc2.entityToFacts.get('windows').size;
  console.log('  · [纯图对照] deg(rocm)=' + degLow + '  deg(windows)=' + degHigh
    + '  boost(X)=' + (bx ? bx.boost.toFixed(4) : 'NA')
    + '  boost(Y)=' + (by ? by.boost.toFixed(4) : 'NA'));
  check('Case3', 'C3-7 ★度惩罚：低频实体路径得分 >> 高频实体路径（' + degHigh + ' 倍量级）',
    !!bx && !!by && bx.boost > by.boost * 10,
    'X=' + (bx ? bx.boost.toFixed(4) : 'NA') + ' Y=' + (by ? by.boost.toFixed(4) : 'NA')
    + ' ratio=' + (bx && by ? (bx.boost / by.boost).toFixed(1) : 'NA'));
}

// ── ⑤ 超级节点截断 ─────────────────────────────────────────────
//
// [2026-10-23 by Assistant · 期8.3 实跑抓到的**测试夹具缺陷**，不是实现缺陷]
//
//   原夹具只有 2 个实体（normal / super），度分别为 2 和 202。
//   于是 computeDynamicThreshold 的 P99 计算退化：
//     n = 2 ⇒ idx = ceil(0.99*2)-1 = 1 ⇒ P99 = degs[1] = 202 = **最大度**
//     threshold = max(100, 202) = 202
//     判定式 deg > threshold ⇒ 202 > 202 = **false** ⇒ 永远不跳过
//
//   这不是 graph.js 的 bug：白队 §9.2 定的判据就是 max(100, P99)，而 P99 在
//   **实体词汇量 < 100** 时必然退化为最大度（ceil(0.99n)-1 == n-1 对一切 n<=100 成立）。
//   小规模库本该靠 MAX_EDGE_ABS=100 这个绝对下界兜底 —— 但原夹具的 P99(202) 反而
//   把下界顶了上去，于是下界失效。真实库（生产实测 28030 实体，P99=24）不会这样。
//
//   修法：**修夹具，不改判据**。补 150 个 deg=1 的填充实体，让实体词汇量 >100，
//   P99 回到它本来的位置（=2），threshold 落回 max(100,2)=100，
//   绝对下界重新成为生效的那一项 —— 这与生产的真实情形一致。
//
//   同时补一条 C3-8b，**把这个退化行为钉成显式事实**（而不是让它悄悄消失）：
//   小词汇量下 P99 退化成最大度，导致超级节点判定失效。这是已知边界。
{
  const g = [];
  g.push({ id: 'S2', entities: ['normal', 'super'] });
  g.push({ id: 'ReachNormal', entities: ['normal'] });
  g.push({ id: 'ReachSuper', entities: ['super'] });
  for (let i = 0; i < 200; i++) g.push({ id: 'gs' + i, entities: ['super'] });   // deg(super) = 202
  // ★ 填充实体：让实体词汇量 >100，P99 不再退化为最大度
  for (let i = 0; i < 150; i++) g.push({ id: 'fill' + i, entities: ['f' + i] }); // 各 deg=1
  const inc3 = buildIncidence(g);
  const st3 = graphStats(inc3);
  const th3 = computeDynamicThreshold(inc3.entityToFacts);
  const ex3 = expandOneHop([{ id: 'S2', score: 1 }], inc3, { threshold: th3, alpha: 0 });
  const hasNormal = ex3.some((e) => e.id === 'ReachNormal');
  const hasSuper = ex3.some((e) => e.id === 'ReachSuper');
  console.log('  · [超级节点] 实体数=' + st3.entities + ' P99Deg=' + st3.p99Deg
    + ' threshold=' + th3 + ' deg(super)=' + inc3.entityToFacts.get('super').size);
  check('Case3', 'C3-8 deg>threshold 的实体整条跳过（超级节点不发散）',
    hasNormal === true && hasSuper === false,
    'ReachNormal=' + hasNormal + ' ReachSuper=' + hasSuper
    + ' deg(super)=' + inc3.entityToFacts.get('super').size + ' threshold=' + th3);
  check('Case3', 'C3-9 graphStats 正确报出超级节点数', st3.superNodes >= 1,
    'superNodes=' + st3.superNodes + ' maxDeg=' + st3.maxDeg);

  // C3-8b：把「小词汇量 ⇒ P99 退化」这条边界钉成显式事实
  const small = [
    { id: 'A', entities: ['x', 'y'] },
    { id: 'B', entities: ['x'] },
    { id: 'C', entities: ['y'] },
  ];
  for (let i = 0; i < 300; i++) small.push({ id: 'n' + i, entities: ['y'] });  // deg(y)=301
  const incS = buildIncidence(small);
  const stS = graphStats(incS);
  const thS = computeDynamicThreshold(incS.entityToFacts);
  check('Case3', 'C3-8b ★已知边界：实体词汇量<100 时 P99 退化为最大度（超级节点判定失效）',
    stS.entities < 100 && thS === stS.maxDeg && stS.superNodes === 0,
    'entities=' + stS.entities + ' P99Deg=' + stS.p99Deg + ' maxDeg=' + stS.maxDeg
    + ' threshold=' + thS + ' superNodes=' + stS.superNodes);
}

// ── ⑥ 去重：同一 fact 多路径只累加 boost，不重复输出 ──────────────
{
  const g = [
    { id: 'S3', entities: ['e1', 'e2'] },
    { id: 'T', entities: ['e1', 'e2'] },     // 两条路径都指向 T
  ];
  const inc4 = buildIncidence(g);
  const ex4 = expandOneHop([{ id: 'S3', score: 1 }], inc4, { threshold: 100, alpha: 0 });
  const tCount = ex4.filter((e) => e.id === 'T').length;
  // deg(e1)=2, deg(e2)=2 ⇒ boost = 0.5 + 0.5 = 1.0
  const tBoost = (ex4.find((e) => e.id === 'T') || {}).boost;
  check('Case3', 'C3-10 多路径命中同一事实：只输出 1 条', tCount === 1, 'count=' + tCount);
  check('Case3', 'C3-11 多路径命中同一事实：boost 累加（0.5+0.5=1.0）',
    Math.abs((tBoost || 0) - 1.0) < 1e-9, 'boost=' + tBoost);
}

// ── ⑦ 性能闸门 ────────────────────────────────────────────────
check('Case3', 'C3-12 ★性能：buildIncidence + threshold + expandOneHop 总耗时 < 2ms',
  msTotal < 2, 'total=' + msTotal.toFixed(4) + 'ms (build=' + msBuild.toFixed(4)
  + ' threshold=' + msThreshold.toFixed(4) + ' expand=' + msExpand.toFixed(4) + ')');

// ── ⑧ 10k 实体级合成压测（如实报告，不做断言门槛）────────────────
{
  const big = [];
  // 10000 事实 × 平均 4 实体 = 40k 边（DESIGN §5.2 的规模口径）
  for (let i = 0; i < 10000; i++) {
    big.push({ id: 'b' + i, entities: ['e' + (i % 10000), 'e' + ((i * 7) % 10000), 'e' + ((i * 13) % 10000), 'e' + ((i * 29) % 10000)] });
  }
  const tb0 = process.hrtime.bigint();
  const incBig = buildIncidence(big);
  const tb1 = process.hrtime.bigint();
  const thBig = computeDynamicThreshold(incBig.entityToFacts);
  const tb2 = process.hrtime.bigint();
  const seedsBig = [];
  for (let i = 0; i < 30; i++) seedsBig.push({ id: 'b' + i, score: 10 });
  const exBig = expandOneHop(seedsBig, incBig, { threshold: thBig });
  const tb3 = process.hrtime.bigint();
  const stBig = graphStats(incBig);
  const msBigBuild = Number(tb1 - tb0) / 1e6;
  const msBigTh = Number(tb2 - tb1) / 1e6;
  const msBigExp = Number(tb3 - tb2) / 1e6;
  console.log('  · [10k 压测] facts=' + stBig.facts + ' entities=' + stBig.entities
    + ' edges=' + stBig.edges + ' threshold=' + stBig.threshold);
  console.log('  · [10k 压测] build=' + msBigBuild.toFixed(2) + 'ms threshold=' + msBigTh.toFixed(2)
    + 'ms expand=' + msBigExp.toFixed(2) + 'ms 合计=' + (msBigBuild + msBigTh + msBigExp).toFixed(2) + 'ms'
    + '  候选=' + (exBig.stats ? exBig.stats.candidates : 'NA'));
  check('Case3', 'C3-13 10k 级建索引耗时 < 200ms（如实记录，非 2ms 闸门）',
    msBigBuild < 200, 'build=' + msBigBuild.toFixed(2) + 'ms');
}

// ═══════════════════════════════════════════════════════════════
// 附加 · 来源赋权与存量降级
// ═══════════════════════════════════════════════════════════════
console.log('\n═══ 附加 · 来源赋权与存量迁移 ═══');
{
  check('Extra', 'E1 显式纠正 = 1.0',
    inferSourceWeight({ role: 'user', text: '不对，应该是 MAX_JOBS=2' }) === SOURCE_WEIGHTS.user_correction);
  check('Extra', 'E2 实测报错 = 0.9',
    inferSourceWeight({ toolError: true, text: 'error: hipErrorOutOfMemory' }) === SOURCE_WEIGHTS.user_observed);
  check('Extra', 'E3 推测 = 0.4',
    inferSourceWeight({ role: 'user', text: '可能是显存不够吧' }) === SOURCE_WEIGHTS.user_speculation);
  check('Extra', 'E4 模型推断 = 0.2',
    inferSourceWeight({ role: 'assistant', text: '我建议这样处理。' }) === SOURCE_WEIGHTS.model_inference);

  const legacy = normalizeEngramV2({ id: 'old1', kind: 'fact', title: '期7 老卡', summary: '没有 status 字段' });
  check('Extra', 'E5 老卡迁移 status=active', legacy.status === STATUS.ACTIVE, 'status=' + legacy.status);
  check('Extra', 'E6 老卡迁移 scope=[global]', JSON.stringify(legacy.scope_tags) === '["global"]', JSON.stringify(legacy.scope_tags));
  check('Extra', 'E7 老卡迁移 confidence=0.5', legacy.confidence === 0.5, 'confidence=' + legacy.confidence);
  check('Extra', 'E8 老卡迁移 is_tentative=false', legacy.is_tentative === false);
  check('Extra', 'E9 老卡打上 _migratedLegacy 标记', legacy._migratedLegacy === true);
}

// ── 汇总 ──
const total = results.length;
const passed = total - fail;
console.log('\n' + '═'.repeat(52));
console.log('P8-BENCH-DONE  checks=' + total + '  passed=' + passed + '  failed=' + fail);
console.log('═'.repeat(52));
if (fail > 0) {
  console.log('\n失败项：');
  for (const r of results) if (!r.ok) console.log('  · [' + r.group + '] ' + r.name + '   ' + r.detail);
}
process.exitCode = fail === 0 ? 0 : 1;
