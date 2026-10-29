/**
 * bm25.js —— 字段加权 BM25，扁平数字倒排，查询去重累加。零依赖。
 * 依据：DESIGN §1.2 / §3.2 验收 B。
 *
 * 打分式（DESIGN §1.2 原文）：
 *   idf(t)  = ln(1 + (N - df(t) + 0.5) / (df(t) + 0.5))
 *   tf_w(t) = sum_f FIELD_WEIGHT[f] * tf_f(t)
 *   len(d)  = sum_f FIELD_WEIGHT[f] * |d_f|
 *   score(d,q) = sum_{t in uniq(tokens(q))} idf(t) * tf_w*(k1+1) / (tf_w + k1*(1-b+b*len/avgdl))
 */
import { FIELD_WEIGHT } from './types.js';
const FIELD_KEYS = ['title', 'summary', 'content'];
/** 内部数据（WeakMap，不导出，防误改） */
const HIDDEN = new WeakMap();
/**
 * 建索引。纯函数：输入卡数组，输出索引对象。
 *
 * 保底口径（红队 P0-2 / DESIGN §1.5.2b）：
 *   **调用方必须传入全部活卡**，不许在这里按「有无超边」预过滤。
 *   本函数不做任何过滤（不查 status、不查 Episode），过滤是调用方的责任。
 *
 * @param {Array<{id:string,title?:string,summary?:string,content?:string}>} docs
 * @param {{tokenize:(t:string)=>string[]}} tok
 * @param {{k1?:number,b?:number,fieldWeight?:object}} [opts]
 */
export function createBm25Index(docs, tok, opts) {
  const k1 = opts && opts.k1 !== undefined ? opts.k1 : 1.2;
  const b = opts && opts.b !== undefined ? opts.b : 0.75;
  const fw = (opts && opts.fieldWeight) || FIELD_WEIGHT;
  const list = Array.isArray(docs) ? docs : [];
  const N = list.length;
  const ids = new Array(N);
  const lens = new Float64Array(N);
  const postings = new Map();
  const dfMap = new Map();
  for (let d = 0; d < N; d++) {
    const doc = list[d];
    ids[d] = doc && doc.id !== undefined ? String(doc.id) : String(d);
    const tf = new Map();
    let len = 0;
    for (const f of FIELD_KEYS) {
      const w = fw[f] !== undefined ? fw[f] : 1;
      const text = doc && doc[f] !== undefined && doc[f] !== null ? doc[f] : '';
      if (!text) continue;
      for (const t of tok.tokenize(text)) {
        tf.set(t, (tf.get(t) || 0) + w);
        len += w;
      }
    }
    lens[d] = len;
    for (const entry of tf) {
      const t = entry[0];
      const w = entry[1];
      let arr = postings.get(t);
      if (arr === undefined) { arr = []; postings.set(t, arr); }
      arr.push(d, w);
      dfMap.set(t, (dfMap.get(t) || 0) + 1);
    }
  }
  let total = 0;
  for (let d = 0; d < N; d++) total += lens[d];
  const avgdl = N > 0 ? total / N : 0;
  let pairs = 0;
  for (const arr of postings.values()) pairs += arr.length / 2;
  const idx = {
    N,
    avgdl,
    k1,
    b,
    vocabSize: postings.size,
    postingsPairs: pairs,
    builtAt: Date.now(),
  };
  HIDDEN.set(idx, { ids, lens, postings, dfMap, tok });
  return idx;
}
function internals(idx) {
  const h = HIDDEN.get(idx);
  if (!h) throw new Error('searchBm25: 传入的不是 createBm25Index 的返回值');
  return h;
}
/**
 * 检索。返回按分降序的 [docId, score]，长度 <= k。
 * 纪律 1：查询词先去重。纪律 2：不做 0..1 归一化。
 *
 * @param {object} idx
 * @param {string} query
 * @param {number} k
 * @returns {Array<[string, number]>}
 */
export function searchBm25(idx, query, k) {
  const inner = internals(idx);
  const ids = inner.ids;
  const lens = inner.lens;
  const postings = inner.postings;
  const dfMap = inner.dfMap;
  const N = idx.N;
  if (N === 0) return [];
  const toks = inner.tok.tokenize(query);
  if (!toks.length) return [];
  const scores = new Map();
  const seen = new Set();
  const k1 = idx.k1;
  const b = idx.b;
  const avgdl = idx.avgdl || 1;
  for (const t of toks) {
    if (seen.has(t)) continue;
    seen.add(t);
    const arr = postings.get(t);
    if (arr === undefined) continue;
    const df = dfMap.get(t);
    const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
    for (let i = 0; i < arr.length; i += 2) {
      const d = arr[i];
      const w = arr[i + 1];
      const norm = w + k1 * (1 - b + (b * lens[d]) / avgdl);
      scores.set(d, (scores.get(d) || 0) + (idf * w * (k1 + 1)) / (norm || 1));
    }
  }
  const out = [];
  for (const pair of scores) out.push([ids[pair[0]], pair[1]]);
  out.sort(function (a, z) { return z[1] - a[1]; });
  return k === undefined || k === null || k < 0 ? out : out.slice(0, k);
}
/** 供 stage1 用：只读元信息 */
export function bm25Meta(idx) {
  const h = internals(idx);
  return { N: idx.N, avgdl: idx.avgdl, vocabSize: idx.vocabSize, docIds: h.ids };
}
export default { createBm25Index, searchBm25, bm25Meta };
