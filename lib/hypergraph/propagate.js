import { HARD } from './types.js';

/**
 * 超图嵌入传播（§1.5.12）。
 * h'_v = h_v + λ · Agg(h_e)，Agg = Σ α·h_u over 同边其他成员。
 * ⚠️ 默认 enabled:false —— 代理向量实测 λ=0 最优；真向量待期3 验（见 DESIGN §1.5.12）。
 *
 * ── [2026-10-24 by Assistant · Round 38 接线审计结论] ──
 * **本模块当前【未接线】：全库零调用。**
 *   实测 grep：除本文件外，没有任何 lib/ scripts/ 引用 propagateEmbeddings。
 *   原因：向量索引当前跑不起来（health.vector.index.ready=false，
 *     模型 bge-m3 与运行时 wantModel/wantDim 都是 null ⇒ incompatible），λ 无从标定。
 *   结论：**保留是对的**（向量可用后直接接上即可），但必须显式标注 ——
 *     否则读代码的人会以为「嵌入传播已经在跑」，从而误判检索能力。
 *   接上时需要做的：检索端拿到 vecIdx 后调本函数，并把 lambda 做成可调参数。
 */
export function propagateEmbeddings(vectors, edges, opts = {}) {
  const lambda = opts.lambda ?? 0;
  if (!lambda) return new Map(vectors);      // λ=0 直接原样返回（省一次深拷贝）
  const out = new Map();
  for (const [k, v] of vectors) out.set(k, Float32Array.from(v));

  for (const e of edges) {
    const ids = e.members.map(m => m.nodeId);
    const wsum = e.members.reduce((a, m) => a + (m.weight ?? 1), 0) || 1;
    // 每个成员的聚合向量
    const agg = new Map();
    for (const m of e.members) {
      const acc = new Float32Array((vectors.get(ids[0]) || []).length || 0);
      for (const o of e.members) {
        if (o.nodeId === m.nodeId) continue;
        const ov = vectors.get(o.nodeId);
        if (!ov) continue;
        const a = (o.weight ?? 1) / wsum;
        for (let i = 0; i < acc.length && i < ov.length; i++) acc[i] += a * ov[i];
      }
      agg.set(m.nodeId, acc);
    }
    for (const m of e.members) {
      const cur = out.get(m.nodeId), add = agg.get(m.nodeId);
      if (!cur || !add) continue;
      for (let i = 0; i < cur.length && i < add.length; i++) cur[i] += lambda * add[i];
    }
  }

  if (opts.normalize !== false) {
    for (const [k, v] of out) {
      let n2 = 0;
      for (let i = 0; i < v.length; i++) n2 += v[i] * v[i];
      const n = Math.sqrt(n2) || 1;
      for (let i = 0; i < v.length; i++) v[i] /= n;
      out.set(k, v);
    }
  }
  return out;
}

/** 按 8:2 切 train/test（seed 固定，可复现） */
export function holdoutSplit(edges, ratio = 0.2, seed = 99) {
  const arr = edges.slice();
  let s = seed >>> 0;
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; }
  const nTest = Math.max(1, Math.round(arr.length * ratio));
  return { train: arr.slice(nTest), test: arr.slice(0, nTest) };
}

function cosine(a, b) {
  let dot = 0;
  for (let i = 0; i < a.length && i < b.length; i++) dot += a[i] * b[i];
  return dot;
}

/**
 * λ 网格搜索（留出法）。
 * ⚠️ 铁律：test 边**从没进过**传播，只在 test 上评分（防自证）。
 */
export function gridSearchLambda(baseVectors, edges, opts = {}) {
  const lambdas = opts.lambdas ?? [0, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7];
  const { train, test } = holdoutSplit(edges, opts.ratio ?? 0.2, opts.seed ?? 99);
  const rows = [];
  for (const lam of lambdas) {
    const vec = propagateEmbeddings(baseVectors, train, { lambda: lam, normalize: true });
    let hit = 0, tot = 0, idCos = 0, idN = 0;
    for (const e of test) {
      const ids = e.members.map(m => m.nodeId);
      const keep = new Set(ids);
      for (const id of ids) {
        const v = vec.get(id);
        if (!v) continue;
        // 同边成员排名
        const scored = ids.filter(x => x !== id && vec.get(x))
          .map(x => ({ x, s: cosine(v, vec.get(x)) }))
          .sort((a, b) => b.s - a.s);
        const top10 = scored.slice(0, 10).filter(o => keep.has(o.x)).length;
        hit += top10; tot += Math.min(10, ids.length - 1);
        const orig = baseVectors.get(id);
        if (orig) { idCos += cosine(v, orig); idN++; }
      }
    }
    rows.push({ lambda: lam, hitAt10: tot ? hit / tot : 0, identityCos: idN ? idCos / idN : 1, chosen: false });
  }
  const best = rows.reduce((a, b) => (b.hitAt10 > a.hitAt10 ? b : a), rows[0]);
  best.chosen = true;
  return rows;
}
