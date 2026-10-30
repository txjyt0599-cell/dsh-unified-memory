#!/usr/bin/env node
/**
 * proto-l0-cache.mjs —— L0 索引持久化【只读原型】
 * [2026-10-31 by Assistant · L0 消融之后的下一步]
 *
 * 与 bm25 原型的关键差别：这次 postings 是**真实的**（用 dumpInternals 拿得到），
 * 不再用等量模拟。所以文件大小与读回耗时可当真。
 *
 * 边界：不接线 retriever.js、不写生产数据根、不改 bm25.js。
 * 用法：PM_DATA_ROOT=<数据根> node scripts/proto-l0-cache.mjs [--runs 20]
 */
import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO = new URL('..', import.meta.url).pathname.replace(/^\//, '');
const LIB = 'file:///' + REPO.replace(/^\/+/, '') + 'lib/';
const { buildL0RoundCards } = await import(LIB + 'hypergraph/l0-rounds.js');
const { createBm25Index, searchBm25, dumpInternals, createBm25FromInternals } = await import(LIB + 'retrieval/bm25.js');
const { createTokenizer } = await import(LIB + 'retrieval/tokenize.js');
const { dataPath } = await import(LIB + 'paths.js');

const RUNS = (() => { const i = process.argv.indexOf('--runs'); return i >= 0 ? Math.max(3, Number(process.argv[i + 1]) || 20) : 20; })();
const p50 = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const p95 = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * 0.95))]; };
const assertOk = [];
function check(n, ok, d) { console.log((ok ? "  OK   " : "  FAIL ") + n + (d === undefined ? "" : "   " + d)); if (!ok) assertOk.push(n); }

// ── 1 · 真实 L0 索引 ──
const conv = dataPath('memory-tencentdb/memory-tdai/conversations');
const t0 = performance.now();
const l0 = buildL0RoundCards(conv, { recentDays: 30 });
const tParse = performance.now() - t0;
const tok = createTokenizer({ mode: 'bigram' });
const t1 = performance.now();
const A = createBm25Index(l0, tok);
const tBuild = performance.now() - t1;
console.log("L0 rounds=" + l0.length + "  vocab=" + A.vocabSize + "  pairs=" + A.postingsPairs);
console.log("  解析 " + tParse.toFixed(0) + "ms  建索引 " + tBuild.toFixed(0) + "ms");

// ── 2 · 真实 postings 序列化（不是模拟）──
const MAGIC = Buffer.from("PML0C\0\0\0", "binary");
const FORMAT_VERSION = 1;

function snapshotOf(cards) {
  const h = createHash("sha256");
  for (const c of cards) h.update(String(c.id) + "\u0003" + String(c.title || "") + "\u0003" + String(c.summary || "") + "\u0003" + (c.content ? c.content.length : 0) + "\u0004");
  return { docCount: cards.length, contentHash: h.digest("hex").slice(0, 24) };
}
const SNAP = snapshotOf(l0);

function serialize(idx, cards, dir, gen) {
  const inner = dumpInternals(idx);
  const h = createHash("sha256");
  const parts = [];
  const push = (b) => { parts.push(b); h.update(b); };

  const idsBuf = Buffer.from(JSON.stringify(inner.ids), "utf8");
  const lb = Buffer.alloc(4); lb.writeUInt32LE(idsBuf.length, 0); push(lb); push(idsBuf);
  push(Buffer.from(inner.lens.buffer, inner.lens.byteOffset, inner.lens.byteLength));

  const terms = [...inner.postings.keys()];
  const vc = Buffer.alloc(4); vc.writeUInt32LE(terms.length, 0); push(vc);
  for (const t of terms) {
    const tb = Buffer.from(t, "utf8");
    const tl = Buffer.alloc(2); tl.writeUInt16LE(tb.length, 0); push(tl); push(tb);
    const arr = inner.postings.get(t);
    const pc = Buffer.alloc(4); pc.writeUInt32LE(arr.length / 2, 0); push(pc);
    const di = new Int32Array(arr.length / 2), wt = new Float64Array(arr.length / 2);
    for (let i = 0; i < arr.length; i += 2) { di[i / 2] = arr[i]; wt[i / 2] = arr[i + 1]; }
    push(Buffer.from(di.buffer)); push(Buffer.from(wt.buffer));
  }
  const body = Buffer.concat(parts);
  const bodyHash = h.digest();
  const header = Buffer.from(JSON.stringify({ formatVersion: FORMAT_VERSION, generation: gen, pool: "l0", N: inner.N, k1: inner.k1, b: inner.b, avgdl: inner.avgdl, tokenizerMode: "bigram", ...SNAP }), "utf8");
  const hl = Buffer.alloc(4); hl.writeUInt32LE(header.length, 0);
  const file = Buffer.concat([MAGIC, hl, header, body, bodyHash]);
  const tmp = join(dir, "l0-" + gen + ".tmp");
  const fin = join(dir, "l0-" + gen + ".bin");
  writeFileSync(tmp, file); renameSync(tmp, fin);
  return { file, path: fin, headerLen: header.length, bodyStart: MAGIC.length + 4 + header.length, size: file.length };
}

function deserialize(path) {
  const t = {};
  let s = performance.now();
  const buf = readFileSync(path);
  t.rawRead = performance.now() - s;
  if (!buf.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error("bad magic");
  const headerLen = buf.readUInt32LE(MAGIC.length);
  const bodyStart = MAGIC.length + 4 + headerLen;
  const header = JSON.parse(buf.subarray(MAGIC.length + 4, bodyStart).toString("utf8"));
  if (header.formatVersion !== FORMAT_VERSION) throw new Error("format version mismatch");
  const body = buf.subarray(bodyStart, buf.length - 32);
  s = performance.now();
  if (!createHash("sha256").update(body).digest().equals(buf.subarray(buf.length - 32))) throw new Error("checksum mismatch");
  t.checksum = performance.now() - s;

  s = performance.now();
  let o = 0;
  const idsLen = body.readUInt32LE(o); o += 4;
  const ids = JSON.parse(body.subarray(o, o + idsLen).toString("utf8")); o += idsLen;
  const lens = new Float64Array(header.N);
  for (let i = 0; i < header.N; i++) { lens[i] = body.readDoubleLE(o); o += 8; }
  const vocab = body.readUInt32LE(o); o += 4;
  const postings = new Map(); const dfMap = new Map();
  for (let i = 0; i < vocab; i++) {
    const tl = body.readUInt16LE(o); o += 2;
    const term = body.subarray(o, o + tl).toString("utf8"); o += tl;
    const pc = body.readUInt32LE(o); o += 4;
    const arr = new Array(pc * 2);
    for (let j = 0; j < pc; j++) { arr[j * 2] = body.readInt32LE(o + j * 4); }
    o += pc * 4;
    for (let j = 0; j < pc; j++) { arr[j * 2 + 1] = body.readDoubleLE(o + j * 8); }
    o += pc * 8;
    postings.set(term, arr); dfMap.set(term, pc);
  }
  t.decode = performance.now() - s;
  if (o !== body.length) throw new Error("trailing bytes");
  if (ids.length !== header.N) throw new Error("ids length mismatch");
  return { header, ids, lens, postings, dfMap, t, size: buf.length };
}

// ── 3 · 实测 ──
const TMP = mkdtempSync(join(tmpdir(), "pm-proto-l0-"));
try {
  console.log("");
  console.log("── 序列化 ──");
  const ser = serialize(A, l0, TMP, "g1");
  console.log("  文件大小 = " + (ser.size / 1024 / 1024).toFixed(2) + " MB  （真实 postings）");

  console.log("");
  console.log("── 热读回（n=" + RUNS + "）──");
  const lat = [];
  for (let i = 0; i < RUNS; i++) { const s = performance.now(); deserialize(ser.path); lat.push(performance.now() - s); }
  const R = p50(lat), R95 = p95(lat);
  console.log("  读回 p50 = " + R.toFixed(1) + "ms   p95 = " + R95.toFixed(1) + "ms");
  const d1 = deserialize(ser.path);
  console.log("    raw     " + d1.t.rawRead.toFixed(1) + "ms");
  console.log("    checksum " + d1.t.checksum.toFixed(1) + "ms");
  console.log("    decode   " + d1.t.decode.toFixed(1) + "ms");

  console.log("");
  console.log("── 等价性 ──");
  const B = createBm25FromInternals({ ids: d1.ids, lens: d1.lens, postings: d1.postings, dfMap: d1.dfMap, k1: d1.header.k1, b: d1.header.b, N: d1.header.N, avgdl: d1.header.avgdl }, { mode: "bigram" }, { createTokenizer });
  const f64hex = (n) => { const b = new DataView(new ArrayBuffer(8)); b.setFloat64(0, n); return Array.from(new Uint8Array(b.buffer)).map((x) => x.toString(16).padStart(2, "0")).join(""); };
  let bad = 0, n = 0;
  for (let i = 0; i < 30; i++) {
    const q = String(l0[(i * 97) % l0.length].content || "").slice(0, 4 + i);
    for (const k of [5, 12, 24, -1]) {
      n++;
      const ra = searchBm25(A, q, k), rb = searchBm25(B, q, k);
      if (JSON.stringify(ra.map((x) => [x[0], f64hex(x[1])])) !== JSON.stringify(rb.map((x) => [x[0], f64hex(x[1])]))) bad++;
    }
  }
  check("真实 L0 逐位一致（" + n + " 组）", bad === 0, bad ? bad + " 组不一致" : "全部一致");

  console.log("");
  console.log("── 损坏拒绝 ──");
  const mk = (nm, mut) => { const b = Buffer.from(ser.file); mut(b); const p = join(TMP, nm); writeFileSync(p, b); let e = null; try { deserialize(p); } catch (err) { e = err.message; } return e; };
  check("截断被拒", !!mk("t.bin", (b) => { b.fill(0, b.length - 40); }));
  check("篡改被拒", !!mk("c.bin", (b) => { b[ser.bodyStart + 200] ^= 0xff; }));
  check("magic 错被拒", !!mk("m.bin", (b) => { b[0] = 0; }));

  console.log("");
  console.log("════ L0 原型结论 ════");
  console.log("  解析      " + tParse.toFixed(0) + "ms（缓存救不了）");
  console.log("  建索引    " + tBuild.toFixed(0) + "ms");
  console.log("  文件      " + (ser.size / 1024 / 1024).toFixed(2) + " MB");
  console.log("  热读回    " + R.toFixed(1) + "ms (p95 " + R95.toFixed(1) + ")");
  console.log("  净省      " + (tBuild - R).toFixed(0) + "ms（未扣接缝开销）");
  console.log("  失败项    " + (assertOk.length ? assertOk.join(", ") : "无"));
  process.exitCode = assertOk.length ? 1 : 0;
} finally {
  try { rmSync(TMP, { recursive: true, force: true }); } catch {}
}