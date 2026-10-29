#!/usr/bin/env node
/**
 * scripts/e2e-distill-isolation.mjs —— 蒸馏的**并发归属隔离**验收
 * [2026-10-26 by Assistant · 白队 P0 指令]
 *
 * 事故背景：readRecentL0() 取「最近两天的共享 .jsonl」再按时间取最后 40 条，
 *   完全不管这 40 条是谁说的；写卡时统一盖 opts.sessionId（触发蒸馏的会话）
 *   ⇒ 两个窗口同时活跃时，A 的对话被记成 B 的卡（张冠李戴）。
 *
 * 锁住的合同：
 *   I1 只取 sessionKey 严格相等的消息
 *   I2 没有 sessionKey 的旧消息一条都不得进入蒸馏池
 *   I3 没有当前会话身份时，蒸馏整体不写卡（reason='no-session'）
 *   I4 端到端：A 蒸馏出的卡不含 B 的任何文本；B 亦然
 */
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { dirs, ensureDirs } from '../lib/ingest/core.js';
import { runDistill, readOwnEngrams, readRecentL0ForSession, resolveDistillSession } from '../lib/ingest/distill.js';

let pass = 0;
let fail = 0;
function check(g, name, ok, detail) {
  if (ok) { pass++; console.log('  PASS ' + g + ' ' + name + (detail ? '   ' + detail : '')); }
  else { fail++; console.log('  FAIL ' + g + ' ' + name + (detail ? '   ' + detail : '')); }
}

console.log('════ DISTILL ISOLATION · 并发归属隔离 ════');

const root = mkdtempSync(join(tmpdir(), 'pm-distill-iso-'));
const d = dirs(root);
ensureDirs(d);

const A_MARK = 'ALPHA_ONLY_标记甲';
const B_MARK = 'BRAVO_ONLY_标记乙';
const L_MARK = 'LEGACY_NO_KEY_标记丙';
const today = new Date().toISOString().slice(0, 10);
mkdirSync(d.conversations, { recursive: true });
const convFile = join(d.conversations, today + '.jsonl');

const rows = [];
let t = Date.now() - 60000;
for (let i = 0; i < 8; i++) {
  rows.push({ sessionKey: 'sess-A', sessionId: 'sess-A', role: i % 2 ? 'assistant' : 'user', content: A_MARK + ' 第' + i + '句 A 窗口在改 retriever 去重逻辑', timestamp: t += 1000, id: 'a' + i });
  rows.push({ sessionKey: 'sess-B', sessionId: 'sess-B', role: i % 2 ? 'assistant' : 'user', content: B_MARK + ' 第' + i + '句 B 窗口在调视频参数', timestamp: t += 1000, id: 'b' + i });
}
rows.push({ role: 'user', content: L_MARK + ' 没有 sessionKey 的历史消息', timestamp: t += 1000, id: 'l1' });
rows.push({ role: 'assistant', content: L_MARK + ' 第二条无 key 历史消息', timestamp: t += 1000, id: 'l2' });
writeFileSync(convFile, rows.map(function (r) { return JSON.stringify(r); }).join('\n') + '\n', 'utf8');

console.log('');
console.log('── I1 · 严格相等过滤 ──');
{
  const a = readRecentL0ForSession(d, 100, 'sess-A');
  const b = readRecentL0ForSession(d, 100, 'sess-B');
  check('I1', 'A 只拿到自己的 8 条', a.length === 8, 'got=' + a.length);
  check('I1', 'A 的文本里有 A 标记', a.every(function (m) { return m.content.indexOf(A_MARK) >= 0; }));
  check('I1', 'A 的文本里没有 B 标记', a.every(function (m) { return m.content.indexOf(B_MARK) < 0; }));
  check('I1', 'B 只拿到自己的 8 条', b.length === 8, 'got=' + b.length);
  check('I1', 'B 的文本里没有 A 标记', b.every(function (m) { return m.content.indexOf(A_MARK) < 0; }));
}

console.log('');
console.log('── I2 · 无 sessionKey 的旧消息必须被挡住 ──');
{
  const a = readRecentL0ForSession(d, 100, 'sess-A');
  const b = readRecentL0ForSession(d, 100, 'sess-B');
  check('I2', 'A 里没有 legacy 消息', a.every(function (m) { return m.content.indexOf(L_MARK) < 0; }));
  check('I2', 'B 里没有 legacy 消息', b.every(function (m) { return m.content.indexOf(L_MARK) < 0; }));
}

console.log('');
console.log('── I3 · 没有会话身份就不写卡 ──');
{
  check('I3', 'sessionKey 为空返回空数组', readRecentL0ForSession(d, 100, '').length === 0);
  check('I3', 'sessionKey 缺失返回空数组', readRecentL0ForSession(d, 100, undefined).length === 0);
}

{
  // ① 完全没有可蒸的消息 ⇒ 才允许 no-session
  const emptyRoot = mkdtempSync(join(tmpdir(), 'pm-distill-empty-'));
  const de = dirs(emptyRoot);
  ensureDirs(de);
  const rEmpty = await runDistill({ llm: { baseUrl: 'http://x', model: 'stub' }, opts: { root: emptyRoot, minDistillMessages: 1 }, completeFn: async function () { return '[]'; } });
  check('I3', '无消息时 runDistill 返回 no-session', rEmpty.written === 0 && rEmpty.reason === 'no-session', JSON.stringify(rEmpty));
  try { rmSync(emptyRoot, { recursive: true, force: true }); } catch (e) {}

  // ② 有消息但**没传 sessionId**（后台定时/手动触发）⇒ 锁定最近活跃会话，绝不混采、绝不静默停产
  const resolved = resolveDistillSession(d);
  check('I3', '能解析出最近活跃会话（已归一化）', resolved === 'session-sess-B', 'resolved=' + resolved);

  // ③ 最近活跃的那个会话**没有新消息**时，不能因为"别的会话有新消息"就误蒸
  const rFallback = await runDistill({
    llm: { baseUrl: 'http://x', model: 'stub' },
    opts: { root: root, minDistillMessages: 1, distillWindowMessages: 100 },
    completeFn: async function (ep, sys, user) {
      const body = String(user || '');
      check('I3', '兜底蒸馏只含单一会话（不含 A 标记）', body.indexOf(A_MARK) < 0);
      check('I3', '兜底蒸馏拿到了 B 的内容', body.indexOf(B_MARK) >= 0);
      return stubCard(body);
    },
  });
  check('I3', '兜底蒸馏正常执行（未静默停产）', rFallback.items >= 1, JSON.stringify({ items: rFallback.items, reason: rFallback.reason }));
}

function stubCard(body) {
  let tag = 'X';
  if (body.indexOf(A_MARK) >= 0) tag = 'A';
  else if (body.indexOf(B_MARK) >= 0) tag = 'B';
  return JSON.stringify([{
    kind: 'note',
    layer: 'global',
    title: '归属隔离探针 ' + tag,
    summary: '归属隔离探针 ' + tag + ' 用于验证蒸馏只看到本会话消息。',   // 必须带 tag，否则 A/B 两张卡会被去重合并
    content: '模型实际收到的对话为：' + body.replace(/\s+/g, ' ').slice(0, 600),
    causesOf: [],
  }]);
}

console.log('');
console.log('── I4 · 端到端：A 的卡不得含 B 的任何文本 ──');
{
  // 清蒸馏游标 + 清空卡库：I3 的兜底跑已经消费过这批消息并写了一张 B 的卡，
  //   不清的话 I4 会 (a) 报 not-enough-new (b) 在 A 的落盘断言里看到 B 的旧卡。
  try { rmSync(d.cursor + '/distill.json', { force: true }); } catch (e) {}
  writeFileSync(d.engrams, '', 'utf8');
  let promptA = '';
  const ra = await runDistill({
    llm: { baseUrl: 'http://x', model: 'stub' },
    opts: { root: root, sessionId: 'sess-A', cwd: 'D:/test', minDistillMessages: 1, distillWindowMessages: 100 },
    completeFn: async function (ep, sys, user) { promptA = String(user || ''); return stubCard(promptA); },
  });
  check('I4', 'A 蒸馏确实写了卡', ra.written >= 1, JSON.stringify(ra));
  check('I4', 'A 的 prompt 含 A 标记', promptA.indexOf(A_MARK) >= 0);
  check('I4', 'A 的 prompt 不含 B 标记', promptA.indexOf(B_MARK) < 0);
  check('I4', 'A 的 prompt 不含 legacy 标记', promptA.indexOf(L_MARK) < 0);

  const afterA = readOwnEngrams(root).map(function (c) { return String(c.content || '') + String(c.summary || ''); }).join('\n');
  check('I4', 'A 落盘的卡不含 B 标记', afterA.indexOf(B_MARK) < 0);
  check('I4', 'A 落盘的卡不含 legacy 标记', afterA.indexOf(L_MARK) < 0);

  // 清空卡库，逼 B 必须**新写**（否则 A 的卡会让 B 命中 2-gram 去重，测不出隔离）
  writeFileSync(d.engrams, '', 'utf8');
  let promptB = '';
  const rb = await runDistill({
    llm: { baseUrl: 'http://x', model: 'stub' },
    opts: { root: root, sessionId: 'sess-B', cwd: 'D:/test', minDistillMessages: 1, distillWindowMessages: 100 },
    completeFn: async function (ep, sys, user) { promptB = String(user || ''); return stubCard(promptB); },
  });
  check('I4', 'B 蒸馏确实写了卡', rb.written >= 1, JSON.stringify(rb));
  check('I4', 'B 的 prompt 含 B 标记', promptB.indexOf(B_MARK) >= 0);
  check('I4', 'B 的 prompt 不含 A 标记', promptB.indexOf(A_MARK) < 0);

  // 只检查 B 这一轮**新写**的卡（库里还留着 A 的卡，整库扫必然误判）
  const newB = readOwnEngrams(root);
  const newBText = newB.map(function (c) { return String(c.content || '') + String(c.summary || '') + String(c.title || ''); }).join('\n');
  check('I4', 'B 这一轮新写了卡', newB.length >= 1, 'new=' + newB.length);
  check('I4', 'B 新写的卡不含 A 标记', newBText.indexOf(A_MARK) < 0);
}

// ── I5 · 反例：前缀相似的会话 id 不许串台（2026-10-28 by Assistant · 补反例）──
//   真实危险：会话 id 形如 session-<uuid>，历史上存在带后缀/别名的写法。
//   若过滤用 indexOf / startsWith 而不是严格相等，session-aaaa 与 session-aaaa-bbbb
//   就会互相串台 —— 而所有正向测试都绿，看不出来。
console.log('');
console.log('── I5 · 反例：前缀相似 id 不许串台 ──');
{
  const root2 = mkdtempSync(join(tmpdir(), 'pm-distill-prefix-'));
  const d2 = dirs(root2);
  ensureDirs(d2);
  const P_MAIN = '前缀反例主语标PMAIN';
  const P_OTHER = '前缀反例旁支标POTHER';
  const ts = Date.now();
  const idMain = 'session-aaaa';
  const idOther = 'session-aaaa-bbbb';
  const writeL0 = (sid, text, t) => {
    const f = d2.conversations + '/' + new Date(t).toISOString().slice(0, 10) + '.jsonl';
    appendFileSync(f, JSON.stringify({ id: 'm-' + Math.random().toString(36).slice(2), sessionKey: sid, sessionId: sid, role: 'user', content: text, timestamp: t }) + '\n', 'utf8');
    appendFileSync(f, JSON.stringify({ id: 'm-' + Math.random().toString(36).slice(2), sessionKey: sid, sessionId: sid, role: 'assistant', content: text + ' 的回答', timestamp: t + 1 }) + '\n', 'utf8');
  };
  writeL0(idMain, P_MAIN, ts);
  writeL0(idOther, P_OTHER, ts + 10);

  const got = readRecentL0ForSession(d2, 100, idMain);
  const text = got.map(function (m) { return String(m.content || ''); }).join('\n');
  check('I5', '取 session-aaaa 时拿到自己的消息', text.indexOf(P_MAIN) >= 0);
  check('I5', '**取 session-aaaa 时绝不带 session-aaaa-bbbb 的消息**（前缀不串台）',
    text.indexOf(P_OTHER) < 0, text.indexOf(P_OTHER) >= 0 ? '⛔ 串台了！' : '隔离正确');

  const got2 = readRecentL0ForSession(d2, 100, idOther);
  const text2 = got2.map(function (m) { return String(m.content || ''); }).join('\n');
  check('I5', '反向取 session-aaaa-bbbb 时也拿到自己的', text2.indexOf(P_OTHER) >= 0,
    text2.indexOf(P_OTHER) >= 0 ? 'ok' : '⛔ 取不到自己的（说明归一化过严）');

  const got3 = readRecentL0ForSession(d2, 100, 'aaaa');
  const text3 = got3.map(function (m) { return String(m.content || ''); }).join('\n');
  check('I5', '不写 session- 前缀也能取到（归一化等价）', text3.indexOf(P_MAIN) >= 0);

  try { rmSync(root2, { recursive: true, force: true }); } catch (e) {}
}

try { rmSync(root, { recursive: true, force: true }); } catch (e) {}

console.log('');
console.log('────────────────────────────────');
console.log(fail === 0
  ? ('DISTILL-ISO-DONE  checks=' + (pass + fail) + ' passed=' + pass + ' failed=0')
  : ('DISTILL-ISO-FAILED  passed=' + pass + ' failed=' + fail));
process.exitCode = fail === 0 ? 0 : 1;
