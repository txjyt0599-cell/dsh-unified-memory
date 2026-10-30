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

// ═══════════════════════════════════════════════════════════════════
// [2026-10-31 by Assistant · 索引持久化接缝]
//
// 为什么要有这两个函数：
//   BM25 索引的内部结构原本全锁在模块级 WeakMap 里，外部拿不到 ⇒
//   "序列化后反序列化" 这条路径**无法与现算索引做逐位对比** ⇒ 任何缓存方案都无法验收。
//   （红队三审 P0：没有接缝就没法证明等价，不许接线。）
//
// 红队三条 P0 的对应处理：
//   ① dumpInternals 必须**深拷贝**，不许把 postings/dfMap 的引用漏出去
//      —— 否则 A/B 共享同一对象，"逐位一致"是自欺。
//   ② createBm25FromInternals 必须**严格校验**，坏 meta 一律抛错，不许"尽量运行"。
//   ③ tokenizer 是闭包，不能序列化；只接受 descriptor，恢复时重新 createTokenizer。
//      **禁止**把 A 的 tok 引用传进来。
//
// ⚠️ 这两个函数标 @internal：仅供测试与缓存层，不进 default export，
//    lib/ 下的生产代码不许调用（scripts/check-hardcodes 之外另有校验）。
// ═══════════════════════════════════════════════════════════════════

/**
 * 导出内部结构（深拷贝快照）。
 * @internal
 * @param {object} idx createBm25Index 的返回值
 * @returns {{ids:string[], lens:Float64Array, postings:Map<string,number[]>, dfMap:Map<string,number>, k1:number, b:number, N:number, avgdl:number}}
 */
export function dumpInternals(idx) {
  const h = internals(idx);
  // ① 逐个深拷贝 —— 任何一个引用漏出去，A/B 就可能共享可变状态
  const postings = new Map();
  for (const [term, arr] of h.postings) postings.set(term, arr.slice());
  const dfMap = new Map(h.dfMap);
  return {
    ids: h.ids.slice(),
    lens: new Float64Array(h.lens),
    postings,
    dfMap,
    k1: idx.k1,
    b: idx.b,
    N: idx.N,
    avgdl: idx.avgdl,
  };
}

/**
 * 用内部快照 + tokenizer descriptor 构造索引（跳过分词）。
 * @internal
 * @param {object} inner dumpInternals 的输出，或从缓存反序列化出来的同形状数据
 * @param {{mode:string}} tokDescriptor 只接受 descriptor，不接受现成的 tok 对象
 * @param {{createTokenizer:Function}} tokFactory 注入的工厂（避免本模块反向依赖 tokenize.js）
 */
export function createBm25FromInternals(inner, tokDescriptor, tokFactory) {
  // ② 严格校验：任何一条不过就抛，绝不降级运行
  if (!inner || typeof inner !== 'object') throw new Error('createBm25FromInternals: inner 必须是对象');
  const { ids, lens, postings, dfMap } = inner;
  if (!Array.isArray(ids) || !(lens instanceof Float64Array)) throw new Error('内部结构缺失 ids/lens');
  if (!(postings instanceof Map) || !(dfMap instanceof Map)) throw new Error('内部结构缺失 postings/dfMap');
  const N = ids.length;
  if (N !== lens.length) throw new Error('ids 与 lens 长度不一致: ' + N + ' vs ' + lens.length);
  if (Number.isFinite(inner.N) && inner.N !== N) throw new Error('N 与 ids.length 不一致: ' + inner.N + ' vs ' + N);

  const seen = new Set();
  for (let i = 0; i < N; i++) {
    const id = String(ids[i]);
    if (seen.has(id)) throw new Error('ids 出现重复: ' + id);
    seen.add(id);
    if (!Number.isFinite(lens[i]) || lens[i] < 0) throw new Error('lens[' + i + '] 非有限非负: ' + lens[i]);
  }

  let pairs = 0;
  for (const [term, arr] of postings) {
    if (typeof term !== 'string' || !term) throw new Error('posting 的 term 非法');
    if (!Array.isArray(arr)) throw new Error('posting[' + term + '] 不是数组');
    if (arr.length % 2 !== 0) throw new Error('posting[' + term + '] 长度不是偶数');
    const docsSeen = new Set();
    for (let j = 0; j < arr.length; j += 2) {
      const d = arr[j], w = arr[j + 1];
      if (!Number.isInteger(d) || d < 0 || d >= N) throw new Error('posting[' + term + '] docIdx 越界: ' + d);
      if (!Number.isFinite(w)) throw new Error('posting[' + term + '] weight 非有限: ' + w);
      if (docsSeen.has(d)) throw new Error('posting[' + term + '] 同一 doc 重复');
      docsSeen.add(d);
      pairs++;
    }
    const df = dfMap.get(term);
    if (df === undefined) throw new Error('dfMap 缺少 term: ' + term);
    if (df !== docsSeen.size) throw new Error('dfMap[' + term + ']=' + df + ' 与实际 doc 数 ' + docsSeen.size + ' 不一致');
  }
  for (const term of dfMap.keys()) {
    if (!postings.has(term)) throw new Error('dfMap 有 postings 没有的 term: ' + term);
  }
  if (!Number.isFinite(inner.k1) || inner.k1 <= 0) throw new Error('k1 非法');
  if (!Number.isFinite(inner.b) || inner.b < 0 || inner.b > 1) throw new Error('b 非法');
  if (!Number.isFinite(inner.avgdl) || inner.avgdl < 0) throw new Error('avgdl 非法');

  // ③ 只接受 descriptor —— 禁止把 A 的 tok 对象传进来（红队 P0-3）
  if (!tokDescriptor || typeof tokDescriptor !== 'object' || typeof tokDescriptor.mode !== 'string') {
    throw new Error('createBm25FromInternals: 必须传 tokenizer descriptor（{mode}），不接受现成 tok 对象');
  }
  if (!tokFactory || typeof tokFactory.createTokenizer !== 'function') {
    throw new Error('createBm25FromInternals: 必须注入 tokFactory.createTokenizer');
  }
  const tok = tokFactory.createTokenizer({ mode: tokDescriptor.mode });
  if (!tok || typeof tok.tokenize !== 'function') throw new Error('createBm25FromInternals: tokenizer 重建失败');

  const idx = {
    N,
    avgdl: inner.avgdl,
    k1: inner.k1,
    b: inner.b,
    vocabSize: postings.size,
    postingsPairs: pairs,
    builtAt: Date.now(),
  };
  HIDDEN.set(idx, { ids: ids.slice(), lens: new Float64Array(lens), postings, dfMap, tok });
  return idx;
}

export default { createBm25Index, searchBm25, bm25Meta };
