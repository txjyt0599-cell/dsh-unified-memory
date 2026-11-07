/**
 * embedding/auto-build.js —— 向量自动增量的**唯一实现**
 * [2026-10-26 by Assistant · 计划 P0 方案甲]
 *
 * 为什么抽出来：脚本（scripts/build-embeddings.mjs）与插件内定时器
 * （lib/index.js）**必须跑同一份逻辑**。两套实现迟早漂移 —— 这正是
 * build 脚本原本自己实现 tdai id 规则留下的教训（B1）。
 *
 * 铁律（与索引共存亡）：
 *   1. **本地端点绝不用于建库**。saveIndex 会写 model: ep.model，
 *      与库里 BAAI/bge-m3 不符 ⇒ isCompatible false ⇒ 8701 条**整库作废**。
 *      ⇒ 本地 bge-m3 只做「查询 fallback」，建库只能用云端同一模型名。
 *   2. 增量：已有向量的卡按 id 跳过，重跑不重复算。
 *   3. 任一批失败只跳过该批，不抛 —— 下一轮自动补。
 */

import { resolveEndpoint, embedTexts, normalize } from './client.js';
import { loadIndex, saveIndex, isCompatible, EMBEDDINGS_DIR } from './index-store.js';
import { readCards as readSourceCards, readTdaiRecords, readOwnIngest } from '../hypergraph/source.js';

/** 三源读卡（与检索侧逐条对齐），按 id 去重。 */
export function collectCards() {
  const out = [];
  const seen = new Set();
  const push = (c, src) => {
    const id = String((c && c.id) || '').trim();
    if (!id || seen.has(id)) return;
    seen.add(id);
    out.push({ id, title: String(c.title || ''), summary: String(c.summary || ''), _source: src });
  };
  try { for (const c of (readSourceCards().alive || [])) push(c, 'engram'); } catch {}
  try { for (const c of (readTdaiRecords().cards || [])) push(c, 'tdai'); } catch {}
  try { for (const c of (readOwnIngest().cards || [])) push(c, 'ingest'); } catch {}
  return out;
}

/** 只嵌「标题：摘要」，约 100~150 字 —— 省钱且够用。 */
export function vecText(card) {
  const t = (card.title ? card.title + '：' : '') + card.summary;
  return t.slice(0, 400) || card.id;
}

/**
 * 增量补齐向量。
 * @param {object} ep  resolveEndpoint 出来的端点
 * @param {object} opts { limit=0, dir=EMBEDDINGS_DIR, log=console, minIntervalGuardMs=0 }
 * @returns {Promise<{ok:boolean, reason?:string, todo:number, done:number, failed:number, count:number, ms:number, skipped?:boolean}>}
 */
export async function buildMissing(ep, opts) {
  const o = opts || {};
  const dir = o.dir || EMBEDDINGS_DIR;
  const limit = Number(o.limit) || 0;
  const log = o.log || console;
  const t0 = Date.now();

  if (!ep) return { ok: false, reason: 'no-endpoint', todo: 0, done: 0, failed: 0, count: 0, ms: 0 };

  const all = collectCards();
  let idx = loadIndex(dir);
  if (idx && !isCompatible(idx, ep.model, ep.dimensions)) {
    // 模型/维度变了 ⇒ 整库作废重建。**这里不自动重建**（可能上千条、要花钱），
    // 只报告，让人决定 —— 自动路径绝不擅自废掉 8701 条。
    return {
      ok: false,
      reason: 'incompatible-index',
      indexModel: idx.model, indexDim: idx.dim,
      wantModel: ep.model, wantDim: ep.dimensions,
      todo: 0, done: 0, failed: 0, count: idx.ids.length,
      ms: Number((Date.now() - t0).toFixed(1)),
    };
  }

  const have = idx ? new Set(idx.ids) : new Set();
  let todo = all.filter((c) => !have.has(c.id));
  if (limit > 0) todo = todo.slice(0, limit);
  if (todo.length === 0) {
    return { ok: true, skipped: true, todo: 0, done: 0, failed: 0, count: have.size, ms: Number((Date.now() - t0).toFixed(1)) };
  }

  // 从已有索引继承（增量）
  const ids = idx ? idx.ids.slice() : [];
  const vectors = [];
  if (idx) {
    for (let i = 0; i < idx.ids.length; i++) {
      const off = i * idx.dim;
      vectors.push(idx.flat.subarray(off, off + idx.dim));
    }
  }

  let done = 0, failed = 0;
  for (let i = 0; i < todo.length; i += ep.batchSize) {
    const batch = todo.slice(i, i + ep.batchSize);
    const got = await embedTexts(ep, batch.map(vecText));
    if (!got) {
      failed += batch.length;
      try { log.warn && log.warn('[vec-auto] 第 ' + (Math.floor(i / ep.batchSize) + 1) + ' 批失败，跳过 ' + batch.length + ' 条'); } catch {}
      continue;   // 任一批失败只跳过该批，下一轮自动补
    }
    for (let k = 0; k < batch.length; k++) {
      ids.push(batch[k].id);
      vectors.push(normalize(got[k]));
    }
    done += batch.length;
    // 断点续传：每 10 批落盘一次
    if ((i / ep.batchSize) % 10 === 9) {
      try { saveIndex(dir, { model: ep.model, dim: ep.dimensions, ids, vectors }); } catch {}
    }
  }

  if (done === 0) {
    return { ok: false, reason: 'all-batches-failed', todo: todo.length, done: 0, failed, count: have.size, ms: Number((Date.now() - t0).toFixed(1)) };
  }

  let meta;
  try {
    meta = saveIndex(dir, { model: ep.model, dim: ep.dimensions, ids, vectors });
  } catch (e) {
    return { ok: false, reason: 'save-failed:' + String(e && e.message || e), todo: todo.length, done, failed, count: have.size, ms: Number((Date.now() - t0).toFixed(1)) };
  }

  return {
    ok: true,
    todo: todo.length, done, failed,
    count: meta.count, dim: meta.dim, builtAt: meta.builtAt,
    ms: Number((Date.now() - t0).toFixed(1)),
  };
}
