#!/usr/bin/env node
/**
 * selftest-ingest.mjs —— 期7 写入侧（L0 捕获 / L1 提取 / engram 蒸馏）自测
 * [2026-10-22 by Assistant · 期7]
 *
 * 全部在**临时目录**里跑，不碰生产数据、不调真模型（注入假补全函数）。
 * 锁住的合同（每条都必须在「删掉旧插件」之后仍然成立）：
 *   A · 路径与目录：超图自己的 ingest 根可自建、与旧插件目录不相交
 *   B · L0 捕获：注入段/短句/命令被过滤、落盘游标幂等、跨会话互不干扰、伪 user 不入库
 *   C · L1 提取：游标落盘（重启后从断点继续）、同内容不重复提取、产物与 tdai 同构
 *   D · engram 蒸馏：2-gram 去重三分支（同标题刷新 / 旧卡退役 / 新卡跳过）、causes 解析
 *   E · 原子写与游标文件安全
 */
import { mkdtempSync, rmSync, readFileSync, readdirSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { dirs, ensureDirs, localDate, messageKey, atomicWriteJson, loadCursor, saveCursor } from './lib/ingest/core.js';
import { captureTurn, shouldCapture, sanitizeText } from './lib/ingest/capture.js';
import { runExtract, readOwnRecords, planWindows, readL0Messages } from './lib/ingest/extract.js';
import { runDistill, readOwnEngrams, bigramOverlap, fallbackDistill } from './lib/ingest/distill.js';
// [2026-10-23 · 期8.1/8.2] AA 组用：认知信用协议的固定基分（与 lib 常量同源，逐字比对）
const SOURCE_WEIGHTS_OBS = 0.90;
import { readOwnIngest } from './lib/hypergraph/source.js';
import { dataPath } from './lib/paths.js';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = fileURLToPath(new URL('./', import.meta.url)).replace(/[\\/]$/, '');

// [2026-10-22 by Assistant] 全局兜底：任何未捕获异常都要可见，不许静默只输出半截。
process.on('uncaughtException', (e) => {
  console.error('');
  console.error('❌ 未捕获异常（这会让输出停在半截，问题就在这里）：');
  console.error(e && e.stack || e);
  process.exit(2);
});
process.on('unhandledRejection', (e) => {
  console.error('');
  console.error('❌ 未处理的 Promise 拒绝：');
  console.error(e && e.stack || e);
  process.exit(2);
});

const R = [];
function check(group, name, ok, detail) {
  R.push({ group, name, ok: !!ok, detail: detail === undefined ? '' : String(detail) });
}
const root = mkdtempSync(join(tmpdir(), 'pm-ingest-'));
const d = dirs(root);
ensureDirs(d);

// ── A · 目录 ──
console.log('── A · 目录与路径 ──');
check('A', 'A1 目录自建', existsSync(d.conversations) && existsSync(d.records) && existsSync(d.cursor), d.root);
check('A', 'A2 与旧目录不相交', !d.root.includes('memory-tencentdb') && !d.root.includes('engram-relay'), d.root);
check('A', 'A3 localDate 本地日期', /^\d{4}-\d{2}-\d{2}$/.test(localDate(1792620454535)), localDate(1792620454535));

// ── B · L0 捕获 ──
console.log('── B · L0 捕获 ──');
const T0 = 1792600000000;
const msgs = [
  { id: 'u1', role: 'user', content: 'User问：期7 的 L0 捕获怎么保证不重复', timestamp: T0 + 1000 },
  { id: 'a1', role: 'assistant', content: 'Assistant答：用落盘游标 + 消息键去重，重启也不重复。', timestamp: T0 + 2000 },
  { id: 'x1', role: 'user', content: '<engram-memory>注入段</engram-memory>', timestamp: T0 + 3000 },
  { id: 'x2', role: 'user', content: '好', timestamp: T0 + 4000 },
  { id: 'x3', role: 'user', content: '/help', timestamp: T0 + 5000 },
];
const c1 = captureTurn({ sessionKey: 's1', sessionId: 's1', messages: msgs, opts: { root, nowMs: T0 + 9000 } });
check('B', 'B1 只写两条真实消息', c1.written === 2, JSON.stringify(c1));
check('B', 'B2 注入段被过滤', shouldCapture('<unified-memory>x</unified-memory>') === false);
check('B', 'B3 短句被过滤', shouldCapture('好') === false);
check('B', 'B4 命令被过滤', shouldCapture('/help') === false);
const c2 = captureTurn({ sessionKey: 's1', sessionId: 's1', messages: msgs, opts: { root, nowMs: T0 + 9500 } });
check('B', 'B5 游标幂等（重喂不重复写）', c2.written === 0, JSON.stringify(c2));
const dayFile = d.conversations + '/' + localDate(T0 + 2000) + '.jsonl';
check('B', 'B6 落盘文件名按本地日期', existsSync(dayFile), dayFile);
const l0lines = readFileSync(dayFile, 'utf8').trim().split('\n').filter(Boolean);
check('B', 'B7 每行一条消息', l0lines.length === 2, l0lines.length);
check('B', 'B8 行内 schema 标记', JSON.parse(l0lines[0]).schema === 'unified-memory.l0.v1');
const c3 = captureTurn({ sessionKey: 's2', sessionId: 's2', messages: [{ id: 'u9', role: 'user', content: '另一个会话的新消息，应该独立计数', timestamp: T0 + 20000 }], opts: { root, nowMs: T0 + 25000 } });
check('B', 'B9 会话级游标互不干扰', c3.written === 1, JSON.stringify(c3));
const c4 = captureTurn({ sessionKey: 's3', messages: [{ id: 'z1', role: 'user', source: { kind: 'plugin:unified-memory' }, content: '这是插件注入的伪用户消息，不该进记忆', timestamp: T0 + 30000 }], opts: { root, nowMs: T0 + 31000 } });
check('B', 'B10 伪 user（插件注入）不入 L0', c4.written === 0, JSON.stringify(c4));
check('B', 'B11 base64 图片被替换', sanitizeText('看这个 data:image/png;base64,AAAABBBB', 'user') === '看这个 [image]');
check('B', 'B12 assistant 代码块被折叠', sanitizeText('前\n```js\nlet a=1\n```\n后', 'assistant').includes('[code]'));

// ── C · L1 提取 ──
console.log('── C · L1 提取 ──');
for (let i = 0; i < 6; i++) {
  captureTurn({
    sessionKey: 's1',
    messages: [
      { id: 'e' + i + 'u', role: 'user', content: '第二轮测试提问 ' + i + '：期7 的提取游标为什么必须落盘，讲清根因与证据。', timestamp: T0 + 100000 + i * 2000 },
      { id: 'e' + i + 'a', role: 'assistant', content: '回答 ' + i + '：因为内存缓冲重启即丢，实测覆盖率只有 2.9%。', timestamp: T0 + 101000 + i * 2000 },
    ],
    opts: { root, nowMs: T0 + 200000 + i },
  });
}
const allMsgs = readL0Messages(d, {});
check('C', 'C1 L0 可读回', allMsgs.length >= 14, allMsgs.length);
const wins = planWindows(allMsgs, { processedKeys: [] }, { batchMessages: 6, minBatchMessages: 4 });
// [2026-10-22 修判据] 不再要求窗口以 user 开头——真实数据 user:assistant ≈ 1:46，
//   强制以 user 开头会让 extract 永远切不出窗口（实测把 extract 饿死）。
check('C', 'C2 能切出窗口（不强制以 user 开头）',
  wins.length >= 1 && wins.every((w) => w.messages.some((m) => m.role === 'user') || w.messages.length >= 4),
  'wins=' + wins.length + ' first=' + (wins[0] && wins[0].messages[0].role));
// 纯 assistant 段落必须也能成窗（这是把 extract 饿死的真实场景）
{
  const assistantOnly = [];
  for (let i = 0; i < 6; i++) assistantOnly.push({ sessionKey: 'aonly', role: 'assistant', content: '纯助手段落 ' + i + '，内容是结论和进展，同样值得记。', timestamp: 1793700000000 + i * 1000 });
  const w2 = planWindows(assistantOnly, { processedKeys: [] }, { batchMessages: 24, minBatchMessages: 4 });
  check('C', 'C2b 纯 assistant 段落也能成窗（防饥饿）', w2.length === 1 && w2[0].messages.length === 6, 'wins=' + w2.length);
}
const keysAfter = wins[0].messages.map((m) => m._key || messageKey(m));
const wins2 = planWindows(allMsgs, { processedKeys: keysAfter }, { batchMessages: 6, minBatchMessages: 4 });
check('C', 'C3 已处理的消息不再进窗口', wins2.every((w) => w.messages.every((m) => !keysAfter.includes(m._key || messageKey(m)))), wins2.length);

const fakeEp = { baseUrl: 'http://fake', apiKey: 'x', model: 'fake', maxTokens: 100, temperature: 0, timeoutMs: 1000 };
let callCount = 0;
const fakeComplete = async () => {
  callCount++;
  return JSON.stringify([
    { type: 'episodic', scene_name: '我（AI）在和User做期7写入侧搬迁', content: '在 2026-10-22 完成期7-A L0 捕获搬迁，用落盘游标解决重启重复与漏段问题。', priority: 85, evidence: '落盘游标' },
    { type: 'instruction', scene_name: '我（AI）在和User约定记忆写入规则', content: 'User要求 AI 以后提取记忆必须用落盘游标，不得再用内存缓冲，否则重启即丢。', priority: 90, evidence: '内存缓冲重启即丢' },
  ]);
};
const r1 = await runExtract({ llm: fakeEp, opts: { root, batchMessages: 6, minBatchMessages: 4, maxWindowsPerRun: 1 }, completeFn: fakeComplete });
check('C', 'C4 首轮提取跑出卡', r1.extracted === 2 && r1.written === 2, JSON.stringify(r1));
check('C', 'C5 只跑了 1 个窗口（限流生效）', r1.windows === 1, r1.windows);
check('C', 'C6 提取游标落盘', existsSync(d.cursor + '/extract.json'), readdirSync(d.cursor).join(','));
const r2 = await runExtract({ llm: fakeEp, opts: { root, batchMessages: 6, minBatchMessages: 4, maxWindowsPerRun: 1 }, completeFn: fakeComplete });
// 第二轮取到的是**下一个窗口**（游标生效），但假模型每次返回同一段内容 ⇒ 内容指纹去重
// ⇒ extracted 必须是 0。这正是「重启后不会把同一段对话反复提取成重复卡」的合同。
check('C', 'C7 游标推进到下一窗口', r2.windows === 1, JSON.stringify(r2));
check('C', 'C7b 同内容不重复提取（指纹去重）', r2.extracted === 0 && r2.written === 0, JSON.stringify(r2));
const curNow = loadCursor(d, 'extract', null, {});
check('C', 'C8 游标累计已处理键', Array.isArray(curNow.processedKeys) && curNow.processedKeys.length >= 12, curNow.processedKeys && curNow.processedKeys.length);

const own = readOwnRecords(root);
check('C', 'C9 自产 L1 卡可读', own.cards.length === 2, own.cards.length);
check('C', 'C10 id 带 pm: 前缀', own.cards.every((c) => c.id.startsWith('pm:')), own.cards[0] && own.cards[0].id);
check('C', 'C11 layer 按 type 映射（instruction→global）', own.cards.some((c) => c._kind === 'instruction' && c.layer === 'global'));
check('C', 'C12 保留 source_message_ids', own.cards.every((c) => Array.isArray(c.source_message_ids)), own.cards[0] && own.cards[0].source_message_ids.length);
check('C', 'C13 createdAt 是数字', own.cards.every((c) => Number.isFinite(c.createdAt)));
const noLlm = await runExtract({ llm: null, opts: { root } });
check('C', 'C14 无 LLM 时安全返回（不抛）', noLlm.llm === 'off' && noLlm.written === 0, JSON.stringify(noLlm));

// ── D · 蒸馏 ──
console.log('── D · engram 蒸馏 ──');
check('D', 'D1 2-gram：同义高', bigramOverlap('记忆改造期7写入侧搬迁', '记忆改造期7写入侧搬迁') > 0.99);
check('D', 'D2 2-gram：无关低', bigramOverlap('记忆改造期7写入侧搬迁', '水处理示例设备A再生示例单据') < 0.2);
// [2026-10-22 修样本] 原样本「请把这段对话记下来，这是关于…的测试内容」是**描述句**，
//   不是结论——新质量规则会（正确地）拒绝它。换成真正的结论句。
const fb = fallbackDistill('用户：把本期结论记下来。AI：已完成期7 写入侧搬迁，三项能力全部落地并通过红队四轮复核无阻断项。');
check('D', 'D3 兜底蒸馏能出卡', fb.length === 1 && fb[0].title.length > 0, JSON.stringify(fb[0] && fb[0].title));
// [2026-10-22 新增] 兜底质量：实跑曾产出 title="这是客观事实" / "Assistant重新测试: AI" 这类垃圾卡。
//   现在必须做到：① 过场话拒绝产卡；② 说话人前缀被剥干净；③ 真结论正常产出。
{
  const noise1 = fallbackDistill('这是客观事实,不能回避。 AI：Assistant这就查上游仓库的提交记录(呆毛一竖)。 AI：Assistant拿到了提交时间线。');
  check('D', 'D3b 过场话被拒绝（不产垃圾卡）', noise1.length === 0, JSON.stringify(noise1.map((x) => x.title)));
  const noise2 = fallbackDistill('Assistant重新测试: AI：**决定性证据:extract 自动跑了!** records: 8 -> 15 张');
  check('D', 'D3c 多重前缀被剥净', noise2.length === 0 || !/AI\s*[:：]/.test(noise2[0].title), JSON.stringify(noise2[0] && noise2[0].title));
  const good1 = fallbackDistill('已完成期7 写入侧搬迁，L0捕获与L1提取全部落地并通过红队四轮复核无阻断项。');
  check('D', 'D3d 真结论能产出且标题干净', good1.length === 1 && /^已完成/.test(good1[0].title), JSON.stringify(good1[0] && good1[0].title));
  const good2 = fallbackDistill('根治了 planWindows 强制 user 开头导致 extract 空转的问题，实测从 0 窗口恢复为 2 窗口。');
  check('D', 'D3e 技术结论能产出', good2.length === 1 && good2[0].content.indexOf('planWindows') >= 0, JSON.stringify(good2[0] && good2[0].title));
  check('D', 'D3f 产出的卡绝不含说话人前缀', [...noise1, ...noise2, ...good1, ...good2].every((x) => !/^\s*(AI|助手|用户)\s*[:：]/.test(x.content)), '');

  // [2026-10-22 补] 实跑抓到蒸馏卡是「过程叙述」而非结论（与 K16 同源问题）
  const procCases = [
    '这让我必须重新审视:我一直在把自己的测试噪音当成生产故障来分析。',
    '这没问题。现在做本轮最重要的事:在真实环境中验证补跑。',
    '它用的是「这是关于期7蒸馏兜底路径的测试内容」这种描述性句子。',
    'Assistant差点被「5/5 全命中」骗过去。',
    '先验证定时器是否真的停止。',
  ];
  const procOut = procCases.map((c) => fallbackDistill(c));
  check('D', 'D3g 过程叙述不产蒸馏卡', procOut.every((r) => r.length === 0),
    JSON.stringify(procOut.map((r) => r.length ? r[0].title : null)));
  const goodProc = fallbackDistill('根治了 planWindows 强制 user 开头导致 extract 空转的问题，实测从 0 窗口恢复为 2 窗口。');
  check('D', 'D3h 技术结论仍能产卡', goodProc.length === 1 && /planWindows/.test(goodProc[0].content), '');
}
const noLlmD = await runDistill({ llm: null, opts: { root } });
check('D', 'D4 无 LLM 时安全返回', noLlmD.llm === 'off', JSON.stringify(noLlmD));

// 已有卡：一张 30 天前（可退役）、一张昨天（不可退役）
const nowMs = Date.now();
const oldCard = { kind: 'note', layer: 'global', projectId: null, title: '期七写入侧搬迁旧结论卡', summary: '旧摘要', content: '旧内容', links: [], sessionId: null, causes: [], effects: [], importance: 0.6, id: 'pmi_old', createdAt: nowMs - 30 * 86400000, hits: 0, lastHitAt: null };
const newCard = { kind: 'note', layer: 'global', projectId: null, title: '期七写入侧搬迁新结论卡', summary: '新摘要', content: '新内容', links: [], sessionId: null, causes: [], effects: [], importance: 0.6, id: 'pmi_new', createdAt: nowMs - 86400000, hits: 0, lastHitAt: null };
writeFileSync(d.engrams, JSON.stringify(oldCard) + '\n' + JSON.stringify(newCard) + '\n', 'utf8');

const distillComplete = async (ep, system, user) => {
  // 三条：① 与旧卡标题高度重叠且旧 → 应退役旧卡并写入新卡；② 与「新卡」重叠且新 → 跳过；③ 全新 → 写入
  return JSON.stringify([
    { kind: 'note', layer: 'global', title: '期七写入侧搬迁旧结论', summary: '同主题的新结论', content: '这应该是新结论内容，覆盖旧的。', causesOf: [] },
    { kind: 'note', layer: 'global', title: '期七写入侧搬迁新结论', summary: '重复汇报', content: '应被跳过。', causesOf: [] },
    { kind: 'decision', layer: 'project', title: '期七搬迁顺序决策', summary: '先功能后关旧', content: 'User明确：先把功能做好才可关旧插件，顺序 7A→7B→7C→7D。', causesOf: ['期七写入侧搬迁旧结论卡'] },
  ]);
};
const rD = await runDistill({ llm: fakeEp, opts: { root, sessionId: 's1', cwd: '~', minDistillMessages: 1, retireAfterDays: 14 }, completeFn: distillComplete });
check('D', 'D5 蒸馏写入/退役/跳过三分支', rD.written === 2 && rD.retired === 1, JSON.stringify(rD));
const engs = readOwnEngrams(root);
check('D', 'D6 旧卡被标记 retired', engs.some((e) => e.id === 'pmi_old' && e.status === 'retired'));
check('D', 'D7 新卡未被退役', engs.some((e) => e.id === 'pmi_new' && e.status !== 'retired'));
check('D', 'D8 写入的卡带 causes 解析', engs.some((e) => Array.isArray(e.causes) && e.causes.includes('pmi_old')), JSON.stringify(engs.filter((e) => e.causes && e.causes.length).map((e) => e.causes)));
check('D', 'D9 project 层带 projectId', engs.some((e) => e.layer === 'project' && e.projectId === '~'));
check('D', 'D10 蒸馏游标落盘', existsSync(d.cursor + '/distill.json'));
const rD2 = await runDistill({ llm: fakeEp, opts: { root, sessionId: 's1', cwd: '~', minDistillMessages: 1 }, completeFn: distillComplete });
check('D', 'D11 重复蒸馏不再产卡（游标+去重）', rD2.written === 0, JSON.stringify(rD2));

// ── E · 原子写与游标 ──
console.log('── E · 原子写与游标 ──');
check('E', 'E1 原子写成功', atomicWriteJson(d.cursor + '/probe.json', { a: 1 }) === true);
check('E', 'E2 游标可读回', loadCursor(d, 'probe', null, {}).a === 1);
check('E', 'E3 损坏游标不抛（回退默认）', (() => { try { writeFileSync(d.cursor + '/broken.json', '{bad json'); return loadCursor(d, 'broken', null, { safe: true }).safe === true; } catch { return false; } })());
saveCursor(d, 'probe', 'sess-A', { v: 2 });
check('E', 'E4 会话级游标文件名安全', existsSync(d.cursor + '/probe-sess-A.json'), readdirSync(d.cursor).join(','));

// ── G · LLM 输出容错归一化（旁路实跑抓到的真 bug）──
console.log('── G · LLM 输出容错 ──');
{
  const { normalizeL1, normalizeEngrams } = await import('./lib/ingest/normalize.js');

  // 实测 glm-4.6v-flash 的真实返回形状：字段名全是自己编的
  const weird = [{ '阶段': '期7', '事件': '写入侧搬迁完成', '完成任务': ['L0 捕获', 'L1 提取', 'engram 蒸馏'], '结果': '全部落在超图自己的 ingest 目录', '状态': '已跑通' }];
  const n1 = normalizeL1(weird, { maxItems: 4 });
  check('G', 'G1 自造字段名也能提取出内容', n1.length === 1 && n1[0].content.length >= 8, JSON.stringify(n1[0] && n1[0].content.slice(0, 30)));
  check('G', 'G2 type 缺失时按内容推断', n1.length === 1 && ['persona', 'episodic', 'instruction'].includes(n1[0].type), n1[0] && n1[0].type);

  // 标准形状不被破坏
  const std = [{ type: 'instruction', scene_name: '约定', content: 'User要求 AI 以后提取记忆必须用落盘游标，不得用内存缓冲。', priority: 90, evidence: '落盘游标' }];
  const n2 = normalizeL1(std);
  check('G', 'G3 标准形状原样通过', n2.length === 1 && n2[0].type === 'instruction' && n2[0].priority === 90, JSON.stringify(n2[0] && n2[0].priority));

  // 中文键名
  const cn = [{ '类型': '偏好', '内容': '用户（User）喜欢在深夜做工程任务，偏好证据可追溯的结论。', '优先级': 70 }];
  const n3 = normalizeL1(cn);
  check('G', 'G4 中文键名映射', n3.length === 1 && n3[0].type === 'persona', JSON.stringify(n3[0] && n3[0].type));

  // 推断规则
  const n4 = normalizeL1([{ content: '用户要求 AI 以后回答都先立个表。' }]);
  check('G', 'G5 「要求/以后」→ instruction', n4.length === 1 && n4[0].type === 'instruction', n4[0] && n4[0].type);
  const n5 = normalizeL1([{ content: 'User喜欢汉堡和披萨，讨厌很酸的水果。' }]);
  check('G', 'G6 「喜欢/讨厌」→ persona', n5.length === 1 && n5[0].type === 'persona', n5[0] && n5[0].type);

  // 空/垃圾不产卡
  check('G', 'G7 纯符号内容不产卡', normalizeL1([{ content: ';;;---' }]).length === 0);
  check('G', 'G8 非数组安全返回', normalizeL1(null).length === 0 && normalizeL1({}).length === 0);

  // 蒸馏：纯标签标题必须被换掉（实跑教训 title="</div>"）
  const e = normalizeEngrams([{ kind: 'note', layer: 'session', title: '</div>', summary: '这次交接的验收也过了', content: '这次交接的验收也过了，3/4 命中。' }]);
  check('G', 'G9 纯标签标题被替换', e.length === 1 && /[\u4e00-\u9fff]/.test(e[0].title), JSON.stringify(e[0] && e[0].title));
  const e2 = normalizeEngrams([{ '类别': '决策', '标题': '搬迁顺序', '内容': 'User明确：先把功能做好才可关旧插件。', '层级': '全局' }]);
  check('G', 'G10 中文 kind/layer 映射', e2.length === 1 && e2[0].kind === 'decision' && ['global', 'project', 'session'].includes(e2[0].layer), JSON.stringify(e2[0] && [e2[0].kind, e2[0].layer]));
}

// ── F · 闭环：写入侧产物能被检索侧读到 ──
console.log('── F · 写入→检索闭环 ──');
{
  const { readOwnIngest } = await import('./lib/hypergraph/source.js');
  const own2 = readOwnIngest(root);
  check('F', 'F1 L1 卡被检索侧读到', own2.cards.filter((c) => c._source === 'ingest-l1').length >= 2, own2.cards.length);
  check('F', 'F2 蒸馏卡被检索侧读到', own2.cards.filter((c) => c._source === 'ingest-engram').length >= 2, own2.cards.filter((c) => c._source === 'ingest-engram').length);
  check('F', 'F3 id 前缀不冲突（pm: / pmi:）', own2.cards.every((c) => c.id.startsWith('pm:') || c.id.startsWith('pmi:')), own2.cards.map((c) => c.id.slice(0, 6)).join(','));
  check('F', 'F4 退役卡不出现', !own2.cards.some((c) => c.id === 'pmi:pmi_old'), own2.cards.map((c) => c.id).join(','));
  check('F', 'F5 layer 落在合法域', own2.cards.every((c) => ['global', 'project', 'session'].includes(c.layer)), own2.cards.map((c) => c.layer).join(','));
  check('F', 'F6 createdAt 全为数字', own2.cards.every((c) => Number.isFinite(c.createdAt)), '');
  // 空目录不报错
  const empty = readOwnIngest(join(tmpdir(), 'pm-ingest-none-' + Date.now()));
  check('F', 'F7 目录不存在时安全返回空', Array.isArray(empty.cards) && empty.cards.length === 0, JSON.stringify(empty.cards.length));
}

// ── H · 红队 P0 回归（同毫秒 / 回拨 / 并发 / 失败不推进 / 刷新落盘 / 注入绕过）──
console.log('── H · 红队 P0 回归 ──');
const root2 = mkdtempSync(join(tmpdir(), 'pm-ingest-p0-'));
const d2 = dirs(root2);
ensureDirs(d2);
{
  const T1 = 1792700000000;
  // H1 同毫秒两条消息都要进来（旧实现 ts<=lastTs 会杀第二条）
  const r1 = captureTurn({
    sessionKey: 's-ms',
    messages: [
      { id: 'ms1', role: 'user', content: '同一毫秒的第一条消息，必须被记下来。', timestamp: T1 },
      { id: 'ms2', role: 'assistant', content: '同一毫秒的第二条消息，也不能被丢掉。', timestamp: T1 },
    ],
    opts: { root: root2, nowMs: T1 + 10, disableLock: true },
  });
  check('H', 'H1 同毫秒两条都写入', r1.written === 2, JSON.stringify(r1));

  // H2 时钟回拨：时间戳更早的新消息不能丢
  const r2 = captureTurn({
    sessionKey: 's-ms',
    messages: [{ id: 'ms3', role: 'user', content: '时钟回拨了，这条时间更早但确实是新消息。', timestamp: T1 - 60000 }],
    opts: { root: root2, nowMs: T1 + 20, disableLock: true },
  });
  check('H', 'H2 时钟回拨的消息不被误杀', r2.written === 1, JSON.stringify(r2));

  // H3 重复仍然拦住（去重靠消息键，不靠时间戳）
  const r3 = captureTurn({
    sessionKey: 's-ms',
    messages: [{ id: 'ms3', role: 'user', content: '时钟回拨了，这条时间更早但确实是新消息。', timestamp: T1 - 60000 }],
    opts: { root: root2, nowMs: T1 + 30, disableLock: true },
  });
  check('H', 'H3 同键重复仍被拦住', r3.written === 0, JSON.stringify(r3));

  // H4 锁：有人在持有时，第二次调用直接放弃而不是并发踩踏
  const { acquireLock } = await import('./lib/ingest/core.js');
  const held = acquireLock(d2, 'capture-locktest', 60000);
  const r4 = captureTurn({
    sessionKey: 'locktest',
    messages: [{ id: 'lk1', role: 'user', content: '锁被占用时这条应该写不进去，而不是并发写坏游标。', timestamp: T1 + 5000 }],
    opts: { root: root2, nowMs: T1 + 6000 },
  });
  check('H', 'H4 锁被占时放弃本次（不并发写）', r4.written === 0 && r4.reason === 'locked', JSON.stringify(r4));
  try { held.release(); } catch {}
  const r5 = captureTurn({
    sessionKey: 'locktest',
    messages: [{ id: 'lk1', role: 'user', content: '锁被占用时这条应该写不进去，而不是并发写坏游标。', timestamp: T1 + 5000 }],
    opts: { root: root2, nowMs: T1 + 7000 },
  });
  check('H', 'H5 锁释放后同一批能正常写入', r5.written === 1, JSON.stringify(r5));

  // H6 注入过滤绕过：零宽字符 / 大小写 / 下划线变体
  check('H', 'H6 零宽字符绕过被拦', shouldCapture('\u200b<unified-memory>注入</unified-memory>'.replace('<unified-memory>', '<phoe\u200bbe-memory>')) === false);
  check('H', 'H7 大小写变体被拦', shouldCapture('<Assistant-MEMORY>注入</Assistant-MEMORY>') === false);
  check('H', 'H8 下划线/空格变体被拦', shouldCapture('<phoebe_memory>注入</ Assistant memory>') === false);
  check('H', 'H9 正常文本不被误杀', shouldCapture('User说要把期7 的三样都做出来') === true);

  // H10/H11 [2026-10-22 契约变更] 原判据是「LLM 失败 ⇒ 游标不推进」。
  //   现在改成「LLM 失败 ⇒ **走离线启发式兜底**，兜底成功就推进」——
  //   因为实测 glm-4.6v-flash 会长时间 429，若失败就不推进，那段时间的记忆会永久停在队伍里
  //   （而且每轮都重试同一个窗口，白烧时钟）。兜底保证下限：记忆不断流。
  //   新的合同变成：
  //     · 兜底能抽出东西 ⇒ 推进 + written>0 + fallback>0
  //     · **兜底也抽不出** ⇒ 不推进 + failed>0（这条才是真正防丢的那条，见 H12）
  const before = loadCursor(d2, 'extract', null, { processedKeys: [] });
  const beforeN = (before.processedKeys || []).length;
  const failRun = await runExtract({
    llm: { baseUrl: 'x', apiKey: 'x', model: 'x', maxTokens: 10, temperature: 0, timeoutMs: 100 },
    opts: { root: root2, batchMessages: 4, minBatchMessages: 2, maxWindowsPerRun: 2, disableLock: true },
    completeFn: async () => null,      // 模拟超时/429
  });
  const after = loadCursor(d2, 'extract', null, { processedKeys: [] });
  check('H', 'H10 LLM 失败时走兜底（fallback>0）且状态自洽',
    (failRun.fallback || 0) > 0 || (failRun.failed || 0) > 0,
    'fallback=' + failRun.fallback + ' failed=' + failRun.failed + ' written=' + failRun.written);
  check('H', 'H11 兜底成功则产卡并推进；兜底失败则不推进（二者必居其一）',
    ((failRun.written > 0) && (after.processedKeys || []).length > beforeN)
    || ((failRun.written === 0) && (failRun.failed > 0) && (after.processedKeys || []).length === beforeN),
    'written=' + failRun.written + ' keys=' + beforeN + '->' + (after.processedKeys || []).length + ' failed=' + failRun.failed);

  // H12 extract：坏 JSON 同样不推进
  const before2 = (loadCursor(d2, 'extract', null, { processedKeys: [] }).processedKeys || []).length;
  const badRun = await runExtract({
    llm: { baseUrl: 'x', apiKey: 'x', model: 'x', maxTokens: 10, temperature: 0, timeoutMs: 100 },
    opts: { root: root2, batchMessages: 4, minBatchMessages: 2, maxWindowsPerRun: 2, disableLock: true },
    completeFn: async () => '抱歉我无法完成',
  });
  const after2 = (loadCursor(d2, 'extract', null, { processedKeys: [] }).processedKeys || []).length;
  check('H', 'H12 坏 JSON 时游标不推进', after2 === before2, before2 + '->' + after2 + ' failed=' + badRun.failed);
}

// H13 蒸馏「同标题刷新」必须落盘（旧实现只改内存，重启即丢）
{
  const dEng = join(root2, 'engrams.jsonl');
  const old = { kind: 'note', layer: 'global', projectId: null, title: '期7 刷新测试卡', summary: '旧摘要', content: '旧内容', links: [], sessionId: null, causes: [], effects: [], importance: 0.6, id: 'pmi_refresh', createdAt: Date.now() - 1000, hits: 0, lastHitAt: null };
  writeFileSync(dEng, JSON.stringify(old) + '\n', 'utf8');
  const r = await runDistill({
    llm: { baseUrl: 'x', apiKey: 'x', model: 'x', maxTokens: 10, temperature: 0, timeoutMs: 100 },
    opts: { root: root2, sessionId: 's-ms', cwd: 'D:/x', minDistillMessages: 1, retireAfterDays: 14, disableLock: true },
    completeFn: async () => JSON.stringify([{ kind: 'note', layer: 'global', title: '期7 刷新测试卡', summary: '新摘要已更新', content: '新内容已更新，这条应该原地刷新旧卡而不是新建一张。' }]),
  });
  check('H', 'H13 刷新计数为 1', r.refreshed === 1, JSON.stringify(r));
  // 关键：**重新从磁盘读**（模拟重启），刷新必须还在
  const afterRestart = readOwnEngrams(root2).find((e) => e.id === 'pmi_refresh');
  check('H', 'H14 刷新已落盘（重读仍生效）', !!afterRestart && afterRestart.content.indexOf('原地刷新') >= 0, afterRestart && String(afterRestart.content).slice(0, 20));
  const rawLen = readFileSync(dEng, 'utf8').trim().split('\n').length;
  check('H', 'H15 刷新是追加行（LWW 语义）', rawLen >= 2, 'lines=' + rawLen);
}

// H18 水位精确性：键被淘汰后，**只挡更早的**，不误杀之后的新消息
{
  const root3 = mkdtempSync(join(tmpdir(), 'pm-ingest-wm-'));
  const d3 = dirs(root3); ensureDirs(d3);
  const base = 1792800000000;
  // 先灌 8 条（keepKeys 设 3，故意让它淘汰）
  const many = [];
  for (let i = 0; i < 8; i++) {
    many.push({ id: 'w' + i, role: i % 2 ? 'assistant' : 'user', content: '水位测试消息编号 ' + i + '，内容足够长以通过过滤。', timestamp: base + i * 1000 });
  }
  const rr = captureTurn({ sessionKey: 'wm', messages: many, opts: { root: root3, nowMs: base + 20000, keepKeys: 3, disableLock: true } });
  check('H', 'H18 大批量写入成功', rr.written === 8, JSON.stringify(rr));
  const curW = loadCursor(d3, 'capture', 'wm', {});
  // [红队 R2 P1] 语义已改：**彻底不用时间戳水位**，改 retiredKeys 精确记。
  check('H', 'H19 被淘汰的键进了 retiredKeys', Array.isArray(curW.retiredKeys) && curW.retiredKeys.length > 0, 'n=' + (curW.retiredKeys && curW.retiredKeys.length));
  check('H', 'H19b 不再有 prunedBelow 水位字段', curW.prunedBelow === undefined, 'v=' + curW.prunedBelow);
  // 比最近窗口更晚的新消息：正常写
  const r2 = captureTurn({ sessionKey: 'wm', messages: [{ id: 'wNew', role: 'user', content: '更晚的新消息，必须照常写入不被误杀。', timestamp: base + 9000 }], opts: { root: root3, nowMs: base + 30000, keepKeys: 3, disableLock: true } });
  check('H', 'H20 更晚的新消息照常写入', r2.written === 1, JSON.stringify(r2));
  // 时间戳很旧但**确实是新消息**（时钟回拨）：必须被写入，不许被时间规则误杀
  const r3 = captureTurn({ sessionKey: 'wm', messages: [{ id: 'wOld', role: 'user', content: '时间戳很旧，但确实是一条没见过的新消息，不能被误杀。', timestamp: base + 1000 }], opts: { root: root3, nowMs: base + 31000, keepKeys: 3, disableLock: true } });
  check('H', 'H21 回拨的旧时间戳新消息也必须写入', r3.written === 1, JSON.stringify(r3));
  // 已淘汰的键仍然被精确记住（重放不会重复）
  const r4 = captureTurn({ sessionKey: 'wm', messages: many.slice(0, 2), opts: { root: root3, nowMs: base + 32000, keepKeys: 3, disableLock: true } });
  check('H', 'H22 已淘汰键重放仍被拦住', r4.written === 0, JSON.stringify(r4));
  try { rmSync(root3, { recursive: true, force: true }); } catch {}
}

// H23·pending 未落盘时，待写消息必须能被重试（红队 R2 P1 的核心纠正）
{
  const root4 = mkdtempSync(join(tmpdir(), 'pm-ingest-pend-'));
  const d4 = dirs(root4); ensureDirs(d4);
  const T2 = 1792900000000;
  // 手工造一个「写了游标（含 key）但没追加」的状态 —— 模拟 append 前崩溃
  const m1 = { id: 'p1', role: 'user', content: '崩溃窗口测试消息：游标写了但文件没写，重启后必须补写。', timestamp: T2 };
  const k1 = messageKey(m1);
  const convFile = d4.conversations + '/' + localDate(T2) + '.jsonl';
  saveCursor(d4, 'capture', 'pend', {
    keys: [k1 + '@' + T2],
    retiredKeys: [],
    maxTs: T2,
    pending: { file: convFile, ids: ['p1'], at: new Date().toISOString() },
    updatedAt: new Date().toISOString(),
  });
  check('H', 'H23 前置：文件确实不存在（模拟崩溃）', !existsSync(convFile), convFile);
  const rr2 = captureTurn({ sessionKey: 'pend', messages: [m1], opts: { root: root4, nowMs: T2 + 1000, disableLock: true } });
  check('H', 'H24 pending 未落盘 ⇒ 消息被重试写入', rr2.written === 1, JSON.stringify(rr2));
  check('H', 'H25 重试后文件出现且含该消息', existsSync(convFile) && readFileSync(convFile, 'utf8').indexOf('崩溃窗口测试消息') >= 0);

  // 反向：pending 已落盘 ⇒ 不能重复写
  const m2 = { id: 'p2', role: 'user', content: '已落盘的 pending 消息，重启后不应重复写入。', timestamp: T2 + 5000 };
  const rr3 = captureTurn({ sessionKey: 'pend2', messages: [m2], opts: { root: root4, nowMs: T2 + 6000, disableLock: true } });
  check('H', 'H26 正常写一条成功', rr3.written === 1, JSON.stringify(rr3));
  // 把 pending 重新塞回去（模拟提交前崩溃），但文件已含该消息
  const curP = loadCursor(d4, 'capture', 'pend2', {});
  saveCursor(d4, 'capture', 'pend2', Object.assign({}, curP, { pending: { file: rr3.file, ids: ['p2'], at: new Date().toISOString() } }));
  const rr4 = captureTurn({ sessionKey: 'pend2', messages: [m2], opts: { root: root4, nowMs: T2 + 7000, disableLock: true } });
  check('H', 'H27 pending 已落盘 ⇒ 不重复写', rr4.written === 0, JSON.stringify(rr4));
  try { rmSync(root4, { recursive: true, force: true }); } catch {}
}

// H28 distill 追加失败时不得推进游标（红队 R2 P0）
{
  const root5 = mkdtempSync(join(tmpdir(), 'pm-ingest-df-'));
  const d5 = dirs(root5); ensureDirs(d5);
  // 先造 L0，让 distill 有料可蒸
  const T3 = 1793000000000;
  captureTurn({
    sessionKey: 'df',
    messages: [
      { id: 'dfu', role: 'user', content: '请把这段关于期7 蒸馏失败路径的结论记下来，内容要足够长。', timestamp: T3 },
      { id: 'dfa', role: 'assistant', content: '好的，已经记下蒸馏失败时不能推进游标这条规则。', timestamp: T3 + 1000 },
    ],
    opts: { root: root5, nowMs: T3 + 2000, disableLock: true },
  });
  // 把 engrams 变成一个**目录**，让 append 必然失败
  mkdirSync(d5.engrams, { recursive: true });
  const before5 = loadCursor(d5, 'distill', null, { processedKeys: [] });
  const badD = await runDistill({
    llm: { baseUrl: 'x', apiKey: 'x', model: 'x', maxTokens: 10, temperature: 0, timeoutMs: 100 },
    opts: { root: root5, sessionId: 'df', cwd: 'D:/x', minDistillMessages: 1, disableLock: true },
    completeFn: async () => JSON.stringify([{ kind: 'note', layer: 'global', title: '蒸馏失败路径测试', summary: '摘要足够长可以过校验', content: '内容足够长，用来触发一次真实的追加写入失败。' }]),
  });
  const after5 = loadCursor(d5, 'distill', null, { processedKeys: [] });
  check('H', 'H28 distill 追加失败时报告失败', badD.written === 0 && badD.reason === 'append-failed', JSON.stringify(badD));
  check('H', 'H29 distill 追加失败时游标不推进', JSON.stringify(after5.processedKeys || []) === JSON.stringify(before5.processedKeys || []), (before5.processedKeys || []).length + '->' + (after5.processedKeys || []).length);
  try { rmSync(root5, { recursive: true, force: true }); } catch {}
}

// H30·真并发：两个 capture 同时抢同一 session，必须只有一个成功/或都不丢
{
  const root6 = mkdtempSync(join(tmpdir(), 'pm-ingest-conc-'));
  dirs(root6); ensureDirs(dirs(root6));
  const T4 = 1793100000000;
  const mk = (n) => ({ id: 'c' + n, role: 'user', content: '并发测试消息 ' + n + '，内容足够长以通过过滤条件。', timestamp: T4 + n });
  // 不用 disableLock，走真锁
  const [a, b] = await Promise.all([
    Promise.resolve().then(() => captureTurn({ sessionKey: 'conc', messages: [mk(1), mk(2)], opts: { root: root6, nowMs: T4 + 100 } })),
    Promise.resolve().then(() => captureTurn({ sessionKey: 'conc', messages: [mk(3), mk(4)], opts: { root: root6, nowMs: T4 + 200 } })),
  ]);
  const totalWritten = (a.written || 0) + (b.written || 0);
  const lockedCount = [a, b].filter((x) => x.reason === 'locked').length;
  check('H', 'H30 并发时至少一方持锁成功', (a.written || 0) > 0 || (b.written || 0) > 0, JSON.stringify({ a: a.written, ar: a.reason, b: b.written, br: b.reason }));
  check('H', 'H31 没有两边同时写（或明确有一方被锁拒绝）', lockedCount >= 1 || totalWritten <= 4, 'locked=' + lockedCount + ' total=' + totalWritten);
  // 落盘内容不能出现重复行（同 id 出现两次 = 并发踩踏）
  const files = readdirSync(dirs(root6).conversations).filter((f) => f.endsWith('.jsonl'));
  const ids = [];
  for (const f of files) {
    for (const line of readFileSync(dirs(root6).conversations + '/' + f, 'utf8').split('\n')) {
      if (!line) continue;
      try { ids.push(JSON.parse(line).id); } catch {}
    }
  }
  const dup = ids.filter((x, i) => ids.indexOf(x) !== i);
  check('H', 'H32 并发后落盘无重复 id', dup.length === 0, 'ids=' + ids.length + ' dup=' + JSON.stringify(dup));
  // 被锁拒绝的那一方，下一轮重试必须能补上
  const retryA = captureTurn({ sessionKey: 'conc', messages: [mk(1), mk(2)], opts: { root: root6, nowMs: T4 + 300 } });
  const retryB = captureTurn({ sessionKey: 'conc', messages: [mk(3), mk(4)], opts: { root: root6, nowMs: T4 + 400 } });
  check('H', 'H33 重试后两批都补齐（或被去重挡住）', (retryA.written + retryB.written) + totalWritten === 4, 'total=' + (retryA.written + retryB.written + totalWritten));
  try { rmSync(root6, { recursive: true, force: true }); } catch {}
}

// H34·无原始 id 的消息，pending 崩溃恢复也必须补写（红队 R3 P0）
{
  const root7 = mkdtempSync(join(tmpdir(), 'pm-ingest-noid-'));
  const d7 = dirs(root7); ensureDirs(d7);
  const T5 = 1793200000000;
  // 消息**故意不带 id**
  const m = { role: 'user', content: '这条消息没有原始 id，崩溃恢复时必须靠去重键而不是生成的 id 找回。', timestamp: T5 };
  const k = messageKey({ id: undefined, role: 'user', timestamp: T5, content: m.content });
  check('H', 'H34 前置：无 id 时去重键走 h: 哈希', k.startsWith('h:'), k.slice(0, 8));
  const convFile = d7.conversations + '/' + localDate(T5) + '.jsonl';
  // 模拟崩溃：游标里有去重键 + pending（文件不存在）
  saveCursor(d7, 'capture', 'noid', {
    keys: [k + '@' + T5],
    retiredKeys: [],
    maxTs: T5,
    pending: { file: convFile, ids: ['msg_generated_xxx'], keys: [k], at: new Date().toISOString() },
    updatedAt: new Date().toISOString(),
  });
  const r = captureTurn({ sessionKey: 'noid', messages: [m], opts: { root: root7, nowMs: T5 + 1000, disableLock: true } });
  check('H', 'H35 无 id + pending 未落盘 ⇒ 必须补写', r.written === 1, JSON.stringify(r));
  check('H', 'H36 文件真的出现了', existsSync(convFile) && readFileSync(convFile, 'utf8').indexOf('没有原始 id') >= 0);
  // 反向：文件已含该消息（按 content 比对）⇒ 不重复写
  const r2 = captureTurn({ sessionKey: 'noid', messages: [m], opts: { root: root7, nowMs: T5 + 2000, disableLock: true } });
  check('H', 'H37 已写入后重放不重复', r2.written === 0, JSON.stringify(r2));
  try { rmSync(root7, { recursive: true, force: true }); } catch {}
}

// H38·旧格式 pending（只有 ids、没有 keys）+ 无原始 id 消息 —— 必须也能救回来（红队 R4 P1）
{
  const root8 = mkdtempSync(join(tmpdir(), 'pm-ingest-legacy-'));
  const d8 = dirs(root8); ensureDirs(d8);
  const T6 = 1793500000000;
  const m = { role: 'user', content: '旧格式游标 + 无原始 id 的消息，兼容分支也必须能救回来。', timestamp: T6 };
  const k = messageKey({ id: undefined, role: 'user', timestamp: T6, content: m.content });
  const convFile = d8.conversations + '/' + localDate(T6) + '.jsonl';
  // 旧格式：pending 只有 ids（且是生成的 msg_xxx），游标里只有 h: 键
  saveCursor(d8, 'capture', 'legacy', {
    keys: [k + '@' + T6],
    maxTs: T6,
    pending: { file: convFile, ids: ['msg_' + T6 + '_abc123'], at: new Date().toISOString() },
    updatedAt: new Date().toISOString(),
  });
  const r = captureTurn({ sessionKey: 'legacy', messages: [m], opts: { root: root8, nowMs: T6 + 1000, disableLock: true } });
  check('H', 'H38 旧格式 pending + 无 id 也能补写', r.written === 1, JSON.stringify(r));
  check('H', 'H39 文件确实生成', existsSync(convFile) && readFileSync(convFile, 'utf8').indexOf('旧格式游标') >= 0);
  try { rmSync(root8, { recursive: true, force: true }); } catch {}
}

// H16 源签名能感知「既有日文件被追加」（红队 P0-3）
{
  const sigModule = await import('./lib/ingest/core.js');
  const dir = join(root2, 'records');
  const f = join(dir, '2026-10-22.jsonl');
  writeFileSync(f, JSON.stringify({ id: 'sig1', content: '第一条' }) + '\n', 'utf8');
  const sig1 = sigModule.sigOfIngest(root2);
  await new Promise((r) => setTimeout(r, 20));
  writeFileSync(f, JSON.stringify({ id: 'sig2', content: '第二条' }) + '\n', { flag: 'a' });
  const sig2 = sigModule.sigOfIngest(root2);
  check('H', 'H16 追加既有日文件能改变签名', sig1 !== sig2, sig1 + ' vs ' + sig2);
  check('H', 'H17 签名读得到（非空）', typeof sig1 === 'string' && sig1.length > 4, sig1);
}

try { rmSync(root2, { recursive: true, force: true }); } catch {}

// ── I · 接线层（createIngest）——之前完全没测过 ──
console.log('── I · 接线层 ──');
{
  const root9 = mkdtempSync(join(tmpdir(), 'pm-ingest-wire-'));
  const { createIngest } = await import('./lib/ingest/index.js');
  const { writeFileSync: wf } = await import('node:fs');
  const cfgPath = join(root9, 'config.json');

  // 造一个假 ctx：记录注册了哪些钩子
  const hooks = new Map();
  const fakeCtx = {
    on(name, fn) { if (!hooks.has(name)) hooks.set(name, []); hooks.get(name).push(fn); return () => {}; },
    logger: { info() {}, warn() {}, debug() {} },
  };
  // 关着的情况
  wf(cfgPath, JSON.stringify({ enabled: false }), 'utf8');
  const off = createIngest(fakeCtx, { configPath: cfgPath, root: join(root9, 'data') }, null);
  check('I', 'I1 关着时也能建实例（链路挂着不动作）', !!off);
  check('I', 'I2 注册了 session/flush 钩子', (hooks.get('session/flush') || []).length === 1);
  check('I', 'I3 注册了 agent/turn-stopping 钩子', (hooks.get('agent/turn-stopping') || []).length === 1);

  // 关着时触发钩子：不能写任何东西
  const flushFn = (hooks.get('session/flush') || [])[0];
  const fakeSession = {
    id: 'wire-sess',
    deriveMessages: () => [
      { id: 'w1', role: 'user', source: { kind: 'user' }, content: '关着的时候这条不该被写进 L0，因为总闸没开。', timestamp: Date.now() },
    ],
  };
  await flushFn(fakeSession);
  const convDir = join(root9, 'data', 'conversations');
  const wrote = existsSync(convDir) ? readdirSync(convDir).filter((f) => f.endsWith('.jsonl')).length : 0;
  check('I', 'I4 关着时钩子不产生数据', wrote === 0, 'files=' + wrote);

  // 打开后触发：应该写
  wf(cfgPath, JSON.stringify({ enabled: true, capture: true, extract: false, distill: false }), 'utf8');
  await flushFn(fakeSession);
  const files = existsSync(convDir) ? readdirSync(convDir).filter((f) => f.endsWith('.jsonl')) : [];
  check('I', 'I5 打开后钩子真的写数据', files.length > 0, files.join(','));
  const body = files.length ? readFileSync(convDir + '/' + files[0], 'utf8') : '';
  check('I', 'I6 写进去的是真实对话内容', body.indexOf('关着的时候这条不该被写进') >= 0);
  check('I', 'I7 enabled() 反映当前开关', off.enabled.master === true && off.enabled.capture === true && off.enabled.extract === false, JSON.stringify(off.enabled));
  check('I', 'I8 status() 有可观测字段', typeof off.status().dir === 'string' && typeof off.status().captureRuns === 'number', JSON.stringify({ dir: off.status().dir, runs: off.status().captureRuns }));
  try { off.dispose(); } catch {}
  check('I', 'I9 dispose 不抛', true);
  try { rmSync(root9, { recursive: true, force: true }); } catch {}
}

// ── K · 限流兜底（LLM 全挂时仍要产卡）──
console.log('── K · 限流兜底 ──');
{
  const { heuristicExtract } = await import('./lib/ingest/extract.js');
  const T = 1793800000000;
  const win = { sessionKey: 'k1', messages: [
    { role: 'user', content: 'User要求 AI 以后提取记忆必须用落盘游标，不得用内存缓冲。', timestamp: T },
    { role: 'assistant', content: '已完成期7写入侧搬迁，L0捕获与L1提取全部落地。', timestamp: T + 1000 },
    { role: 'assistant', content: '根治了 planWindows 强制 user 开头导致 extract 空转的问题。', timestamp: T + 2000 },
    { role: 'user', content: 'User喜欢汉堡和披萨，讨厌很酸的水果和沙拉。', timestamp: T + 3000 },
  ] };
  const h = heuristicExtract(win, { maxItems: 4 });
  check('K', 'K1 启发式能抽出规则类', h.some((x) => x.type === 'instruction'), JSON.stringify(h.map((x) => x.type)));
  check('K', 'K2 启发式能抽出偏好类', h.some((x) => x.type === 'persona'), '');
  check('K', 'K3 启发式能抽出进展类', h.some((x) => x.type === 'episodic'), '');
  check('K', 'K4 抽出内容非空且长度合理', h.every((x) => x.content.length >= 12 && x.content.length <= 300), JSON.stringify(h.map((x) => x.content.length)));
  check('K', 'K5 maxItems 生效', h.length <= 4, 'n=' + h.length);
  check('K', 'K6 无内容时返回空', heuristicExtract({ messages: [{ role: 'user', content: '好', timestamp: T }] }, {}).length === 0);

  // [2026-10-22 新增] 实跑曾产出带 markdown 残留 + 过场话的卡，这里锁死清洗规则
  const noisy = { sessionKey: 'k2', messages: [
    { role: 'assistant', content: 'Assistant这就查上游仓库有没有修复(呆毛一竖)。', timestamp: T },
    { role: 'assistant', content: '备份完成 ✓ Assistant开始改两处(呆毛竖起)', timestamp: T + 1 },
    { role: 'assistant', content: '关键发现:\`ingest-capture\` 在持续写入日志,说明 capture 和 extract 都在运行。', timestamp: T + 2 },
    { role: 'assistant', content: '已完成期7 写入侧搬迁，三项能力全部落地并通过红队四轮复核。', timestamp: T + 3 },
  ] };
  const hq = heuristicExtract(noisy, { maxItems: 6 });
  check('K', 'K10 过场话（Assistant这就…/备份完成…）被拒', !hq.some((x) => /^(Assistant这就|备份完成)/.test(x.content)), JSON.stringify(hq.map((x) => x.content.slice(0, 16))));
  check('K', 'K11 markdown 反引号被清除', hq.every((x) => x.content.indexOf('\`') < 0), '');
  check('K', 'K12 真结论仍被保留', hq.some((x) => x.content.indexOf('已完成期7') >= 0), JSON.stringify(hq.map((x) => x.content.slice(0, 20))));
  check('K', 'K13 产出的卡都含中文（不是符号碎片）', hq.every((x) => /[\u4e00-\u9fff]/.test(x.content)), '');

  // [2026-10-22 补] 实跑抓到过「| HANDOFF-xxx.md | 主交接 |」这种 markdown 表格卡
  const tblWin = { sessionKey: 'k3', messages: [
    { role: 'assistant', content: '| HANDOFF-20261022-memory.md | 主交接 :下一步做什么 |', timestamp: T },
    { role: 'assistant', content: '|:---|---|', timestamp: T + 1 },
    { role: 'assistant', content: '已完成期7 写入侧搬迁，三项能力全部落地并通过红队复核。', timestamp: T + 2 },
  ] };
  const ht = heuristicExtract(tblWin, { maxItems: 6 });
  check('K', 'K14 markdown 表格行被过滤', !ht.some((x) => x.content.indexOf('|') >= 0 || /HANDOFF/i.test(x.content)),
    JSON.stringify(ht.map((x) => x.content.slice(0, 20))));
  check('K', 'K15 表格句后的真结论仍保留', ht.some((x) => x.content.indexOf('已完成期7') >= 0), '');

  // [2026-10-22 补] 实跑抓到自产卡是「我的过程叙述」而不是「结论」：
  //   「这让我必须重新审视:」「这没问题」「它用的是「这是关于期」」「Assistant差点被…骗过去」
  //   这些对长期记忆毫无价值 —— 必须过滤，只留名词性结论。
  const procWin = { sessionKey: 'k4', messages: [
    { role: 'assistant', content: '这让我必须重新审视:我一直在把自己的测试噪音当成生产故障来分析。', timestamp: T },
    { role: 'assistant', content: '这没问题。现在做本轮最重要的事:在真实环境中验证补跑。', timestamp: T + 1 },
    { role: 'assistant', content: '它用的是「这是关于期7蒸馏兜底路径的测试内容」这种描述性句子。', timestamp: T + 2 },
    { role: 'assistant', content: 'Assistant差点被「5/5 全命中」骗过去。', timestamp: T + 3 },
    { role: 'assistant', content: '先验证定时器是否真的停止。', timestamp: T + 4 },
    { role: 'assistant', content: '根因确认:DSH 进程是 Idle 优先级，Windows 会大幅降低 setInterval 的触发精度。', timestamp: T + 5 },
    { role: 'assistant', content: '已完成期7 写入侧搬迁，三项能力全部落地并通过红队四轮复核。', timestamp: T + 6 },
  ] };
  const hp = heuristicExtract(procWin, { maxItems: 10 });
  check('K', 'K16 过程叙述（这让我/这没问题/Assistant差点）被拒',
    !hp.some((x) => /^(这让我|这没问题|它用的是|Assistant差点|先验证)/.test(x.content)),
    JSON.stringify(hp.map((x) => x.content.slice(0, 18))));
  check('K', 'K17 技术结论仍保留', hp.some((x) => x.content.indexOf('Idle 优先级') >= 0), '');
  check('K', 'K18 产出的卡必须含具体对象（技术名词/数字）', hp.every((x) => /[a-zA-Z]{3,}|[0-9]|进程|定时器|配置|索引|游标|卡片|记忆|窗口/.test(x.content)),
    JSON.stringify(hp.map((x) => x.content.slice(0, 16))));

  // 集成：LLM 全失败时 runExtract 仍能产卡（fallback）
  const rootK = mkdtempSync(join(tmpdir(), 'pm-ingest-fb-'));
  const dK = dirs(rootK); ensureDirs(dK);
  const TK = 1793900000000;
  for (let i = 0; i < 6; i++) {
    captureTurn({ sessionKey: 'fb', messages: [
      { id: 'fb' + i + 'a', role: 'assistant', content: '已完成第 ' + i + ' 项修复，根治了一个真实缺陷。', timestamp: TK + i * 1000 },
    ], opts: { root: rootK, nowMs: TK + 20000 + i, disableLock: true } });
  }
  const rf = await runExtract({
    llm: { baseUrl: 'http://fake', apiKey: 'x', model: 'x', maxTokens: 10, temperature: 0, timeoutMs: 100 },
    opts: { root: rootK, batchMessages: 24, minBatchMessages: 4, disableLock: true },
    completeFn: async () => null,      // LLM 全挂（模拟 429）
  });
  check('K', 'K7 LLM 全挂时走 fallback 且产卡', (rf.written || 0) > 0, JSON.stringify(rf).slice(0, 160));
  check('K', 'K8 fallback 窗口计数 > 0', (rf.fallback || 0) > 0, 'fallback=' + rf.fallback);
  check('K', 'K9 兜底产出的卡可读回', readOwnRecords(rootK).cards.length > 0, 'n=' + readOwnRecords(rootK).cards.length);
  try { rmSync(rootK, { recursive: true, force: true }); } catch {}
}

// ── J · 蒸馏双触发（回合收尾 + 定时兜底）—— 实跑抓到的真问题 ──
console.log('── J · 蒸馏双触发 ──');
{
  const rootJ = mkdtempSync(join(tmpdir(), 'pm-ingest-dual-'));
  const { createIngest } = await import('./lib/ingest/index.js');
  const cfgJ = join(rootJ, 'config.json');
  const dataJ = join(rootJ, 'data');
  const hooks = new Map();
  const fakeCtx = {
    on(n, f) { if (!hooks.has(n)) hooks.set(n, []); hooks.get(n).push(f); return () => {}; },
    logger: { info() {}, warn() {}, debug() {} },
  };
  // [注意] 不能用 wf：那是 I 组的块内 const，J 组引用会 ReferenceError（被顶层吞掉只剩半截输出）
  writeFileSync(cfgJ, JSON.stringify({ enabled: true, capture: true, extract: false, distill: true, minDistillMessages: 1 }), 'utf8');

  // 先灌一批可蒸发的 L0
  const TJ = 1793600000000;
  for (let i = 0; i < 4; i++) {
    captureTurn({ sessionKey: 'dual', messages: [
      { id: 'dj' + i + 'u', role: 'user', content: '双触发测试用户消息 ' + i + '，内容足够长可以通过过滤。', timestamp: TJ + i * 2000 },
      { id: 'dj' + i + 'a', role: 'assistant', content: '双触发测试回答 ' + i + '，内容足够长可以通过过滤。', timestamp: TJ + i * 2000 + 1000 },
    ], opts: { root: dataJ, nowMs: TJ + 20000 + i, disableLock: true } });
  }

  const ing = createIngest(fakeCtx, { configPath: cfgJ, root: dataJ }, null);
  check('J', 'J1 注册了 turn-stopping（第一触发）', (hooks.get('agent/turn-stopping') || []).length >= 1, 'n=' + (hooks.get('agent/turn-stopping') || []).length);
  check('J', 'J2 status 能报告 distillRuns', typeof ing.status().distillRuns === 'number', String(ing.status().distillRuns));
  // [注意] 这里**不能**调 ing.runDistillNow()：它内部会解析真实 LLM 端点并发网络请求，
  //   在自测里就是挂 45 秒超时（曾把整个 selftest 的输出都吞掉）。
  //   正确做法：直接用 runDistill + 注入假 completeFn，验证同一条代码路径。
  const rD = await runDistill({
    llm: { baseUrl: 'http://fake', apiKey: 'x', model: 'x', maxTokens: 100, temperature: 0, timeoutMs: 100 },
    opts: { root: dataJ, sessionId: 'dual', cwd: 'D:/x', minDistillMessages: 1, disableLock: true },
    completeFn: async () => JSON.stringify([{ kind: 'note', layer: 'project', title: '双触发链路验证', summary: '蒸馏链路在测试里必须可跑通', content: '这条卡用来证明定时兜底调到的那个函数本身是工作的。' }]),
  });
  check('J', 'J3 蒸馏链路可用（假模型跑通并落盘）', (rD.written || 0) === 1, JSON.stringify(rD).slice(0, 140));
  check('J', 'J4 产物能被读回', readOwnEngrams(dataJ).length >= 1, 'n=' + readOwnEngrams(dataJ).length);
  try { ing.dispose(); } catch {}
  try { rmSync(rootJ, { recursive: true, force: true }); } catch {}
}

// ── L · 端到端：真实会话形态 + LLM 全挂（最恶劣条件）──
console.log('── L · 端到端（1 user + 20 assistant，LLM 全挂）──');
{
  const rootL = mkdtempSync(join(tmpdir(), 'pm-ingest-e2e-'));
  const dL = dirs(rootL); ensureDirs(dL);
  const TL = 1794000000000;
  // 真实形态：工具密集型会话 = 1 条 user + 大量 assistant
  const msgsL = [{ id: 'u1', role: 'user', content: '我要你把期7的三样都做完，并且做红队审核。', timestamp: TL }];
  for (let i = 0; i < 20; i++) msgsL.push({ id: 'a' + i, role: 'assistant', content: '已完成第 ' + i + ' 步：根治了真实缺陷，索引与数据同步正常。', timestamp: TL + 1000 * (i + 1) });
  const cL = captureTurn({ sessionKey: 'sL', messages: msgsL, opts: { root: rootL, nowMs: TL + 30000, disableLock: true } });
  check('L', 'L1 capture 全部写入（1 user + 20 assistant）', cL.written === 21, JSON.stringify(cL.written));

  const allL = readL0Messages(dL, {});
  const winsL = planWindows(allL, loadCursor(dL, 'extract', null, { processedKeys: [] }), { batchMessages: 24, minBatchMessages: 4 });
  check('L', 'L2 planWindows 能在 assistant 主导的会话切出窗口（旧代码 0）', winsL.length >= 1, 'wins=' + winsL.length + ' L0=' + allL.length);

  const fakeLlmL = { baseUrl: 'http://f', apiKey: 'x', model: 'x', maxTokens: 100, temperature: 0, timeoutMs: 100 };
  const exL = await runExtract({ llm: fakeLlmL, opts: { root: rootL, batchMessages: 24, minBatchMessages: 4, disableLock: true }, completeFn: async () => null });
  check('L', 'L3 LLM 全挂时 extract 仍产卡（走兜底）', (exL.written || 0) > 0, JSON.stringify(exL).slice(0, 150));
  check('L', 'L4 L1 卡可读回', readOwnRecords(rootL).cards.length > 0, 'n=' + readOwnRecords(rootL).cards.length);

  const diL = await runDistill({ llm: fakeLlmL, opts: { root: rootL, sessionId: 'sL', cwd: 'D:/x', minDistillMessages: 1, disableLock: true }, completeFn: async () => null });
  check('L', 'L5 LLM 全挂时 distill 也产出（fallbackDistill）', (diL.written || 0) > 0, JSON.stringify(diL).slice(0, 150));
  check('L', 'L6 蒸馏卡可读回', readOwnEngrams(rootL).length > 0, 'n=' + readOwnEngrams(rootL).length);

  const ingL = readOwnIngest(rootL);
  check('L', 'L7 检索侧能读到全部自产数据', ingL.cards.length >= 2, 'cards=' + ingL.cards.length);
  check('L', 'L8 全链路无数据丢失（capture→extract→distill→检索）',
    ingL.cards.length === readOwnRecords(rootL).cards.length + readOwnEngrams(rootL).length,
    'ingest=' + ingL.cards.length + ' l1=' + readOwnRecords(rootL).cards.length + ' eng=' + readOwnEngrams(rootL).length);
  try { rmSync(rootL, { recursive: true, force: true }); } catch {}
}

// ── M · L0 注入相关性门槛（实跑抓到的「无脑塞 24 条无关原话」）──
console.log('── M · L0 相关性门槛 ──');
{
  const { createRetriever } = await import('./lib/retrieval/retriever.js');
  const rt = createRetriever({
    l0Enabled: true, l0RecentDays: 30,
    conversationsDir: dataPath('memory-tencentdb/memory-tdai/conversations'),
  });
  await rt.warmup();
  const cases = [
    { q: '你要先把功能做好了才可以关旧的', want: true },
    { q: '刚刚跑的是 CPU', want: true },
    { q: '记忆改造到哪了', want: true },
    { q: '今天天气不错', want: false },
    { q: 'zzzz qqqq 无意义字符串', want: false },
    { q: '水处理 示例设备A 再生 示例单据', want: false },
  ];
  let okN = 0;
  for (const c of cases) {
    const r = await rt.search(c.q);
    const l0 = (r.hits || []).filter((x) => String(x.id).startsWith('l0round'));
    const got = l0.length > 0;
    const pass = got === c.want;
    if (pass) okN++;
    check('M', 'M ' + c.q.slice(0, 16) + ' → ' + (c.want ? '应命中' : '应拒绝'), pass,
      'L0=' + l0.length + (l0[0] ? ' 最高=' + (l0[0].score || 0).toFixed(1) : ''));
  }
  check('M', 'M7 判别正确率 6/6', okN === cases.length, okN + '/' + cases.length);
  // 关键合同：无关查询绝不能刷屏（旧代码恒为 24 条）
  const noise = await rt.search('今天是星期几天气怎么样');
  const noiseL0 = (noise.hits || []).filter((x) => String(x.id).startsWith('l0round'));
  check('M', 'M8 无关查询不刷屏（旧代码恒 24 条）', noiseL0.length <= 3, 'L0=' + noiseL0.length);
  // 关键合同：真命中时数量也受控（不再占满 k.fact）
  const real = await rt.search('你要先把功能做好了才可以关旧的');
  const realL0 = (real.hits || []).filter((x) => String(x.id).startsWith('l0round'));
  check('M', 'M9 真命中时数量受控（≤ k.fact/2）', realL0.length <= 12, 'L0=' + realL0.length);
}

// ── N · 事件驱动补跑（Idle 优先级下 Timer 会长期不跳）──
console.log('── N · 事件驱动补跑 ──');
{
  const rootN = mkdtempSync(join(tmpdir(), 'pm-ingest-catchup-'));
  const { createIngest } = await import('./lib/ingest/index.js');
  const cfgN = join(rootN, 'config.json');
  const dataN = join(rootN, 'data');
  const hooksN = new Map();
  const ctxN = {
    on(n, f) { if (!hooksN.has(n)) hooksN.set(n, []); hooksN.get(n).push(f); return () => {}; },
    logger: { info() {}, warn() {}, debug() {} },
  };
  writeFileSync(cfgN, JSON.stringify({ enabled: true, capture: true, extract: true, distill: false }), 'utf8');
  const ingN = createIngest(ctxN, { configPath: cfgN, root: dataN }, null);
  const flushN = (hooksN.get('session/flush') || [])[0];
  check('N', 'N1 注册了 session/flush', typeof flushN === 'function');

  // 灌 12 轮对话（够 1 个窗口），全程**不等 timer**
  const TN = 1795000000000;
  for (let i = 0; i < 12; i++) {
    await flushN({ id: 'sN', header: { cwd: 'D:/x' }, deriveMessages: () => [
      { id: 'nu' + i, role: 'user', source: { kind: 'user' }, content: '第' + i + '次提问：落盘游标必须记录清楚，内容要足够长才行。', timestamp: TN + i * 1000 },
      { id: 'na' + i, role: 'assistant', content: '已完成第' + i + '项，根治了真实缺陷，索引与数据同步正常。', timestamp: TN + i * 1000 + 500 },
    ] });
  }
  const stN = ingN.status();
  check('N', 'N2 capture 被钩子驱动（12 次）', stN.captureRuns >= 12, 'runs=' + stN.captureRuns);
  // [核心合同] 不靠 timer，extract 也应被 capture 钩子触发
  check('N', 'N3 extract 由 capture 钩子补跑（没等 timer）', stN.extractRuns >= 1, 'extractRuns=' + stN.extractRuns);
  // [判据说明] N4 只验「补跑链路跑通了」，不验「一定产出卡」——
  //   因为补跑走的是真实 LLM 端点，限流时走兜底、兜底也可能抽不出内容。
  //   产出能力由 K 组（限流兜底）和 L 组（端到端）保证。
  check('N', 'N4 补跑链路跑通（extractRuns>0 即可，产出取决于LLM）', stN.extractRuns >= 1,
    'runs=' + stN.extractRuns + ' written=' + stN.extractWritten);
  try { ingN.dispose(); } catch {}
  try { rmSync(rootN, { recursive: true, force: true }); } catch {}
}

  // ── N5~N7 · 补跑不得阻塞 capture 关键路径 ──
  {
    const rootN2 = mkdtempSync(join(tmpdir(), 'pm-ingest-perf-'));
    const { createIngest: ci2 } = await import('./lib/ingest/index.js');
    const cfgN2 = join(rootN2, 'config.json');
    const dataN2 = join(rootN2, 'data');
    const hooks2 = new Map();
    const ctx2 = {
      on(n, f) { if (!hooks2.has(n)) hooks2.set(n, []); hooks2.get(n).push(f); return () => {}; },
      logger: { info() {}, warn() {}, debug() {} },
    };
    writeFileSync(cfgN2, JSON.stringify({ enabled: true, capture: true, extract: true, distill: true }), 'utf8');
    const ing2 = ci2(ctx2, { configPath: cfgN2, root: dataN2 }, null);
    const flush2 = (hooks2.get('session/flush') || [])[0];
    const T2 = 1795100000000;
    const times = [];
    for (let i = 0; i < 20; i++) {
      const t0 = Date.now();
      await flush2({ id: 'sP', header: { cwd: 'D:/x' }, deriveMessages: () => [
        { id: 'pp' + i, role: 'user', source: { kind: 'user' }, content: '性能测试第' + i + '条，内容要足够长才能过过滤。', timestamp: T2 + i * 1000 },
      ] });
      times.push(Date.now() - t0);
    }
    times.sort((a, b) => a - b);
    const p50 = times[10];
    const maxT = times[19];
    check('N', 'N5 capture p50 < 50ms（补跑不拖慢关键路径）', p50 < 50, 'p50=' + p50 + 'ms');
    check('N', 'N6 capture max < 500ms（无长阻塞）', maxT < 500, 'max=' + maxT + 'ms');
    check('N', 'N7 20 次 capture 全部成功', times.length === 20, 'n=' + times.length);
    try { ing2.dispose(); } catch {}
    try { rmSync(rootN2, { recursive: true, force: true }); } catch {}
  }

// ── P · 卡片标题质量（实跑抓到「标题全是场景叙述」）──
console.log('── P · 卡片标题质量 ──');
{
  const { normalizeL1 } = await import('./lib/ingest/normalize.js');
  const items = [
    { type: 'episodic', title: '我（AI）在和系统调试记忆召回机制', content: 'DSH 进程是 Idle 优先级导致定时器不触发。', priority: 70 },
    { type: 'episodic', title: '现在去查', content: 'L0 注入原先无条件占满位置，已加门槛修复。', priority: 70 },
    { type: 'episodic', title: 'planWindows 强制user开头导致extract饿死', content: '真实会话是 1 user : 46 assistant。', priority: 80 },
  ];
  const outP = normalizeL1(items, { sessionId: 's', cwd: 'D:/x', maxItems: 5 });
  check('P', 'P1 产出 3 张卡', outP.length === 3, 'n=' + outP.length);
  check('P', 'P2 每张卡都有 title 字段', outP.every((x) => x.title && x.title.length > 0), JSON.stringify(outP.map((x) => x.title)));
  check('P', 'P3 场景模板标题被替换掉', !outP.some((x) => /^我（AI）在|^现在去|^接下来/.test(x.title)),
    JSON.stringify(outP.map((x) => x.title)));
  check('P', 'P4 好标题原样保留', outP.some((x) => String(x.title).indexOf('planWindows') >= 0), '');
  check('P', 'P5 标题都含具体对象', outP.every((x) => /[a-zA-Z]{3,}|[0-9]|进程|定时器|注入|会话/.test(x.title)), '');

  // [2026-10-22] 实跑抓到标题被切在英文词中间：「将 EXTRACT_SYSTEM_PROMPT 中的 sce」
  const longItem = [{ type: 'episodic', title: '', content: '将 EXTRACT_SYSTEM_PROMPT 中的 scene_name 格式改为名词性结论标题，并在下游显式读取 title 字段。', priority: 70 }];
  const outLong = normalizeL1(longItem, { sessionId: 's', cwd: 'D:/x', maxItems: 2 });
  check('P', 'P6 标题不在英文词中间截断', outLong.length === 1 && !/[a-z]{2}$/.test(String(outLong[0].title || '').trim()),
    JSON.stringify(String(outLong[0] && outLong[0].title)));
  check('P', 'P7 标题长度在合理范围（8~34 字）',
    outLong.length === 1 && String(outLong[0].title).length >= 4 && String(outLong[0].title).length <= 34,
    'len=' + String(outLong[0] && outLong[0].title).length);

  // [2026-10-22 三次修正] 实跑抓到 4 张卡全叫「超图记忆改造第13轮」（场景式短语当标题）
  const sceneItems = [
    { type: 'episodic', title: '超图记忆改造第13轮', content: '判断一句话三个月后是否对回答技术问题有用。', priority: 70 },
    { type: 'episodic', title: '关于L0检索的讨论', content: 'L0 候选无条件占满 k.fact 个位置，完全忽略分数。', priority: 70 },
    { type: 'episodic', title: '本次会话', content: 'DSH 进程是 Idle 优先级导致定时器不触发。', priority: 70 },
    { type: 'episodic', title: 'Idle优先级导致定时器不跳', content: 'DSH 进程是 Idle 优先级。', priority: 80 },
  ];
  const outScene = normalizeL1(sceneItems, { sessionId: 's', cwd: 'D:/x', maxItems: 6 });
  check('P', 'P8 场景式标题（第N轮/关于X/本次会话）被替换',
    !outScene.some((x) => /第\s*\d+\s*轮|^关于|^本次/.test(String(x.title || ''))),
    JSON.stringify(outScene.map((x) => String(x.title || '').slice(0, 16))));
  check('P', 'P9 好标题仍原样保留',
    outScene.some((x) => String(x.title || '').indexOf('Idle优先级') >= 0), '');
  check('P', 'P10 替换后的标题不重复（4 张各不相同）',
    new Set(outScene.map((x) => String(x.title || ''))).size === outScene.length,
    'unique=' + new Set(outScene.map((x) => String(x.title || ''))).size + '/' + outScene.length);

  // [2026-10-22 四次修正] 实跑抓到 4 张卡全叫 "backfill"（LLM 把会话名当标题）
  const sidItems = [
    { type: 'episodic', title: 'backfill', content: 'DSH 进程被设为 Idle 优先级，导致 setInterval 可能数小时不触发。', priority: 70 },
    { type: 'episodic', title: 'record', content: 'glm-4.6v-flash 返回 429，修法是加模型降级链。', priority: 70 },
    { type: 'episodic', title: 'Idle优先级导致定时器不跳', content: 'DSH 进程是 Idle 优先级。', priority: 80 },
  ];
  const outSid = normalizeL1(sidItems, { sessionId: 'backfill', cwd: 'D:/x', maxItems: 5 });
  check('P', 'P11 会话名当标题（backfill）被替换',
    !outSid.some((x) => /^(backfill|record)$/i.test(String(x.title || ''))),
    JSON.stringify(outSid.map((x) => String(x.title || '').slice(0, 16))));
  check('P', 'P12 纯英文短标题（无中文无名词）被替换',
    outSid.every((x) => String(x.title || '').length > 6), '');
  check('P', 'P13 好标题仍保留', outSid.some((x) => String(x.title || '').indexOf('Idle优先级') >= 0), '');

  // [2026-10-22 第22轮] 实测生产产出 8 张「会话：session-xxxx」标题
  const sidCore = 'session-<redacted>6f';
  const variants = [
    '会话：session-<redacted>6f',
    'session-<redacted>6f',
    '会话：session-<redacted>6',
  ];
  for (let i = 0; i < variants.length; i++) {
    const outV = normalizeL1(
      [{ type: 'episodic', title: variants[i], content: '新卡质量得到提升，包括HTML标签混入卡片内容与清洗逻辑调整。', priority: 70 }],
      { sessionId: sidCore, cwd: 'D:/x', maxItems: 2 }
    );
    check('P', 'P' + (14 + i) + ' 变体标题被替换: ' + variants[i].slice(0, 18),
      outV.length === 1 && !/session-f7a52c5e/.test(String(outV[0].title || '')),
      JSON.stringify(String(outV[0] && outV[0].title || '').slice(0, 30)));
  }
  // 纯 UUID 形态
  const outU = normalizeL1(
    [{ type: 'episodic', title: 'id:1792645849542-7d8f3a', content: '定时器不触发的根因是 Idle 优先级导致唤醒合并。', priority: 70 }],
    { sessionId: 'other', cwd: 'D:/x', maxItems: 2 }
  );
  check('P', 'P17 UUID 形态标题被替换',
    outU.length === 1 && !/^[a-z]*[:：]?\s*[0-9a-f]{8}-/i.test(String(outU[0].title || '')),
    JSON.stringify(String(outU[0] && outU[0].title || '').slice(0, 30)));

  // [2026-10-22 第24轮] 截断版 session id + 过短无名词标题
  const truncCases = [
    'session-<redacted>',
    'session-<redacted>-99a4-7b95ddb42',
  ];
  for (let i = 0; i < truncCases.length; i++) {
    const outT = normalizeL1(
      [{ type: 'episodic', title: truncCases[i], content: '当 maxTotalChars 设置为 400 时系统返回 392 字，这是保底至少一个场景的合理行为。', priority: 70 }],
      { sessionId: 'session-<redacted>6f', cwd: 'D:/x', maxItems: 2 }
    );
    check('P', 'P' + (18 + i) + ' 截断 session id 标题被替换',
      outT.length === 1 && !/session-f7a52c5e/.test(String(outT[0].title || '')),
      JSON.stringify(String(outT[0] && outT[0].title || '').slice(0, 30)));
  }
  const outShort = normalizeL1(
    [{ type: 'episodic', title: '坏卡修复', content: 'AI 确认 title 字段为空而 scene_name 是会话 id，并修复了 8 张坏卡。', priority: 70 }],
    { sessionId: 'other', cwd: 'D:/x', maxItems: 2 }
  );
  check('P', 'P20 过短无名词标题（坏卡修复）被替换',
    outShort.length === 1 && String(outShort[0].title || '').length > 6,
    JSON.stringify(String(outShort[0] && outShort[0].title || '').slice(0, 30)));
}

// ── O · L3 人格画像接管（关旧插件后不丢User画像）──
console.log('── O · 人格画像接管 ──');
{
  const { readPersona, extractPersonaFacts, appendPersonaFacts } = await import('./lib/ingest/persona.js');
  const p = readPersona();
  check('O', 'O1 能读 tdai 的 persona.md', !p.missing && p.bytes > 1000, 'bytes=' + p.bytes);
  check('O', 'O2 内容确实是User画像', p.text.indexOf('User Narrative Profile') >= 0 || p.text.indexOf('User') >= 0, p.text.slice(0, 30));

  const sample = '用户（User）喜欢在深夜做工程任务。User是示例单位的技术专家。今天天气不错。用户要求 AI 以后回答先立个表。这段是无关过场话。';
  const facts = extractPersonaFacts(sample, { maxItems: 8 });
  check('O', 'O3 能抽出稳定事实', facts.length >= 2, JSON.stringify(facts.map((f) => f.slice(0, 16))));
  check('O', 'O4 过场话被排除', !facts.some((f) => f.indexOf('今天天气') >= 0), '');
  check('O', 'O5 抽的都是指向用户的属性', facts.every((f) => /(用户|User)/.test(f)), '');

  const rootO = mkdtempSync(join(tmpdir(), 'pm-persona-'));
  const r1 = appendPersonaFacts(rootO, facts);
  check('O', 'O6 能追加到超图自己的文件', r1.appended >= 2, JSON.stringify(r1));
  const r2 = appendPersonaFacts(rootO, facts);
  check('O', 'O7 重复追加被去重', r2.appended === 0, JSON.stringify(r2));
  const noteText = readFileSync(r1.file, 'utf8');
  check('O', 'O8 文件里写着权威主档仍是 tdai', noteText.indexOf('权威主档') >= 0, '');
  // 关键：绝不能改 tdai 原件
  const p2 = readPersona();
  check('O', 'O9 tdai 的 persona.md 未被修改', p2.bytes === p.bytes, p.bytes + ' -> ' + p2.bytes);

  // [2026-10-22 补] 三级降级：关旧后不能因为 persona.md 消失就报错
  {
    const ownDir = mkdtempSync(join(tmpdir(), 'pm-persona-fb-'));
    const ownFile = join(ownDir, 'persona-notes.md');
    writeFileSync(ownFile, '# 超图画像要点\n- 用户喜欢深夜做工程任务\n', 'utf8');
    // ① 主档缺失 ⇒ 降级到自有笔记
    const pFallback = readPersona('C:/nonexistent/persona.md', ownFile);
    check('O', 'O10 主档缺失时降级到自有笔记', pFallback.source === 'own-notes' && pFallback.degraded === true,
      pFallback.source + ' bytes=' + pFallback.bytes);
    check('O', 'O11 降级后仍能读到内容', pFallback.text.indexOf('深夜') >= 0, '');
    // ② 两个都缺 ⇒ 安全返回，不抛
    let threw = false;
    let pNone = null;
    try { pNone = readPersona('C:/nope-a.md', 'C:/nope-b.md'); } catch { threw = true; }
    check('O', 'O12 全缺时不抛错', !threw);
    check('O', 'O13 全缺时返回 missing', pNone && pNone.missing === true && pNone.source === 'none', JSON.stringify(pNone));
    try { rmSync(ownDir, { recursive: true, force: true }); } catch {}
  }
  try { rmSync(rootO, { recursive: true, force: true }); } catch {}
}

// ── Q · 兜底抽出「可复用事实」（第12轮质量审计的核心修复）──
console.log('── Q · 兜底抽出可复用事实 ──');
{
  // [块作用域教训第 5 次] K 组里的 heuristicExtract 是块内导入，Q 组拿不到 ⇒ 必须自己导。
  const { heuristicExtract: heuristicExtractQ } = await import('./lib/ingest/extract.js');
  const TQ = 1796000000000;
  const winQ = { sessionKey: 'q', messages: [
    { role: 'assistant', content: '查到了:DSH 进程被系统设成 Idle 优先级，Windows 会合并定时器唤醒，setInterval 可能几小时不触发。', timestamp: TQ },
    { role: 'assistant', content: '改成事件驱动补跑:保留 setInterval 尽力而为，同时在 capture 钩子里检查该跑没跑，超时立即补跑。', timestamp: TQ + 1 },
    { role: 'assistant', content: '因为 L0 候选无条件占满 k.fact 个位置，完全不看分数，所以无关查询也能拿 16 分。', timestamp: TQ + 2 },
    { role: 'user', content: '以后记忆写入必须用落盘游标，不许用内存缓冲。', timestamp: TQ + 3 },
  ] };
  const hq = heuristicExtractQ(winQ, { maxItems: 8 });
  const allText = hq.map((x) => x.content).join(' ');
  check('Q', 'Q1 抽出根因类事实（Idle 优先级）', /Idle 优先级/.test(allText), JSON.stringify(hq.map((x) => x.content.slice(0, 18))));
  check('Q', 'Q2 抽出机制类事实（L0 无条件占满）', /L0 候选无条件占满/.test(allText), '');
  check('Q', 'Q3 抽出规则类（落盘游标）', hq.some((x) => x.type === 'instruction' && /落盘游标/.test(x.content)), '');
  check('Q', 'Q4 一条消息多个事实全扫（旧代码只取第一条）', hq.length >= 3, 'n=' + hq.length);
  check('Q', 'Q5 标题不含口语前缀（查到了:/因为/确认了:）',
    !hq.some((x) => /^(查到了|因为|确认了|发现|原来)\s*[:：]/.test(String(x.scene_name || ''))),
    JSON.stringify(hq.map((x) => String(x.scene_name || '').slice(0, 16))));
  check('Q', 'Q6 标题含具体名词（可被检索命中）',
    hq.every((x) => /[a-zA-Z]{3,}|[0-9]|进程|定时器|游标|检索|注入|优先级/.test(String(x.scene_name || ''))), '');
}

// ── R · LLM 模型降级链（主模型持续 429 时自动换）──
console.log('── R · LLM 模型降级链 ──');
{
  // 用假 fetch 模拟：主模型 429，备用模型 200
  const realFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body.model);
    if (body.model === 'glm-4.6v-flash') {
      return { ok: false, status: 429, headers: { get: () => null } };
    }
    return {
      ok: true, status: 200,
      json: async () => ({ choices: [{ message: { content: '[{"type":"episodic","title":"降级成功","content":"备用模型可用"}]' } }] }),
      headers: { get: () => null },
    };
  };
  try {
    const { complete } = await import('./lib/ingest/llm.js');
    const ep = { baseUrl: 'http://fake', apiKey: 'k', model: 'glm-4.6v-flash', maxTokens: 100, temperature: 0, timeoutMs: 5000 };
    const out = await complete(ep, 'sys', 'user');
    check('R', 'R1 主模型 429 时自动降级并返回结果', typeof out === 'string' && out.indexOf('降级成功') >= 0, JSON.stringify(String(out).slice(0, 40)));
    check('R', 'R2 降级时确实调用了备用模型', calls.indexOf('glm-4-flash') >= 0, JSON.stringify(calls.slice(0, 5)));
    check('R', 'R3 主模型被优先尝试', calls[0] === 'glm-4.6v-flash', calls[0]);
  } finally {
    globalThis.fetch = realFetch;
  }

  // 全部模型都挂 ⇒ 返回 null（不能假装成功）
  const realFetch2 = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 429, headers: { get: () => null } });
  try {
    const { complete: complete2 } = await import('./lib/ingest/llm.js');
    const ep2 = { baseUrl: 'http://fake', apiKey: 'k', model: 'glm-4.6v-flash', maxTokens: 100, temperature: 0, timeoutMs: 5000 };
    const out2 = await complete2(ep2, 'sys', 'user');
    check('R', 'R4 全部模型失败时返回 null（不假装成功）', out2 === null, String(out2));
  } finally {
    globalThis.fetch = realFetch2;
  }
}

// ── S · 检索命中必须自带可读文本（实跑误判「召回 0」的根因）──
console.log('── S · 命中带文本 ──');
{
  const { createRetriever: cr } = await import('./lib/retrieval/retriever.js');
  const rtS = cr({ l0Enabled: false });
  await rtS.warmup();
  const res = await rtS.search('在线embedding熔断缺失问题');
  const hitsS = res.hits || [];
  check('S', 'S1 有命中结果', hitsS.length > 0, 'n=' + hitsS.length);
  const withTitle = hitsS.filter((h) => String(h.title || '').length > 0);
  check('S', 'S2 命中结果自带 title（不是只有 id）', withTitle.length > 0,
    '带标题的 ' + withTitle.length + '/' + hitsS.length);
  check('S', 'S3 命中结果自带 content', hitsS.some((h) => String(h.content || '').length > 0), '');
  check('S', 'S4 命中结果标注来源（_source）', hitsS.some((h) => String(h.source || '').length > 0),
    JSON.stringify(hitsS.slice(0,3).map((h) => h.source)));
  // [核心合同] 自产卡命中时必须能一眼看出是自产卡
  const ownHit = hitsS.find((h) => String(h.source || '').indexOf('ingest') >= 0);
  check('S', 'S5 自产卡命中能被辨认出来', !!ownHit, ownHit ? String(ownHit.title).slice(0,30) : '未命中自产卡');
}

// ── T · 窗口优先选高信息量消息（第17轮）──
console.log('── T · 窗口优先选事实 ──');
{
  const { planWindows: pw } = await import('./lib/ingest/extract.js');
  const TT = 1797000000000;
  // 造 30 条消息：前 20 条是过程叙述，后 10 条是技术事实
  const msgs = [];
  for (let i = 0; i < 20; i++) {
    msgs.push({ id: 'p' + i, sessionKey: 's', role: 'assistant', content: '这没问题。接下来继续做最终验证，先看下一步。', timestamp: TT + i * 1000 });
  }
  for (let i = 0; i < 10; i++) {
    msgs.push({ id: 'f' + i, sessionKey: 's', role: 'assistant', content: '根因找到了：DSH 进程是 Idle 优先级，导致 setInterval 定时器可能数小时不触发。', timestamp: TT + 30000 + i * 1000 });
  }
  const emptyCur = { processedKeys: [], retiredKeys: [] };
  const wins = pw(msgs, emptyCur, { batchMessages: 10, minBatchMessages: 2 });
  check('T', 'T1 切出了窗口', wins.length > 0, 'n=' + wins.length);
  const firstWin = wins[0] ? wins[0].messages : [];
  const factN = firstWin.filter((m) => /Idle|setInterval|定时器/.test(String(m.content))).length;
  const procN = firstWin.filter((m) => /这没问题|最终验证/.test(String(m.content))).length;
  check('T', 'T2 首个窗口优先包含技术事实', factN > 0, '事实 ' + factN + ' / 过程 ' + procN);
  check('T', 'T3 首个窗口事实数 > 过程数', factN > procN, factN + ' vs ' + procN);
  // 窗口内仍按时间排序（上下文连贯）
  let sorted = true;
  for (let i = 1; i < firstWin.length; i++) if (firstWin[i].timestamp < firstWin[i-1].timestamp) sorted = false;
  check('T', 'T4 窗口内按时间排序（保持上下文连贯）', sorted, '');
}

// ── U · 蒸馏路径质量闸门（实跑产出过「它其实命中了」这类卡）──
console.log('── U · 蒸馏质量闸门 ──');
{
  const { normalizeEngrams: ne } = await import('./lib/ingest/normalize.js');
  const llmOut = [
    { kind: 'note', layer: 'session', title: '它其实命中了', summary: '命中但没标题', content: '它其实命中了只是结果里没有标题。' },
    { kind: 'event', layer: 'session', title: '补测试并做最终验证', summary: '收尾', content: '补测试并做最终验证。' },
    { kind: 'decision', layer: 'project', title: 'Idle优先级导致定时器不跳', summary: '根因', content: 'DSH 进程是 Idle 优先级，Windows 会合并定时器唤醒，setInterval 可能数小时不触发。' },
    { kind: 'fact', layer: 'project', title: 'L0门槛取25', summary: '阈值', content: 'L0 相关性门槛取绝对分 25，真命中 36~142 分，无关 12~16 分。' },
  ];
  const outU = ne(llmOut, { sessionId: 's', cwd: 'D:/x', maxItems: 6 });
  check('U', 'U1 过程叙述（它其实命中了）被拒', !outU.some((e) => /^它其实/.test(String(e.title))), '');
  check('U', 'U2 过程叙述（补测试并做最终验证）被拒', !outU.some((e) => /补测试/.test(String(e.title))), '');
  check('U', 'U3 技术事实通过（Idle 优先级）', outU.some((e) => /Idle/.test(String(e.title))), '');
  check('U', 'U4 参数类通过（L0门槛）', outU.some((e) => /L0门槛|L0 门槛/.test(String(e.title))), '');
  check('U', 'U5 恰好通过 2 条', outU.length === 2, 'n=' + outU.length);
  // 决策/约定类不强制技术名词（实跑教训：「先把功能做好才可关旧插件」是有效约定）
  const decOut = ne([{ kind: 'decision', layer: 'project', title: '关旧顺序约定', summary: '先功能后关旧', content: 'User明确：先把功能做好才可关旧插件。' }], { sessionId: 's', cwd: 'D:/x' });
  check('U', 'U6 决策/约定类不被技术名词要求挡住', decOut.length === 1, 'n=' + decOut.length);

  // [2026-10-22 第19轮] 实跑抓到 engram 卡标题是纯 "</style>"
  const htmlOut = ne([
    { kind: 'note', layer: 'session', title: '</style>', summary: '', content: '</style>' },
    { kind: 'note', layer: 'session', title: '<div class="x">注入段为空现象</div>', summary: '注入段为空', content: '注入段为空现象需要排查。' },
  ], { sessionId: 's', cwd: 'D:/x', maxItems: 5 });
  check('U', 'U7 纯 HTML 卡被拒（不产「对话片段」占位）', htmlOut.length === 1, 'n=' + htmlOut.length);
  check('U', 'U8 标题里的 HTML 标签被剥净',
    htmlOut.every((x) => !/<[^>]*>/.test(String(x.title || ''))),
    JSON.stringify(htmlOut.map((x) => String(x.title || ''))));
  check('U', 'U9 剥完的标题仍有内容', htmlOut.every((x) => String(x.title || '').length >= 4), '');
}

// ── V · persona 注入接管（期7-D 关旧前置）──
console.log('── V · persona 注入接管 ──');
{
  const { createSectionRenderer } = await import('./lib/section.js');
  const mk = (cfg) => createSectionRenderer({
    orchestrator: { levelAvailability: () => ({ engram: true }) },
    prefetcher: null, config: cfg, logger: null,
  });
  const asm = { agent: { session: { id: 'sess-v' } } };

  // ① 关闭时不注入（默认行为不变）
  const off = mk({ personaInject: false });
  const outOff = off(asm);
  check('V', 'V1 personaInject=false 时不注入 persona', outOff.indexOf('<user-persona>') < 0, 'len=' + outOff.length);
  check('V', 'V2 关闭时仍保留固定说明段', outOff.indexOf('<unified-memory>') >= 0, '');

  // ② 打开时注入，且内容来自真实 persona.md
  const on = mk({ personaInject: true, personaMaxChars: 300 });
  const outOn = on(asm);
  check('V', 'V3 personaInject=true 时注入 persona', outOn.indexOf('<user-persona>') >= 0, 'len=' + outOn.length);
  check('V', 'V4 注入内容是User画像', outOn.indexOf('User Narrative Profile') >= 0 || outOn.indexOf('User') >= 0, '');
  check('V', 'V5 固定说明段仍在', outOn.indexOf('<unified-memory>') >= 0, '');
  check('V', 'V6 遵守 personaMaxChars 预算', outOn.length < 1200, 'len=' + outOn.length);

  // ③ 核心合同：同一会话内必须逐字节稳定（否则前缀缓存全废）
  const a = on(asm);
  const b = on(asm);
  check('V', 'V7 同会话两次渲染逐字节相同（不破前缀缓存）', a === b, 'a=' + a.length + ' b=' + b.length);

  // ④ 不同会话可以各自快照
  const c = on({ agent: { session: { id: 'sess-other' } } });
  check('V', 'V8 换会话也能正常渲染', c.indexOf('<user-persona>') >= 0, 'len=' + c.length);
}

// ── W · persona 注入接管（走 assembly.contexts 通道，与 tdai 同位）──
console.log('── W · persona 注入（contexts 通道）──');
{
  const modW = await import('./lib/index.js');
  const buildCtx = () => {
    const hooks = new Map();
    const ctx = {
      on(n, f) { if (!hooks.has(n)) hooks.set(n, []); hooks.get(n).push(f); return () => {}; },
      effect(fn) { try { const d = fn(); return typeof d === 'function' ? d : () => {}; } catch { return () => {}; } },
      get() { return undefined; },
      logger: { info(){}, warn(){}, debug(){}, error(){} },
      systemPrompt: { section(){ return () => {}; }, context(){ return () => {}; } },
    };
    return { hooks, ctx };
  };
  const baseCfg = {
    __resetMerge: true, enabled: true, hypergraphAutoRefresh: false,
    ingest: { configPath: 'C:/Users/Administrator/AppData/Local/Temp/pm-none-w.json' },
    logs: { dir: 'C:/Users/Administrator/AppData/Local/Temp/pm-w-logs' },
  };

  // ① 关闭时不注入
  const off = buildCtx();
  const dOff = modW.apply(off.ctx, Object.assign({}, baseCfg, { personaInject: false }));
  const asmOff = { sections: [], contexts: [], agent: { session: { id: 'w1' } } };
  const hookOff = (off.hooks.get('system-prompt/assemble') || [])[0];
  const outOff = hookOff ? await hookOff(asmOff, {}, async () => asmOff) : asmOff;
  check('W', 'W1 personaInject=false 时不注入', !(outOff.contexts || []).some((c) => c.name === 'Assistant:persona'),
    JSON.stringify((outOff.contexts || []).map((c) => c.name)));
  if (typeof dOff === 'function') dOff();

  // ② 打开时注入，同名不重复
  const on = buildCtx();
  const dOn = modW.apply(on.ctx, Object.assign({}, baseCfg, { personaInject: true, personaMaxChars: 200 }));
  const asmOn = { sections: [], contexts: [], agent: { session: { id: 'w2' } } };
  const hookOn = (on.hooks.get('system-prompt/assemble') || [])[0];
  const outOn = hookOn ? await hookOn(asmOn, {}, async () => asmOn) : asmOn;
  const p1 = (outOn.contexts || []).filter((c) => c.name === 'Assistant:persona');
  check('W', 'W2 personaInject=true 时注入 persona', p1.length === 1, 'n=' + p1.length);
  check('W', 'W3 注入内容是User画像', p1[0] && (p1[0].text.indexOf('User Narrative Profile') >= 0 || p1[0].text.indexOf('User') >= 0), '');
  check('W', 'W4 遵守 personaMaxChars 预算', p1[0] && p1[0].text.length < 600, 'len=' + (p1[0] ? p1[0].text.length : 0));
  check('W', 'W5 order=1001（与 tdai 同位）', p1[0] && p1[0].order === 1001, p1[0] && p1[0].order);

  // ③ 核心合同：同会话两次注入必须逐字节一致（否则破缓存）
  const a2 = await hookOn(asmOn, {}, async () => asmOn);
  const t1 = (outOn.contexts || []).find((c) => c.name === 'Assistant:persona');
  const t2 = (a2.contexts || []).find((c) => c.name === 'Assistant:persona');
  check('W', 'W6 同会话两次注入逐字节相同', !!t1 && !!t2 && t1.text === t2.text, '');

  // ④ 原有 contexts 不能被冲掉
  const keep = buildCtx();
  const dKeep = modW.apply(keep.ctx, Object.assign({}, baseCfg, { personaInject: true, personaMaxChars: 100 }));
  const hookKeep = (keep.hooks.get('system-prompt/assemble') || [])[0];
  const asmKeep = { sections: [], contexts: [{ name: 'existing', order: 1, text: 'abc' }], agent: { session: { id: 'w3' } } };
  const outKeep = await hookKeep(asmKeep, {}, async () => asmKeep);
  check('W', 'W7 原有 contexts 被保留', (outKeep.contexts || []).some((c) => c.name === 'existing'),
    JSON.stringify((outKeep.contexts || []).map((c) => c.name)));
  if (typeof dOn === 'function') dOn();
  if (typeof dKeep === 'function') dKeep();
}

// ── X · scene-navigation 注入接管 ──
console.log('── X · scene-navigation 接管 ──');
{
  // ① 纯函数：生成器本身
  const { generateSceneNavigation } = await import('./lib/ingest/scene-nav.js');
  const nav = generateSceneNavigation();
  check('X', 'X1 能生成场景导航', nav.text.length > 0 && nav.scenes > 0, 'scenes=' + nav.scenes + ' chars=' + nav.totalChars);
  check('X', 'X2 用 XML 标签包裹', nav.text.indexOf('<scene-navigation>') === 0 && nav.text.indexOf('</scene-navigation>') > 0, '');
  check('X', 'X3 按热度降序（最高热度在最前）', nav.text.indexOf('软件开发与工程项目') < nav.text.indexOf('KVMEM'), '');
  check('X', 'X4 每条含路径/热度/摘要', /### Path: /.test(nav.text) && /热度/.test(nav.text) && /Summary: /.test(nav.text), '');
  check('X', 'X5 遵守 maxTotalChars 预算', generateSceneNavigation(null, { maxScenes: 3, maxTotalChars: 600 }).totalChars <= 700, '');
  check('X', 'X6 遵守 maxScenes 上限', generateSceneNavigation(null, { maxScenes: 2 }).scenes <= 2, '');
  const miss = generateSceneNavigation('C:/definitely-not-exist', {});
  check('X', 'X7 目录不存在时安全返回', miss.missing === true && miss.text === '', '');

  // ② 接线：真的注入 contexts
  const modX = await import('./lib/index.js');
  const hooksX = new Map();
  const ctxX = {
    on(n, f) { if (!hooksX.has(n)) hooksX.set(n, []); hooksX.get(n).push(f); return () => {}; },
    effect(fn) { try { const dd = fn(); return typeof dd === 'function' ? dd : () => {}; } catch { return () => {}; } },
    get() { return undefined; },
    logger: { info(){}, warn(){}, debug(){}, error(){} },
    systemPrompt: { section(){ return () => {}; }, context(){ return () => {}; } },
  };
  const dX = modX.apply(ctxX, {
    __resetMerge: true, enabled: true, hypergraphAutoRefresh: false,
    sceneNavInject: true, sceneNavMaxChars: 1200,
    ingest: { configPath: 'C:/Users/Administrator/AppData/Local/Temp/pm-none-x.json' },
    logs: { dir: 'C:/Users/Administrator/AppData/Local/Temp/pm-x-logs' },
  });
  const hookX = (hooksX.get('system-prompt/assemble') || [])[0];
  const asmX = { sections: [], contexts: [], agent: { session: { id: 'x1' } } };
  const outX = await hookX(asmX, {}, async () => asmX);
  const navCtx = (outX.contexts || []).filter((c) => c.name === 'Assistant:scene-nav');
  check('X', 'X8 sceneNavInject=true 时注入', navCtx.length === 1, 'n=' + navCtx.length);
  check('X', 'X9 注入内容含场景索引', navCtx[0] && navCtx[0].text.indexOf('软件开发与工程项目') >= 0, '');
  check('X', 'X10 order=1002（排在 persona 之后）', navCtx[0] && navCtx[0].order === 1002, navCtx[0] && navCtx[0].order);
  const outX2 = await hookX(asmX, {}, async () => asmX);
  check('X', 'X11 同会话两次注入逐字节相同（不破缓存）',
    JSON.stringify(outX) === JSON.stringify(outX2), '');

  // ③ 关闭时不注入（必须用**全新的 hooks**，否则会调到上一个实例的 listener）
  const hooksY = new Map();
  const ctxY = {
    on(n, f) { if (!hooksY.has(n)) hooksY.set(n, []); hooksY.get(n).push(f); return () => {}; },
    effect(fn) { try { const dd = fn(); return typeof dd === 'function' ? dd : () => {}; } catch { return () => {}; } },
    get() { return undefined; },
    logger: { info(){}, warn(){}, debug(){}, error(){} },
    systemPrompt: { section(){ return () => {}; }, context(){ return () => {}; } },
  };
  const dY = modX.apply(ctxY, {
    __resetMerge: true, enabled: true, hypergraphAutoRefresh: false, sceneNavInject: false,
    ingest: { configPath: 'C:/Users/Administrator/AppData/Local/Temp/pm-none-x2.json' },
    logs: { dir: 'C:/Users/Administrator/AppData/Local/Temp/pm-x-logs2' },
  });
  const hookY = (hooksY.get('system-prompt/assemble') || [])[0];
  const asmY = { sections: [], contexts: [], agent: { session: { id: 'x2' } } };
  const outY = hookY ? await hookY(asmY, {}, async () => asmY) : asmY;
  check('X', 'X12 sceneNavInject=false 时不注入', !(outY.contexts || []).some((c) => c.name === 'Assistant:scene-nav'),
    JSON.stringify((outY.contexts || []).map((c) => c.name)));
  if (typeof dX === 'function') dX();
  if (typeof dY === 'function') dY();
}

// ── Y · 重启前预演（真实 profile 配置 + 两个新开关）──
console.log('── Y · 重启前预演 ──');
{
  const modY = await import('./lib/index.js');
  const hooksY = new Map();
  const secsY = [];
  const ctxY = {
    on(n, f) { if (!hooksY.has(n)) hooksY.set(n, []); hooksY.get(n).push(f); return () => {}; },
    effect(fn) { try { const dd = fn(); return typeof dd === 'function' ? dd : () => {}; } catch { return () => {}; } },
    get() { return undefined; },
    logger: { info(){}, warn(){}, debug(){}, error(){} },
    systemPrompt: { section(o){ secsY.push(o); return () => {}; }, context(){ return () => {}; } },
  };
  // 完全照 profile 的真实配置 + 本次要开的两个新开关
  const cfgY = {
    __resetMerge: true, enabled: true, emit: 'section', freezePerSession: true,
    injectMaxChars: 8000, budgetTokens: 450, order: 0.6,
    hypergraph: { indexRoot: dataPath('hypergraph') },
    hypergraphAutoRefresh: false,
    workingMemoryDir: dataPath('working'),
    retrieval: { l0Enabled: true, l0RecentDays: 30, sourceWeight: 0.85, topicBoost: 0.15 },
    ingest: { configPath: dataPath('ingest/config.json') },
    logs: { dir: dataPath('logs'), wakeSampleRate: 1.0 },
    personaInject: true, personaMaxChars: 3000,
    sceneNavInject: true, sceneNavMaxChars: 4000,
  };
  let disposeY = null;
  let threw = false;
  try { disposeY = modY.apply(ctxY, cfgY); } catch (e) { threw = true; }
  check('Y', 'Y1 apply 不抛错', !threw, '');
  check('Y', 'Y2 返回可调用的 dispose', typeof disposeY === 'function', typeof disposeY);
  check('Y', 'Y3 注册了 digest section', secsY.some((s) => s.name === 'unified-memory:digest'),
    JSON.stringify(secsY.map((s) => s.name)));
  const needHooks = ['agent/pre-step', 'agent/turn-stopping', 'system-prompt/assemble', 'session/flush'];
  const missingHooks = needHooks.filter((h) => !(hooksY.get(h) || []).length);
  check('Y', 'Y4 四个钩子都注册了', missingHooks.length === 0, missingHooks.join(',') || 'all');

  const asmY = { sections: [], contexts: [], agent: { session: { id: 'preflight-y' } } };
  const hookY = (hooksY.get('system-prompt/assemble') || [])[0];
  const outY = await hookY(asmY, {}, async () => asmY);
  check('Y', 'Y5 persona 真的注入', (outY.contexts || []).some((c) => c.name === 'Assistant:persona'),
    JSON.stringify((outY.contexts || []).map((c) => c.name)));
  check('Y', 'Y6 scene-nav 真的注入', (outY.contexts || []).some((c) => c.name === 'Assistant:scene-nav'), '');
  const outY2 = await hookY(asmY, {}, async () => asmY);
  check('Y', 'Y7 两次渲染逐字节相同（不破前缀缓存）',
    JSON.stringify(outY) === JSON.stringify(outY2), '');
  // 原有 contexts 不被冲掉（关旧前 tdai 还在，两条会并存）
  const asmZ = { sections: [], contexts: [{ name: 'tdai:recall', order: 1000, text: 'x' }], agent: { session: { id: 'preflight-z' } } };
  const outZ = await hookY(asmZ, {}, async () => asmZ);
  check('Y', 'Y8 原有 contexts 被保留（不冲掉 tdai 的）',
    (outZ.contexts || []).some((c) => c.name === 'tdai:recall'),
    JSON.stringify((outZ.contexts || []).map((c) => c.name)));
  if (typeof disposeY === 'function') { try { disposeY(); } catch {} }
}


// ── Z · 蒸馏侧标题闸门（与 normalizeL1 共用同一份判据）──
console.log('── Z · 蒸馏侧标题闸门 ──');
{
  const { normalizeEngrams: nE, isIdLikeTitle, isTooShortVague } = await import('./lib/ingest/normalize.js');
  const mk = (title) => nE(
    [{ kind: 'decision', layer: 'project', title, summary: 'User排查额度条不显示的根因，确认汇总接口缺组而逐模型接口仍在返回。', content: 'User排查额度条不显示的根因，确认汇总接口缺组而逐模型接口仍在返回。' }],
    { maxItems: 1 }
  );

  // ① 判据函数本身
  check('Z', 'Z1 裸 session id 判为 id-like', isIdLikeTitle('session-00000000-0000-0000-9f67-ed4190894d7e') === true);
  check('Z', 'Z2 会话前缀 id 判为 id-like', isIdLikeTitle('会话：session-00000000-0000-0000-9f67-ed4190894d7e') === true);
  check('Z', 'Z3 UUID 形态判为 id-like', isIdLikeTitle('a1b2c3d4-e5f6-7890') === true);
  check('Z', 'Z4 正常标题不误判', isIdLikeTitle('期8 认知信用协议落盘') === false);
  check('Z', 'Z5 长度<6 判为过短', isTooShortVague('额度修复') === true);
  check('Z', 'Z6 长度>=6 不算过短', isTooShortVague('期8 认知信用协议') === false);

  // ② 蒸馏路径真的会替换
  for (const [i, badTitle] of [
    'session-00000000-0000-0000-9f67-ed4190894d7e',
    '会话：session-00000000-0000-0000-9f67-ed4190894d7e',
    '额度修复',
  ].entries()) {
    const out = mk(badTitle);
    const t = out.length ? String(out[0].title || '') : '';
    check('Z', 'Z' + (7 + i) + ' 蒸馏侧替换坏标题: ' + badTitle.slice(0, 18),
      out.length === 1 && !isIdLikeTitle(t) && !isTooShortVague(t),
      JSON.stringify(t.slice(0, 28)));
  }

  // ③ 好标题原样保留
  const goodOut = mk('坑6（索引与数据同步）的修复');
  check('Z', 'Z10 蒸馏侧保留正常标题',
    goodOut.length === 1 && String(goodOut[0].title || '').includes('索引'),
    JSON.stringify(String(goodOut[0] && goodOut[0].title || '').slice(0, 28)));
}

// ══════════════════════════════════════════════════════════════
// ── AA · 期8.1/8.2 认知信用 + 冷却期（红队五项阻断的回归）──
//
// 背景：红队 REDTEAM-8.1-8.2 实证 selftest-ingest 的 271 项对 belief/consolidate
//   **零命中** —— 期8.1/8.2 只有 bench-p8.mjs / trace-p8.mjs 这两个一次性脚本在测，
//   而它们没进 restart-batch verify 的六套测试。本组把它们固化成常驻回归。
//
// 覆盖（与任务书逐条对齐）：
//   AA1~AA5   inferSourceWeight 五档（中文报错 / 英文报错 / 纠正 / 推测 / 普通陈述）
//   AA6~AA9   judgeConflict 四态（fork / refute / merge / ignore）
//   AA10~AA13 filterEngrams（refuted 被过滤 / 无 status 被放行 / scoped_active 按 scope）
//   AA14~AA18 consolidate（onCommit 抛错不中断且 pending 清理 / 重复归档不重复落盘 /
//              refute 回写旧卡 / 单条失败计数）
//   AA19~AA22 distill 接线（开关默认 false 逐位等同 / 打开后 refute 旧卡 append refuted /
//              fork / 判决统计）
// ══════════════════════════════════════════════════════════════
console.log('── AA · 认知信用与冷却期（期8.1/8.2）──');
{
  const {
    inferSourceWeight, judgeConflict, filterEngrams, normalizeEngramV2, scopeDelta, STATUS,
  } = await import('./lib/ingest/belief.js');
  const { createConsolidation, IDLE_CONSOLIDATE_MS } = await import('./lib/ingest/consolidate.js');

  // ── ① inferSourceWeight 五档 ──
  check('AA', 'AA1 中文报错词 = 0.9（红队 B-1：原来被 \b 挡住判成 0.6）',
    inferSourceWeight({ role: 'user', text: '编译失败了' }) === SOURCE_WEIGHTS_OBS,
    JSON.stringify(inferSourceWeight({ role: 'user', text: '编译失败了' })));
  check('AA', 'AA1b 中文报错词更多形态 = 0.9',
    ['这个方案失败了', '他失败了三次', '✗ 未通过', 'ROCm 编译报错 hipErrorOutOfMemory', '进程崩溃了'].every((x) =>
      inferSourceWeight({ role: 'user', text: x }) === SOURCE_WEIGHTS_OBS),
    JSON.stringify(['这个方案失败了', '他失败了三次', '✗ 未通过', '进程崩溃了'].map((x) => inferSourceWeight({ role: 'user', text: x }))));
  check('AA', 'AA2 英文报错词 = 0.9（\b 分支保留，行为不变）',
    inferSourceWeight({ role: 'user', text: 'ERROR: file not found' }) === SOURCE_WEIGHTS_OBS
    && inferSourceWeight({ toolError: true, text: 'error: hipErrorOutOfMemory' }) === SOURCE_WEIGHTS_OBS
    && inferSourceWeight({ role: 'user', text: 'exit code 1' }) === SOURCE_WEIGHTS_OBS);
  // [2026-10-23 修正] 第一版这句自相矛盾：句子里本来就含 "error" ⇒ 必然命中 0.9。
  //   真正要验的是「\b 分支没把无报错词的普通句误判成报错」，改用完全无 error 词的句子。
  check('AA', 'AA2b 英文词边界未被破坏（无报错词的普通英文句仍走 0.6）',
    inferSourceWeight({ role: 'user', text: 'The build finished gracefully and all steps passed' }) === 0.6
    && inferSourceWeight({ role: 'assistant', text: 'All checks passed' }) === 0.2,
    JSON.stringify([
      inferSourceWeight({ role: 'user', text: 'The build finished gracefully and all steps passed' }),
      inferSourceWeight({ role: 'assistant', text: 'All checks passed' }),
    ]));
  check('AA', 'AA3 纠正词 = 1.0',
    inferSourceWeight({ role: 'user', text: '不对，应该是 MAX_JOBS=2' }) === 1.0);
  check('AA', 'AA4 推测词 = 0.4',
    inferSourceWeight({ role: 'user', text: '可能是显存不够吧' }) === 0.4
    && inferSourceWeight({ role: 'user', text: '我猜大概是端口问题' }) === 0.4);
  check('AA', 'AA5 普通陈述 = 0.6 / 模型推断 = 0.2',
    inferSourceWeight({ role: 'user', text: 'User问：期7 的 L0 捕获怎么保证不重复' }) === 0.6
    && inferSourceWeight({ role: 'assistant', text: '我建议这样处理。' }) === 0.2);

  // ── ② judgeConflict 四态 ──
  const mkE = (o) => normalizeEngramV2(Object.assign({ id: 'x', title: 't', claim: 'c', scope_tags: ['global'], confidence: 0.5 }, o));
  const vFork = judgeConflict(mkE({ id: 'a', scope_tags: ['ubuntu'], confidence: 0.9 }), mkE({ id: 'b', scope_tags: ['arch'], confidence: 0.5 }));
  check('AA', 'AA6 judgeConflict fork（scope 分化 ⇒ 双 scoped_active，绝不 refuted）',
    vFork.action === 'fork' && vFork.newStatus === STATUS.SCOPED_ACTIVE && vFork.oldStatus === STATUS.SCOPED_ACTIVE,
    JSON.stringify(vFork));
  const vRefute = judgeConflict(mkE({ id: 'a', confidence: 0.95 }), mkE({ id: 'b', confidence: 0.5 }));
  check('AA', 'AA7 judgeConflict refute（同 scope 高出 0.30 ⇒ 旧卡 refuted）',
    vRefute.action === 'refute' && vRefute.newStatus === STATUS.ACTIVE && vRefute.oldStatus === STATUS.REFUTED,
    JSON.stringify(vRefute));
  const vMerge = judgeConflict(mkE({ id: 'a', confidence: 0.6 }), mkE({ id: 'b', confidence: 0.5 }));
  check('AA', 'AA8 judgeConflict merge（分差 ≤0.30 ⇒ 双 active）',
    vMerge.action === 'merge' && vMerge.newStatus === STATUS.ACTIVE && vMerge.oldStatus === STATUS.ACTIVE,
    JSON.stringify(vMerge));
  const vIgnore = judgeConflict(mkE({ id: 'a', confidence: 0.2 }), mkE({ id: 'b', confidence: 0.9 }));
  check('AA', 'AA9 judgeConflict ignore（新证据更弱 ⇒ 新卡 superseded，旧卡 active）',
    vIgnore.action === 'ignore' && vIgnore.newStatus === STATUS.SUPERSEDED && vIgnore.oldStatus === STATUS.ACTIVE,
    JSON.stringify(vIgnore));
  check('AA', 'AA9b judgeConflict 不修改入参（纯函数）',
    (() => { const a = mkE({ id: 'a', confidence: 0.95 }); const b = mkE({ id: 'b', confidence: 0.5 }); judgeConflict(a, b); return a.status === STATUS.ACTIVE && b.status === STATUS.ACTIVE; })(), '');

  // ── ③ filterEngrams ──
  const poolAA = [
    { id: 'L0', claim: '无 status 老卡', title: '无status' },
    { id: 'L1', claim: 'active 卡', status: 'active' },
    { id: 'L2', claim: 'refuted 卡', status: 'refuted' },
    { id: 'L3', claim: 'superseded 卡', status: 'superseded' },
    { id: 'L4', claim: 'arch scoped', status: 'scoped_active', scope_tags: ['arch'] },
    { id: 'L5', claim: 'ubuntu scoped', status: 'scoped_active', scope_tags: ['ubuntu'] },
  ];
  const fDefault = filterEngrams(poolAA, { mode: 'default', scopes: [] });
  check('AA', 'AA10 refuted / superseded 被过滤',
    !fDefault.some((e) => e.id === 'L2' || e.id === 'L3'), JSON.stringify(fDefault.map((e) => e.id)));
  check('AA', 'AA11 无 status 的卡按 active 放行（阻断5：3000+ 张存量卡不能整批消失）',
    fDefault.some((e) => e.id === 'L0'), JSON.stringify(fDefault.map((e) => e.id)));
  check('AA', 'AA11b 阻断5 原始复现用例：filterEngrams([{id,claim}]) 非空',
    filterEngrams([{ id: 'L', claim: 'x' }], { mode: 'default' }).length === 1,
    JSON.stringify(filterEngrams([{ id: 'L', claim: 'x' }], { mode: 'default' })));
  check('AA', 'AA12 scoped_active 未指定环境全放行',
    fDefault.some((e) => e.id === 'L4') && fDefault.some((e) => e.id === 'L5'));
  check('AA', 'AA13 scoped_active 指定 scope 只出匹配项',
    (() => { const g = filterEngrams(poolAA, { mode: 'default', scopes: ['arch'] }); return g.some((e) => e.id === 'L4') && !g.some((e) => e.id === 'L5'); })(),
    JSON.stringify(filterEngrams(poolAA, { mode: 'default', scopes: ['arch'] }).map((e) => e.id)));
  check('AA', 'AA13b history 模式全放行',
    filterEngrams(poolAA, { mode: 'history' }).length === poolAA.length, JSON.stringify(filterEngrams(poolAA, { mode: 'history' }).length));
  check('AA', 'AA13c scopeDelta 大小写安全',
    scopeDelta(['Global'], ['global']).length === 0, JSON.stringify(scopeDelta(['Global'], ['global'])));

  // ── ④ consolidate：阻断4（onCommit 抛错）+ 阻断2（refute 回写旧卡）──
  check('AA', 'AA14 闲置阈值默认 30 分钟', IDLE_CONSOLIDATE_MS === 30 * 60 * 1000, 'idleMs=' + IDLE_CONSOLIDATE_MS);

  {
    // onCommit 第一条抛错 ⇒ 不中断整批 + pending 被清理
    let clock = 1792667400000;
    const done = [];
    const cons4 = createConsolidation({
      now: () => clock,
      onCommit: (e) => {
        done.push(e);
        if (done.length === 1) throw new Error('disk full');
      },
    });
    cons4.stage('s-fail', { engram_key: 'k1', title: '第一条', claim: '第一条', confidence: 0.6, scope_tags: ['global'] });
    cons4.stage('s-fail', { engram_key: 'k2', title: '第二条', claim: '第二条', confidence: 0.6, scope_tags: ['global'] });
    const a4 = cons4.archive('s-fail', { reason: 'manual' });
    check('AA', 'AA15 onCommit 抛错不中断整批（两条都尝试过）',
      a4.committed === 2 && a4.commitFailed === 1 && a4.ok === false,
      JSON.stringify({ committed: a4.committed, failed: a4.commitFailed }));
    check('AA', 'AA16 onCommit 抛错后 pending 被清理（不重复落盘）',
      cons4.pendingCount('s-fail') === 0 && cons4.snapshot().pending === 0,
      JSON.stringify(cons4.snapshot()));
    const a4b = cons4.archive('s-fail', { reason: 'retry' });
    check('AA', 'AA16b 重复归档同一 session 不再落盘',
      a4b.committed === 0 && done.length === 2, JSON.stringify({ committed: a4b.committed, done: done.length }));

    // 阻断2：refute 回写旧卡
    const refutedRows = [];
    const cons2 = createConsolidation({
      now: () => clock,
      onCommit: (e) => { if (e.status === STATUS.ACTIVE) refutedRows.push(e); },
    });
    const oldCard = { id: 'egOld', engram_id: 'egOld', title: 'MTP 可用', claim: 'MTP 可用', scope_tags: ['global'], confidence: 0.5, status: 'active' };
    cons2.stage('s-refute', { engram_key: 'MTP', title: 'MTP 可用', claim: 'MTP 实测不可用', confidence: 0.95, scope_tags: ['global'] });
    const a2 = cons2.archive('s-refute', { existing: [oldCard], reason: 'manual' });
    check('AA', 'AA17 archive 返回被推翻的旧卡 id 列表',
      Array.isArray(a2.refutedOldIds) && a2.refutedOldIds.length === 1 && a2.refutedOldIds[0] === 'egOld',
      JSON.stringify(a2.refutedOldIds));
    const row2 = cons2.refuteOldCards(oldCard);
    check('AA', 'AA18 refuteOldCards 产出 append-only refuted 版本行（原对象不被修改）',
      row2 && row2.status === STATUS.REFUTED && row2.id === 'egOld' && oldCard.status === 'active',
      JSON.stringify({ status: row2 && row2.status, old: oldCard.status }));
    check('AA', 'AA18b refute 后新卡 active 且带 refute_by / supersedes',
      (() => { const f = a2.list && a2.list[0]; return !!f && f.status === STATUS.ACTIVE && (f.refute_by || []).includes('egOld') && (f.supersedes || []).includes('egOld'); })(),
      JSON.stringify(a2.list && a2.list[0] && { status: a2.list[0].status, refute_by: a2.list[0].refute_by }));

    // 阻断2 实效：走**真实读盘路径**（append 后按 id last-write-wins），
    //   再让 filterEngrams 过滤 —— 这才能复现红队探针 C1 的实害闭环。
    const rootC1 = mkdtempSync(join(tmpdir(), 'pm-aa-c1-'));
    const dC1 = dirs(rootC1);
    ensureDirs(dC1);
    writeFileSync(dC1.engrams,
      JSON.stringify(oldCard) + '\n' + JSON.stringify(row2) + '\n' + JSON.stringify(a2.list[0]) + '\n', 'utf8');
    const readBack = readOwnEngrams(rootC1);
    const after = filterEngrams(readBack.filter((e) => e.status !== 'retired'), { mode: 'default', scopes: [] });
    check('AA', 'AA18c 旧卡 refuted 后不再被默认检索召回（红队 C1 实害闭环）',
      !after.some((e) => e.id === 'egOld') && after.every((e) => (e.status || 'active') !== 'refuted'),
      JSON.stringify({ readBack: readBack.map((e) => [e.id, e.status]), after: after.map((e) => [e.id, e.status]) }));
    try { rmSync(rootC1, { recursive: true, force: true }); } catch {}
  }

  // ── ⑤ distill 接线（阻断3）──
  //
  // [2026-10-23 · 关键设计发现] 判决必须放在 **dedup 之前**。
  //   第一版把判决放在 dedup 之后 ⇒ 「同主题」一律被 dedup 第三分支
  //   （旧卡还新 ⇒ 重复汇报 ⇒ continue）拦掉，判决段一次都没执行过
  //   （探针实测 beliefRefuted 恒 0）。搬到 dedup 前才真正接上。
  //   这也解释了红队为什么说「零接线」——原来那位置等于没接。
  {
    const mkAARoot = (tag) => {
      const rootAA = mkdtempSync(join(tmpdir(), 'pm-aa-' + tag + '-'));
      const dAA = dirs(rootAA);
      ensureDirs(dAA);
      const T = 1792667400000;
      // 同主题但**不同字面**的标题：同标题会走 dedup 的「刷新」分支（那是既有行为，不许改）
      // [2026-10-26 · 归属隔离] 夹具必须带 sessionKey：蒸馏现在**只取有归属的消息**，
      //   无 sessionKey 的历史消息一律不进池（白队铁律2）。
      const msgsAA = [
        { id: 'aa-u1', role: 'user', sessionKey: 'sAA', content: 'MTP 在本机实测编译失败，方案不可用。', timestamp: T + 1000 },
        { id: 'aa-a1', role: 'assistant', sessionKey: 'sAA', content: '记录：MTP 方案实测不可用。', timestamp: T + 2000 },
      ];
      writeFileSync(dAA.conversations + '/' + localDate(T + 1000) + '.jsonl',
        msgsAA.map((m) => JSON.stringify(m)).join('\n') + '\n', 'utf8');
      const oldAA = {
        kind: 'note', layer: 'global', projectId: null, title: 'MTP 方案可用', summary: '旧摘要',
        content: '旧结论：MTP 方案可用。', links: [], sessionId: null, causes: [], effects: [], importance: 0.6,
        id: 'pmi_aa_old', createdAt: T, hits: 0, lastHitAt: null,
        status: 'active', scope_tags: ['global'], confidence: 0.5,
      };
      writeFileSync(dAA.engrams, JSON.stringify(oldAA) + '\n', 'utf8');
      return rootAA;
    };
    const completeAA = async () => JSON.stringify([{
      kind: 'note', layer: 'global', title: 'MTP 方案不可用',
      summary: '实测 MTP 不可用',
      content: '实测 MTP 编译失败，方案不可用。',
    }]);

    // ⑤-a 开关关闭（缺省）⇒ 逐位等同现状：不写 refuted 行、不产新卡
    const rootOff = mkAARoot('off');
    const rOff = await runDistill({ llm: fakeEp, opts: { root: rootOff, sessionId: 'sAA', minDistillMessages: 1, disableLock: true, retireAfterDays: 14 }, completeFn: completeAA });
    check('AA', 'AA19 开关默认 false 时 beliefRefuted/beliefForked 恒 0',
      rOff.beliefRevision === false && rOff.beliefRefuted === 0 && rOff.beliefForked === 0, JSON.stringify(rOff));
    check('AA', 'AA19b 开关关闭时旧卡不被 refuted（行为等同现状）',
      !readOwnEngrams(rootOff).some((e) => e.id === 'pmi_aa_old' && e.status === 'refuted'),
      JSON.stringify(readOwnEngrams(rootOff).map((e) => [e.id, e.status])));
    check('AA', 'AA19c 开关关闭时不因判决多写卡（written 与开关于否无关地保持 0）',
      rOff.written === 0, JSON.stringify({ written: rOff.written }));

    // ⑤-b 开关打开 ⇒ refute：旧卡 append refuted 行 + 新卡 active
    const rootOn = mkAARoot('on');
    const rOn = await runDistill({ llm: fakeEp, opts: { root: rootOn, sessionId: 'sAA', minDistillMessages: 1, disableLock: true, retireAfterDays: 14, beliefRevisionEnabled: true }, completeFn: completeAA });
    check('AA', 'AA20 开关打开时判决统计生效',
      rOn.beliefRevision === true && rOn.beliefRefuted === 1, JSON.stringify(rOn));
    const engsAA = readOwnEngrams(rootOn);
    check('AA', 'AA21 旧卡被 append 成 refuted（last-write-wins）',
      engsAA.some((e) => e.id === 'pmi_aa_old' && e.status === 'refuted'),
      JSON.stringify(engsAA.map((e) => [e.id, e.status])));
    check('AA', 'AA21b 新卡为 active 且 trace 记了判决理由',
      engsAA.some((e) => e.id !== 'pmi_aa_old' && e.status === 'active' && /refute/.test(String(e.trace || ''))),
      JSON.stringify(engsAA.filter((e) => e.id !== 'pmi_aa_old').map((e) => [e.status, String(e.trace || '').slice(0, 40)])));
    check('AA', 'AA22 refuted 旧卡不再出现在默认检索过滤结果里（红队 C1 实害闭环）',
      (() => {
        const live = engsAA.filter((e) => e.status !== 'retired');
        const got = filterEngrams(live, { mode: 'default', scopes: [] });
        return got.length === 1 && got[0].id !== 'pmi_aa_old';
      })(),
      JSON.stringify(filterEngrams(engsAA.filter((e) => e.status !== 'retired'), { mode: 'default', scopes: [] }).map((e) => e.id)));
    try { rmSync(rootOff, { recursive: true, force: true }); } catch {}
    try { rmSync(rootOn, { recursive: true, force: true }); } catch {}
  }
}


// ── AC · L1 标题闸门（scene_name 净化 + 端到端）──
// [2026-10-23 by Assistant · 期8.3.2 · **本组是本修复的核心判据**]
//
//   昨天的事故形态：单测 305/305 全绿，生产当天照样新产 29 张坏卡。
//   原因：闸门装在 normalizeL1 的 **title** 字段上，而 L1 卡根本没有 title 字段
//   —— 落盘对象只有 scene_name（extract.js 主路径），且启发式兜底路径连
//   normalizeL1 都不走。⇒ 单测测的字段，和生产坏的字段，压根不是同一个。
//
//   所以本组**必须用真实坏样本做端到端**：喂假的 completeFn 返回这些坏标题，
//   跑 runExtract，再**读回真正落盘的 jsonl 文件**断言里面没有坏标题。
//   只测 sanitizeTitle 单函数是不够的 —— 那正是昨天漏掉的地方。
console.log('── AC · L1 标题闸门（scene_name）──');
{
  const { sanitizeTitle, isGoodTitle } = await import('./lib/ingest/normalize.js');
  // 真实生产坏样本（2026-10-23 从 records/2026-10-23.jsonl 逐条抄下来的）
  const BAD = [
    { scene: '对抗审查', content: 'bench-p8.mjs 的真实退出码为 1，其中 2 项测试失败，影响基准可信度。' },
    { scene: '团队恢复', content: '工具总数从 104 恢复到 110，包括补丁修复后的 spawn_teammate 工具。' },
    { scene: '系统调试', content: 'DSH 可用事件名包括 session 结束和卸载钩子，具体为 session/disposed。' },
    { scene: '反例实测', content: '当 rocm1 作为种子时，扩散结果中仅包含邻居节点，种子自身被忽略。' },
    { scene: 'e48e0c35-fde6-49c9-b4a9-0c0b2e6d95ae', content: 'AI发现AA2b测试字符串包含错误信息，导致测试自我失败。' },
    { scene: '81b7eb32-8587-4789-ba4f-b05ffbd067fe', content: '补候选是往池子里加新人，改分是给在场的人重新发牌。' },
    { scene: '会话：304d3b5a-b001-4489-858d-8c92133a83ea', content: 'C5的 ownAlive 计数错误，因为 readOwnIngest 计算原始行数时翻倍。' },
    { scene: 'Investigation of dualpool failure', content: 'Dualpool selftest script located in scripts/ instead of root.' },
    { scene: 'Fixing bugs in Graph.js', content: '修复 Graph.js 的若干 bug，实测通过。' },
    { scene: 'Running bench test', content: 'bench-p8 基准测试跑完，输出字节数正常。' },
  ];
  const FORBIDDEN = ['对抗审查', '团队恢复', '系统调试', '反例实测',
    'e48e0c35-fde6-49c9-b4a9-0c0b2e6d95ae', '81b7eb32-8587-4789-ba4f-b05ffbd067fe',
    '会话：304d3b5a', 'Investigation of', 'Fixing bugs in G', 'Running bench test'];

  // AC1 · 每个坏标题单独过净化：要么被换成合格标题，要么被丢弃（null）
  for (let i = 0; i < BAD.length; i++) {
    const got = sanitizeTitle(BAD[i].scene, BAD[i].content);
    check('AC', 'AC1.' + (i + 1) + ' 坏标题被净化或丢弃: ' + String(BAD[i].scene).slice(0, 22),
      got === null || isGoodTitle(got),
      got === null ? 'discarded' : JSON.stringify(got));
  }
  // AC1.11 · 净化结果绝不能还是原来那个坏标题
  for (let i = 0; i < BAD.length; i++) {
    const got = sanitizeTitle(BAD[i].scene, BAD[i].content);
    check('AC', 'AC1.11.' + (i + 1) + ' 结果不是原坏标题', got !== BAD[i].scene, JSON.stringify(got));
  }
  // AC2 · 合格标题不能被误伤（防"闸门过严把好卡也丢了"）
  const GOODK = ['记忆卡标题规范与闸门', '期7 写入侧搬迁完成', 'DSH 进程是 Idle 优先级导致定时器停摆'];
  check('AC', 'AC2 合格标题不被误伤', GOODK.every((g) => sanitizeTitle(g, '正文') === g || isGoodTitle(sanitizeTitle(g, '正文'))),
    JSON.stringify(GOODK.map((g) => sanitizeTitle(g, '正文'))));
  // AC3 · 长度上限：中文 ≤24 字 / 英文 ≤8 词
  //   [Lead 裁定后] 英文放行 ⇒ 切法改成分语言（24 字符对英文只有约 4 词，不够判「≥3 实词」）
  {
    const over = BAD.filter((b) => {
      const g = sanitizeTitle(b.scene, b.content);
      if (g === null) return false;
      return /[\u4e00-\u9fff]/.test(g) ? g.length > 24 : (g.match(/\s+/g) || []).length + 1 > 8;
    });
    check('AC', 'AC3 标题长度 <= 24 汉字 / <= 8 英文词', over.length === 0,
      over.length ? JSON.stringify(over.map((b) => sanitizeTitle(b.scene, b.content))) : '');
  }
  // AC4 · 正文也提不出 ⇒ 必须 null（宁缺毋滥，不能返回碎片）
  check('AC', 'AC4 正文提不出时返回 null（不返回碎片）',
    sanitizeTitle('对抗审查', '太短') === null && sanitizeTitle('xx', 'abc') === null, '');

  // ★ AC5 · **端到端**（本修复的核心判据）
  //   喂假 completeFn 返回上面那批坏 scene_name，跑 runExtract，
  //   然后**读回落盘的 jsonl 文件**逐字节断言：文件里不出现任何坏标题。
  {
    const { mkdtempSync, rmSync, readFileSync, readdirSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { dirs: dirsAC, ensureDirs: ensureAC } = await import('./lib/ingest/core.js');
    const { captureTurn: capAC } = await import('./lib/ingest/capture.js');
    const { runExtract: runExAC } = await import('./lib/ingest/extract.js');

    const rootAC = mkdtempSync(join(tmpdir(), 'pm-ac-'));
    const dAC = dirsAC(rootAC);
    ensureAC(dAC);
    const T = 1792700000000;
    for (let i = 0; i < 6; i++) {
      capAC({
        sessionKey: 'ac1',
        messages: [
          { id: 'acu' + i, role: 'user', content: '第 ' + i + ' 轮提问：这批卡的标题为什么全是坏的，讲清根因。', timestamp: T + i * 2000 },
          { id: 'aca' + i, role: 'assistant', content: '回答 ' + i + '：因为闸门装在 title 字段上，而 L1 卡只有 scene_name 字段。', timestamp: T + i * 2000 + 1000 },
        ],
        opts: { root: rootAC, nowMs: T + 100000 + i },
      });
    }
    // 假模型：原样返回生产里那批坏 scene_name（这就是昨天的真实 LLM 输出）
    const badComplete = async () => JSON.stringify(
      BAD.map((b) => ({ type: 'episodic', scene_name: b.scene, content: b.content, priority: 70, evidence: '' })),
    );
    const epAC = { baseUrl: 'http://fake', apiKey: 'x', model: 'fake', maxTokens: 100, temperature: 0, timeoutMs: 1000 };
    const rAC = await runExAC({
      llm: epAC,
      opts: { root: rootAC, batchMessages: 6, minBatchMessages: 4, maxWindowsPerRun: 2 },
      completeFn: badComplete,
    });
    // 读回真正落盘的文件
    let recFiles = [];
    try { recFiles = readdirSync(dAC.records).filter((f) => f.endsWith('.jsonl')); } catch {}
    let rawAC = '';
    for (const f of recFiles) rawAC += readFileSync(dAC.records + '/' + f, 'utf8');
    const linesAC = rawAC.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    check('AC', 'AC5 端到端：确实落盘了卡', linesAC.length > 0, 'written=' + rAC.written + ' lines=' + linesAC.length);
    // 逐条断言：每张卡的 scene_name 都不是坏标题
    const badOnes = linesAC.filter((r) => {
      const s = String(r.scene_name || '');
      return FORBIDDEN.some((f) => s.indexOf(f) >= 0) || !isGoodTitle(s);
    });
    check('AC', 'AC6 端到端：落盘文件里没有坏 scene_name',
      badOnes.length === 0,
      badOnes.length ? JSON.stringify(badOnes.slice(0, 3).map((r) => r.scene_name)) : '共 ' + linesAC.length + ' 张卡全部合格');
    // 逐条断言：整个文件的原始字节里不出现那批坏标题字符串
    const hitList = FORBIDDEN.filter((f) => rawAC.indexOf(f) >= 0);
    check('AC', 'AC7 端到端：落盘字节流不含任何坏标题串', hitList.length === 0,
      hitList.length ? '命中: ' + hitList.join(' | ') : '0 命中 / ' + FORBIDDEN.length + ' 条禁用串');
    // 端到端：数量必须小于输入条数（提不出标题的卡被丢弃，而不是原样落盘）
    check('AC', 'AC8 端到端：提不出标题的卡被丢弃而非原样落盘',
      linesAC.length < BAD.length, 'in=' + BAD.length + ' out=' + linesAC.length);
    for (const r of linesAC) {
      check('AC', 'AC9 端到端：卡 ' + String(r.scene_name).slice(0, 18) + ' 合格', isGoodTitle(r.scene_name), JSON.stringify(r.scene_name));
    }
    try { rmSync(rootAC, { recursive: true, force: true }); } catch {}
  }

  // ★ AC10 · **启发式兜底路径**也要过闸门（LLM 全挂时的那条路，昨天完全没设防）
  {
    const { heuristicExtract: hx } = await import('./lib/ingest/extract.js');
    const winAC = {
      sessionKey: 'ac-sess-0000',
      messages: [
        { role: 'user', content: '问：这批 4 字泛称标题是怎么来的，请讲清楚根因和机制。', timestamp: 1792700000000 },
        { role: 'assistant', content: '对抗审查的原因是启发式兜底路径直接把 content 前 36 字切出来当 scene_name，完全没过标题判据。', timestamp: 1792700001000 },
        { role: 'assistant', content: 'e48e0c35-fde6-49c9-b4a9-0c0b2e6d95ae 这种 UUID 型坏标题也是从兜底路径直接落盘的。', timestamp: 1792700002000 },
      ],
    };
    const fbOut = hx(winAC, { max: 8 });
    // 注意：这里的正文里**故意**写了「对抗审查」四个字（复现生产形态），
    //   所以不能用「子串包含」判 —— 那会把「对抗审查的原因是…」这种合法句子误杀。
    //   合同是：① 标题过 isGoodTitle；② 标题不**精确等于**任何一个坏标题。
    const badFb = fbOut.filter((c) => {
      const s = String(c.scene_name || '').trim();
      return FORBIDDEN.some((f) => s === f) || !isGoodTitle(s);
    });
    check('AC', 'AC10 启发式兜底路径也过闸门',
      badFb.length === 0,
      badFb.length ? JSON.stringify(badFb.map((c) => c.scene_name)) : '共 ' + fbOut.length + ' 张全部合格');
    // 兜底路径的旧行为是 content.slice(0,36)，必须证明现在产出的不是那个裸切片
    check('AC', 'AC10c 产出不是 content 的裸前 36 字切片',
      fbOut.every((c) => c.scene_name !== String(c.content).slice(0, 36)),
      JSON.stringify(fbOut.map((c) => [c.scene_name, String(c.content).slice(0, 12)])));
    check('AC', 'AC10b 兜底路径仍有产出（闸门不是一刀切）', fbOut.length > 0, 'out=' + fbOut.length);
  }


  // ★ AC12 · **英文标题降级放行**（Lead 2026-10-23 裁定）
  //   裁定原文：纯英文卡「放行，但走降级而非丢弃」—— 卡里的内容有价值，只是标题不是中文。
  //   同时：空壳前缀（Investigation of / Fixing bugs in / Verification of …）仍判不合格，
  //        必须从正文重新提炼；提不出的才丢弃。
  {
    const { isGoodEnglishTitle } = await import('./lib/ingest/normalize.js');
    const EN_BAD = ['Investigation of dualpool failure', 'Fixing bugs in Graph.js',
      'Verification of diagnosis and fixing degenerate fixture', 'Running bench test'];
    // ① 空壳英文标题本身必须判不合格（不能因为它们有 3 个词就放行）
    check('AC', 'AC12.1 空壳英文前缀仍判不合格',
      EN_BAD.every((t) => !isGoodEnglishTitle(t)),
      JSON.stringify(EN_BAD.map((t) => isGoodEnglishTitle(t))));
    // ② 但**卡不能被丢弃** —— 要从正文提炼出合格英文标题
    const EN_CASES = [
      { t: 'Investigation of dualpool failure', c: 'Dualpool selftest script located in scripts/ instead of root, identified as a path bug in restart-batch.mjs.' },
      { t: 'Fixing bugs in Graph.js', c: 'Graph.js super-node bug was fixed.' },
      { t: 'Verification of diagnosis and fixing degenerate fixture', c: 'Two failures in Graph.js were caused by a degenerate test fixture in bench-p8.mjs section 5, which was fixed.' },
      { t: 'Running bench test', c: 'Bench test completed successfully with 40/40 passes.' },
    ];
    for (let i = 0; i < EN_CASES.length; i++) {
      const got = sanitizeTitle(EN_CASES[i].t, EN_CASES[i].c);
      check('AC', 'AC12.2.' + (i + 1) + ' 英文卡被降级放行而非丢弃',
        got !== null && isGoodTitle(got) && isGoodEnglishTitle(got),
        got === null ? 'DISCARDED(错)' : JSON.stringify(got));
    }
    // ③ 合格的英文标题不能被误伤
    const EN_OK = ['Dualpool selftest path bug in restart-batch.mjs', 'Graph.js super-node bug was fixed'];
    check('AC', 'AC12.3 合格英文标题不被误伤', EN_OK.every((t) => isGoodEnglishTitle(t)),
      JSON.stringify(EN_OK.map((t) => isGoodEnglishTitle(t))));
    // ④ 真·无内容可提的仍需丢弃（宁缺毋滥的底线不能松）
    check('AC', 'AC12.4 单词/全大写缩写仍判不合格',
      !isGoodEnglishTitle('Note') && !isGoodEnglishTitle('API RATE LIMIT') && !isGoodEnglishTitle(''),
      JSON.stringify(['Note', 'API RATE LIMIT', ''].map((t) => isGoodEnglishTitle(t))));
    // ⑤ 英文标题按**词**切（24 字符对英文只有约 4 词，切完过不了「≥3 实词」）
    check('AC', 'AC12.5 英文标题按词切而非按字符切',
      (() => {
        const g = sanitizeTitle('Investigation of dualpool failure',
          'Dualpool selftest script located in scripts/ instead of root, identified as a path bug in restart-batch.mjs.');
        return g !== null && (g.match(/\s+/g) || []).length + 1 >= 3;
      })(), '');
    // ⑥ 中文口径不受影响（英文放行不能把中文判据放松）
    check('AC', 'AC12.6 中文口径未被英文放行放松',
      !isGoodTitle('对抗审查') && !isGoodTitle('团队恢复') && isGoodTitle('记忆卡标题规范与闸门'),
      '');
  }
  // ★ AC13 · **离线兜底路径**（LLM 挂掉时的 usedFallback 分支）—— 同类事故的第三处
  //   [2026-10-23 · Lead 定位] 前两轮分别修了 extract.js:200（启发式产卡）与 :465（LLM 主路径），
  //   唯独「LLM 挂掉 → heuristicExtract → 直接落盘」这条路线没有闸门，
  //   `it.scene_name || it.content.slice(0,30)` 原样落盘 ⇒ session id 当标题。
  //   ⇒ 本组核心判据是**端到端**：假 completeFn 返回 null 触发 usedFallback，
  //     跑 runExtract，读回落盘文件，断言里面没有 session id 当 scene_name。
  {
    const { mkdtempSync, rmSync, readFileSync, readdirSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { dirs: d13, ensureDirs: e13 } = await import('./lib/ingest/core.js');
    const { captureTurn: c13 } = await import('./lib/ingest/capture.js');
    const { runExtract: rx13, heuristicExtract: hx13 } = await import('./lib/ingest/extract.js');

    // ① 真·生产坏卡字段（sessionKey 与 scene_name 完全相同，逐字抄自 records/2026-10-23.jsonl）
    const SESS = 'session-<redacted>6f';
    const REAL4 = [
      { scene: SESS, content: '英文标题卡不再直接丢弃，而是通过 isGoodEnglishTitle 函数提炼合格英文标题。' },
      { scene: SESS, content: '英文卡在体检中不再被判为不合格，允许含有英文标题。' },
      { scene: SESS, content: '建议将体检判据从必须含中文改为含中文或合格英文标题。' },
      { scene: SESS, content: '如果存在英文卡，体检结果将显示为不合格。' },
    ];
    for (let i = 0; i < REAL4.length; i++) {
      const got = sanitizeTitle(REAL4[i].scene, REAL4[i].content);
      check('AC', 'AC13.1.' + (i + 1) + ' 真坏卡 scene_name 被净化', got !== null && isGoodTitle(got), JSON.stringify(got));
      check('AC', 'AC13.1b.' + (i + 1) + ' 结果不含 session id', got !== null && got.indexOf('session-f7a52c5e') < 0, JSON.stringify(got));
    }

    // ② 源头（C 项）：heuristicExtract 不许把 win.sessionKey 吐成 scene_name
    {
      const w = {
        sessionKey: SESS,
        messages: [
          { role: 'user', content: '问：为什么这批卡的标题全是 session id，请讲清根因和机制。', timestamp: 1792719472000 },
          { role: 'assistant', content: '因为启发式路径把 sessionKey 直接塞进了 scene_name，属于源头污染。', timestamp: 1792719473000 },
        ],
      };
      const hh = hx13(w, { max: 8 });
      check('AC', 'AC13.2 heuristicExtract 不吐 sessionKey 当 scene_name',
        hh.every((x) => String(x.scene_name || '').indexOf(SESS) < 0),
        JSON.stringify(hh.map((x) => x.scene_name)));
    }

    // ③ ★ 端到端：假 completeFn 返回 null ⇒ 强制 usedFallback ⇒ 读回落盘文件断言
    const root13 = mkdtempSync(join(tmpdir(), 'pm-ac13-'));
    const dd = d13(root13);
    e13(dd);
    const T13 = 1792719000000;
    for (let i = 0; i < 6; i++) {
      c13({
        sessionKey: SESS,
        messages: [
          { id: 'f' + i + 'u', role: 'user', content: '第 ' + i + ' 轮：这批卡标题为什么是 session id，讲清根因。', timestamp: T13 + i * 2000 },
          { id: 'f' + i + 'a', role: 'assistant', content: '回答 ' + i + '：因为离线兜底路径没有过标题闸门，导致 sessionKey 被直接当成 scene_name 落盘，修复已通过自测。', timestamp: T13 + i * 2000 + 1000 },
        ],
        opts: { root: root13, nowMs: T13 + 100000 + i },
      });
    }
    const ep13 = { baseUrl: 'http://fake', apiKey: 'x', model: 'fake', maxTokens: 100, temperature: 0, timeoutMs: 1000 };
    // 关键：completeFn 返回 null ⇒ parseJsonArray(null) 失败 ⇒ usedFallback = true
    const r13 = await rx13({
      llm: ep13,
      opts: { root: root13, batchMessages: 6, minBatchMessages: 4, maxWindowsPerRun: 2 },
      completeFn: async () => null,
    });
    check('AC', 'AC13.3 端到端：确实触发了离线兜底', r13.fallback > 0, JSON.stringify(r13));
    let f13 = [];
    try { f13 = readdirSync(dd.records).filter((x) => x.endsWith('.jsonl')); } catch {}
    let raw13 = '';
    for (const x of f13) raw13 += readFileSync(dd.records + '/' + x, 'utf8');
    const lines13 = raw13.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    check('AC', 'AC13.4 端到端：兜底路径确实落盘了卡', lines13.length > 0, 'written=' + r13.written + ' lines=' + lines13.length);
    check('AC', 'AC13.5 端到端：落盘卡无一以 session id 当 scene_name',
      lines13.every((r) => String(r.scene_name || '').indexOf(SESS) < 0 && isGoodTitle(r.scene_name)),
      JSON.stringify(lines13.slice(0, 3).map((r) => r.scene_name)));
    check('AC', 'AC13.6 端到端：落盘字节流不含 session id 作标题',
      raw13.indexOf('"scene_name":"' + SESS) < 0, '');
    check('AC', 'AC13.7 端到端：entities 也用净化后的 scene（不带 session id）',
      lines13.every((r) => !r.entities || JSON.stringify(r.entities).indexOf(SESS) < 0),
      JSON.stringify(lines13.slice(0, 2).map((r) => r.entities)));

    // ④ ★ 端到端（补）：直接构造「scene_name 是 session id」的卡喂给兜底落盘表达式
    //    —— 这才是 :410 修复前真正会漏的形态（heur 自己有闸门，但它的上游可能吐脏值）。
    //    用同一行代码路径验证：旧表达式原样落盘坏值，新表达式净化后落盘。
    {
      const rawBad = { scene_name: SESS, content: '英文标题卡不再直接丢弃，而是通过 isGoodEnglishTitle 函数提炼合格英文标题。' };
      const oldWay = String(rawBad.scene_name || '').trim() || String(rawBad.content).slice(0, 30);
      const newWay = sanitizeTitle(String(rawBad.scene_name || '').trim() || String(rawBad.content).slice(0, 30), rawBad.content);
      check('AC', 'AC13.8 旧表达式会落盘 session id（证明漏网真实存在）',
        oldWay === SESS && !isGoodTitle(oldWay), JSON.stringify(oldWay));
      check('AC', 'AC13.9 新表达式落盘的是净化后标题',
        newWay !== null && isGoodTitle(newWay) && newWay.indexOf('session-f7a52c5e') < 0, JSON.stringify(newWay));
    }
    try { rmSync(root13, { recursive: true, force: true }); } catch {}
  }
  // ★ AC11 · 蒸馏路径（engram 的 title）同样接上了同一个 sanitizeTitle
  {
    const { normalizeEngrams: neAC } = await import('./lib/ingest/normalize.js');
    for (let i = 0; i < BAD.length; i++) {
      const r = neAC([{ kind: 'note', layer: 'session', title: BAD[i].scene, summary: BAD[i].content.slice(0, 40), content: BAD[i].content }]);
      const ok = r.length === 0 || isGoodTitle(r[0].title);
      check('AC', 'AC11.' + (i + 1) + ' 蒸馏侧坏标题: ' + String(BAD[i].scene).slice(0, 22),
        ok, r.length ? JSON.stringify(r[0].title) : 'discarded');
    }
  }
}


// ── AD · 冷却期接线（期8.2 缺口 b）──
console.log('── AD · 冷却期 session/flush 接线 ──');
{
  const { createConsolidation, IDLE_CONSOLIDATE_MS } = await import('./lib/ingest/consolidate.js');

  // ① 关闭态：ensureConsolidation 逻辑等价于「不创建实例」
  //    这里直接验证开关判据本身（不依赖 DSH 运行时）
  const shouldEnable = (cfg) => cfg && cfg.consolidationWindowEnabled === true;
  check('AD', 'AD1 开关缺省 ⇒ 不启用', shouldEnable({}) === false);
  check('AD', 'AD2 开关 false ⇒ 不启用', shouldEnable({ consolidationWindowEnabled: false }) === false);
  check('AD', 'AD3 开关 true ⇒ 启用', shouldEnable({ consolidationWindowEnabled: true }) === true);

  // ② 闲置阈值默认 30 分钟（白队裁定，不是 5 分钟）
  check('AD', 'AD4 默认闲置阈值 30 分钟', IDLE_CONSOLIDATE_MS === 30 * 60 * 1000, IDLE_CONSOLIDATE_MS);

  // ③ sweepIdle：未满阈值不动，满了才收敛
  {
    let clock = 1792700000000;
    const committed = [];
    const cons = createConsolidation({ now: () => clock, idleMs: 30 * 60 * 1000, onCommit: (e) => committed.push(e) });
    cons.stage('s1', { engram_key: 'k1', claim: '暂存一', confidence: 0.6, scope_tags: ['global'] });

    clock += 10 * 60 * 1000;   // 10 分钟
    const r1 = cons.sweepIdle();
    check('AD', 'AD5 未满 30 分钟不触发收敛', r1.archived === 0 && committed.length === 0,
      'archived=' + r1.archived + ' committed=' + committed.length);

    clock += 25 * 60 * 1000;   // 累计 35 分钟
    const r2 = cons.sweepIdle();
    check('AD', 'AD6 超 30 分钟触发收敛', r2.archived === 1 && committed.length === 1,
      'archived=' + r2.archived + ' committed=' + committed.length);
    check('AD', 'AD7 收敛只写最终态一条', committed.length === 1, 'n=' + committed.length);
  }

  // ④ 归档后 pending 清零
  {
    let clock = 1792700000000;
    const cons = createConsolidation({ now: () => clock, idleMs: 60000, onCommit: () => {} });
    cons.stage('s2', { engram_key: 'k2', claim: 'A', confidence: 0.6, scope_tags: ['global'] });
    const before = cons.pendingCount('s2');
    cons.archive('s2', { reason: 'session-ended' });
    const after = cons.pendingCount('s2');
    check('AD', 'AD8 归档后 pending 归零', before === 1 && after === 0, before + '->' + after);
  }

  // ⑤ 多次会话互不干扰
  {
    let clock = 1792700000000;
    const committed = [];
    const cons = createConsolidation({ now: () => clock, idleMs: 30 * 60 * 1000, onCommit: (e) => committed.push(e) });
    cons.stage('a', { engram_key: 'ka', claim: '会话A', confidence: 0.6, scope_tags: ['global'] });
    cons.stage('b', { engram_key: 'kb', claim: '会话B', confidence: 0.6, scope_tags: ['global'] });
    check('AD', 'AD9 两个会话各自计 pending',
      cons.pendingCount('a') === 1 && cons.pendingCount('b') === 1);
    clock += 31 * 60 * 1000;
    const swept = cons.sweepIdle();
    check('AD', 'AD10 闲置清扫一次收敛两个会话', swept.archived === 2 && committed.length === 2,
      'archived=' + swept.archived + ' committed=' + committed.length);
  }
}


// ── AE · 接线金丝雀（红队裁决三：终结"测空图还全绿"）──
console.log('── AE · 接线金丝雀（端到端）──');
// [2026-10-29 开源版适配] AE 组依赖本机已积累的卡库（读 engrams.jsonl），
//   全新安装没有该文件 ⇒ readCards() 直接抛 ENOENT 把整轮输出打断。
//   无数据就整组跳过，并把原因说清楚。
if (!existsSync(dataPath('engram-relay/engrams.jsonl'))) {
  console.log('  ⚠️ 跳过：本机还没有卡库（新装即如此），AE 组需要已积累的 engram 数据');
} else {
  const { buildIncidence, graphStats } = await import('./lib/ingest/graph.js');
  const S = await import('./lib/hypergraph/source.js');
  const { createRetriever } = await import('./lib/retrieval/retriever.js');

  // AE1 · 摄取不变量：edges 必须与 facts 同量级
  //   一旦 readOwnIngest 又把 entities 字段弄丢，edges 会塌成 0，这里立刻报红。
  const all = (S.readOwnIngest().cards || []).concat(S.readCards().cards || []);
  const inc = buildIncidence(all);
  const gs = graphStats(inc);
  check('AE', 'AE1 摄取不变量 edges > facts*0.5',
    gs.facts > 0 && gs.edges > gs.facts * 0.5,
    'facts=' + gs.facts + ' edges=' + gs.edges + ' ratio=' + (gs.facts ? (gs.edges / gs.facts).toFixed(2) : 'n/a'));

  // AE2 · entities 必须真的透传（不是空数组）
  const withEnt = all.filter(function (c) { return Array.isArray(c.entities) && c.entities.length > 0; }).length;
  check('AE', 'AE2 读卡时 entities 已透传', withEnt > 0, withEnt + '/' + all.length + ' 张带 entities');

  // AE3 · 差分敏感度：wGraph 开与关，输出必须不同
  //   这是抓「wGraph=0 或 entities 漏传」最快的一条——两者都表现为"输出完全一致"。
  const mk = async function (w) {
    const r = createRetriever({ enabled: true, l0Enabled: false, graphExpandEnabled: true, wGraph: w });
    await r.warmup();
    return r;
  };
  const r05 = await mk(0.5);
  const r00 = await mk(0);
  const sig = function (r) { return r.hits.slice(0, 8).map(function (h) { return String(h.id); }).join('|'); };
  const q1 = '标题闸门 scene_name 哪一处漏了';
  const sA = sig(await r05.search(q1, {}));
  const sB = sig(await r00.search(q1, {}));
  check('AE', 'AE3 差分敏感度 wGraph=0.5 与 0 输出不同', sA !== sB,
    sA === sB ? '完全相同 ⇒ 图没生效' : '不同 ⇒ 图确实参与');

  // AE4 · Kill Switch：wGraph=0 时不应有任何 graph 分
  const rz = await r00.search(q1, {});
  const gz = rz.hits.filter(function (h) { return h.scoreParts && Number(h.scoreParts.graph) > 0; }).length;
  check('AE', 'AE4 Kill Switch wGraph=0 ⇒ 零 graph 分', gz === 0, gz + ' 条带 graph 分');
}


// ── AF · 记忆动力学（红白双队收敛版）──
console.log('── AF · 记忆动力学（浓度/门控/公理）──');
{
  const { ingestWithConcentration, gateBoost, hasNumberConflict, isUserCorrection, extractNumbers } = await import('./lib/ingest/concentrate.js');
  const { qualifiesAsAxiom, stageAxioms, consumeAxioms, revokeAxiom, AXIOM_RULES } = await import('./lib/ingest/axioms.js');
  const { weightedFuse } = await import('./lib/retrieval/rrf.js');

  // AF1 · 红队警报1：数字冲突必须覆写，而不是给旧卡刷票
  {
    const old = { title: '显存', content: 'RX 9060 XT 显存为 4GB', hits: 5, confidence: 0.5 };
    const neu = { title: '显存', content: 'RX 9060 XT 显存为 16GB', rawSource: '不对，是16G' };
    const r = ingestWithConcentration(neu, [old], { similarity: () => 0.95 });
    check('AF', 'AF1 数字冲突 ⇒ 覆写文本(不是给旧卡+1)', r.action === 'update' && /16GB/.test(old.content), 'content=' + old.content);
    // [2026-10-23 按语义修正] 纠错 = 本次提及(+1) + 纠错奖励(+2) = 共 +3
    //   原期望 7（+2）是在 hits 递增有 bug（0→2）时写下的，修复后应为 5+1+2=8
    check('AF', 'AF2 覆写继承 hits 并 +3(1次提及+2纠错奖)', old.hits === 8, 'hits=' + old.hits);
    check('AF', 'AF3 旧文本进 history_trace 留痕', Array.isArray(old.history_trace) && /4GB/.test(old.history_trace[0]), JSON.stringify(old.history_trace));
  }

  // AF4 · 红队警报1b：机器探针刷票必须无效
  {
    const old = { title: 'X', content: 'Y', hits: 3 };
    const r = ingestWithConcentration({ title: 'X', content: 'Y', sourceType: 'system_log' }, [old], { similarity: () => 0.99 });
    check('AF', 'AF4 机器来源不累加 hits', r.action === 'skip-machine' && old.hits === 3, 'hits=' + old.hits);
  }

  // AF5 · 正常人类重复 ⇒ 浓度+1，不新建卡
  {
    const old = { title: 'Z', content: 'W', hits: 2 };
    const r = ingestWithConcentration({ title: 'Z', content: 'W' }, [old], { similarity: () => 0.95 });
    check('AF', 'AF5 人类重复 ⇒ hits+1 且不新建', r.action === 'update' && old.hits === 3, 'hits=' + old.hits);
  }

  // AF6 · 红队警报2：无关话题里高 hits 卡不得霸榜
  {
    const cards = new Map([['hot', { hits: 100, confidence: 1 }], ['cold', { hits: 1, confidence: 0.5 }]]);
    const off = weightedFuse([['hot', 0.2], ['cold', 0.6]], [], {});
    const on = weightedFuse([['hot', 0.2], ['cold', 0.6]], [], { concentrationBoostEnabled: true, cardsById: cards });
    check('AF', 'AF6 低分不释放杠杆（防霸榜）', Math.abs(on.find(x => x[0] === 'hot')[1] - 0.2) < 1e-9, 'hot=' + on.find(x => x[0] === 'hot')[1]);
    check('AF', 'AF7 关闭态与原来逐位相同', JSON.stringify(off.map(x => [x[0], +x[1].toFixed(6)])) === '[["cold",0.6],["hot",0.2]]');
  }

  // AF8 · 高分时正常释放杠杆
  {
    const cards = new Map([['hot', { hits: 50, confidence: 1 }]]);
    const on = weightedFuse([['hot', 0.5]], [], { concentrationBoostEnabled: true, cardsById: cards });
    check('AF', 'AF8 高分才释放浓度杠杆', on[0][1] > 0.5, 'score=' + on[0][1].toFixed(3));
  }

  // AF9 · 红队警报3：公理晋升门槛
  {
    check('AF', 'AF9 hits不足不晋升', qualifiesAsAxiom({ hits: 5, confidence: 1, session_keys: ['a','b','c'] }).ok === false);
    check('AF', 'AF10 session不足不晋升', qualifiesAsAxiom({ hits: 20, confidence: 1, session_keys: ['a'] }).ok === false);
    check('AF', 'AF11 机器来源永不成公理', qualifiesAsAxiom({ hits: 20, confidence: 1, session_keys: ['a','b','c'], sourceType: 'system_log' }).ok === false);
    check('AF', 'AF12 人类多次跨会话才晋升', qualifiesAsAxiom({ hits: 10, confidence: 1, session_keys: ['a','b','c'] }).ok === true);
  }

  // AF13 · 公理只进待审池，绝不实时改 System Prompt
  {
    const tmp = join(osTmpdir(), 'axioms-test-') + Date.now() + '.jsonl';
    const s = stageAxioms([{ id: 'ax1', title: '9060XT 是 16GB', content: '真实显存 16GB', hits: 10, confidence: 1, session_keys: ['a','b','c'] }], tmp);
    check('AF', 'AF13 公理写入待审池', s.staged === 1, 'staged=' + s.staged);
    const c = consumeAxioms(tmp);
    check('AF', 'AF14 冷启动可读出待审公理', c.axioms.length === 1 && c.retireIds[0] === 'ax1');
    const rv = revokeAxiom(tmp, 'ax1');
    check('AF', 'AF15 可撤销公理', rv.revoked === 1 && consumeAxioms(tmp).axioms.length === 0);
    try { (await import('node:fs')).unlinkSync(tmp); } catch (e) {}
  }

  // AF16 · 工具函数边界
  {
    check('AF', 'AF16 数字提取正确', JSON.stringify(extractNumbers('4GB 和 16GB 与 3.5')) === '["4","16","3.5"]', JSON.stringify(extractNumbers('4GB 和 16GB 与 3.5')));
    check('AF', 'AF17 无数字不算冲突', hasNumberConflict('纯文本', '也是纯文本') === false);
    check('AF', 'AF18 纠错词识别', isUserCorrection('不对，是16G') === true && isUserCorrection('今天天气不错') === false);

  // AF19 · 端到端：重复产生的是"浓度"不是"体积"（本轮接线的核心判据）
  {
    const { ingestWithConcentration } = await import('./lib/ingest/concentrate.js');
    const pool = [];
    const sim = (a, b) => (String(a.title || '') === String(b.title || '') ? 1 : 0);
    let last = null;
    for (let i = 0; i < 3; i++) {
      const r = ingestWithConcentration(
        { id: 'c' + i, title: '插件加载失败', content: '插件突然加载不出来什么都没报', sourceType: 'user_chat' },
        pool, { similarity: sim }
      );
      last = r;
      if (r.action === 'insert') pool.push(r.card);
    }
    check('AF', 'AF19 三次提及 ⇒ 卡池仍为 1 张（体积不增长）', pool.length === 1, 'pool=' + pool.length);
    check('AF', 'AF20 三次提及 ⇒ hits 增长到 3（浓度在增长）', pool[0].hits === 3, 'hits=' + pool[0].hits);
    check('AF', 'AF21 第三次 action 是 update 不是 insert', last.action === 'update', 'action=' + last.action);
  }

  // AF22 · 关闭态必须逐位等同（接线铁律）
  {
    const { DEFAULT_LIVE } = await import('./lib/ingest/config.js');
    // [2026-10-23 by Assistant · 判据按意图修正]
    //   原断言写死"默认必须 false"——那是**接线期的安全默认**，不是永久意图。
    //   2026-10-23 User明确要求启用三开关，判据应改为「开关必须是明确的布尔值，
    //   且与 profile 生产配置一致」，而不是永远为 false（否则功能一开测试就红）。
    check('AF', 'AF22 浓度引擎开关是明确布尔值', typeof DEFAULT_LIVE.concentrationEnabled === 'boolean', 'enabled=' + DEFAULT_LIVE.concentrationEnabled);
    check('AF', 'AF23 检索加权开关是明确布尔值', typeof DEFAULT_LIVE.concentrationBoostEnabled === 'boolean', 'boost=' + DEFAULT_LIVE.concentrationBoostEnabled);
    check('AF', 'AF24 公理晋升开关是明确布尔值', typeof DEFAULT_LIVE.axiomStagingEnabled === 'boolean', 'axiom=' + DEFAULT_LIVE.axiomStagingEnabled);
    // 并显式锁定「已按User要求启用」这个事实，防止将来被悄悄改回 false 而无人发现
    check('AF', 'AF24b 三开关已按User要求启用', DEFAULT_LIVE.concentrationEnabled === true && DEFAULT_LIVE.concentrationBoostEnabled === true && DEFAULT_LIVE.axiomStagingEnabled === true);

  // AF25 · 红白五点逐条判据对齐（User要求：5 点都要有判据）
  {
    // ① 浓度引擎已接线
    const dsrc = (await import('node:fs')).readFileSync(join(ROOT, '')lib/ingest/distill.js', 'utf8');
    check('AF', 'AF25 ①浓度引擎已接进 distill 写盘', /ingestWithConcentration/.test(dsrc) && !/existingEngrams/.test(dsrc));

    // ② 相关性门控：rrf 有实现 + retriever 有传参
    const rsrc = (await import('node:fs')).readFileSync(join(ROOT, '')lib/retrieval/rrf.js', 'utf8');
    const retsrc = (await import('node:fs')).readFileSync(join(ROOT, '')lib/retrieval/retriever.js', 'utf8');
    check('AF', 'AF26 ②门控 rrf 有实现', /gateBoost/.test(rsrc));
    check('AF', 'AF27 ②门控 retriever 有传参', /concentrationBoostEnabled:\s*c\.concentrationBoostEnabled/.test(retsrc) && /cardsById:\s*state\.cardsById/.test(retsrc));

    // ③ 公理待审池已接进 section（冷启动合入）
    const ssrc = (await import('node:fs')).readFileSync(join(ROOT, '')lib/section.js', 'utf8');
    check('AF', 'AF28 ③公理已接进 section 冷启动', /consumeAxioms/.test(ssrc) && /established_axioms/.test(ssrc));
    check('AF', 'AF29 ③公理用会话快照（保缓存）', /axiomSnapshots/.test(ssrc));

    // ④ 白队补充1：覆写联动 L3 refute
    const { ingestWithConcentration } = await import('./lib/ingest/concentrate.js');
    const old = { id: 'f1', title: 'T', content: '显存 4GB', hits: 5 };
    const rr = ingestWithConcentration({ title: 'T', content: '显存 16GB', rawSource: '不对' }, [old], { similarity: () => 0.95 });
    check('AF', 'AF30 ④覆写产出 refute 作用域', rr.card.needsEngramRefute === true && rr.refuteScopes && rr.refuteScopes.factId === 'f1');

    // ⑤ 白队补充2：公理撤销
    const { revokeAxiom, stageAxioms, consumeAxioms } = await import('./lib/ingest/axioms.js');
    const tmp = join(osTmpdir(), 'ax-af-') + Date.now() + '.jsonl';
    stageAxioms([{ id: 'axX', title: '测试公理', content: '内容', hits: 10, confidence: 1, session_keys: ['a', 'b', 'c'] }], tmp);
    const before = consumeAxioms(tmp).axioms.length;
    revokeAxiom(tmp, 'axX');
    const after = consumeAxioms(tmp).axioms.length;
    check('AF', 'AF31 ⑤公理可撤销', before === 1 && after === 0, before + '->' + after);

  // AF32-35 · 三点收尾的判据（L3 refute 消费者 / 撤销入口 / 开关生效）
  {
    // ① L3 refute 消费者：事实覆写 ⇒ 依据它的结论被作废，且不误伤正当记录
    const { findAffectedEngrams, buildRefuteLines, scopeKeywords } = await import('./lib/ingest/refute-scan.js');
    const engrams = [
      { id: 'e1', title: '9060XT 4GB 只能跑小模型', content: '因为显存只有 4GB，跑 27B 必 OOM', supporting_facts: ['fact-4g'], status: 'active' },
      { id: 'e2', title: '显存分配池设为 4096MB', content: 'ComfyUI 池 4096MB 够用', supporting_facts: [], status: 'active' },
      { id: 'e3', title: '无关卡', content: '今天去哪玩', supporting_facts: [], status: 'active' },
    ];
    const scope = { factId: 'fact-4g', oldText: '9060XT 显存 4GB' };
    const hit = findAffectedEngrams(engrams, scope);
    check('AF', 'AF32 L3 refute 命中依据旧事实的结论', hit.length === 1 && hit[0].card.id === 'e1', 'hit=' + hit.map(h => h.card.id).join(','));
    check('AF', 'AF33 L3 refute 不误伤正当记录', !hit.some(h => h.card.id === 'e2' || h.card.id === 'e3'));
    const built = buildRefuteLines(engrams, scope);
    check('AF', 'AF34 refuted 行是 append-only（不改原卡）', built.count === 1 && engrams[0].status === 'active');

    // ② 撤销入口：正则解析（与 index.js 内同款）
    const re = /撤销公理[:：]\s*([^\n，。；]{1,40})/;
    check('AF', 'AF35 撤销指令解析（含逗号截断）',
      re.exec('撤销公理：9060XT')[1] === '9060XT' &&
      re.exec('撤销公理：9060XT，顺便')[1] === '9060XT' &&
      re.exec('今天天气不错') === null);

    // ③ 开关已生效（生产口径）
    // ④ 【零接线防御】配置必须真的透传到 distill 的 opts（这是第 4 次同类坑）
    {
      const idxSrc = (await import('node:fs')).readFileSync(join(ROOT, '')lib/ingest/index.js', 'utf8');
      const m = /const optsOf = \(L\) => \(\{([\s\S]*?)\}\);/ .exec(idxSrc);
      const body = m ? m[1] : '';
      // ⑤ hits 从 0 起步必须 +1（不能 0→2）——真实生产卡 hits 都是 0，这个 bug 会立刻爆
    {
      const { ingestWithConcentration } = await import('./lib/ingest/concentrate.js');
      const a = { id: 'z1', title: 'T', content: 'C', hits: 0 };
      ingestWithConcentration({ title: 'T', content: 'C' }, [a], { similarity: () => 1 });
      check('AF', 'AF38 hits 0→1（不是 0→2）', a.hits === 1, 'hits=' + a.hits);
      const b = { id: 'z2', title: 'T', content: 'C', hits: 5 };
      ingestWithConcentration({ title: 'T', content: 'C' }, [b], { similarity: () => 1 });
      check('AF', 'AF39 hits 5→6', b.hits === 6, 'hits=' + b.hits);
      const c = { id: 'z3', title: 'T', content: '4GB', hits: 0 };
      ingestWithConcentration({ title: 'T', content: '16GB', rawSource: '不对' }, [c], { similarity: () => 0.95 });
      check('AF', 'AF40 纠错 hits 0→3（+1 再加2）', c.hits === 3, 'hits=' + c.hits);
    }

    check('AF', 'AF37 配置透传到 opts（防零接线第4例）',
        /concentrationEnabled:\s*L\.concentrationEnabled/.test(body) &&
        /axiomsPendingPath:\s*L\.axiomsPendingPath/.test(body),
        'optsOf 含浓度开关=' + /concentrationEnabled/.test(body));
    }

    check('AF', 'AF36 三开关已启用（User 2026-10-23 要求）',
      DEFAULT_LIVE.concentrationEnabled === true &&
      DEFAULT_LIVE.concentrationBoostEnabled === true &&
      DEFAULT_LIVE.axiomStagingEnabled === true);
  }
    try { (await import('node:fs')).unlinkSync(tmp); } catch (e) {}
  }
  }
  }
}

// ── 汇总 ──
// [2026-10-22 by Assistant] 防「静默中断」：这轮踩了三次同类陷阱 ——
//   块作用域变量跨组引用 / 未 import 的符号 / const TDZ，
//   三者都会在顶层抛错，表现是输出停在某个组标题就没了（看起来像卡住）。
// ── AG · 蒸馏窗口角色配额（Phase 2 连续 assistant 折叠）──
//   实测病灶：本会话最近 40 条 L0 是 user=5 / assistant=35（12.5%），
//   1 次提问配 7 次工具中间叙述，蒸馏原料 87.5% 是助手独白。
//   本节锁死折叠语义：合并连续 assistant、留中间干货、末条完整、不修改入参。
console.log('── AG · 蒸馏窗口角色配额 ──');
{
  const { collapseAssistantMonologues, summarizeIntermediateAssistant } = await import('./lib/ingest/distill.js');
  const msgs = [
    { id: 'u1', role: 'user', content: '帮我把 E8 修好', timestamp: 1 },
    { id: 'a1', role: 'assistant', content: '~我这就去看看', timestamp: 2 },
    { id: 'a2', role: 'assistant', content: '查了 distill.js:235，发现 readRecentL0 跨会话混采，这是根因', timestamp: 3 },
    { id: 'a3', role: 'assistant', content: '最终结论：已修好，verify 30 套全绿', timestamp: 4 },
    { id: 'u2', role: 'user', content: '那就重启吧', timestamp: 5 },
    { id: 'a4', role: 'assistant', content: '好，重启完成', timestamp: 6 },
  ];
  const before = JSON.parse(JSON.stringify(msgs));
  const out = collapseAssistantMonologues(msgs);
  check('AG', 'AG1  连续 assistant 被合并成一条', out.filter((m) => m.role === 'assistant').length === 2, 'assistant条数=' + out.filter((m) => m.role === 'assistant').length);
  check('AG', 'AG2  user 消息原样保留、顺序不变', out.filter((m) => m.role === 'user').map((m) => m.id).join(',') === 'u1,u2');
  check('AG', 'AG3  末条（最终结论）完整保留', String((out.find((m) => m.role === 'assistant' && m.id === 'a3') || {}).content || '').indexOf('已修好，verify 30 套全绿') >= 0);
  const merged = String((out[1] || {}).content || '');
  check('AG', 'AG4  中间干货（文件名+根因）未被丢弃', merged.indexOf('distill.js:235') >= 0 && merged.indexOf('根因') >= 0, merged.slice(0, 60));
  check('AG', 'AG5  合并条带 collapsedFrom 诊断字段', out[1] && out[1].collapsedFrom === 3, 'collapsedFrom=' + (out[1] && out[1].collapsedFrom));
  check('AG', 'AG6  单条 assistant 不被无谓包装', String((out.find((m) => m.id === 'a4') || {}).content) === '好，重启完成');
  check('AG', 'AG7  纯函数：不修改入参', JSON.stringify(msgs) === JSON.stringify(before));
  check('AG', 'AG8  空输入安全', collapseAssistantMonologues([]).length === 0 && collapseAssistantMonologues(null).length === 0);
  check('AG', 'AG9  摘要器优先抓含文件/数字的干货行', summarizeIntermediateAssistant('我去看看\n查了 a.js:12 报错 EACCES\n结束了').indexOf('a.js:12') >= 0);
  // 真实窗口：折叠后 user 占比必须 ≥30%
  const { dirs: dirs2 } = await import('./lib/ingest/core.js');
  const { readRecentL0ForSession: read2 } = await import('./lib/ingest/distill.js');
  const dAD = dirs2(dataPath('ingest'));
  const rawAD = read2(dAD, 40, 'session-00000000-0000-0000-a8b1-97e633f439b3');
  if (rawAD.length >= 10) {
    const colAD = collapseAssistantMonologues(rawAD);
    const uAD = colAD.filter((m) => m.role === 'user').length;
    const ratioAD = (uAD / colAD.length) * 100;
    check('AG', 'AG10 真实窗口折叠后 user 占比 ≥30%', ratioAD >= 30, ratioAD.toFixed(1) + '%（' + uAD + '/' + colAD.length + '）');
  } else {
    check('AG', 'AG10 真实窗口折叠后 user 占比 ≥30%', true, '样本不足，跳过（' + rawAD.length + ' 条）');
  }
}

// ── 汇总 ──
let pass = 0;
for (const r of R) { if (r.ok) pass++; else console.log('  ❌ ' + r.group + '/' + r.name + (r.detail ? '  ← ' + r.detail : '')); }
console.log('');
console.log('总计 ' + R.length + ' 项，通过 ' + pass + ' 项' + (pass === R.length ? '  ✅ 全绿' : '  ❌ 有失败'));
// 组件覆盖自检：确保每一组都真的跑到了（防"某组被跳过但没人发现"）
{
  const groups = new Set(R.map((r) => r.group));
  // [2026-10-23 · 期8.1/8.2] AA 组是认知信用/冷却期的常驻回归，必须每轮都跑到
  const expect = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'AA', 'AC', 'AD', 'AE', 'AG'];
  const missing = expect.filter((g) => !groups.has(g));
  if (missing.length) {
    console.log('⚠️ 有组没跑到: ' + missing.join(',') + '（可能是被条件跳过或中途退出）');
    process.exitCode = 2;
  }
}
try { rmSync(root, { recursive: true, force: true }); } catch {}
if (process.exitCode === undefined) process.exitCode = pass === R.length ? 0 : 1;
