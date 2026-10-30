#!/usr/bin/env node
/**
 * proto-normal-pool-cache.mjs —— 普通池 BM25 缓存【只读原型·真实 postings】
 * [2026-10-31 by Assistant]
 *
 * 与早先 proto-bm25-cache.mjs 的区别：那次 postings 是模拟的（接缝还没有）。
 * 现在接缝已有，本原型序列化**真实** postings，所有数字可当真。
 *
 * 边界：不接线、不写数据根、不改 bm25.js。
 * 用法：PM_DATA_ROOT=<数据根> node scripts/proto-normal-pool-cache.mjs [--runs 15]
 */
import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO = new URL('..', import.meta.url).pathname.replace(/^\//, '');
const LIB = 'file:///' + REPO.replace(/^\/+/, '') + 'lib/';
const { readCards, readTdaiRecords, readOwnIngest, readSoulMdCards, DEFAULT_TDAI_DIR, DEFAULT_INGEST_ROOT, DEFAULT_SOULMD_ROOT } = await import(LIB + 'hypergraph/source.js');
const { createBm25Index, searchBm25, dumpInternals, createBm25FromInternals } = await import(LIB + 'retrieval/bm25.js');
const { createTokenizer } = await import(LIB + 'retrieval/tokenize.js');

const RUNS = (() => { const i = process.argv.indexOf('--runs'); return i >= 0 ? Math.max(3, Number(process.argv[i + 1]) || 15) : 15; })();
const p50 = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const fails = [];
function check(n, ok, d) { console.log((ok ? "  OK   " : "  FAIL ") + n + (d === undefined ? "" : "   " + d)); if (!ok) fails.push(n); }

// ── 1 · 装配最终 docs（复刻 retriever.js 四源合并顺序）──
function contentKey(c0) {
  const t = String(c0 && c0.title || "").replace(/\s+/g, "").slice(0, 200);
  const s = String(c0 && c0.summary || "").replace(/\s+/g, "").slice(0, 300);
  if (!t && !s) return "";
  return createHash("sha1").update(t + "\u0000" + s, "utf8").digest("hex").slice(0, 16);
}
function assemble() {
  const t0 = performance.now();
  const base = readCards();
  let cards = (base.all || base.alive || []).slice();
  const td = readTdaiRecords(DEFAULT_TDAI_DIR);
  if (td && td.cards && td.cards.length) {
    const ids = new Set(cards.map((x) => String(x.id)));
    const fp = new Set(); for (const x of cards) { const k = contentKey(x); if (k) fp.add(k); }
    for (const tc of td.cards) { if (ids.has(String(tc.id))) continue; const k = contentKey(tc); if (k && fp.has(k)) continue; cards.push(tc); if (k) fp.add(k); }
  }
  const own = readOwnIngest(DEFAULT_INGEST_ROOT);
  if (own && own.cards && own.cards.length) { const have = new Set(cards.map((x) => String(x.id))); for (const oc of own.cards) { if (have.has(String(oc.id))) continue; cards.push(oc); have.add(String(oc.id)); } }
  const sm = readSoulMdCards(DEFAULT_SOULMD_ROOT);
  if (sm && sm.cards && sm.cards.length) { const ids = new Set(cards.map((x) => String(x.id))); for (const sc of sm.cards) { const id = String(sc.id || ""); if (!id || ids.has(id)) continue; cards.push(sc); ids.add(id); } }
  return { cards, ms: performance.now() - t0 };
}
const asm = assemble();
const DOCS = asm.cards;
console.log("docs = " + DOCS.length + "   装配 = " + asm.ms.toFixed(0) + "ms（缓存救不了）");

function snapshotOf(docs) {
  const h = createHash("sha256");
  const ids = docs.map((d) => String(d && d.id));
  h.update(ids.join("\u0001")); h.update("\u0002");
  for (const d of docs) h.update(String(d && d.id) + "\u0003" + String(d && d.title || "") + "\u0003" + String(d && d.summary || "") + "\u0003" + String(d && d.content || "") + "\u0004");
  return { docCount: docs.length, idOrderHash: createHash("sha256").update(ids.join("\u0001")).digest("hex").slice(0, 16), contentHash: h.digest("hex").slice(0, 24) };
}
const SNAP = snapshotOf(DOCS);

const MAGIC = Buffer.from("PMB25R\0\0", "binary");
const FORMAT_VERSION = 2;

function serialize(idx, docs, dir, gen) {
  const inner = dumpInternals(idx);
  const h = createHash("sha256");
  const parts = []; const push = (b) => { parts.push(b); h.update(b); };
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
  const header = Buffer.from(JSON.stringify({ formatVersion: FORMAT_VERSION, generation: gen, pool: "normal", N: inner.N, k1: inner.k1, b: inner.b, avgdl: inner.avgdl, tokenizerMode: "bigram", ...SNAP }), "utf8");
  const hl = Buffer.alloc(4); hl.writeUInt32LE(header.length, 0);
  const file = Buffer.concat([MAGIC, hl, header, body, bodyHash]);
  const tmp = join(dir, "normal-" + gen + ".tmp"), fin = join(dir, "normal-" + gen + ".bin");
  writeFileSync(tmp, file); renameSync(tmp, fin);
  return { file, path: fin, bodyStart: MAGIC.length + 4 + header.length, size: file.length };
}

function deserialize(path) {
  const t = {};
  let s = performance.now(); const buf = readFileSync(path); t.rawRead = performance.now() - s;
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
    for (let j = 0; j < pc; j++) arr[j * 2] = body.readInt32LE(o + j * 4);
    o += pc * 4;
    for (let j = 0; j < pc; j++) arr[j * 2 + 1] = body.readDoubleLE(o + j * 8);
    o += pc * 8;
    postings.set(term, arr); dfMap.set(term, pc);
  }
  t.decode = performance.now() - s;
  if (o !== body.length) throw new Error("trailing bytes");
  if (ids.length !== header.N) throw new Error("ids mismatch");
  return { header, ids, lens, postings, dfMap, t, size: buf.length };
}

const TMP = mkdtempSync(join(tmpdir(), "pm-proto-np-"));
try {
  const tok = createTokenizer({ mode: "bigram" });
  console.log("");
  console.log("── 建索引基线（n=" + RUNS + "）──");
  const build = []; let A = null;
  for (let i = 0; i < RUNS; i++) { const s = performance.now(); A = createBm25Index(DOCS, tok); build.push(performance.now() - s); }
  const B0 = p50(build);
  console.log("  建索引 p50 = " + B0.toFixed(0) + "ms   vocab = " + A.vocabSize + "   pairs = " + A.postingsPairs);

  console.log("");
  console.log("── 序列化（真实 postings）──");
  const ser = serialize(A, DOCS, TMP, "g1");
  console.log("  文件大小 = " + (ser.size / 1024 / 1024).toFixed(2) + " MB");

  console.log("");
  console.log("── 热读回（n=" + RUNS + "）──");
  const lat = [];
  for (let i = 0; i < RUNS; i++) { const s = performance.now(); deserialize(ser.path); lat.push(performance.now() - s); }
  const R = p50(lat);
  console.log("  读回 p50 = " + R.toFixed(1) + "ms");
  const d1 = deserialize(ser.path);
  console.log("    raw " + d1.t.rawRead.toFixed(1) + " / checksum " + d1.t.checksum.toFixed(1) + " / decode " + d1.t.decode.toFixed(1));

  console.log("");
  console.log("── 等价性（真实 docs）──");
  const B = createBm25FromInternals({ ids: d1.ids, lens: d1.lens, postings: d1.postings, dfMap: d1.dfMap, k1: d1.header.k1, b: d1.header.b, N: d1.header.N, avgdl: d1.header.avgdl }, { mode: "bigram" }, { createTokenizer });
  const f64hex = (n) => { const b = new DataView(new ArrayBuffer(8)); b.setFloat64(0, n); return Array.from(new Uint8Array(b.buffer)).map((x) => x.toString(16).padStart(2, "0")).join(""); };
  let bad = 0, n = 0;
  const QS = ["记忆系统", "检索 延迟", "插件 安装", "超频 显存", "日记 归档", "B站 评论区", "缓存 索引", "a", ""];
  for (const q of QS) for (const k of [0, 5, 12, 24, 35, -1, DOCS.length]) {
    n++;
    const ra = searchBm25(A, q, k), rb = searchBm25(B, q, k);
    if (JSON.stringify(ra.map((x) => [x[0], f64hex(x[1])])) !== JSON.stringify(rb.map((x) => [x[0], f64hex(x[1])]))) bad++;
  }
  check("真实普通池逐位一致（" + n + " 组）", bad === 0, bad ? bad + " 组不一致" : "全部一致");

  console.log("");
  console.log("── 损坏拒绝 ──");
  const mk = (nm, mut) => { const b = Buffer.from(ser.file); mut(b); const p = join(TMP, nm); writeFileSync(p, b); let e = null; try { deserialize(p); } catch (err) { e = err.message; } return e; };
  check("截断被拒", !!mk("t.bin", (b) => { b.fill(0, b.length - 40); }));
  check("篡改被拒", !!mk("c.bin", (b) => { b[ser.bodyStart + 300] ^= 0xff; }));
  check("magic 错被拒", !!mk("m.bin", (b) => { b[0] = 0; }));

  const seam = 83.5;  // 普通池接缝实测（SEAM 报告）
  console.log("");
  console.log("════ 普通池原型结论 ════");
  console.log("  装配(救不了)  " + asm.ms.toFixed(0) + "ms");
  console.log("  建索引         " + B0.toFixed(0) + "ms");
  console.log("  文件           " + (ser.size / 1024 / 1024).toFixed(2) + " MB");
  console.log("  热读回         " + R.toFixed(1) + "ms");
  console.log("  接缝开销       " + seam.toFixed(1) + "ms");
  console.log("  净省           " + (B0 - R - seam).toFixed(0) + "ms");
  console.log("  失败项         " + (fails.length ? fails.join(", ") : "无"));
  process.exitCode = fails.length ? 1 : 0;
} finally {
  try { rmSync(TMP, { recursive: true, force: true }); } catch {}
}