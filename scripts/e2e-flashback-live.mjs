#!/usr/bin/env node
/**
 * e2e-flashback-live.mjs —— 闪回「活配置」通路验证
 * [2026-10-24 by Assistant · Round 10]
 *
 * 之前踩过的误判：拿 getGraph() 去找 incidence，找不到就以为"图没建"。
 * 实际上 getGraph() 只返回 state.ctx（节点/边结构），incidence 是另一个字段。
 * 这个测试用**真实触发**来证明图建了、闪回能用：
 *   ① 活配置 flashbackEnabled=false ⇒ 闪回必须 null（默认安静）
 *   ② 显式传 flashbackEnabled=true ⇒ 必须能触发（证明图真的建起来了）
 *   ③ 恢复活配置（测试不能改生产配置）
 */
import { createRetriever } from '../lib/retrieval/retriever.js';
import { loadLiveConfig } from '../lib/ingest/config.js';

const QS = ['我不是装了生图插件吗', '评论区推荐66', '你之前不是说推荐66吗'];

let fail = 0;
const check = (n, ok, d) => { console.log((ok ? '  ✅ ' : '  ❌ ') + n + (d ? '   ' + d : '')); if (!ok) fail++; };

const live = loadLiveConfig();
console.log('[活配置] flashbackEnabled =', live.flashbackEnabled);

// ① 生产默认路径（跟随活配置）
{
  const ret = createRetriever({ l0Enabled: false }, null);
  await ret.warmup();
  let fired = 0;
  for (const q of QS) { const r = await ret.search(q, {}); if (r.flashback) fired++; }
  if (live.flashbackEnabled === false) {
    check('① 活配置关闭时闪回安静（' + QS.length + ' 条查询）', fired === 0, '触发 ' + fired + ' 次');
  } else {
    console.log('  · 活配置开着，跳过"必须安静"这一条；实测触发 ' + fired + ' 次');
  }
}

// ② 显式开启必须能触发（证明图真的建了 + 闪回逻辑可用）
{
  const ret = createRetriever({ l0Enabled: false, flashbackEnabled: true }, null);
  await ret.warmup();
  let fired = 0;
  const titles = [];
  for (const q of QS) {
    const r = await ret.search(q, {});
    if (r.flashback) { fired++; titles.push(String(r.flashback.title || '').slice(0, 22)); }
  }
  check('② 显式开启时能触发（证明图已建 + 闪回可用）', fired > 0, '触发 ' + fired + '/' + QS.length);
  titles.forEach((t) => console.log('     · ' + t));
}

// ③ 确认测试没改活配置
const after = loadLiveConfig();
check('③ 测试没有改动生产活配置', after.flashbackEnabled === live.flashbackEnabled,
  'before=' + live.flashbackEnabled + ' after=' + after.flashbackEnabled);

console.log('\n' + (fail === 0 ? '✅ 全部通过' : '❌ ' + fail + ' 项失败'));
process.exit(fail === 0 ? 0 : 1);
