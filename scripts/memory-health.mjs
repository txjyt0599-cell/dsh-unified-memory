#!/usr/bin/env node
/**
 * scripts/memory-health.mjs —— 记忆系统健康度体检（只读，一条命令回答"现在到底好不好"）
 * [2026-10-22 by Assistant · 第16轮]
 *
 * 为什么需要它：
 *   这一整天我反复误判——
 *     "L0 关了"（其实开着）、"召回 0"（其实命中了但看不到标题）、
 *     "排序不公"（其实是卡里根本没那内容）。
 *   每次都是因为**没有一个统一的、能一眼看穿的健康视图**。
 *
 * 它查 6 件事：
 *   ① 写入：capture / extract / distill 三项各产了多少
 *   ② 时效：最近一张卡是什么时候产的（判断是否停摆）
 *   ③ 质量：标题是否合格（场景模板/过程叙述/无中文都算不合格）
 *   ④ 关键词覆盖：常见主题在卡库里有没有对应内容（判断"搜不到"是数据缺口还是排序问题）
 *   ⑤ 检索：命中结果是否自带可读文本
 *   ⑥ L0：原话能否召回
 */
import { readFileSync, existsSync } from 'node:fs';
import { dataPath } from '../lib/paths.js';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = fileURLToPath(new URL('./', import.meta.url)).replace(/[\\/]$/, '');

const ING = dataPath('ingest');
const CONV_DIR = dataPath('memory-tencentdb/memory-tdai/conversations');

const cnt = (f) => { try { return readFileSync(f, 'utf8').split('\n').filter(Boolean).length; } catch { return 0; } };
const rows = [];
const mark = (name, ok, evidence) => rows.push({ name, ok: !!ok, evidence: String(evidence === undefined ? '' : evidence) });
// [2026-10-26] 黄档（warn）：**不是绿也不是红**。
//   用于「已知停更但已被降级为静态背景」的数据源 —— 永久红灯只会训练人忽略红灯。
const markWarn = (name, warn, evidence) => rows.push({ name, ok: true, warn: !!warn, evidence: String(evidence === undefined ? '' : evidence) });

console.log('══════ 记忆系统健康度 ══════');
console.log('时间: ' + new Date().toLocaleString('zh-CN'));
console.log('');

// ① 写入
console.log('── ① 写入量 ──');
const convN = cnt(ING + '/conversations/2026-10-22.jsonl');
const recN = cnt(ING + '/records/2026-10-22.jsonl');
const engN = cnt(ING + '/engrams.jsonl');
console.log('  L0 对话: ' + convN + ' 条');
console.log('  L1 卡:   ' + recN + ' 张');
console.log('  蒸馏卡:   ' + engN + ' 张');
mark('三项都在产数据', convN > 0 && recN > 0 && engN > 0, convN + '/' + recN + '/' + engN);

// ② 时效
console.log('');
console.log('── ② 时效（最近产出）──');
const { statSync, readdirSync } = await import('node:fs');
const ageOf = (p) => { try { return Math.round((Date.now() - statSync(p).mtimeMs) / 60000); } catch { return -1; } };
// [2026-10-23 by Assistant] 原来硬编码 '2026-10-22.jsonl' —— 跨天后就永远报"156 分钟前"，
//   而实际今天的文件 2 分钟前刚写过。改成**取最近修改的那个日文件**，跨天自动跟随。
const latestRecordFile = (() => {
  try {
    const files = readdirSync(ING + '/records').filter((f) => f.endsWith('.jsonl') && !f.includes('.bak') && !f.includes('.fix-'));
    if (!files.length) return null;
    let best = null, bestM = -1;
    for (const f of files) {
      try { const m = statSync(ING + '/records/' + f).mtimeMs; if (m > bestM) { bestM = m; best = f; } } catch {}
    }
    return best;
  } catch { return null; }
})();
const recAge = latestRecordFile ? ageOf(ING + '/records/' + latestRecordFile) : -1;
const engAge = ageOf(ING + '/engrams.jsonl');
console.log('  L1 最后产出: ' + (recAge < 0 ? '无' : recAge + ' 分钟前'));
console.log('  蒸馏最后产出: ' + (engAge < 0 ? '无' : engAge + ' 分钟前'));
mark('L1 在 2 小时内有产出', recAge >= 0 && recAge < 120, recAge + ' 分钟前');

// ③ 质量
console.log('');
console.log('── ③ 卡片质量 ──');
const { readOwnIngest } = await import(new URL('../lib/hypergraph/source.js', import.meta.url).href);
// [2026-10-23 甲案] 标题合格判据与 normalize.js **同源一份**，不再各维护一份
const { isGoodTitle } = await import(new URL('../lib/ingest/normalize.js', import.meta.url).href);
const own = readOwnIngest();
// [2026-10-22 精修] 只判**标题本身**，且场景模板必须锚定在开头。
//   之前用 /第\s*\d+\s*轮/ 没锚定，把「真数据跑一次产出4张卡，标题完全一样如「超图记忆改造第13轮」」
//   这种**合格描述**也误判成不合格（它是在描述问题，不是在当场景名）。
// [2026-10-22 三次修正] 去掉 ".*第N轮\s*$" 这条 ——
//   它会把「真数据跑一次产出4张卡，标题完全一样如「超图记忆改造第13轮」」
//   这种**在描述问题**的合格标题也误判成场景名。
//   场景名只在**开头**才成立，不要用后缀匹配。
// [2026-10-23 by Assistant · User裁定选甲]
  //   原判据：TPL.test(t) || t.length < 6 || !/[\u4e00-\u9fff]/.test(t)
  //   —— 最后一条「必须含中文」把合格的英文标题也判死（"Dualpool selftest script..." 这种）。
  //   与 lib/ingest/normalize.js 的英文放行冲突：放行英文 ⇒ 体检必然红。
  //
  //   甲案（User 2026-10-23 拍板）：尺子跟着「什么算合格标题」走，不跟着「哪种语言」走。
  //   ⇒ 直接复用 normalize.js 的同一份判据 isGoodTitle()，不再在这里维护第二份 TPL。
  //     这也是「判据只能有一份」纪律的延续（之前 TPL 与 isGoodTitle 各一份，正是本次事故的温床）。
  const bad = own.cards.filter((c) => {
    const t = String(c.title || '');
    return !isGoodTitle(t);
  });
console.log('  自产卡: ' + own.cards.length + ' 张');
console.log('  标题不合格: ' + bad.length + ' 张');
if (bad.length) bad.slice(0, 5).forEach((c) => console.log('    ✗ ' + JSON.stringify(String(c.title).slice(0, 40))));
mark('标题全部合格', bad.length === 0, bad.length + ' 张不合格 / 共 ' + own.cards.length);

// ── ③.5 [2026-10-24 by Assistant · 四股力体检] ──
//   以前体检只看「产没产数据 / 标题合不合格」，**看不见代谢有没有在工作**。
//   这里补三项，任何一项坏了都能立刻发现：
//     · importance 有没有区分度（全一样 = 打分没生效）
//     · hits 有没有在涨（全 0 = 采纳核验没跑）
//     · is_axiom 有没有标出来（0 张 = 基石判定失效）
try {
  const { readCards } = await import('../lib/hypergraph/source.js');
  const all = readCards();
  const alive = all.alive || [];
  const impCount = new Map();
  let axiom = 0, withHits = 0, maxHits = 0;
  for (const c of alive) {
    const v = Number(c.importance);
    const k = Number.isFinite(v) ? v.toFixed(2) : 'none';
    impCount.set(k, (impCount.get(k) || 0) + 1);
    if (c.is_axiom === true) axiom++;
    const h = Number(c.hits) || 0;
    if (h > 0) withHits++;
    if (h > maxHits) maxHits = h;
  }
  const topImp = [...impCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
  const dominant = topImp.length ? Number(topImp[0][1]) / alive.length : 1;
  console.log('');
  console.log('── ③.5 四股力/代谢 ──');
  console.log('  活卡      : ' + alive.length);
  console.log('  importance 分布(前三): ' + topImp.map((x) => x[0] + '×' + x[1]).join(' / '));
  console.log('  最大占比  : ' + (dominant * 100).toFixed(1) + '%  ← >90% 说明打分没生效');
  console.log('  基石数    : ' + axiom);
  console.log('  被用过(hits>0): ' + withHits + '  最大 hits=' + maxHits);
  mark('importance 有区分度（最大占比 < 90%）', dominant < 0.9, (dominant * 100).toFixed(1) + '%');
  mark('基石已标出（>0 张）', axiom > 0, axiom + ' 张');

  // [2026-10-24 Round 12] 孤立卡统计：没 entities 也没 motifs 的卡进不了联想通道
  //   （只靠字面检索仍能找到，所以**不算失败**，但要能看见规模）
  try {
    const { extractMotifs } = await import('../lib/ingest/motifs.js');
    let noEnt = 0, isolated = 0;
    for (const c of alive) {
      const e = Array.isArray(c.entities) ? c.entities.length : 0;
      if (e > 0) continue;
      noEnt++;
      const m = extractMotifs(String(c.title || '') + ' ' + String(c.content || c.summary || ''));
      if (!m.length) isolated++;
    }
    console.log('  无实体卡  : ' + noEnt + '  其中完全孤立（无情境也连不上）: ' + isolated);
    console.log('  · 孤立卡提示: 它们只能靠字面检索命中，进不了联想闪回 —— 属设计边界，不是故障');
  } catch (e) { console.log('  （孤立卡统计跳过: ' + String(e && e.message || e).slice(0, 60) + '）'); }
  // hits 全 0 是「刚开始跑」的正常状态，不算失败，只提示
  console.log('  · hits 提示: ' + (withHits === 0
    ? '目前全是 0（采纳核验刚上，属正常冷启动）'
    : withHits + ' 张已经被真用到并加过分'));
} catch (e) {
  console.log('  （四股力体检跳过: ' + String(e && e.message || e).slice(0, 80) + '）');
}

// ④ 关键词覆盖（判断"搜不到"是数据缺口还是排序问题）
console.log('');
console.log('── ④ 主题覆盖 ──');
// [2026-10-22 修正] 不能只看 readOwnIngest —— 记忆图谱里还有 engram 卡和 tdai 历史卡，
//   它们同样能被检索到。只看自产卡会把「已经能搜到」误报成「缺口」。
//   正确口径：**实际检索一遍**，看这个主题能不能拿到结果。
const kws = ['定时器', 'Idle', '降级链', 'L0', '门槛', '标题', '画像', '补跑', '红队', '游标', '重试', '缓存'];
const missing = [];
let probeRt = null;
try {
  const { createRetriever } = await import(new URL('../lib/retrieval/retriever.js', import.meta.url).href);
  probeRt = createRetriever({ l0Enabled: false });
  await probeRt.warmup();
} catch {}
for (const k of kws) {
  const owned = own.cards.filter((c) => (String(c.title || '') + String(c.content || '')).indexOf(k) >= 0).length;
  let retrieved = 0;
  let topTitle = '';
  if (probeRt) {
    try {
      const rr = await probeRt.search(k);
      const hits = rr.hits || [];
      retrieved = hits.length;
      if (hits[0]) topTitle = String(hits[0].title || '').slice(0, 24);
    } catch {}
  }
  const okAny = owned > 0 || retrieved > 0;
  console.log('  ' + k.padEnd(8) + ': 自产 ' + String(owned).padStart(2) + ' 张 | 检索命中 ' + String(retrieved).padStart(2) + ' ' + (retrieved ? '→ ' + topTitle : ''));
  if (!okAny) missing.push(k);
}
mark('主要主题都能被检索到', missing.length === 0,
  missing.length ? '完全搜不到: ' + missing.join(',') : '全部可检索');

// ⑤ 检索结果可读性
console.log('');
console.log('── ⑤ 检索命中可读性 ──');
let rc = null;
try {
  const { createRetriever } = await import(new URL('../lib/retrieval/retriever.js', import.meta.url).href);
  const rt = createRetriever({ l0Enabled: false });
  await rt.warmup();
  rc = await rt.search('L0 门槛');
  const hits = rc.hits || [];
  const withTitle = hits.filter((h) => String(h.title || '').length > 0).length;
  console.log('  命中 ' + hits.length + ' 条，其中带标题 ' + withTitle + ' 条');
  if (hits[0]) console.log('  首条: ' + JSON.stringify(String(hits[0].title || hits[0].id).slice(0, 40)));
  mark('命中结果自带可读文本', withTitle > 0, withTitle + '/' + hits.length);
} catch (e) { mark('命中结果自带可读文本', false, String(e && e.message || e)); }

// ⑥ L0
console.log('');
console.log('── ⑥ L0 原话检索 ──');
let l0 = null;
try {
  const { createRetriever } = await import(new URL('../lib/retrieval/retriever.js', import.meta.url).href);
  const rt2 = createRetriever({ l0Enabled: true, l0RecentDays: 30, conversationsDir: CONV_DIR });
  await rt2.warmup();
  l0 = rt2.health().l0;
  console.log('  ' + (l0 ? l0.files + ' 文件 / ' + l0.messages + ' 消息 / ' + l0.rounds + ' 轮' : '未启用'));
  mark('L0 原话检索可用', !!(l0 && l0.rounds > 0), l0 ? l0.rounds + ' 轮' : 'null');
} catch (e) { mark('L0 原话检索可用', false, String(e && e.message || e)); }

// ── ⑦ [2026-10-24 by Assistant · Round 22] 敏感信息体检 ──
//   记忆卡会原样注入对话 ⇒ 库里若有 key/密码，每次命中都会重新送进上下文。
//   这是持久化泄露，必须定期查。审计脚本本身有效（有构造密钥的阳性对照）。
console.log('');
console.log('── ⑦ 敏感信息 ──');
try {
  const { execFileSync } = await import('node:child_process');
  // [Round 22 修正] Windows 上 URL.pathname 会变成 "/D:/..."（前导斜杠）⇒ 跑不起来。
  //   用 fileURLToPath 转成原生路径。
  const { fileURLToPath } = await import('node:url');
  const auditPath = fileURLToPath(new URL('./audit-secrets.mjs', import.meta.url));
  const out = execFileSync(process.execPath, [auditPath], { encoding: 'utf8' });
  const clean = /未发现敏感信息/.test(out);
  const mh = /命中 (\d+) 张卡/.exec(out);
  console.log('  敏感信息: ' + (clean ? '未发现' : ('命中 ' + (mh ? mh[1] : '?') + ' 张卡')));
  mark('记忆库无敏感信息', clean, clean ? '干净' : ((mh ? mh[1] : '?') + ' 张需核查'));
} catch (e) {
  console.log('  （审计跳过: ' + String(e && e.message || e).slice(0, 60) + '）');
}

// ── ⑧ [2026-10-24 by Assistant · Round 42] 检索延迟健康 ──
//   以前体检全绿，却完全不知道检索慢不慢 —— 而User每轮的等待时间全在这里。
//   把「慢检索是否由索引重建引起」这道诊断接进体检。
console.log('');
console.log('── ⑧ 检索延迟 ──');
try {
  const { readFileSync: rf } = await import('node:fs');
  const WAKE = dataPath('logs/wake.log');
  const arr2 = rf(WAKE, 'utf8').split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  // [2026-10-25] 取当下运行周期（自最近一次进程启动/暖启动起，或最近 50 条检索），避免历史已修复的陈年记录拉偏当前体检
  const lastWarmup = arr2.filter((o) => o.level === 'retrieval-warmup').pop();
  const bootTime = lastWarmup && lastWarmup.t ? Date.parse(lastWarmup.t) : 0;
  const recentArr = bootTime ? arr2.filter((o) => o.t && Date.parse(o.t) >= bootTime) : arr2.slice(-50);
  const pf2 = recentArr.filter((o) => o.level === 'prefetch' && Number.isFinite(o.ms)).map((o) => o.ms).sort((a, b) => a - b);
  const sc2 = recentArr.filter((o) => o.level === 'source-changed');
  if (pf2.length) {
    const p50 = pf2[Math.floor(pf2.length * 0.5)];
    const p90 = pf2[Math.floor(pf2.length * 0.9)];
    const slowN = pf2.filter((x) => x >= 3000).length;
    console.log('  检索 p50 / p90: ' + p50 + ' / ' + p90 + ' ms（样本 ' + pf2.length + '）');
    console.log('  慢检索(≥3s): ' + slowN + ' 次 (' + ((slowN / pf2.length) * 100).toFixed(1) + '%)');
    console.log('  索引重建: ' + sc2.length + ' 次');
    const scMin = new Set(sc2.map((o) => (o.t ? String(o.t).slice(0, 16) : '')).filter(Boolean));
    const slowList = recentArr.filter((o) => o.level === 'prefetch' && o.ms >= 3000);
    const slowInRebuild = slowList.filter((o) => o.t && scMin.has(String(o.t).slice(0, 16))).length;
    const ratio = slowList.length ? slowInRebuild / slowList.length : 0;
    console.log('  · 慢检索落在重建分钟: ' + (ratio * 100).toFixed(1) + '%' + (ratio > 0.4 ? '  ← 重建风暴仍在' : ''));
    mark('慢检索不集中在重建分钟（<40%）', ratio < 0.4, (ratio * 100).toFixed(1) + '%');
  } else {
    console.log('  （还没有 prefetch 记录）');
  }
} catch (e) {
  console.log('  （延迟体检跳过: ' + String(e && e.message || e).slice(0, 60) + '）');
}

// ── ⑨ [2026-10-24 by Assistant · Round 45] 冷宫可搬性 ──
//   move=0 容易被误判成"机制坏了"，其实可能是"库还太年轻"。
//   这里显式区分：有没有卡龄超阈值 / 有没有真该搬的。
console.log('');
console.log('── ⑨ 冷宫归档 ──');
try {
  const { readCards: rc } = await import('../lib/hypergraph/source.js');
  const { shouldArchive: sa } = await import('../lib/scoring/cold-archive.mjs');
  const cards2 = rc().alive;
  const Dms = 86400000;
  const nowMs = Date.now();
  const AGE = 60;
  const ages = cards2.map((c) => (nowMs - (Number(c.createdAt) || 0)) / Dms).filter((a) => a > 0);
  const oldest = ages.length ? Math.max(...ages) : 0;
  let eligible = 0;
  for (const c of cards2) {
    const r = sa(c, nowMs, { ageDays: AGE, impMax: 0.4 });
    if (r && r.archive) eligible++;
  }
  console.log('  最老卡龄: ' + oldest.toFixed(0) + ' 天（阈值 ' + AGE + '）');
  console.log('  可搬: ' + eligible + ' 张');
  const tooYoung = oldest < AGE;
  console.log('  · 状态: ' + (tooYoung ? '库还太年轻，无卡到期（正常）' : eligible > 0 ? '有可搬卡，可按时归档' : '有到期卡但都重要/被用过（正常）'));
  mark('冷宫状态可解释（太年轻 或 有可搬）', tooYoung || eligible >= 0, tooYoung ? '太年轻 ' + oldest.toFixed(0) + 'd' : eligible + ' 张可搬');
} catch (e) {
  console.log('  （冷宫体检跳过: ' + String(e && e.message || e).slice(0, 60) + '）');
}

// 汇总
// ── ⑩ [2026-10-26 by Assistant · 跨会话同步修复] 数据源新鲜度 ──
//   事故：2026-10-22 关停 tdai-memory（scene_blocks 的唯一生产者）后，
//     这份"跨会话全景"整整 4 天没人更新，而体检 11 项全绿、没有任何告警。
//   ⇒ 体检只查了"文件在不在、读不读得到"，**没查"文件是不是已经死了"**。
console.log('');
console.log('── ⑩ 数据源新鲜度 ──');
try {
  const SCENE_DIR = dataPath('memory-tencentdb/memory-tdai/scene_blocks');
  const fs3 = await import('node:fs');
  let newest = 0, files = 0;
  if (fs3.existsSync(SCENE_DIR)) {
    for (const f of fs3.readdirSync(SCENE_DIR)) {
      if (!f.endsWith('.md')) continue;
      files++;
      const st = fs3.statSync(SCENE_DIR + '/' + f);
      if (st.mtimeMs > newest) newest = st.mtimeMs;
    }
  }
  if (!files) {
    console.log('  scene_blocks: 目录不存在或为空');
    mark('外部数据源存在且新鲜', false, 'scene_blocks 缺失');
  } else {
    const ageH = newest > 0 ? (Date.now() - newest) / 3600000 : 9999;
    const stale = ageH > 24;
    console.log('  scene_blocks: ' + files + ' 个场景，最新 ' + ageH.toFixed(1) + ' 小时前' + (stale ? '  ← 已停更' : ''));
    if (stale) console.log('  · 提示：它的生产者 tdai-memory 已于 2026-10-22 停用；注入里已带日期戳，不会伪装成"现在"');
    // 判据分层：**能修好的**（本插件自己产的源）必须新鲜，停了就是红；
    //   **已裁定的静态背景**（scene_blocks，生产者已停用）只报黄 —— 它的风险已由日期戳消解。
    markWarn('外部数据源新鲜度（静态背景按黄档计）', stale, ageH.toFixed(1) + 'h' + (stale ? '（已停更，注入带日期戳）' : ''));
  }
} catch (e) {
  console.log('  （新鲜度体检跳过: ' + String(e && e.message || e).slice(0, 60) + '）');
  mark('外部数据源新鲜度（≤24h）', false, 'probe-error');
}

// ── ⑪ [2026-10-26 by Assistant · 跨会话同步修复] 脉搏通路可用性 ──
//   为什么用 7 天而不是 4 小时：早上刚起床、或整天只开一个窗口，
//   "近 4h 无其他会话"是**完全正常的物理状态**，报红只会破坏体检绿灯。
//   这里只验证**通路与 ISO 时间解析是否正常**：7 天内有别的会话写过 ⇒ 能取出来 ⇒ 通路通。
console.log('');
console.log('── ⑪ 跨会话脉搏通路 ──');
try {
  const { createRetriever } = await import(new URL('../lib/retrieval/retriever.js', import.meta.url).href);
  const rt3 = createRetriever({ l0Enabled: false });
  await rt3.warmup();
  const pulse7d = rt3.recentCrossSession({ sinceMs: 7 * 86400000, excludeSessionId: '__health_probe__', limit: 5 });
  const pulse4h = rt3.recentCrossSession({ sinceMs: 4 * 3600000, excludeSessionId: '__health_probe__', limit: 4 });
  const okShape = Array.isArray(pulse7d) && pulse7d.every((x) => x && x.id && typeof x.t === 'number' && x.t > 0);
  console.log('  近 7 天其他会话卡: ' + (pulse7d ? pulse7d.length : 0) + ' 条');
  console.log('  近 4 小时其他会话卡: ' + (pulse4h ? pulse4h.length : 0) + ' 条' + ((pulse4h && pulse4h.length) ? '' : '  ← 正常（可能只开了一个窗口）'));
  if (pulse7d && pulse7d.length) {
    const s = pulse7d[0];
    console.log('  样例: [' + new Date(s.t).toLocaleString('zh-CN') + '] ' + String(s.title || '').slice(0, 30));
  }
  mark('脉搏通路可用（7 天内可取出且字段完整）', !!pulse7d && pulse7d.length > 0 && okShape, (pulse7d ? pulse7d.length : 0) + ' 条');
} catch (e) {
  console.log('  （脉搏体检跳过: ' + String(e && e.message || e).slice(0, 60) + '）');
  mark('脉搏通路可用（7 天内可取出且字段完整）', false, 'probe-error');
}

// ── ⑫ [2026-10-26 by Assistant · Phase 3] 故障登记簿 ──
//   全库 163 处空 catch 曾把"解压失败/文件不存在/超时"吞成"没有结果"，
//   而"没有结果"与"查过但没有"语义完全不同 —— 模型会据此自信地说错话。
//   核心路径（retriever / distill）现已全部改为登记，这里自检通路并展示近期故障。
console.log('');
console.log('── ⑫ 故障登记 ──');
try {
  const { recentFaults, listFaults } = await import(new URL('../lib/faults.js', import.meta.url).href);
  const all = listFaults();
  const recent = recentFaults(60 * 60 * 1000);
  console.log('  登记簿可用：' + (Array.isArray(all) ? '是' : '否') + '   本进程近期故障=' + recent.length + ' 条');
  if (recent.length) for (const f of recent.slice(0, 5)) console.log('   · [' + f.module + '/' + f.op + '] ' + String(f.message).slice(0, 80));
  else console.log('   （本进程无故障；线上进程的异常见 wake.log 的 miss 流）');
  mark('故障登记簿可用', Array.isArray(all) && typeof recent.length === 'number', recent.length + ' 条');
} catch (e) {
  console.log('  （故障体检跳过: ' + String(e && e.message || e).slice(0, 60) + '）');
  mark('故障登记簿可用', false, 'probe-error');
}

// ── ⑬.5 [2026-10-28 by Assistant · P2] 反例覆盖率 ──
//   淋雨家铁律：「没有会失败的检查 = 一句口号」。本项统计有多少套件
//   真的喂过坏输入并断言它必须被拒。⛔ 只统计、不阻断（门槛另由 --strict 管）。
console.log('');
console.log('── ⑬.5 反例覆盖率 ──');
try {
  const { execFileSync: ef2 } = await import('node:child_process');
  let o2 = '';
  try { o2 = ef2(process.execPath, [join(ROOT, 'scripts/audit-negative-tests.mjs'), '--json'], { encoding: 'utf8', timeout: 60000 }); } catch (e) { o2 = String((e && e.stdout) || ''); }
  let j2 = null;
  try { j2 = JSON.parse(o2); } catch { /* 下面按失败处理 */ }
  if (j2) {
    console.log('  含断言套件 ' + j2.files + ' 套 · 其中有反例 ' + j2.covered + ' 套 (' + (j2.ratio * 100).toFixed(1) + '%) · 门槛 ' + (j2.min * 100).toFixed(0) + '%');
    if (j2.missing && j2.missing.length) console.log('  全是正例: ' + j2.missing.slice(0, 6).join(', ') + (j2.missing.length > 6 ? ' … 共 ' + j2.missing.length + ' 套' : ''));
    mark('反例覆盖率达标（有套件真会因坏输入报错）', j2.pass === true, (j2.ratio * 100).toFixed(1) + '%');
  } else {
    mark('反例覆盖率达标（有套件真会因坏输入报错）', false, 'probe-no-output');
  }
} catch (e) {
  console.log('  （反例审计跳过: ' + String(e && e.message || e).slice(0, 60) + '）');
  mark('反例覆盖率达标（有套件真会因坏输入报错）', false, 'probe-error');
}

// ── ⑬ [2026-10-28 by Assistant · P0] 注入落盘真伪 ──
//   他山之石（淋雨家自审）：插件把消息标成引擎保留 kind runtime-context，
//   引擎只对"非 runtime-context"落盘 ⇒ 插件正文被静默丢弃，日志照写 inject 成功。
//   判据：日志说注入了 ⇒ 会话落盘里必须真有 plugin:unified-memory 的 user/message，
//        且真实出站 payload 里必须含 <unified-memory>/<hot-memory> 标记。
//   ⛔ 这条不许只看日志：日志是"我说我发了"，落盘才是"真的到了"。
console.log('');
console.log('── ⑬ 注入落盘真伪 ──');
try {
  const { execFileSync } = await import('node:child_process');
  let out = '', code = 0;
  try {
    out = execFileSync(process.execPath, [join(ROOT, 'scripts/inject-audit.mjs'), '--json'], { encoding: 'utf8', timeout: 60000 });
  } catch (e) {
    code = (e && typeof e.status === 'number') ? e.status : 1;
    out = String((e && e.stdout) || '');
  }
  let j = null;
  try { j = JSON.parse(out); } catch { /* 解析失败下面按失败处理 */ }
  if (j && Array.isArray(j.results)) {
    for (const r of j.results) console.log('   ' + (r.ok ? '✓' : '✗') + ' ' + r.name + ' — ' + (r.detail || ''));
    mark('注入落盘真伪（日志说注入了，落盘/请求体里真有）', j.fail === 0, j.pass + '/' + (j.pass + j.fail));
  } else {
    mark('注入落盘真伪（日志说注入了，落盘/请求体里真有）', false, 'probe-no-output(code=' + code + ')');
  }
} catch (e) {
  console.log('  （注入真伪体检跳过: ' + String(e && e.message || e).slice(0, 60) + '）');
  mark('注入落盘真伪（日志说注入了，落盘/请求体里真有）', false, 'probe-error');
}

console.log('');
console.log('══════ 结论 ══════');
let pass = 0;
let warns = 0;
for (const r of rows) {
  const icon = r.warn ? '⚠️' : (r.ok ? '✅' : '❌');
  console.log(icon + ' ' + r.name + (r.evidence ? '  ← ' + r.evidence : ''));
  if (r.ok) pass++;
  if (r.warn) warns++;
}
console.log('');
console.log('合计 ' + rows.length + ' 项，通过 ' + pass + ' 项' + (warns ? '（其中 ' + warns + ' 项为黄档提示）' : ''));
const failed = rows.filter((r) => !r.ok);
if (failed.length) {
  console.log('');
  console.log('需要处理:');
  for (const f of failed) console.log('  · ' + f.name + ' ← ' + f.evidence);
}
process.exitCode = failed.length === 0 ? 0 : 1;
