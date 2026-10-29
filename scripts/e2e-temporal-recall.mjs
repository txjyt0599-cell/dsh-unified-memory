#!/usr/bin/env node
/**
 * e2e-temporal-recall.mjs —— 「指代当下」查询的时间召回
 * [2026-10-24 by Assistant · Round 18]
 *
 * 抓到的真缺陷（三层，一层扣一层）：
 *   ① 「我们刚才在做什么」没被识别为时间查询 ⇒ 走字面检索
 *   ② 识别成时间查询后，在**错误的候选集**里排时间（池里只有含"在做/什么"的旧卡）
 *   ③ 加了时间种子后，种子按 Map 插入序取 ⇒ 名额全给最老的 engram 卡
 *
 * 修法：① 补指代表达 ② 时间意图时注入近 N 天种子 ③ 种子**按时间倒序**选
 * 本测试锁：这类查询的 Top5 里必须有「近 3 天」的卡。
 */
import { createRetriever } from '../lib/retrieval/retriever.js';
import { classifyTemporal } from '../lib/retrieval/rrf.js';

const DAY = 86400000;
const now = Date.now();
let fail = 0;
const check = (n, ok, d) => { console.log((ok ? '  ✅ ' : '  ❌ ') + n + (d ? '   ' + d : '')); if (!ok) fail++; };

// ① 分类器：指代当下必须被识别，普通问句不能被误伤
console.log('── ① 时间意图识别 ──');
const MUST_LATEST = ['我们刚才在做什么', '上次聊到哪了', '继续', '接着刚才的', '后来呢'];
const MUST_NULL = ['为什么要重启', '怎么改配置', '示例设备A再生怎么操作', '我显卡显存多大'];
let miss = 0, wrong = 0;
for (const q of MUST_LATEST) if (classifyTemporal(q) !== 'latest') { miss++; console.log('    ✗ 未识别: ' + q); }
for (const q of MUST_NULL) if (classifyTemporal(q) !== null) { wrong++; console.log('    ✗ 误判: ' + q + ' → ' + classifyTemporal(q)); }
check('指代当下的问法都被识别', miss === 0, (MUST_LATEST.length - miss) + '/' + MUST_LATEST.length);
check('普通问句不被误判成时间查询', wrong === 0, wrong + ' 误判');

// ② 端到端：Top5 里必须有近 3 天的卡
console.log('── ② 召回的时间新鲜度 ──');
const ret = createRetriever({ l0Enabled: true, l0RecentDays: 30 }, null);
await ret.warmup();
const { readCards, readTdaiRecords, readOwnIngest } = await import('../lib/hypergraph/source.js');
const map = new Map();
for (const c of readCards().alive) map.set(String(c.id), c);
try { for (const c of (readTdaiRecords().cards || [])) if (!map.has(String(c.id))) map.set(String(c.id), c); } catch {}
try { for (const c of (readOwnIngest().cards || [])) if (!map.has(String(c.id))) map.set(String(c.id), c); } catch {}

for (const q of ['我们刚才在做什么', '上次聊到哪了']) {
  const r = await ret.search(q, { k: 5 });
  const hits = (r.hits || []).slice(0, 5);
  let fresh = 0;
  const ages = [];
  for (const h of hits) {
    const c = map.get(String(h.id));
    const v = c && c.createdAt;
    const n = Number(v) || Date.parse(v || '');
    if (!Number.isFinite(n)) { ages.push('?'); continue; }
    const days = (now - n) / DAY;
    ages.push(days < 1 ? Math.round(days * 24) + 'h' : Math.round(days) + 'd');
    if (days <= 3) fresh++;
  }
  console.log('    · ' + q + ' → 年龄 ' + ages.join(', '));
  check('『' + q + '』Top5 含近 3 天的卡', fresh > 0, fresh + '/5 新鲜');
}

console.log('\n' + (fail === 0 ? '✅ 全部通过' : '❌ ' + fail + ' 项失败'));
process.exit(fail === 0 ? 0 : 1);
