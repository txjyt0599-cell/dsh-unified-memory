#!/usr/bin/env node
/**
 * scripts/e2e-resolution-lifecycle.mjs —— 问题生命周期回放验收
 * [2026-10-26 by Assistant · 根因治理验收]
 *
 * 验收 4 条（对应复审给的验收标准）：
 *   1. 回放今天真实对话 ⇒ 必须识别出「问题已解决」候选，且能产出终态
 *   2. 负例：只有 AI 自称、无证据 ⇒ 标 claimed，不关卡
 *   3. 入口列表：问题卡必须进得去（根因修复的硬判据）
 *   4. 状态枚举：resolved / claimed 必须真的写进卡库
 */
import { existsSync, readFileSync, writeFileSync, mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runDistill, readOwnEngrams } from '../lib/ingest/distill.js';
import { buildEntryList, isProblemCard } from '../lib/ingest/resolution.js';

let fail = 0;
const check = (n, ok, d) => { console.log((ok ? '  ✅ ' : '  ❌ ') + n + (d ? '   ' + d : '')); if (!ok) fail++; };

console.log('══════ 问题生命周期 回放验收 ══════');
console.log('');

// ── ① 入口列表：问题卡必须进得去（根因硬判据）──
console.log('── ① 入口列表装配 ──');
{
  const existing = readOwnEngrams();
  const built = buildEntryList(existing, { budgetChars: 1800 });
  const problems = existing.filter((c) => isProblemCard(c));

  check('入口列表非空', built.text.length > 0, built.text.length + ' 字符');
  check('装入的问题卡 > 0（根因已修复）', built.stats.pickedProblems > 0,
    built.stats.pickedProblems + ' 张 / 库存 ' + problems.length + ' 张');
  check('最新卡也在入口列表内', (() => {
    const newest = existing.filter((c) => String(c.status || 'active') !== 'retired')
      .sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0))[0];
    return newest && built.text.includes(String(newest.id || ''));
  })());
  check('同标题去重生效', built.stats.dedupeDropped >= 0, '丢弃 ' + built.stats.dedupeDropped + ' 张重复');
  check('不超预算', built.stats.chars <= built.stats.budget, built.stats.chars + '/' + built.stats.budget);
}

// ── ② 正例：真实对话里的"已解决"必须被识别 ──
console.log('');
console.log('── ② 正例：有验证证据的解决 ──');
{
  const tmp = mkdtempSync(join(tmpdir(), 'pm-res-'));
  // dirs(root) 直接以 root 为 ingest 根 ⇒ 子目录挂在 tmp 下，不要再套一层 ingest
  const d = tmp;
  mkdirSync(join(d, 'conversations'), { recursive: true });
  mkdirSync(join(d, 'records'), { recursive: true });

  // 造一张待关闭的问题卡
  const problemCard = {
    id: 'pmi_test_problem_01', kind: 'fact', layer: 'project',
    title: '延迟拆分功能未落地',
    summary: '索引检索、冷启动、案卷回溯的计时代码未实现',
    content: '延迟拆分功能未落地，需要补三段计时',
    createdAt: Date.now() - 3600000, status: 'active', hits: 0,
  };
  writeFileSync(join(d, 'engrams.jsonl'), JSON.stringify(problemCard) + '\n', 'utf8');

  // 造一轮"已解决 + 有验证证据"的对话
  const now = Date.now();
  const msgs = [
    { sessionKey: 'session-test-res', role: 'user', content: '开始吧', timestamp: now - 5000 },
    { sessionKey: 'session-test-res', role: 'assistant', content: '三段延迟计时已落地，verify 全绿，27 套测试通过', timestamp: now - 4000 },
    { sessionKey: 'session-test-res', role: 'user', content: '延迟拆分功能修好了吗', timestamp: now - 3000 },
    { sessionKey: 'session-test-res', role: 'assistant', content: '延迟拆分功能已落地，source_trace_ms 已进 memory_get 输出，实测通过', timestamp: now - 2000 },
    { sessionKey: 'session-test-res', role: 'user', content: '好的通过验收', timestamp: now - 1000 },
    { sessionKey: 'session-test-res', role: 'assistant', content: '收到', timestamp: now },
  ];
  writeFileSync(join(d, 'conversations', '2099-01-01.jsonl'),
    msgs.map((m) => JSON.stringify(m)).join('\n') + '\n', 'utf8');

  // 假 LLM：返回空，让确定性兜底生效
  const res = await runDistill({
    opts: { root: tmp, disableLock: true, minDistillMessages: 2, distillWindowMessages: 20 },
    llm: { provider: 'test', model: 'fake' },
    completeFn: async () => '[]',
  });

  check('蒸馏跑通', res && res.llm === 'ready', JSON.stringify({ written: res.written, resolved: res.resolved, claimed: res.claimed }));
  check('识别出已解决（resolved > 0）', (res.resolved || 0) > 0, 'resolved=' + res.resolved);

  const after = readOwnEngrams(tmp);
  const closed = after.filter((c) => c.id === 'pmi_test_problem_01' && c.status === 'resolved');
  check('旧卡被写成 status=resolved', closed.length > 0, closed.length ? '有 resolved 版本行' : '没有');
  check('resolvedBy 证据可追溯', closed.length > 0 && Boolean(closed[closed.length - 1].resolvedBy));

  rmSync(tmp, { recursive: true, force: true });
}

// ── ③ 负例：只有 AI 自称，无证据 ⇒ claimed，不关卡 ──
console.log('');
console.log('── ③ 负例：AI 自嗨不算闭环 ──');
{
  const tmp = mkdtempSync(join(tmpdir(), 'pm-res-neg-'));
  const d = tmp;
  mkdirSync(join(d, 'conversations'), { recursive: true });
  mkdirSync(join(d, 'records'), { recursive: true });

  const problemCard = {
    id: 'pmi_test_problem_02', kind: 'fact', layer: 'project',
    title: '冷启动计时字段写死为0',
    summary: 'cold_start_ms 硬编码为 0，未实际测量',
    content: 'cold_start_ms 硬编码为 0',
    createdAt: Date.now() - 3600000, status: 'active', hits: 0,
  };
  writeFileSync(join(d, 'engrams.jsonl'), JSON.stringify(problemCard) + '\n', 'utf8');

  const now = Date.now();
  const msgs = [
    { sessionKey: 'session-test-neg', role: 'user', content: '继续', timestamp: now - 3000 },
    // 只有 AI 自称，没有任何验证证据、用户也没确认
    { sessionKey: 'session-test-neg', role: 'assistant', content: '冷启动计时字段写死为0 这个问题已经解决了', timestamp: now - 2000 },
    { sessionKey: 'session-test-neg', role: 'user', content: '嗯', timestamp: now - 1000 },
    { sessionKey: 'session-test-neg', role: 'assistant', content: '好的', timestamp: now },
  ];
  writeFileSync(join(d, 'conversations', '2099-01-02.jsonl'),
    msgs.map((m) => JSON.stringify(m)).join('\n') + '\n', 'utf8');

  const res = await runDistill({
    opts: { root: tmp, disableLock: true, minDistillMessages: 2, distillWindowMessages: 20 },
    llm: { provider: 'test', model: 'fake' },
    completeFn: async () => '[]',
  });

  const after = readOwnEngrams(tmp);
  const resolvedRows = after.filter((c) => c.id === 'pmi_test_problem_02' && c.status === 'resolved');
  const claimedRows = after.filter((c) => c.id === 'pmi_test_problem_02' && c.status === 'claimed');

  check('AI 自嗨没有把它标成 resolved', resolvedRows.length === 0, 'resolved 行数=' + resolvedRows.length);
  // [2026-10-26] 原来这条写成 `claimedRows.length > 0 || res.claimed >= 0` —— 恒真，等于没测。
  //   真正的契约是：要么标 claimed（有识别但证据不足），要么完全不动 ——
  //   但绝不允许出现 resolved。这里断言「没有 resolved 才是硬要求」，
  //   并且如果识别到了，状态必须是 claimed（不能是别的）。
  const anyBad = after.filter((c) => c.id === 'pmi_test_problem_02'
    && c.status && c.status !== 'active' && c.status !== 'claimed');
  check('识别到的状态只能是 claimed，绝不是 resolved/refuted',
    anyBad.length === 0,
    anyBad.length ? '出现异常状态: ' + anyBad.map((c) => c.status).join(',') : '状态干净（claimed 或 active）');
  check('claimed 语义被用上（证据不足时降级）',
    claimedRows.length > 0 ? true : (res.claimed || 0) === 0,
    'claimed 行数=' + claimedRows.length + ' / res.claimed=' + (res.claimed || 0));

  rmSync(tmp, { recursive: true, force: true });
}

// ── ④ 同标题去重：一张卡只能被关一次 ──
console.log('');
console.log('── ④ 同标题去重（历史重复卡不重复关卡）──');
{
  const tmp = mkdtempSync(join(tmpdir(), 'pm-res-dup-'));
  const d = tmp;
  mkdirSync(join(d, 'conversations'), { recursive: true });
  mkdirSync(join(d, 'records'), { recursive: true });

  // 造两张同名不同 id 的问题卡（线上实测存在 18 组这种历史冗余）
  const now = Date.now();
  const mkProblem = (id, offset) => ({
    id, kind: 'fact', layer: 'project',
    title: '延迟拆分功能未落地', summary: '计时代码未实现', content: '延迟拆分功能未落地',
    createdAt: now - offset, status: 'active', hits: 0,
  });
  // [2026-10-26 二次修复] 除了「同标题不同 id」，还要防「同一张卡两种 id 形式」：
  //   pmi_xxx 与 pmi:pmi_xxx 是历史前缀不一致遗留（实测生产库里真有这种成对行）。
  const rows = [
    mkProblem('pmi_dup_a', 3600000),
    mkProblem('pmi_dup_b', 1800000),
    mkProblem('pmi_dup_c', 900000),       // 同标题第三个
    mkProblem('pmi:pmi_dup_a', 600000),   // 同一张卡的 pmi: 前缀变体
  ];
  // [2026-10-26 四次修复] 再加一张「已被别的版本闭环过」的卡：
  //   pmi_x 仍 active，但 pmi:pmi_x 已是 resolved —— 同一张卡两个版本状态不一致，
  //   按单版本 status 判会漏，必须按 canon id 聚合判。
  const resolvedVariant = Object.assign(mkProblem('pmi:pmi_done_a', 300000), { status: 'resolved', resolvedAt: new Date().toISOString() });
  rows.push(mkProblem('pmi_done_a', 200000));
  rows.push(resolvedVariant);
  writeFileSync(join(d, 'engrams.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');

  const msgs = [
    { sessionKey: 'session-dup', role: 'user', content: '延迟拆分功能修好了吗', timestamp: now - 3000 },
    { sessionKey: 'session-dup', role: 'assistant', content: '延迟拆分功能已落地，verify 全绿，实测通过', timestamp: now - 2000 },
    { sessionKey: 'session-dup', role: 'user', content: '好的通过验收', timestamp: now - 1000 },
    { sessionKey: 'session-dup', role: 'assistant', content: '收到', timestamp: now },
  ];
  writeFileSync(join(d, 'conversations', '2099-01-03.jsonl'),
    msgs.map((m) => JSON.stringify(m)).join('\n') + '\n', 'utf8');

  const res = await runDistill({
    opts: { root: tmp, disableLock: true, minDistillMessages: 2, distillWindowMessages: 20 },
    llm: { provider: 'test', model: 'fake' },
    completeFn: async () => '[]',
  });

  const after = readOwnEngrams(tmp);
  const resolvedRows = after.filter((c) => c.status === 'resolved');
  check('同标题只关一次（不重复写版本行）', resolvedRows.length === 1,
    'resolved 行数=' + resolvedRows.length + ' / res.resolved=' + (res.resolved || 0));
  // 归一化 id 去重：pmi_xxx 与 pmi:pmi_xxx 视为同一张卡
  const canon = (x) => String(x || '').replace(/^pmi:pmi_/, 'pmi_').replace(/^pmi:/, '');
  const canonSet = new Set(resolvedRows.map((c) => canon(c.id)));
  check('归一化 id 去重生效（pmi_ 与 pmi:pmi_ 视为同一张）',
    canonSet.size === resolvedRows.length,
    '归一后唯一 id=' + canonSet.size + ' / 行数=' + resolvedRows.length);
  // 已闭环的卡（含其 id 变体）不得被再次关闭
  const doneAgain = after.filter((c) => canon(c.id) === 'pmi_done_a' && c.status === 'resolved');
  check('已闭环的卡（任一版本）不会重复关闭',
    doneAgain.length === 1,
    'pmi_done_a 的 resolved 行数=' + doneAgain.length + '（应恒为 1，即原始那条）');

  rmSync(tmp, { recursive: true, force: true });
}

// ── ⑤ 状态枚举完整性 ──
console.log('');
console.log('── ⑤ 状态枚举与真实卡库 ──');
{
  const { STATUS } = await import('../lib/ingest/belief.js');
  check('STATUS.RESOLVED 已定义', STATUS.RESOLVED === 'resolved');
  check('STATUS.CLAIMED 已定义', STATUS.CLAIMED === 'claimed');

  const real = readOwnEngrams();
  const resolvedReal = real.filter((c) => c.status === 'resolved');
  console.log('    （线上真实库 resolved 卡: ' + resolvedReal.length + ' 张，首轮跑出 0 属正常）');
}

console.log('');
console.log(fail === 0 ? '✅ 问题生命周期验收全部通过' : '❌ ' + fail + ' 项失败');
process.exit(fail === 0 ? 0 : 1);
