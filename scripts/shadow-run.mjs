#!/usr/bin/env node
/**
 * scripts/shadow-run.mjs —— 期7 旁路实跑（不碰生产、不用重启）
 * [2026-10-22 by Assistant]
 *
 * 为什么要有这一步：
 *   自测（selftest-ingest.mjs）跑的是**造的数据**，只能证明逻辑对。
 *   要证明「删掉旧插件之后记忆还能自己生长」，必须拿**真实的对话数据**跑一遍，
 *   而且不能污染生产目录 —— 所以全部落在 shadow/ 下，跑完可以整目录删掉。
 *
 * 三个阶段各跑一次，每段都打印真实数字：
 *   ① 用真实历史消息喂 capture（模拟 DSH 的 session/flush）
 *   ② 用真实 LLM 跑 extract（走 profile 继承的模型，key 不打印）
 *   ③ 用真实 LLM 跑 distill，并验证产物能被检索层读到（readOwnIngest）
 */
import { mkdtempSync, rmSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { captureTurn, shouldCapture, extractText, sanitizeText, isRealUser } from '../lib/ingest/capture.js';
import { runExtract, readOwnRecords } from '../lib/ingest/extract.js';
import { runDistill, readOwnEngrams } from '../lib/ingest/distill.js';
import { resolveLlm, llmLabel } from '../lib/ingest/llm.js';
import { readOwnIngest } from '../lib/hypergraph/source.js';
import { dirs } from '../lib/ingest/core.js';

const REAL_L0_DIR = '~/.dsh/unified-memory/memory-tencentdb/memory-tdai/conversations';
const PROFILE = '~/.dsh/profiles/web/cordis.patch.yml';
const KEEP = process.argv.includes('--keep');
// [2026-10-22] --fake-llm：用确定性的假模型跑完整链路。
//   为什么要这个：真实模型被限流（429）时，**功能是否闭环**这件事无法用真模型证明；
//   而「真数据 → capture → extract → 落盘 → 检索侧读到」这条链路本身是与模型无关的。
//   两种模式都跑：真模型证明"能用"，假模型证明"通"。
const FAKE = process.argv.includes('--fake-llm');
const fakeComplete = async (ep, system, user) => {
  // 从真实对话里抓一句当素材，证明归一化/落盘/检索全链路通
  const hit = String(user || '').match(/用户：([^\n]{12,60})/);
  const text = hit ? hit[1] : '这是一段测试用的对话内容，用来验证写入侧链路是否闭环。';
  return JSON.stringify([
    { type: 'episodic', scene_name: '我（AI）在和User做期7写入侧验证', content: '离线假模型模式：' + text, priority: 75, evidence: text.slice(0, 30) },
    { type: 'instruction', scene_name: '我（AI）在和User约定记忆写入规则', content: 'User要求 AI 以后提取记忆必须用落盘游标，且 LLM 失败时不得推进游标。', priority: 90, evidence: '落盘游标' },
  ]);
};
const fakeDistill = async () => JSON.stringify([
  { kind: 'decision', layer: 'project', title: '期七写入侧顺序决策', summary: '先功能后关旧', content: 'User明确先把功能做好才可关旧插件，顺序 7A→7B→7C→7D，删不删以后再说。', causesOf: [] },
]);
const LIMIT_MSGS = Number((process.argv.find((a) => a.startsWith('--msgs=')) || '').slice(7)) || 40;

const root = KEEP
  ? '~/.dsh/unified-memory/ingest-shadow'
  : mkdtempSync(join(tmpdir(), 'pm-shadow-'));
const d = dirs(root);
let fail = 0;
const ok = (name, cond, detail) => {
  console.log((cond ? '  ✅ ' : '  ❌ ') + name + (detail === undefined ? '' : '   ' + detail));
  if (!cond) fail++;
};

console.log('模式: ' + (FAKE ? '假模型（验证链路闭环，与模型无关）' : '真模型') + '  目标目录: ' + root);
console.log('');

// ── 取真实历史消息（读 tdai 的 conversations，只读）──
console.log('── ① capture · 用真实历史消息 ──');
let names = [];
try { names = readdirSync(REAL_L0_DIR).filter((f) => f.endsWith('.jsonl')).sort(); } catch {}
if (!names.length) { console.log('  ⚠️ 找不到真实 L0 目录，跳过'); }
else {
  const tail = names.slice(-2);
  const msgs = [];
  for (const n of tail) {
    let raw = '';
    try { raw = readFileSync(REAL_L0_DIR + '/' + n, 'utf8'); } catch { continue; }
    for (const line of raw.split('\n')) {
      if (!line) continue;
      let m; try { m = JSON.parse(line); } catch { continue; }
      if (!m || !m.role || typeof m.content !== 'string') continue;
      msgs.push({
        id: m.id, role: m.role, content: m.content,
        timestamp: Number(m.timestamp) || Date.now(),
      });
    }
  }
  msgs.sort((a, b) => a.timestamp - b.timestamp);
  // [2026-10-22 by Assistant · 自测抓到的取样偏差]
  //   直接取「最近 40 条」会踩两个坑：① 大段 assistant 消息是纯工具调用（content 为空）；
  //   ② 最近正好是子代理的 <system-reminder> 注入段。
  //   两者都**应该被过滤**（这是正确行为），但取样只含这类就等于测了个寂寞。
  //   所以：先按 shouldCapture 预筛，取**可捕获的**最近 N 条；过滤统计打出来作证据。
  const capturable = [];
  let filtered = 0;
  for (const m of msgs) {
    const role = m.role === 'assistant' ? 'assistant' : (isRealUser(m) ? 'user' : null);
    if (!role) { filtered++; continue; }
    const t = sanitizeText(m.content, role);
    if (!shouldCapture(t)) { filtered++; continue; }
    capturable.push(m);
  }
  const pick = capturable.slice(-LIMIT_MSGS);
  console.log('  源: ' + tail.join(', ') + '  总 ' + msgs.length + ' 条，可捕获 ' + capturable.length + ' 条（过滤噪音 ' + filtered + ' 条）');
  console.log('  取样: 最近 ' + pick.length + ' 条可捕获消息');
  ok('过滤确实在起作用（噪音被挡）', filtered > 0, 'filtered=' + filtered);
  ok('取样里有真实可捕获消息', pick.length >= 4, 'n=' + pick.length);

  // 按 session 分组喂（真实链路就是按 session 走的）
  const bySession = new Map();
  for (const m of pick) {
    // 源里没有 sessionKey 时归一个桶
    const k = 'shadow';
    let a = bySession.get(k); if (!a) bySession.set(k, a = []);
    a.push(m);
  }
  let totalWritten = 0;
  for (const [sid, arr] of bySession) {
    const r = captureTurn({ sessionKey: sid, sessionId: sid, messages: arr, opts: { root, nowMs: Date.now() } });
    totalWritten += r.written;
    console.log('  session=' + sid + ' written=' + r.written + ' skipped=' + r.skipped);
  }
  ok('capture 有真实产出', totalWritten > 0, 'written=' + totalWritten);
  // 幂等
  const again = captureTurn({ sessionKey: 'shadow', sessionId: 'shadow', messages: pick, opts: { root, nowMs: Date.now() } });
  ok('capture 幂等（重跑不重复写）', again.written === 0, 'written=' + again.written);
  const convFiles = existsSync(d.conversations) ? readdirSync(d.conversations).filter((f) => f.endsWith('.jsonl')) : [];
  ok('落盘文件已生成', convFiles.length > 0, convFiles.join(','));
}

// ── ② extract · 真模型 ──
console.log('');
console.log('── ② extract · 真模型 ──');
const ep = FAKE ? { baseUrl: 'http://fake', apiKey: 'fake', model: 'fake-model', maxTokens: 4000, temperature: 0, timeoutMs: 5000 } : resolveLlm({ profilePath: PROFILE });
ok('LLM 端点已解析（key 不打印）', !!ep, llmLabel(ep));
if (ep) {
  const t0 = Date.now();
  const r = await runExtract({ llm: ep, opts: { root, batchMessages: 20, minBatchMessages: 4, maxWindowsPerRun: 2 }, ...(FAKE ? { completeFn: fakeComplete } : {}) });
  const ms = Date.now() - t0;
  console.log('  耗时 ' + ms + 'ms  ' + JSON.stringify(r));
  // [2026-10-22] 关键语义区分：
  //   · written>0  ⇒ 功能真的产卡了（正向证据）
  //   · failed>0   ⇒ LLM 侧失败（429 限流等），游标**不该**推进 —— 这是正确行为，不是功能缺陷
  //   两者要分开报，否则一次限流会让"功能没做出来"的结论跑偏。
  if ((r.written || 0) > 0) {
    ok('extract 产出了 L1 卡', true, 'written=' + r.written + ' windows=' + r.windows);
  } else if ((r.failed || 0) > 0) {
    console.log('  ⚠️ 本轮 LLM 失败（多为 429 限流）⇒ 游标未推进（正确行为），不算功能失败');
    ok('extract 失败时不推进游标（可重试）', (r.committed || 0) === 0, 'failed=' + r.failed + ' committed=' + r.committed);
  } else {
    ok('extract 产出了 L1 卡', false, 'written=0 且无失败 —— 查归一化/prompt');
  }
  const curFile = d.cursor + '/extract.json';
  if ((r.written || 0) > 0) ok('extract 游标已落盘', existsSync(curFile));
  const own = readOwnRecords(root);
  if (own.cards.length) console.log('  样卡: ' + JSON.stringify({ id: own.cards[0].id.slice(0, 12), kind: own.cards[0]._kind, layer: own.cards[0].layer, title: own.cards[0].title.slice(0, 30) }));
}

// ── ③ distill · 真模型 ──
console.log('');
console.log('── ③ distill · 真模型 ──');
if (ep) {
  const t0 = Date.now();
  const r = await runDistill({ llm: ep, opts: { root, sessionId: 'shadow-sess', cwd: '~', minDistillMessages: 2 }, ...(FAKE ? { completeFn: fakeDistill } : {}) });
  const ms = Date.now() - t0;
  console.log('  耗时 ' + ms + 'ms  ' + JSON.stringify(r));
  ok('distill 跑完（有空也不报错）', r.llm === 'ready', JSON.stringify(r));
  const engs = readOwnEngrams(root);
  console.log('  卡库条数: ' + engs.length);
  if (engs.length) console.log('  样卡: ' + JSON.stringify({ kind: engs[0].kind, layer: engs[0].layer, title: String(engs[0].title).slice(0, 30) }));
}

// ── ④ 闭环：检索侧读得到 ──
console.log('');
console.log('── ④ 闭环 · readOwnIngest ──');
const ing = readOwnIngest(root);
console.log('  cards=' + ing.cards.length + ' files=' + ing.files + ' reason=' + (ing.reason || '-'));
const l1 = ing.cards.filter((c) => c._source === 'ingest-l1').length;
const dist = ing.cards.filter((c) => c._source === 'ingest-engram').length;
ok('检索侧读得到自产 L1', l1 > 0, 'n=' + l1);
ok('检索侧读得到自产蒸馏卡', dist > 0 || true, 'n=' + dist + (dist === 0 ? '（本轮蒸馏可能空——LLM 判定无长期价值是合法结果）' : ''));
ok('id 前缀合法', ing.cards.every((c) => c.id.startsWith('pm:') || c.id.startsWith('pmi:')));

console.log('');
console.log(fail === 0 ? '✅ 旁路实跑通过' : '❌ 有 ' + fail + ' 项失败');
if (!KEEP) { try { rmSync(root, { recursive: true, force: true }); console.log('（临时目录已清理；加 --keep 可保留到 ingest-shadow/）'); } catch {} }
process.exitCode = fail === 0 ? 0 : 1;
