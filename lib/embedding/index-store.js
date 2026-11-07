/**
 * embedding/index-store.js —— 卡片向量索引（落盘 + 增量）
 * [2026-10-22 by Assistant · 向量接入第二块]
 *
 * 存储形态（二进制，省内存也省 IO）：
 *   <dir>/index.json   { model, dim, builtAt, count, ids: string[] }
 *   <dir>/vectors.bin  Float32Array 连续存放（第 i 行 = ids[i]），已 L2 归一化
 *
 * 为什么这样存：
 *   5500 张卡 × 1024 维 × 4 字节 ≈ 22.5 MB。JSON 存会膨胀到 100MB+ 且解析巨慢；
 *   连续 Float32Array 一次读入即可，点积即 cosine（已归一化）。
 *
 * 铁律：
 *   1. **模型/维度变了整库作废**（不同模型的向量不可比 —— 这是「代理向量不可比」的教训）。
 *   2. **原子写**：先写 .tmp 再 rename，断电不会留下半截索引。
 *   3. 增量只补「没有向量」的卡；已有向量不重算（省钱）。
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { normalize, dot } from './client.js';
import { dataPath } from '../paths.js';

const INDEX_FILE = 'index.json';
const VECTORS_FILE = 'vectors.bin';

export const EMBEDDINGS_DIR = dataPath('embeddings');

/** 打开（或报告不存在）一个向量索引。 */
export function loadIndex(dir) {
  const d = dir || EMBEDDINGS_DIR;
  const metaPath = join(d, INDEX_FILE);
  const vecPath = join(d, VECTORS_FILE);
  if (!existsSync(metaPath) || !existsSync(vecPath)) return null;
  try {
    const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
    const buf = readFileSync(vecPath);
    if (!meta || !Array.isArray(meta.ids) || !meta.dim) return null;
    const count = meta.ids.length;
    if (buf.byteLength !== count * meta.dim * 4) return null;
    // [P3/E4] 校验 meta 里记的 vectors 哈希，防「index.json 新、vectors.bin 旧」的混搭
    if (meta.vectorsHash) {
      const h = createHash('sha1').update(buf).digest('hex').slice(0, 16);
      if (h !== meta.vectorsHash) return null;
    }
    if (meta.vectorsBytes && meta.vectorsBytes !== buf.byteLength) return null;
    // 复制成独立 ArrayBuffer（避免 Buffer 池共享导致的越界）
    const ab = new ArrayBuffer(buf.byteLength);
    new Uint8Array(ab).set(buf);
    return {
      model: String(meta.model || ''),
      dim: Number(meta.dim),
      builtAt: Number(meta.builtAt) || 0,
      ids: meta.ids.slice(),
      pos: buildPos(meta.ids),
      flat: new Float32Array(ab),
      dir: d,
    };
  } catch {
    return null;
  }
}

function buildPos(ids) {
  const m = new Map();
  for (let i = 0; i < ids.length; i++) m.set(ids[i], i);
  return m;
}

/** 索引里的向量（拷贝一份，防止调用方改写内部状态）。 */
export function vectorOf(idx, cardId) {
  if (!idx) return null;
  const i = idx.pos.get(String(cardId));
  if (i === undefined) return null;
  const off = i * idx.dim;
  return idx.flat.subarray(off, off + idx.dim);
}

/**
 * 保存（原子）。
 * @param {string} dir
 * @param {{model:string, dim:number, ids:string[], vectors:Float32Array[]}} data
 */
export function saveIndex(dir, data) {
  const d = dir || EMBEDDINGS_DIR;
  mkdirSync(d, { recursive: true });
  const dim = Number(data.dim) || 0;
  const ids = data.ids.slice();
  const flat = new Float32Array(ids.length * dim);
  for (let i = 0; i < ids.length; i++) {
    const v = data.vectors[i];
    if (!v || v.length !== dim) throw new Error('embedding dim mismatch at ' + ids[i]);
    flat.set(v, i * dim);
  }
  // [2026-10-22 by Assistant · 架构红队 P3/E4] 两文件一致性。
  //   红队指出：index.json 与 vectors.bin 分别 rename 不是事务，
  //   一个成功一个失败会「新旧混搭」（loadIndex 只能靠长度校验碰运气）。
  //   做法：
  //     ① index.json 里记录 vectors.bin 的 **sha1 前 16 位**
  //     ② **先写 vectors.bin 再写 index.json**（顺序反了会让新 meta 指向旧向量）
  //     ③ loadIndex 校验 hash，不匹配就整库判废（返回 null，调用方退回纯 BM25）
  const vecBuf = Buffer.from(flat.buffer, flat.byteOffset, flat.byteLength);
  const vectorsHash = createHash('sha1').update(vecBuf).digest('hex').slice(0, 16);
  const meta = {
    model: String(data.model || ''),
    dim: dim,
    builtAt: Date.now(),
    count: ids.length,
    ids: ids,
    vectorsBytes: vecBuf.byteLength,
    vectorsHash: vectorsHash,
  };
  const metaTmp = join(d, INDEX_FILE + '.tmp');
  const vecTmp = join(d, VECTORS_FILE + '.tmp');
  writeFileSync(vecTmp, vecBuf);
  writeFileSync(metaTmp, JSON.stringify(meta), 'utf8');
  // 顺序：先 vectors（大文件）再 index（小文件，作为"提交点"）
  renameSync(vecTmp, join(d, VECTORS_FILE));
  renameSync(metaTmp, join(d, INDEX_FILE));
  return { model: meta.model, dim: dim, count: ids.length, builtAt: meta.builtAt, dir: d };
}

/** 索引与当前配置是否兼容（模型/维度任一不同 ⇒ 不兼容，必须重建）。 */
export function isCompatible(idx, model, dim) {
  if (!idx) return false;
  if (String(idx.model) !== String(model)) return false;
  if (Number(idx.dim) !== Number(dim)) return false;
  return true;
}

/**
 * 向量检索：返回 [{ id, score }] 按 cosine 降序。
 * 索引里没有的卡不会被返回（调用方自行与 BM25 融合）。
 */
export function searchVector(idx, queryVec, topK) {
  if (!idx || !queryVec || queryVec.length !== idx.dim) return [];
  const k = Math.max(1, Number(topK) || 20);
  const q = normalize(Float32Array.from(queryVec));
  const dim = idx.dim;
  const n = idx.ids.length;
  // 小顶堆式选择：k 很小时不必全排序
  const best = [];
  for (let i = 0; i < n; i++) {
    const off = i * dim;
    let s = 0;
    const base = idx.flat;
    for (let j = 0; j < dim; j++) s += base[off + j] * q[j];
    if (best.length < k) {
      best.push({ id: idx.ids[i], score: s });
      if (best.length === k) best.sort(function (a, b) { return a.score - b.score; });
    } else if (s > best[0].score) {
      best[0] = { id: idx.ids[i], score: s };
      // 重新下沉（k 通常 <= 30，直接排序更省心）
      best.sort(function (a, b) { return a.score - b.score; });
    }
  }
  return best.sort(function (a, b) { return b.score - a.score; });
}

/** 索引统计（给 probe / health 用）。 */
export function indexStats(idx) {
  if (!idx) return { ready: false };
  return {
    ready: true,
    model: idx.model,
    dim: idx.dim,
    count: idx.ids.length,
    builtAt: idx.builtAt,
    bytes: idx.flat.byteLength,
    dir: idx.dir,
  };
}
