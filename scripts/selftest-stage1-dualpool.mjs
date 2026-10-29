#!/usr/bin/env node
/**
 * selftest-stage1-dualpool.mjs —— 期6 P0-a 专项：双池分离 + L3(Topic) 接通
 *
 * 验收铁律：
 *   ① **默认（sourceWeight=1, topicBoost=0）必须与旧行为逐位一致** —— 这是不许破的红线
 *   ② sourceWeight<1 时，tdai 卡分数按比例下降
 *   ③ topicBoost>0 时，属于高分 Topic 的卡加分（只加不减）
 *   ④ 不设参数时，candidates 长度/顺序/分数与「纯 searchBm25 + 归一化」完全相同
 */
import { stage1 } from '../lib/retrieval/stages.js';
import { createBm25Index, searchBm25 } from '../lib/retrieval/bm25.js';


let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
}

// ---- 构造一个最小 ctx（3 张 engram + 2 张 tdai，2 个 Episode）----
const docs = [
  { id: 'eng:a', title: '裁决中继设计', summary: 'post-execute 硬挂载点', content: '裁决中继为什么挂 tools post-execute 硬挂载' },
  { id: 'eng:b', title: '面板滑块', summary: '不要复选框', content: '面板布尔项一律滑块开关 不要复选框' },
  { id: 'eng:c', title: '记忆分层', summary: 'L0到L3', content: '记忆分层 L0 L1 L2 L3 超图 Topic Episode Fact' },
  { id: 'tdai:1', title: '我在和用户优化裁决中枢插件', summary: '拦截规则与文件关键字提取', content: '我在和用户优化裁决中枢插件 拦截规则 文件关键字提取' },
  { id: 'tdai:2', title: '我在和用户检查记忆系统备份', summary: '存储与备份配置', content: '我在和用户检查记忆系统的存储与备份配置' },
];

// ⚠️ bm25.js 调用的是 tok.tokenize(text)，不是 tok(text)。
//    踩过的坑：把 tok 写成函数 ⇒ tok.tokenize 是 undefined ⇒ TypeError ⇒ 进程静默退出、输出全丢。
const tok = {
  tokenize(s) {
    const out = [];
    const t = String(s || '').toLowerCase();
    for (const ch of t) if (/[\u4e00-\u9fff]/.test(ch)) out.push(ch);
    for (const w of t.split(/[^a-z0-9]+/)) if (w.length >= 2) out.push(w);
    return out;
  },
};
const bm25 = createBm25Index(docs, tok);

// 两个 Episode：ep1 含 eng:a + tdai:1（projectId=P1），ep2 含 eng:b（projectId=P2）
const cardToEpisode = new Map([['eng:a', 'ep1'], ['tdai:1', 'ep1'], ['eng:b', 'ep2']]);
const episodes = new Map([
  ['ep1', { id: 'ep1', projectId: 'P1', members: ['eng:a', 'tdai:1'] }],
  ['ep2', { id: 'ep2', projectId: 'P2', members: ['eng:b'] }],
]);
const edgesByEpisode = new Map([['ep1', []], ['ep2', []]]);

const ctx = { bm25, cardToEpisode, episodes, edgesByEpisode, tok, alias: null };

const q = '裁决中继 post-execute';

// ---- ① 默认 = 旧行为（逐位）----
console.log('\n[1] 默认必须等于旧行为');
const raw = searchBm25(bm25, q, 30);
let max = 0;
for (const p of raw) if (p[1] > max) max = p[1];
const expect = max > 0 ? raw.map(p => [p[0], p[1] / max]) : raw.map(p => [p[0], 0]);
const got = stage1(ctx, q, 5);
ok('长度一致', got.candidates.length === expect.length, got.candidates.length + ' vs ' + expect.length);
let identical = true;
for (let i = 0; i < expect.length; i++) {
  if (got.candidates[i][0] !== expect[i][0]) { identical = false; break; }
  if (Math.abs(got.candidates[i][1] - expect[i][1]) > 1e-12) { identical = false; break; }
}
ok('逐位一致（id + 分数）', identical);
ok('topic 元信息存在', got.topic && got.topic.sourceWeight === 1 && got.topic.topicBoost === 0,
   JSON.stringify(got.topic));
ok('默认不降权（sameSourceHit 计数应为 0）', got.topic.sameSourceHit === 0, String(got.topic.sameSourceHit));

// ---- ② sourceWeight=0.5 ⇒ tdai 分数减半 ----
console.log('\n[2] sourceWeight=0.5 时 tdai 降权');
const got2 = stage1(ctx, q, 5, { sourceWeight: 0.5 });
const map1 = new Map(got.candidates);
const map2 = new Map(got2.candidates);
let tdaiHalved = true, engramUnchanged = true;
for (const [id, s] of map1) {
  const s2 = map2.get(id);
  if (s2 === undefined) { tdaiHalved = false; break; }
  if (id.indexOf('tdai:') === 0) {
    if (Math.abs(s2 - s * 0.5) > 1e-12) { tdaiHalved = false; break; }
  } else {
    if (Math.abs(s2 - s) > 1e-12) { engramUnchanged = false; break; }
  }
}
ok('tdai 分数变为 0.5 倍', tdaiHalved);
ok('engram 分数不变', engramUnchanged);
ok('sameSourceHit 被统计', got2.topic.sameSourceHit > 0, String(got2.topic.sameSourceHit));

// ---- ③ topicBoost>0 ⇒ 高分 Topic 的卡加分 ----
console.log('\n[3] topicBoost>0 时按 Topic 加分');
const got3 = stage1(ctx, q, 5, { topicBoost: 0.5 });
let allNonDecreasing = true;
for (const [id, s] of map1) {
  const s3 = map3Get(got3, id);
  if (s3 === undefined) continue;
  if (s3 < s - 1e-12) { allNonDecreasing = false; break; }
}
function map3Get(g, id) { for (const p of g.candidates) if (p[0] === id) return p[1]; return undefined; }
ok('所有卡分数不减（只加分不准入）', allNonDecreasing);
ok('topicBoosted 被统计', got3.topic.topicBoosted >= 0, String(got3.topic.topicBoosted));

// ---- ④ 空 ctx 容错 ----
console.log('\n[4] 边界容错');
const emptyCtx = { bm25, cardToEpisode: new Map(), episodes: new Map(), edgesByEpisode: new Map(), tok, alias: null };
let noThrow = true;
try { stage1(emptyCtx, q, 5, { sourceWeight: 0.5, topicBoost: 1 }); } catch (e) { noThrow = false; }
ok('无 Episode 的 ctx 不抛错', noThrow);
let noThrow2 = true;
try { stage1(ctx, '', 5); } catch (e) { noThrow2 = false; }
ok('空查询不抛错', noThrow2);

console.log('\n======================================');
console.log('  通过 ' + pass + ' / 失败 ' + fail);
console.log('======================================');
// ⚠️ 不能用 process.exit()：stdout 是管道时它是异步 flush 的，
//    process.exit 会立刻杀掉进程、丢掉全部 console.log 输出（踩过：RC=0 但零输出）。
process.exitCode = fail === 0 ? 0 : 1;
