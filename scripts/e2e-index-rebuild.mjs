#!/usr/bin/env node
/**
 * e2e-index-rebuild.mjs —— 索引重建时机回归
 * [2026-10-24 by Assistant · Round 40]
 *
 * 抓到的性能坑：
 *   索引签名里带了 mtime + ctime ⇒ **任何**写盘都触发整库重建。
 *   而采纳核验每轮都给命中卡 hits+1（往主库追加一行）⇒ mtime 变
 *   ⇒ 每 5 秒重建一次 9,534 张文档的索引（~1.5 秒）。
 *   实测：13 分钟里 warmup 跑了 10 次、source-changed 137 次。
 *   **这才是「检索 p90 = 4.5 秒」的真正原因**（不是机器负载 —— 之前判断错了）。
 *
 * 修法：签名只反映「影响 BM25 索引的字段」——卡 id + 标题 + 摘要。
 *   hits / importance / lastHitAt 变化 **不触发**重建。
 *
 * 本测试锁两个方向：
 *   ① 只改 hits ⇒ 不重建（否则每轮都在白烧 1.5 秒）
 *   ② 加新卡   ⇒ 必须重建（否则新卡永远搜不到）
 */
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { createRetriever } from '../lib/retrieval/retriever.js';
import { dataPath } from '../lib/paths.js';

const P = dataPath('engram-relay/engrams.jsonl');
let fail = 0;
const check = (n, ok, d) => { console.log((ok ? '  ✅ ' : '  ❌ ') + n + (d ? '   ' + d : '')); if (!ok) fail++; };

const events = [];
const logger = { wake: (o) => events.push(o), miss: (o) => events.push(o) };
const ret = createRetriever({ l0Enabled: false }, logger);
await ret.warmup();
events.length = 0;

const backup = readFileSync(P, 'utf8');

try {
  // ── ① 只改 hits：不该重建 ──
  console.log('── ① 只改 hits（模拟采纳加分）──');
  const lines = backup.split('\n').filter(Boolean);
  const last = JSON.parse(lines[lines.length - 1]);
  appendFileSync(P, JSON.stringify(Object.assign({}, last, { hits: (last.hits || 0) + 1 })) + '\n', 'utf8');
  await ret.search('记忆改造', {});
  await new Promise((r) => setTimeout(r, 300));
  const rebuildAfterHits = events.filter((e) => e.level === 'source-changed').length;
  console.log('    触发重建 ' + rebuildAfterHits + ' 次');
  check('只改 hits 不触发重建', rebuildAfterHits === 0, rebuildAfterHits + ' 次');

  // ── ② 加新卡：必须重建 ──
  console.log('── ② 加一张全新卡 ──');
  events.length = 0;
  const nid = 'rebuild-test-' + Date.now();
  appendFileSync(P, JSON.stringify({
    id: nid, title: '索引重建验证卡', summary: '验证新卡会触发重建',
    content: '这是一张专门用于验证索引签名会正确变化的新卡片正文内容',
    status: 'active', createdAt: Date.now(),
  }) + '\n', 'utf8');
  await ret.search('记忆改造', {});
  await new Promise((r) => setTimeout(r, 300));
  const rebuildAfterNew = events.filter((e) => e.level === 'source-changed').length;
  console.log('    触发重建 ' + rebuildAfterNew + ' 次');
  check('加新卡必须触发重建', rebuildAfterNew >= 1, rebuildAfterNew + ' 次');

  // ── ③ 新卡能被搜到（端到端）──
  console.log('── ③ 新卡最终能被检索到 ──');
  await ret.warmup(true);   // 强制重建一次，确保新卡进索引
  const r = await ret.search('索引重建验证卡', { k: 5 });
  const found = (r.hits || []).some((h) => String(h.id) === nid);
  check('新卡在重建后可被检索', found, found ? '找到了' : '未找到');
} finally {
  // 还原文件（去掉测试追加的行）
  writeFileSync(P, backup, 'utf8');
  console.log('（已还原卡库文件）');
}

console.log('\n' + (fail === 0 ? '✅ 索引重建时机正确' : '❌ ' + fail + ' 项失败'));
process.exit(fail === 0 ? 0 : 1);
