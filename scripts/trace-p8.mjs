#!/usr/bin/env node
/**
 * scripts/trace-p8.mjs —— 生成交给白队的 Trace 日志（期8.1/8.2 实证）
 * [2026-10-23 by Assistant]
 *
 * 白队原话：「跑完拿 Trace 日志来找我，我们看数据说话。」
 * 本脚本把 Case 1 / Case 2 的**真实执行轨迹**落成可审的 JSON + Markdown。
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import {
  judgeConflict, filterEngrams, detectQueryScopes,
  inferSourceWeight, normalizeEngramV2, STATUS,
} from '../lib/ingest/belief.js';
import { createConsolidation } from '../lib/ingest/consolidate.js';
import { dataPath } from '../lib/paths.js';

const OUT_DIR = dataPath('ingest/traces');
mkdirSync(OUT_DIR, { recursive: true });

const trace = { at: new Date().toISOString(), cases: {} };

// ── Case 1 ──
{
  const T = 1792667400000;
  const egA = normalizeEngramV2({ id: 'egA', claim: 'MTP 可用', scope_tags: ['ubuntu'],
    confidence: inferSourceWeight({ role: 'user', text: '周一在 Ubuntu 下测过 MTP，运行正常。' }), createdAt: T, updatedAt: T });
  const egB = normalizeEngramV2({ id: 'egB', claim: 'MTP 不兼容', scope_tags: ['arch'],
    confidence: inferSourceWeight({ role: 'user', text: '周三在 Arch 下测 MTP 直接 OOM 报错。' }), createdAt: T + 172800000, updatedAt: T + 172800000 });
  const verdict = judgeConflict(egB, egA);
  egA.status = verdict.oldStatus; egB.status = verdict.newStatus;

  const q1 = 'MTP 能用吗';
  const q2 = 'Arch 下 MTP 怎样';
  const s1 = detectQueryScopes(q1), s2 = detectQueryScopes(q2);
  const r1 = filterEngrams([egA, egB], { mode: 'default', scopes: s1 });
  const r2 = filterEngrams([egA, egB], { mode: 'default', scopes: s2 });

  trace.cases.case1 = {
    verdict,
    egA: { claim: egA.claim, scope: egA.scope_tags, confidence: egA.confidence, status: egA.status },
    egB: { claim: egB.claim, scope: egB.scope_tags, confidence: egB.confidence, status: egB.status },
    query_no_scope: { q: q1, scopes: s1, hit: r1.map((x) => x.id + ':' + x.scope_tags.join('/')) },
    query_arch: { q: q2, scopes: s2, hit: r2.map((x) => x.id + ':' + x.scope_tags.join('/')) },
    pass: {
      fork_not_refute: verdict.action === 'fork' && egA.status !== STATUS.REFUTED,
      dual_recall: r1.length === 2,
      arch_only_b: r2.length === 1 && r2[0].id === 'egB',
    },
  };
}

// ── Case 2 ──
{
  let clock = 1792667400000;
  const committed = [];
  const cons = createConsolidation({ now: () => clock, idleMs: 30 * 60 * 1000, onCommit: (e) => committed.push(e) });
  const SID = 'session-case2';

  const steps = [];
  const push = (label, claim) => {
    cons.stage(SID, { engram_key: 'A方案', title: claim, claim, confidence: 0.6, scope_tags: ['global'] });
    steps.push({ at: new Date(clock).toISOString(), utterance: claim, committedSoFar: committed.length, pending: cons.pendingCount(SID) });
  };

  push('t0', '放弃 A 方案');
  clock += 3 * 60000;
  push('t+3min', 'A 方案打补丁还能救');
  clock += 5 * 60000;
  push('t+8min', '彻底废弃 A 方案');

  const arch = cons.archive(SID, { reason: 'manual' });
  const finalE = committed[0];

  trace.cases.case2 = {
    steps,
    archive: { committed: arch.committed, trace: String(finalE && finalE.trace || ''), claim: String(finalE && finalE.claim || ''), status: String(finalE && finalE.status || '') },
    pass: {
      no_write_during_session: steps.every((s) => s.committedSoFar === 0),
      single_final: arch.committed === 1,
      trace_has_history: /放弃/.test(String(finalE && finalE.trace || '')) && /救/.test(String(finalE && finalE.trace || '')),
      no_oscillation: !filterEngrams(committed, { mode: 'default', scopes: [] }).some((e) => /救/.test(String(e.claim || ''))),
    },
  };
}

const jsonPath = OUT_DIR + '/p8-trace-' + Date.now() + '.json';
writeFileSync(jsonPath, JSON.stringify(trace, null, 2), 'utf8');

const md = [
  '# 期8 对抗基准 Trace（交给白队）',
  '',
  '生成时间：' + trace.at,
  '',
  '## Case 1 · 跨环境条件分裂',
  '',
  '**判决**：`' + trace.cases.case1.verdict.action + '`（' + trace.cases.case1.verdict.reason + '）',
  '',
  '| 卡片 | 主张 | scope | confidence | status |',
  '|---|---|---|---|---|',
  '| egA | ' + trace.cases.case1.egA.claim + ' | ' + trace.cases.case1.egA.scope.join('/') + ' | ' + trace.cases.case1.egA.confidence + ' | ' + trace.cases.case1.egA.status + ' |',
  '| egB | ' + trace.cases.case1.egB.claim + ' | ' + trace.cases.case1.egB.scope.join('/') + ' | ' + trace.cases.case1.egB.confidence + ' | ' + trace.cases.case1.egB.status + ' |',
  '',
  '| 查询 | 识别 scope | 命中 |',
  '|---|---|---|',
  '| ' + trace.cases.case1.query_no_scope.q + ' | ' + JSON.stringify(trace.cases.case1.query_no_scope.scopes) + ' | ' + trace.cases.case1.query_no_scope.hit.join(' , ') + ' |',
  '| ' + trace.cases.case1.query_arch.q + ' | ' + JSON.stringify(trace.cases.case1.query_arch.scopes) + ' | ' + trace.cases.case1.query_arch.hit.join(' , ') + ' |',
  '',
  '**判据**：' + JSON.stringify(trace.cases.case1.pass, null, 0),
  '',
  '## Case 2 · 多轮拉锯与冷却期',
  '',
  '| 时刻 | 用户原话 | 已落盘 | pending |',
  '|---|---|---|---|',
  ...trace.cases.case2.steps.map((s) => '| ' + s.at.slice(11, 19) + ' | ' + s.utterance + ' | ' + s.committedSoFar + ' | ' + s.pending + ' |'),
  '',
  '**归档结果**：只写 ' + trace.cases.case2.archive.committed + ' 条',
  '',
  '- 最终 claim：`' + trace.cases.case2.archive.claim + '`',
  '- 折叠 trace：`' + trace.cases.case2.archive.trace + '`',
  '- status：`' + trace.cases.case2.archive.status + '`',
  '',
  '**判据**：' + JSON.stringify(trace.cases.case2.pass, null, 0),
  '',
  '---',
  '',
  '*Assistant · 期8.1/8.2 实证*',
].join('\n');

const mdPath = OUT_DIR + '/p8-trace-' + Date.now() + '.md';
writeFileSync(mdPath, md, 'utf8');

console.log('JSON: ' + jsonPath);
console.log('MD  : ' + mdPath);
