/**
 * probe-template.mjs —— 探针标准模板（2026-10-27 封箱第 4 点）
 *
 * 【为什么存在】
 *   实测踩坑：Assistant的临时探针只配了 engram + own 两个源，漏了 tdai（3169 张），
 *   导致同一查询探针 hits=0、生产 hits=24 —— 差点拿着错误结论去改代码。
 *   根因：生产是 engram + tdai + own 三源，探针必须逐项复刻，不能只传部分参数。
 *
 * 【用法】复制本文件到 scripts/_probe-xxx.mjs，改最后的 QS 列表即可。
 *   注意：cwd 必须是插件根，导入路径用 ../lib/...
 */
import { createRetriever } from '../lib/retrieval/retriever.js';
import { dataPath } from '../lib/paths.js';

/** 生产同款三源配置 —— 任何探针都必须从这里取，禁止手写部分参数 */
export const PROD_CONVERSATION_DIRS = [
  dataPath('memory-tencentdb/memory-tdai/conversations'),
  dataPath('ingest/conversations'),
];

export function makeProdRetriever(extra) {
  return createRetriever(Object.assign({
    // ① L0 双目录（缺了它会漏掉近 5 天对话）
    l0Enabled: true,
    l0RecentDays: 30,
    conversationsDir: PROD_CONVERSATION_DIRS,
    // ② 三源权重（缺 sourceWeight/topicBoost 会改变排序）
    sourceWeight: 0.85,
    topicBoost: 0.15,
    // ③ 浓度引擎（生产开着，探针不配会导致分数不同）
    concentrationEnabled: true,
    concentrationBoostEnabled: true,
    concentrationGate: 0.35,
    concentrationAlpha: 0.15,
    // ④ 图门控
    graphGate: 0.15,
  }, extra || {}), null);
}

export async function probe(queries, opts) {
  const ret = makeProdRetriever(opts && opts.retrieverCfg);
  await ret.warmup();
  const h = ret.health();
  const rows = [];
  for (const q of queries) {
    const r = await ret.search(q, Object.assign({ tokenBudget: 400000 }, (opts && opts.searchOpts) || {}));
    const hits = r.hits || [];
    const top = hits[0];
    const card = top && ret.getCard ? ret.getCard(String(top.id)) : null;
    rows.push({
      q,
      n: hits.length,
      topTitle: String((card && card.title) || (top && top.title) || '-'),
      topAgeDays: card && card.createdAt ? (Date.now() - Number(card.createdAt)) / 86400000 : null,
    });
  }
  return { health: h, rows };
}

export function printProbe(res) {
  console.log('[三源核对] docs=' + (res.health.bm25 && res.health.bm25.docs)
    + ' tdai=' + (res.health.tdai && res.health.tdai.added)
    + ' l0Rounds=' + (res.health.l0 && res.health.l0.rounds));
  console.log('查询'.padEnd(30) + ' hits  Top1');
  for (const r of res.rows) {
    console.log(r.q.padEnd(30) + ' ' + String(r.n).padEnd(6) + r.topTitle.slice(0, 44));
  }
}