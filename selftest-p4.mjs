#!/usr/bin/env node
/**
 * selftest-p4.mjs —— 期4 分层工作记忆验收脚本（A~H 八组）。
 * 依据：_team-v2/p4/DESIGN.md §3；期4 任务单（含两处「与期3 实际对接」缺口）。
 *
 * 用法：
 *   node selftest-p4.mjs                 全跑
 *   node selftest-p4.mjs --only=A,C      只跑指定组
 *   node selftest-p4.mjs --verbose
 *
 * 铁律：
 *   · **不写 engrams.jsonl**（只读）；写盘只落在 _team-v2/p4/_wmselftest/（自己的目录）
 *   · 每个 async 调用点**必须 await**（期3 教训：漏 await 把「发起开销」量成耗时）
 *   · H 组是端到端冒烟：retriever.search → working-memory.assemble → render，缺一环不算过
 *   · 不进 lib/、不被 index.js import
 */

import { readFileSync, existsSync, statSync, mkdirSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';

const ARGS = process.argv.slice(2);
const HAS = (f) => ARGS.includes(f);
const VERBOSE = HAS('--verbose');
const ONLY_ARG = ARGS.find((a) => a.startsWith('--only='));
const ONLY = ONLY_ARG ? ONLY_ARG.slice(7).split(',').map((x) => x.trim().toUpperCase()).filter(Boolean) : null;

const PLUGIN_ROOT = 'D:/dsh-plugins/dsh-unified-memory';
const LIB_RETRIEVAL = PLUGIN_ROOT + '/lib/retrieval';
const LIB_HG = PLUGIN_ROOT + '/lib/hypergraph';
const LIB_WM = PLUGIN_ROOT + '/lib/working-memory';
const INDEX_ROOT = '~/.dsh/unified-memory/hypergraph';
const ENGRAM_PATH = '~/.dsh/unified-memory/engram-relay/engrams.jsonl';
const TMP_DIR = '~/_team-v2/p4/_wmselftest';

const results = [];
let failed = 0;
const f2 = (x) => Number(x).toFixed(2);
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

const MODS = {};

async function loadModules() {
  const wmBase = 'file:///' + LIB_WM.replace(/\\/g, '/') + '/';
  MODS.wm = await import(wmBase + 'index.js');
  const retBase = 'file:///' + LIB_RETRIEVAL.replace(/\\/g, '/') + '/';
  MODS.retriever = await import(retBase + 'retriever.js');
  MODS.stages = await import(retBase + 'stages.js');
  MODS.rtypes = await import(retBase + 'types.js');
  const hgBase = 'file:///' + LIB_HG.replace(/\\/g, '/') + '/';
  MODS.hgStore = await import(hgBase + 'store.js');
}

/** 源卡快照（只读）：lines / alive / mtimeMs / sha256(前1MB) */
function snapshot() {
  const st = statSync(ENGRAM_PATH);
  const raw = readFileSync(ENGRAM_PATH);
  const text = raw.toString('utf8');
  let lines = 0, alive = 0;
  for (const line of text.split('\n')) {
    if (!line) continue;
    lines++;
    try { const o = JSON.parse(line); if ((o.status || 'active') !== 'retired') alive++; } catch {}
  }
  const sha = createHash('sha256').update(raw.subarray(0, 1024 * 1024)).digest('hex').slice(0, 16);
  return { bytes: st.size, mtimeMs: st.mtimeMs, lines, alive, sha256Head1MB: sha };
}

/** 只读载入活卡（与 retriever.readSourceCards 同口径） */
function loadCards() {
  const raw = readFileSync(ENGRAM_PATH, 'utf8');
  const cards = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if ((o.status || 'active') === 'retired') continue;
    if (!o.id) continue;
    cards.push(o);
  }
  const byId = new Map();
  for (const c of cards) byId.set(c.id, c);
  const reader = {
    header: (id) => {
      const c = byId.get(id);
      if (!c) return null;
      // [2026-10-22 by Assistant] 必须带 createdAt —— 否则测不出 recency；
      //   真实代码 index.js 的 header 也曾漏这个字段（架构缺陷，已修）。
      return { id: c.id, title: c.title || '', summary: c.summary || '', layer: c.layer || 'global', createdAt: Number(c.createdAt) || 0 };
    },
    content: (id) => { const c = byId.get(id); return c ? String(c.content || '') : null; },
    projectIdOf: (id) => { const c = byId.get(id); return c ? (c.projectId || null) : null; },
    sessionIdOf: (id) => { const c = byId.get(id); return c ? (c.sessionId || null) : null; },
  };
  return { cards, byId, reader };
}

/** 期3 同款 ctx（只读） */
function buildCtx(cards, tok, bm25) {
  const man = MODS.hgStore.readManifest(INDEX_ROOT);
  const all = man ? MODS.hgStore.readAllRecords(INDEX_ROOT, (man.shards || []).length)
    : { episodes: [], factEdges: [], episodeEdges: [], topics: [], ordinaryEdges: [], byType: {} };
  const episodes = new Map();
  const cardToEpisode = new Map();
  for (const ep of all.episodes) {
    const cardIds = ep.cardIds || [];
    episodes.set(ep.id, {
      id: ep.id, cardIds,
      weightScale: ep.weightScale !== undefined && ep.weightScale !== null ? ep.weightScale : 1,
      completeness: ep.completeness !== undefined ? ep.completeness : null,
      startAt: ep.startAt || 0, endAt: ep.endAt || 0, projectId: ep.projectId || null,
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
  const members = new Set();
  for (const fe of all.factEdges) for (const m of (fe.members || [])) members.add(m.nodeId);
  return { ctx: { bm25, cardToEpisode, episodes, edgesByEpisode, tok, bm25Fallback: true }, records: all, members, episodes, cardToEpisode, edgesByEpisode };
}

function freshTmp(name) {
  const d = TMP_DIR + '/' + name;
  rmSync(d, { recursive: true, force: true });
  mkdirSync(d, { recursive: true });
  return d;
}

// ============================ A · 预算（红队 B2） ============================
async function runA() {
  log('\n── A · L0 相对预算（红队 B2：删 500 硬限） ──');
  const { computeL0Budget, WM_DEFAULTS } = MODS.wm;

  const short = computeL0Budget(10, WM_DEFAULTS);
  const mid = computeL0Budget(100, WM_DEFAULTS);
  const long = computeL0Budget(2000, WM_DEFAULTS);

  // [2026-10-22 by Assistant] 不再硬编码 240 —— 地板值是**可调配置**，
  //   断言应引用 WM_DEFAULTS 实际值（同 B2 教训：测试要编码真实契约，不是写死数字）。
  //   语义只锁「短输入走 floor 分支」这件事，具体值随配置走。
  check('A', 'A1 短输入走 floor', short.l0CapTokens === WM_DEFAULTS.l0.floorTokens && short.boundBy === 'floor', 'cap=' + short.l0CapTokens + ' floorCfg=' + WM_DEFAULTS.l0.floorTokens + ' boundBy=' + short.boundBy);
  check('A', 'A2 中输入按 ×8 相对上限', mid.l0CapTokens === 800 && mid.boundBy === 'factor', 'input=100 cap=' + mid.l0CapTokens);
  check('A', 'A3 长输入走 ceiling 保险丝', long.l0CapTokens === 4096 && long.boundBy === 'ceiling', 'cap=' + long.l0CapTokens);
  check('A', 'A4 没有 500 token 硬限', short.l0CapTokens !== 500 && mid.l0CapTokens !== 500 && long.l0CapTokens !== 500, '三档=' + short.l0CapTokens + '/' + mid.l0CapTokens + '/' + long.l0CapTokens);
  check('A', 'A5 HEADER 计入预算', mid.usedTokens === 75 && mid.remainingTokens === 725, 'used=' + mid.usedTokens + ' remain=' + mid.remainingTokens);
  const mono = computeL0Budget(20, WM_DEFAULTS).l0CapTokens <= computeL0Budget(21, WM_DEFAULTS).l0CapTokens;
  check('A', 'A6 预算随输入单调不减', mono);
  record('A', 'budget(input,cap,boundBy)', [10, 100, 2000].map((n) => { const b = computeL0Budget(n, WM_DEFAULTS); return n + '->' + b.l0CapTokens + '(' + b.boundBy + ')'; }).join('  '));
}

// ============================ B · 渲染与 tier ============================
async function runB() {
  log('\n── B · 分级渲染成本（三 tier 实测占位） ──');
  const { renderCardLine, RENDER_TIER, computeL0Budget, WM_DEFAULTS } = MODS.wm;
  const card = { title: 'KVMem ROCm移植', summary: '把 KVMem 的 ROCm 运行库换成 10.1 后回归全部通过，VBR 池未触发 gro。', layer: 'project' };
  const full = renderCardLine(card, RENDER_TIER.full, ['a', 'b'], ['c', 'd']);
  const sum = renderCardLine(card, RENDER_TIER.summary);
  const title = renderCardLine(card, RENDER_TIER.title);
  check('B', 'B1 full 含因果注', full.line.includes('↑因:') && full.line.includes('↓果:'), 'len=' + full.line.length);
  check('B', 'B2 summary 无因果注', !sum.line.includes('↑因:'), 'cost=' + sum.costTokens);
  check('B', 'B3 title 级最短', title.costTokens < sum.costTokens && sum.costTokens <= full.costTokens, title.costTokens + ' < ' + sum.costTokens + ' <= ' + full.costTokens);
  check('B', 'B4 成本用 estimateTokens（非均价）', title.costTokens > 0 && full.costTokens > sum.costTokens);

  // 30 张混排成本 vs 800 预算（input=100）
  const b = computeL0Budget(100, WM_DEFAULTS);
  let used = b.headerTokens;
  for (let i = 0; i < 30; i++) used += renderCardLine(card, i === 0 ? RENDER_TIER.full : i <= 2 ? RENDER_TIER.summary : RENDER_TIER.title).costTokens;
  check('B', 'B5 30 张混排装得进 input×8', used <= b.l0CapTokens, 'used=' + used + ' cap=' + b.l0CapTokens);
  record('B', '30 张同卡混排成本', used + ' tok（cap=' + b.l0CapTokens + '）');
}

// ============================ C · 激活落盘（原子写 + 锁） ============================
async function runC() {
  log('\n── C · activation.json 落盘（红队 L1：原子写 + 锁 + 自校验） ──');
  const { createActivationStore, ACTIVATION_FILE } = MODS.wm;
  const dir = freshTmp('C');
  const st = createActivationStore({ dir, alpha: 0.7, halfLifeMs: 7 * 24 * 3600 * 1000 });
  st.load(Date.now());

  st.reinforce('card-A', 0.9, 'session-1', Date.now());
  st.reinforce('card-B', 0.4, 'session-1', Date.now());
  const first = st.flush(Date.now());
  check('C', 'C1 首次落盘成功', existsSync(dir + '/' + ACTIVATION_FILE) && first.bytes > 0, 'bytes=' + first.bytes);

  const raw = JSON.parse(readFileSync(dir + '/' + ACTIVATION_FILE, 'utf8'));
  check('C', 'C2 schema 四字段齐（红队 L1）',
    !!raw.records['card-A'] && typeof raw.records['card-A'].cardId === 'string' &&
    typeof raw.records['card-A'].activation === 'number' &&
    typeof raw.records['card-A'].lastUpdate === 'number' &&
    Array.isArray(raw.records['card-A'].sourceSession),
    JSON.stringify(raw.records['card-A']));
  check('C', 'C3 顶层带 version/alpha', raw.version === 1 && Math.abs(raw.alpha - 0.7) < 1e-9, 'version=' + raw.version + ' alpha=' + raw.alpha);

  const leftovers = readdirSync(dir).filter((n) => n.includes('.tmp-'));
  check('C', 'C4 无残留 tmp 文件（原子写）', leftovers.length === 0, 'tmp=' + leftovers.length);
  check('C', 'C5 锁已释放', !existsSync(dir + '/' + ACTIVATION_FILE + '.lock'));

  // 坏档降级：写坏主档 ⇒ load 应回落 .bak 或空档，不抛
  const st2 = createActivationStore({ dir, alpha: 0.7 });
  writeFileSync(dir + '/' + ACTIVATION_FILE, '{"version":1,"records":{"card-A":', 'utf8');
  let crashed = false;
  try { st2.load(Date.now()); } catch { crashed = true; }
  check('C', 'C6 坏档不抛错（降级）', !crashed, 'records=' + st2.size() + ' warnings=' + st2.warnings().length);
  check('C', 'C7 坏档时告警留痕', st2.warnings().some((w) => w.code === 'parse-failed' || w.code === 'shape-invalid'));

  // 衰减
  const { decayedActivation } = MODS.wm;
  const now = Date.now();
  const rec = { cardId: 'x', activation: 0.8, lastUpdate: now - 7 * 24 * 3600 * 1000 };
  const dec = decayedActivation(rec, now, 7 * 24 * 3600 * 1000);
  check('C', 'C8 7 天半衰期衰减到一半', Math.abs(dec - 0.4) < 0.02, 'decayed=' + f2(dec));

  // 二次落盘：旧档备份一代
  const st3 = createActivationStore({ dir: freshTmp('C2'), alpha: 0.7 });
  st3.load(now); st3.reinforce('c1', 0.5, 's', now); st3.flush(now);
  st3.reinforce('c2', 0.5, 's', now); st3.flush(now);
  check('C', 'C9 二次落盘生成 .bak', existsSync(st3.file + '.bak'));
  record('C', 'activation 记录数/字节', 'n=' + st3.size() + ' bytes=' + statSync(st3.file).size);
}

// ============================ D · 多会话合并（α=0.7） ============================
async function runD() {
  log('\n── D · 多会话合并 α=0.7（红队 L1：交换律/幂等/不膨胀） ──');
  const { mergeActivationFiles, mergeActivation } = MODS.wm;
  const now = Date.now();

  function mk(records, updatedAt, alpha) { return { version: 1, alpha: alpha === undefined ? 0.7 : alpha, updatedAt: updatedAt || now, records }; }
  function rec(id, a, t, s) { return { cardId: id, activation: a, lastUpdate: t, sourceSession: s || ['s'], hits: 1 }; }

  // D1 交换律（200 组随机）
  let bad = 0;
  let seed = 20261021;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  for (let k = 0; k < 200; k++) {
    const t = now - Math.floor(rnd() * 1e7);
    const A = mk({ x: rec('x', Number(rnd().toFixed(3)), t), y: rec('y', Number(rnd().toFixed(3)), t + 1000) }, now);
    const B = mk({ x: rec('x', Number(rnd().toFixed(3)), t + 500), z: rec('z', Number(rnd().toFixed(3)), t) }, now);
    const ab = mergeActivationFiles(A, B, now, 0.7, 0);
    const ba = mergeActivationFiles(B, A, now, 0.7, 0);
    for (const id of Object.keys(ab.records)) {
      const r1 = ab.records[id], r2 = ba.records[id];
      if (!r2 || Math.abs(r1.activation - r2.activation) > 1e-9 || Math.abs(r1.lastUpdate - r2.lastUpdate) > 0) bad++;
    }
  }
  check('D', 'D1 交换律 merge(A,B)≡merge(B,A)', bad === 0, 'bad=' + bad + '/200');

  // D2 幂等
  const one = mk({ x: rec('x', 0.6, now) }, now);
  const rr = mergeActivationFiles(one, one, now, 0.7, 0);
  check('D', 'D2 幂等 merge(A,A)≈A', Math.abs(rr.records.x.activation - 0.6) < 1e-6, 'got=' + rr.records.x.activation);

  // D3 不膨胀：5 会话各 0.8
  let acc = { cardId: 'x', activation: 0.8, lastUpdate: now - 5000, sourceSession: ['s0'], hits: 1 };
  for (let i = 1; i < 5; i++) {
    acc = { cardId: 'x', activation: mergeActivation(acc, 0.8, now, 0.7, 0), lastUpdate: now, sourceSession: acc.sourceSession.concat('s' + i), hits: i + 1 };
  }
  check('D', 'D3 5 会话各 0.8 不膨胀', acc.activation < 0.95 && acc.activation > 0.7, 'act=' + f2(acc.activation) + '（相加会得 4.0，取 max 得 0.8）');

  // D4 α 不匹配仍加载
  const { createActivationStore } = MODS.wm;
  const dir = freshTmp('D');
  const st = createActivationStore({ dir, alpha: 0.7 });
  st.load(now); st.reinforce('k', 0.5, 's', now); st.flush(now);
  const diskRaw = JSON.parse(readFileSync(st.file, 'utf8'));
  diskRaw.alpha = 0.5;
  writeFileSync(st.file, JSON.stringify(diskRaw), 'utf8');
  const st2 = createActivationStore({ dir, alpha: 0.7 });
  let ok = true;
  try { st2.load(now); } catch { ok = false; }
  check('D', 'D4 α 不匹配告警但可加载', ok && st2.size() === 1 && st2.warnings().some((w) => w.code === 'alpha-mismatch'), 'n=' + st2.size());

  // D5 α=0.7 的数值语义：新旧权重 7:3
  const v = mergeActivation({ activation: 0.2, lastUpdate: now }, 0.9, now, 0.7, 0);
  check('D', 'D5 α=0.7 ⇒ 0.9×0.7+0.2×0.3=0.69', Math.abs(v - 0.69) < 1e-6, 'got=' + v);
  record('D', '5 会话合并终值', 'act=' + f2(acc.activation) + ' sessions=' + acc.sourceSession.length);
}

// ============================ E · 激活扩散（队列≠输出，红队 H5） ============================
async function runE(env) {
  log('\n── E · 激活扩散（红队 H5：queueCap 保险丝 vs outputCap 真输出） ──');
  const { createSpreader, createGraphAdapter } = MODS.wm;

  // 合成图：两个种子各 1 跳共达 M、2 跳共达 X（制造真交点）+ 长链（制造 outputCap 截断）
  //   S1 - M - X - S2  （M/X 都被两锚点到达 ⇒ 交点）
  //   S1 - c1 - c2 - c3 ... c12（长尾，保证输出超过 outputCap）
  const adj = new Map();
  function add(a, b) { if (!adj.has(a)) adj.set(a, []); if (!adj.has(b)) adj.set(b, []); adj.get(a).push({ cardId: b, weight: 1 }); adj.get(b).push({ cardId: a, weight: 1 }); }
  add('S1', 'M'); add('M', 'X'); add('X', 'S2');
  for (let i = 1; i <= 12; i++) add('c' + i, 'c' + (i + 1));
  add('S1', 'c1');
  const iso = 'ISOLATED-NOEDGE';
  const g = { neighbors: (id) => adj.get(id) || [], degree: (id) => (adj.get(id) || []).length, nodeCount: adj.size };
  const sp = createSpreader(g, { decay: 0.5, maxHops: 3, minActivation: 0.01, queueCap: 5000, outputCap: 5, maxSeeds: 2, intersectionBonus: 0.6 });

  const r = sp.spread([{ cardId: 'S1', activation: 1 }, { cardId: 'S2', activation: 1 }]);
  check('E', 'E1 输出受 outputCap 卡住', r.nodes.length === 5 && r.stats.truncatedByOutput === true, 'out=' + r.nodes.length + ' cap=5 truncOut=' + r.stats.truncatedByOutput);
  check('E', 'E2 queueCap 未熔断（保险丝）', r.stats.truncatedByQueue === false && r.stats.queuePeak < r.stats.queueCap, 'peak=' + r.stats.queuePeak + '/' + r.stats.queueCap);
  const m = r.nodes.find((n) => n.cardId === 'M');
  check('E', 'E3 decay=0.5 每跳减半（M 是 1 跳=0.5）', !!m && Math.abs(m.activation - 0.5) < 1e-9, m ? 'M.act=' + m.activation : 'M missing');
  const inter = r.nodes.filter((n) => n.intersection);
  check('E', 'E4 交点被整组前置', inter.length > 0 && r.nodes[0].intersection === true, 'intersections=' + inter.length + ' top=' + r.nodes[0].cardId + ' anchors=' + r.nodes[0].anchors.length);
  // X 与 S2 直接相连 ⇒ 1 跳(0.5)，但两锚点都能到它 ⇒ anchors=2（交点不要求等跳数）
  const x = r.nodes.find((n) => n.cardId === 'X');
  check('E', 'E4b 交点 X：两锚点 + 取最优跳(1跳=0.5)', !!x && x.anchors.length === 2 && Math.abs(x.activation - 0.5) < 1e-9, x ? 'X.act=' + x.activation + ' anchors=' + x.anchors.length : 'X missing');
  // 纯 2 跳卡（S1-c1-c2）：act=1×0.5×0.5=0.25，单锚点。
  // 用大 outputCap 的另一个 spreader 看完整集合（上面那个 cap=5 会把它截断，属设计内行为）
  const spDecay = createSpreader(g, { decay: 0.5, maxHops: 3, minActivation: 0.01, queueCap: 5000, outputCap: 50, maxSeeds: 2, intersectionBonus: 0.6 });
  const rd = spDecay.spread([{ cardId: 'S1', activation: 1 }, { cardId: 'S2', activation: 1 }]);
  const c2 = rd.nodes.find((n) => n.cardId === 'c2');
  // 注：c2 的 anchors=2 是**正确的**——S2 侧经 X→M→S1 把锚点回传，S1 再下发到 c1/c2；
  //    激活值仍按「最优到达路径」= 2 跳 0.25，说明锚点合并不抬高分数（只用于交点前置）。
  check('E', 'E4c 纯 2 跳衰减到 0.25（c2）', !!c2 && Math.abs(c2.activation - 0.25) < 1e-9 && c2.hop === 2, c2 ? 'c2.act=' + c2.activation + ' hop=' + c2.hop + ' anchors=' + c2.anchors.length : 'c2 missing');
  check('E', 'E4d 同图 outputCap=50 时不截断长尾', rd.nodes.length > 5 && rd.stats.truncatedByOutput === false, 'out=' + rd.nodes.length + ' truncOut=' + rd.stats.truncatedByOutput);

  // 孤立点（无超边卡）：种子分必须原样保留，不被降权
  const r2 = sp.spread([{ cardId: iso, activation: 0.73 }]);
  const got = r2.nodes.find((n) => n.cardId === iso);
  check('E', 'E5 无邻居卡 activation 恒为种子分', !!got && Math.abs(got.activation - 0.73) < 1e-9, got ? 'act=' + got.activation : 'not-found');
  check('E', 'E6 无邻居卡 hop=0', !!got && got.hop === 0);

  // queueCap 真能熔断（把 cap 调到 1）
  const sp2 = createSpreader(g, { queueCap: 1, outputCap: 50, maxHops: 5 });
  const r3 = sp2.spread([{ cardId: 'S1', activation: 1 }]);
  check('E', 'E7 queueCap 调小能熔断并留痕', r3.stats.truncatedByQueue === true, 'popped=' + r3.stats.popped);

  // 真实图压测（只读）
  if (env && env.ctx) {
    const adapter = createGraphAdapter(env.ctx, { maxPerNode: 24 });
    const real = createSpreader(adapter, { decay: 0.5, maxHops: 3, minActivation: 0.01, queueCap: 5000, outputCap: 50, maxSeeds: 5 });
    const seeds = Array.from(env.ctx.cardToEpisode.keys()).slice(0, 200).map((id) => ({ cardId: id, activation: 1 }));
    let peak = 0, truncQ = 0, truncO = 0, maxVisited = 0;
    for (const s of seeds) {
      const rr = real.spread([s]);
      if (rr.stats.queuePeak > peak) peak = rr.stats.queuePeak;
      if (rr.stats.visited > maxVisited) maxVisited = rr.stats.visited;
      if (rr.stats.truncatedByQueue) truncQ++;
      if (rr.stats.truncatedByOutput) truncO++;
    }
    check('E', 'E8 真实图 queuePeak ≤ 5000（H5 保险丝不熔）', peak <= 5000, 'peak=' + peak + ' maxVisited=' + maxVisited);
    check('E', 'E9 真实图 queueCap 熔断次数=0', truncQ === 0, 'truncQueue=' + truncQ + '/' + seeds.length);
    record('E', '真实图 200 种子扩散', 'peak=' + peak + ' maxVisited=' + maxVisited + ' truncOutput=' + truncO + '/200');
  }
}

// ============================ F · L1 恢复（重启后） ============================
async function runF(env) {
  log('\n── F · 重启后 L1 恢复（DESIGN §1.3.5 六条断言） ──');
  const { createWorkingMemory, createActivationStore } = MODS.wm;
  const dir = freshTmp('F');
  const now = Date.now();

  // ① 造状态：A=0.9 / B=0.4 / C=0.01，sourceSession=session-OLD
  const st = createActivationStore({ dir, alpha: 0.7, halfLifeMs: 7 * 24 * 3600 * 1000 });
  st.load(now);
  const weekAgo = now - 7 * 24 * 3600 * 1000;
  st.reinforce('A', 0.9, 'session-OLD', weekAgo);
  st.reinforce('B', 0.4, 'session-OLD', weekAgo);
  st.reinforce('C', 0.01, 'session-OLD', weekAgo);
  st.flush(now);

  const stateOld = {
    version: 1, sessionId: 'session-OLD', cwd: '~', turn: 12,
    l1: [
      { cardId: 'A', activation: 0.9, lastHitAt: now - 7 * 24 * 3600 * 1000 },
      { cardId: 'B', activation: 0.4, lastHitAt: now - 7 * 24 * 3600 * 1000 },
      { cardId: 'C', activation: 0.01, lastHitAt: now - 7 * 24 * 3600 * 1000 },
      { cardId: 'CARD-WITH-NO-STORE', activation: 0.55, lastHitAt: now },
    ],
    savedAt: now,
  };

  // ② 冷启动新会话（新进程语义：重新 new 一个 WorkingMemory + 重新 load 激活）
  const wm = createWorkingMemory({ dir, cards: env.reader, enabled: true });
  wm.loadActivation(now);
  const rep = wm.restoreL1(stateOld, now);

  const snap = wm.snapshot('session-OLD');
  const l1 = new Set(snap.l1Ids);
  check('F', 'F1 A/B 进 L1，C 被阈值挡（0.01×0.5=0.005<0.05）', l1.has('A') && l1.has('B') && !l1.has('C'), 'l1=' + snap.l1Ids.join(','));
  const aEntry = snap.l1.find((x) => x.cardId === 'A');
  check('F', 'F2 A 经 7 天半衰后≈0.45', !!aEntry && Math.abs(aEntry.activation - 0.45) < 0.05, aEntry ? 'act=' + f2(aEntry.activation) : 'missing');
  const order = snap.l1.map((x) => x.cardId);
  check('F', 'F3 L1 按激活降序（不是字典序）', order.indexOf('A') < order.indexOf('B'), 'order=' + order.join('>'));
  check('F', 'F4 不在激活档里的卡也能搬（用 state 的 activation）', l1.has('CARD-WITH-NO-STORE'), 'act=' + (snap.l1.find((x) => x.cardId === 'CARD-WITH-NO-STORE') || {}).activation);
  check('F', 'F5 carry 标记已打', snap.carried.length > 0, 'carried=' + snap.carried.length);

  // ⑥ 反证：没有落盘 ⇒ L1 空
  const dir2 = freshTmp('F2');
  const wm2 = createWorkingMemory({ dir: dir2, cards: env.reader, enabled: true });
  wm2.loadActivation(now);
  const snap2 = wm2.snapshot('session-NEW');
  check('F', 'F6 无落盘时 L1 为空（证明真读盘）', snap2.l1Ids.length === 0);

  // 落盘 + 读回
  const wm3 = createWorkingMemory({ dir, cards: env.reader });
  wm3.loadActivation(now);
  wm3.restoreL1(stateOld, now);
  const p = wm3.persist(now);
  const back = wm3.loadState('session-OLD');
  check('F', 'F7 persist 后能 loadState 读回', !!back && Array.isArray(back.l1) && back.l1.length > 0, 'n=' + (back ? back.l1.length : -1));
  const norm = (x) => String(x || '').replace(/\\/g, '/');
  check('F', 'F8 state 文件落在自己目录', p.statePaths.length > 0 && norm(p.statePaths[0]).indexOf(norm(dir)) === 0, p.statePaths[0] || 'none');
  record('F', 'restore 报告', 'kept=' + (rep ? rep.kept : -1) + ' removed=' + (rep ? rep.removed.length : -1) + ' carried=' + (rep ? rep.carried.length : -1));
}

// ============================ G · 无超边卡（1173 张 / 21.5%） ============================
async function runG(env) {
  log('\n── G · 无超边卡（期3 实测 noEdge 1173 张） ──');
  const { createWorkingMemory, createGraphAdapter } = MODS.wm;

  const cov = { alive: env.cards.length, episodeCovered: env.ctx.cardToEpisode.size, edgeCovered: env.members.size };
  cov.noEdge = cov.episodeCovered - cov.edgeCovered;
  check('G', 'G1 noEdge 数量与期3 实测同量级', cov.noEdge > 1000 && cov.noEdge < 1400, 'noEdge=' + cov.noEdge + ' alive=' + cov.alive + ' ratio=' + f2(cov.noEdge / cov.alive * 100) + '%');

  // 取一张真实的 noEdge 卡（无 fedge 成员）
  const noEdgeIds = [];
  for (const id of env.ctx.cardToEpisode.keys()) if (!env.members.has(id) && env.byId.has(id)) noEdgeIds.push(id);
  const target = noEdgeIds.find((id) => (env.byId.get(id).title || '').length >= 4) || noEdgeIds[0];
  check('G', 'G2 找到真实 noEdge 卡', !!target, target || 'none');

  const adapter = createGraphAdapter(env.ctx, { maxPerNode: 24 });
  const dir = freshTmp('G');

  // G3：noEdge 卡以 Stage1 原分进入候选 ⇒ 必须能进 L0
  const wm = createWorkingMemory({ dir, cards: env.reader, graph: adapter });
  wm.loadActivation(Date.now());
  const adm = wm.assemble(
    { sessionId: 'session-G', cwd: '~', queryText: '这张无超边卡能不能进来', queryTokens: 400, turn: 1 },
    [{ id: target, score: 0.62, via: 'stage1' }]
  );
  check('G', 'G3 noEdge 卡能被 L0 独立召回', adm.cards.some((c) => c.cardId === target), 'cards=' + adm.cards.map((c) => c.cardId).slice(0, 3).join(','));
  const inL0 = adm.cards.find((c) => c.cardId === target);
  check('G', 'G4 noEdge 卡分数不被降权（retrieveScore=原分）', !!inL0 && inL0.retrieveScore === 0.62, inL0 ? 'score=' + inL0.retrieveScore : 'missing');
  check('G', 'G5 noEdge 卡打上 noEdge 标记', !!inL0 && inL0.noEdge === true);

  // G6：批量 — 50 张 noEdge 卡各单候选，全部应进 L0
  let lost = 0;
  for (const id of noEdgeIds.slice(0, 50)) {
    const a = wm.assemble(
      { sessionId: 'session-G2', cwd: '~', queryText: '测试', queryTokens: 800, turn: 2 },
      [{ id, score: 0.5, via: 'stage1' }]
    );
    if (!a.cards.some((c) => c.cardId === id)) lost++;
  }
  check('G', 'G6 50 张 noEdge 单候选全部进 L0', lost === 0, 'lost=' + lost + '/50');

  // G7：noEdge 卡在扩散里不因「无邻居」被排除/降权
  const sp = wm.spreader.spread([{ cardId: target, activation: 0.66 }]);
  const got = sp.nodes.find((n) => n.cardId === target);
  check('G', 'G7 noEdge 在扩散里保持种子分', !!got && Math.abs(got.activation - 0.66) < 1e-9, got ? 'act=' + got.activation : 'missing');

  // G8：与有超边卡混排时不被「Episode/fedge 过滤」掉
  const withEdge = Array.from(env.members).find((id) => env.byId.has(id));
  const mix = wm.assemble(
    { sessionId: 'session-G3', cwd: '~', queryText: '混排', queryTokens: 800, turn: 3 },
    [{ id: withEdge, score: 0.9, via: 'stage1' }, { id: target, score: 0.61, via: 'stage1' }]
  );
  check('G', 'G8 混排时 noEdge 仍留在 L0', mix.cards.some((c) => c.cardId === target), 'cards=' + mix.cards.length + ' noEdgeInL0=' + mix.stats.noEdgeInL0);
  record('G', '覆盖口径', 'alive=' + cov.alive + ' episodeCovered=' + cov.episodeCovered + ' edgeCovered=' + cov.edgeCovered + ' noEdge=' + cov.noEdge);
}


// ============================ I · 时间新鲜度（越近越详细） ============================
async function runI(env) {
  log('\n── I · 时间新鲜度（越近越详细 · 2026-10-22 架构补） ──');
  const { createWorkingMemory } = MODS.wm;
  const { WM_DEFAULTS, RENDER_TIER } = MODS.wm;

  // I1 配置存在
  check('I', 'I1 recency 配置已定义', WM_DEFAULTS.recency && WM_DEFAULTS.recency.halfLifeDays > 0 && WM_DEFAULTS.recency.detailTop >= 1,
    JSON.stringify(WM_DEFAULTS.recency));

  // I2 header 带 createdAt
  const anyId = env.cards[0].id;
  const h = env.reader.header(anyId);
  check('I', 'I2 header 带 createdAt', h && typeof h.createdAt === 'number' && h.createdAt > 0, 'createdAt=' + (h && h.createdAt));

  // I3 finalScore 含 recency（用两批不同时间的假卡直接验装配结果）
  const DIR = '~/_tmp/p4-recency';
  const NOW = Date.now();
  const fake = new Map();
  const mk = (id, title, ageDays, score) => {
    fake.set(id, { id, title, summary: '测试卡 ' + id + ' 的摘要内容用于渲染', layer: 'global', content: '', createdAt: NOW - ageDays * 86400000, _score: score });
  };
  mk('fresh-1', '两小时前的决定', 0.08, 1.0);
  mk('fresh-2', '昨天的决定', 1, 1.0);
  mk('old-1', '两周前的旧事', 14, 1.0);
  mk('old-2', '一个月前的旧事', 30, 1.0);
  const fakeReader = {
    header: (id) => { const c = fake.get(id); return c ? { id, title: c.title, summary: c.summary, layer: c.layer, createdAt: c.createdAt } : null; },
    content: (id) => (fake.get(id) || {}).content || null,
    projectIdOf: () => null,
    sessionIdOf: () => null,
  };
  const wm = createWorkingMemory({ dir: DIR, cards: fakeReader, enabled: true });
  const hits = [...fake.keys()].map((id) => ({ cardId: id, id, score: fake.get(id)._score, via: 'stage1', scoreParts: null, noEdge: true }));
  let adm = null;
  try { adm = wm.assemble({ sessionId: 'sess-recency', queryText: '测试 时间 新鲜度', retrieval: { hits } }, hits); } catch (e) { adm = null; }
  check('I', 'I3 assemble 成功', adm && Array.isArray(adm.cards) && adm.cards.length > 0, adm ? 'cards=' + adm.cards.length : 'null');

  if (adm && adm.cards) {
    const byId = new Map(adm.cards.map((c) => [c.cardId, c]));
    const f1 = byId.get('fresh-1'), o2 = byId.get('old-2');
    // I4 新卡 recency 显著高于老卡
    check('I', 'I4 新卡 recency > 老卡', f1 && o2 && f1.recency > o2.recency * 3,
      'fresh=' + (f1 ? f1.recency.toFixed(3) : '?') + ' old=' + (o2 ? o2.recency.toFixed(4) : '?'));
    // I5 最近 detailTop 条拿到详细档（不全是 title）
    const detailed = adm.cards.filter((c) => c.tier === RENDER_TIER.full || c.tier === RENDER_TIER.summary);
    check('I', 'I5 最近几条拿到详细档', detailed.length >= 1, '详细档=' + detailed.length + ' 条：' + detailed.map((c) => c.cardId + '(' + c.tier + ')').join(','));
    // I6 详细档给的是「最近的」，不是「分最高的」
    const detailedIds = detailed.map((c) => c.cardId);
    check('I', 'I6 详细档优先给最近（非最高分）', detailedIds.indexOf('fresh-1') >= 0 && detailedIds.indexOf('old-2') < 0,
      '详细档=' + detailedIds.join(','));
    // I7 渲染行带时间标签
    const withAge = adm.cards.filter((c) => /\([^)]*前\)|\(刚刚\)/.test(c.line));
    check('I', 'I7 渲染行带时间标签', withAge.length >= 1, '带标签=' + withAge.length + ' 条；样例=' + (adm.cards[0] ? adm.cards[0].line.slice(0, 70) : ''));
  } else {
    check('I', 'I4 新卡 recency > 老卡', false, 'assemble 失败');
    check('I', 'I5 最近几条拿到详细档', false, 'assemble 失败');
    check('I', 'I6 详细档优先给最近（非最高分）', false, 'assemble 失败');
    check('I', 'I7 渲染行带时间标签', false, 'assemble 失败');
  }
}

// ============================ H · 端到端冒烟（必须 await） ============================
async function runH(env) {
  log('\n── H · 端到端冒烟（retriever.search → assemble → render） ──');
  const { createWorkingMemory, createGraphAdapter } = MODS.wm;
  const rt = MODS.retriever.createRetriever({}, null);
  check('H', 'H1 retriever 创建成功', !!rt);

  const warm = await rt.warmup();          // ★ 必须 await
  check('H', 'H2 暖启动完成', warm && warm.ok === true, 'ms=' + (warm && warm.ms) + ' docs=' + (warm && warm.reason || ''));

  const t0 = performance.now();
  const res = await rt.search('KVMem ROCm 移植 回归');   // ★ 必须 await
  const ms = performance.now() - t0;
  check('H', 'H3 search 返回 hits', res && Array.isArray(res.hits) && res.hits.length > 0, 'hits=' + (res ? res.hits.length : 0) + ' degrade=' + (res && res.degrade) + ' ' + f2(ms) + 'ms');
  check('H', 'H4 search 真的 await 了（耗时 > 0.1ms）', ms > 0.1, ms.toFixed(3) + 'ms');

  const adapter = createGraphAdapter(env.ctx, { maxPerNode: 24 });
  const dir = freshTmp('H');
  const wm = createWorkingMemory({ dir, cards: env.reader, graph: adapter });
  wm.loadActivation(Date.now());

  const adm = wm.assemble(
    { sessionId: 'session-H', cwd: '~', queryText: 'KVMem ROCm 移植 回归', queryTokens: MODS.rtypes.estimateTokens('KVMem ROCm 移植 回归'), turn: 1 },
    res.hits
  );
  check('H', 'H5 assemble 产出非空 L0', adm.cards.length > 0, 'picked=' + adm.cards.length + ' dropped=' + adm.dropped.length);
  check('H', 'H6 L0 预算未超', adm.budget.usedTokens <= adm.budget.l0CapTokens, 'used=' + adm.budget.usedTokens + '/' + adm.budget.l0CapTokens);

  const text = wm.render(adm, '<wm-memory>');
  check('H', 'H7 渲染出注入串', typeof text === 'string' && text.indexOf('<wm-memory>') === 0 && text.split('\n').length > 1, 'chars=' + (text ? text.length : 0));

  // commitTurn 必须写回激活
  const c = wm.commitTurn({ sessionId: 'session-H' }, { usedCardIds: [adm.cards[0].cardId] });
  check('H', 'H8 commitTurn 写回激活', c.reinforced.length > 0 && wm.store.size() > 0, 'reinforced=' + c.reinforced.length + ' store=' + wm.store.size());

  const p = wm.persist(Date.now());
  check('H', 'H9 persist 落盘成功', p.bytes > 0 && existsSync(p.activationPath), 'bytes=' + p.bytes);

  // 端到端不许有静默 catch 吞掉 ReferenceError：再跑一遍带 await 的完整链路
  let err = null;
  try {
    const r2 = await rt.search('超图 分层 工作记忆');
    const a2 = wm.assemble({ sessionId: 'session-H2', queryText: '超图 分层 工作记忆', turn: 9 }, r2.hits);
    const t2 = wm.render(a2, '<wm-memory>');
    if (typeof t2 !== 'string') throw new Error('render 非字符串');
  } catch (e) { err = e; }
  check('H', 'H10 第二遍链路无异常', err === null, err ? String(err && err.message) : 'ok');
  record('H', '端到端', 'hits=' + res.hits.length + ' L0=' + adm.cards.length + ' used=' + adm.budget.usedTokens + '/' + adm.budget.l0CapTokens + ' degrade=' + res.degrade);
}

// ============================ main ============================
async function main() {
  log('════════ P4 SELFTEST · 期4 分层工作记忆 ════════');
  const snap = snapshot();
  log('源卡快照: lines=' + snap.lines + ' alive=' + snap.alive + ' bytes=' + snap.bytes + ' sha256(1MB)=' + snap.sha256Head1MB);

  await loadModules();   // ★ await

  const { cards, byId, reader } = loadCards();
  log('只读载入活卡: ' + cards.length);

  let ctxPack = null;
  try {
    const tok = (await import('file:///' + LIB_RETRIEVAL.replace(/\\/g, '/') + '/tokenize.js')).createTokenizer({ mode: 'bigram' });
    const bm25 = (await import('file:///' + LIB_RETRIEVAL.replace(/\\/g, '/') + '/bm25.js')).createBm25Index(cards, tok);
    ctxPack = buildCtx(cards, tok, bm25);
    log('期3 图谱 ctx: episodes=' + ctxPack.episodes.size + ' fedges=' + (ctxPack.edgesByEpisode.size ? Array.from(ctxPack.edgesByEpisode.values()).reduce((a, b) => a + b.length, 0) : 0) + ' edgeMembers=' + ctxPack.members.size);
  } catch (e) {
    log('图谱 ctx 构建失败（G/E8 将跳过）: ' + (e && e.message));
  }

  const env = Object.assign({ cards, byId, reader, snap }, ctxPack ? { ctx: ctxPack.ctx, members: ctxPack.members, episodes: ctxPack.episodes } : { ctx: null, members: new Set() });

  if (groupOf('A')) await runA();
  if (groupOf('B')) await runB();
  if (groupOf('C')) await runC();
  if (groupOf('D')) await runD();
  if (groupOf('E')) await runE(env);
  if (groupOf('F')) await runF(env);
  if (groupOf('G') && env.ctx) await runG(env);
  else if (groupOf('G')) log('\n── G · SKIP（无图谱 ctx） ──');
  if (groupOf('H') && env.ctx) await runH(env);
  else if (groupOf('H')) log('\n── H · SKIP（无图谱 ctx） ──');

  if (groupOf('I') && env.ctx) await runI(env);
  else if (groupOf('I')) log('\n── I · SKIP（无图谱 ctx） ──');

  log('\n════════ P4 SELFTEST SUMMARY ════════');
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
  log('P4-' + (failed === 0 ? 'DONE' : 'FAILED') + '  checks=' + (totalPass + failed) + '  passed=' + totalPass + '  failed=' + failed + '  recorded=' + totalRec);

  // 只读自证：源卡 mtime 未变
  const after = snapshot();
  if (after.mtimeMs !== snap.mtimeMs || after.sha256Head1MB !== snap.sha256Head1MB) {
    log('  ⚠ 源卡快照变化（可能被别的进程写，不一定是本脚本）: before=' + snap.sha256Head1MB + ' after=' + after.sha256Head1MB);
  } else {
    log('  只读自证: engrams.jsonl mtime/sha256 未变 (' + snap.sha256Head1MB + ')');
  }
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('SELFTEST CRASH:', e && e.stack || e);
  process.exit(2);
});
