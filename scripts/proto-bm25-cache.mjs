#!/usr/bin/env node
/**
 * proto-bm25-cache.mjs —— BM25 持久化缓存【只读原型】
 * [2026-10-31 by Assistant · 按红队二审裁定：只做原型，不接线]
 *
 * ## 边界（红队明确划的，违反即作废）
 *   · 不接 retriever.js，不改 bm25.js 任何现有行为
 *   · 不写生产数据目录（所有临时文件走 os.tmpdir()）
 *   · 只读生产数据
 *
 * ## 它要回答的问题（红队说这些都没核实）
 *   1. 序列化文件到底多大
 *   2. 热读回到底多久（raw / checksum / decode / Map 重建 分开计）
 *   3. 逐位一致性：全量 + 边界 k + 各档 adaptive K
 *   4. 损坏/截断/代际不匹配时能不能可靠拒绝
 *
 * 用法：
 *   PM_DATA_ROOT=<数据根> node scripts/proto-bm25-cache.mjs [--runs 30]
 */
import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, statSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO = new URL('..', import.meta.url).pathname.replace(/^\//, '');
const LIB = 'file:///' + REPO.replace(/^\/+/, '') + 'lib/';
const { readCards, readTdaiRecords, readOwnIngest, readSoulMdCards, DEFAULT_TDAI_DIR, DEFAULT_INGEST_ROOT, DEFAULT_SOULMD_ROOT } = await import(LIB + 'hypergraph/source.js');
const { createBm25Index, searchBm25 } = await import(LIB + 'retrieval/bm25.js');
const { createTokenizer } = await import(LIB + 'retrieval/tokenize.js');
const { FIELD_WEIGHT } = await import(LIB + 'retrieval/types.js');

const RUNS = (() => { const i = process.argv.indexOf('--runs'); return i >= 0 ? Math.max(5, Number(process.argv[i + 1]) || 30) : 30; })();
const FAILS = [];
function check(name, ok, detail) {
  console.log((ok ? '  ✅ ' : '  ❌ ') + name + (detail === undefined ? '' : '   ' + detail));
  if (!ok) FAILS.push(name);
}
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };

// ═══════════════════════════════════════════════════════════
// 1 · 复刻生产装配（与 retriever.js:440-563 同序同规则）
// ═══════════════════════════════════════════════════════════
console.log('── 1 · 装配最终 docs（复刻生产顺序）──');
function assembleDocs() {
  const t0 = performance.now();
  // ④ 源卡（engram）
  const base = readCards();
  let cards = (base.all || base.alive || []).slice();

  // ④.5 tdai（含跨源内容去重，同 retriever.js:456-486）
  const contentKey = (c0) => {
    const t = String(c0 && c0.title || '').replace(/\s+/g, '').slice(0, 200);
    const s = String(c0 && c0.summary || '').replace(/\s+/g, '').slice(0, 300);
    if (!t && !s) return '';
    return createHash('sha1').update(t + '\u0000' + s, 'utf8').digest('hex').slice(0, 16);
  };
  const td = readTdaiRecords(DEFAULT_TDAI_DIR);
  if (td && td.cards && td.cards.length) {
    const ids = new Set(cards.map((x) => String(x.id)));
    const fp = new Set();
    for (const x of cards) { const k = contentKey(x); if (k) fp.add(k); }
    for (const tc of td.cards) {
      if (ids.has(String(tc.id))) continue;
      const k = contentKey(tc);
      if (k && fp.has(k)) continue;
      cards.push(tc);
      if (k) fp.add(k);
    }
  }

  // ④.6 自产 ingest
  const own = readOwnIngest(DEFAULT_INGEST_ROOT);
  if (own && own.cards && own.cards.length) {
    const have = new Set(cards.map((x) => String(x.id)));
    for (const oc of own.cards) {
      if (have.has(String(oc.id))) continue;
      cards.push(oc); have.add(String(oc.id));
    }
  }

  // ④.7 soul-md
  const sm = readSoulMdCards(DEFAULT_SOULMD_ROOT);
  if (sm && sm.cards && sm.cards.length) {
    const ids = new Set(cards.map((x) => String(x.id)));
    for (const sc of sm.cards) {
      const id = String(sc.id || '');
      if (!id || ids.has(id)) continue;
      cards.push(sc); ids.add(id);
    }
  }
  return { cards, ms: performance.now() - t0 };
}

const asm = assembleDocs();
const DOCS = asm.cards;
console.log('  docs =', DOCS.length, ' 装配耗时', asm.ms.toFixed(0), 'ms');
console.log('');

// ═══════════════════════════════════════════════════════════
// 2 · 缓存头（红队 P0-1：必须与最终 docs 同口径）
// ═══════════════════════════════════════════════════════════
function snapshotOf(docs) {
  const h = createHash('sha256');
  const ordered = docs.map((d) => String(d && d.id));
  h.update(ordered.join('\u0001'));
  h.update('\u0002');
  for (const d of docs) {
    h.update(String(d && d.id) + '\u0003' +
      String(d && d.title || '') + '\u0003' +
      String(d && d.summary || '') + '\u0003' +
      String(d && d.content || '') + '\u0004');
  }
  return { docCount: docs.length, idOrderHash: createHash('sha256').update(ordered.join('\u0001')).digest('hex').slice(0, 16), contentHash: h.digest('hex').slice(0, 24) };
}

const SNAP = snapshotOf(DOCS);
console.log('── 2 · 快照指纹 ──');
console.log('  docCount     =', SNAP.docCount);
console.log('  idOrderHash  =', SNAP.idOrderHash);
console.log('  contentHash  =', SNAP.contentHash, '（含 content！红队 P0-1）');
console.log('');

// ═══════════════════════════════════════════════════════════
// 3 · 序列化 / 反序列化（二进制 + SHA-256 全长校验）
// ═══════════════════════════════════════════════════════════
const MAGIC = Buffer.from('PMB25\0\0\0', 'binary');
const FORMAT_VERSION = 1;

function headerOf(extra) {
  return {
    formatVersion: FORMAT_VERSION,
    k1: 1.2, b: 0.75,
    fieldWeight: { title: FIELD_WEIGHT.title, summary: FIELD_WEIGHT.summary, content: FIELD_WEIGHT.content },
    tokenizer: {
      mode: 'bigram', sig: 'stub',
      node: process.versions.node.split('.').slice(0, 2).join('.'),
      icu: process.versions.icu || null,
    },
    pool: 'normal',
    N: DOCS.length,        // 反序列化要用它跳过 lens 段，必须写进 header
    ...SNAP,
    ...extra,
  };
}

function serialize(idx, docs, tmpDir, gen) {
  const h = createHash('sha256');
  const parts = [];
  const push = (b) => { parts.push(b); h.update(b); };

  // ids
  const idsBuf = Buffer.from(JSON.stringify(docs.map((d) => String(d.id))), 'utf8');
  const lenBuf = Buffer.alloc(4); lenBuf.writeUInt32LE(idsBuf.length, 0);
  push(lenBuf); push(idsBuf);

  // lens
  const lensArr = new Float64Array(idx.N);
  for (let i = 0; i < idx.N; i++) lensArr[i] = 0;   // 原型不依赖真实 lens（索引在闭包里）
  push(Buffer.from(lensArr.buffer));

  // postings：原型用 idx 的统计量做等量模拟，验证的是"格式与校验"，不是内容等价
  const vocab = idx.vocabSize, pairs = idx.postingsPairs;
  const per = Math.max(1, Math.round(pairs / vocab));
  const termBufs = [];
  let total = 0;
  for (let i = 0; i < vocab; i++) { const b = Buffer.from('t' + i.toString(36), 'utf8'); termBufs.push(b); total += 2 + b.length + 4 + per * 12; }
  const vocabHead = Buffer.alloc(4); vocabHead.writeUInt32LE(vocab, 0); push(vocabHead);
  for (let i = 0; i < vocab; i++) {
    const b = termBufs[i];
    const lb = Buffer.alloc(2); lb.writeUInt16LE(b.length, 0); push(lb); push(b);
    const pc = Buffer.alloc(4); pc.writeUInt32LE(per, 0); push(pc);
    const n = per * 12;
    push(Buffer.alloc(n));
  }

  const body = Buffer.concat(parts);
  const bodyHash = h.digest();     // 32 字节 SHA-256（红队要求，原方案只有 4 字节）
  const header = Buffer.from(JSON.stringify(headerOf({ generation: gen })), 'utf8');
  const hl = Buffer.alloc(4); hl.writeUInt32LE(header.length, 0);

  const file = Buffer.concat([MAGIC, hl, header, body, bodyHash]);
  const tmp = join(tmpDir, 'bm25-' + gen + '.tmp');
  const final = join(tmpDir, 'bm25-' + gen + '.bin');
  writeFileSync(tmp, file);
  renameSync(tmp, final);          // 原子提交
  return { file, path: final, header, bodyOffset: MAGIC.length + 4 + header.length, bodyLen: body.length };
}

function deserialize(path) {
  const t = {};
  let s = performance.now();
  const buf = readFileSync(path);
  t.rawRead = performance.now() - s;

  if (buf.length < MAGIC.length + 4 + 32) throw new Error('file too short');
  if (!buf.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('bad magic');
  const headerLen = buf.readUInt32LE(MAGIC.length);
  const bodyStart = MAGIC.length + 4 + headerLen;
  if (bodyStart > buf.length - 32) throw new Error('headerLen out of range');
  const header = JSON.parse(buf.subarray(MAGIC.length + 4, bodyStart).toString('utf8'));
  if (header.formatVersion !== FORMAT_VERSION) throw new Error('format version mismatch');

  const body = buf.subarray(bodyStart, buf.length - 32);
  const want = buf.subarray(buf.length - 32);

  s = performance.now();
  const got = createHash('sha256').update(body).digest();
  t.checksum = performance.now() - s;
  if (!got.equals(want)) throw new Error('body checksum mismatch');

  // decode
  s = performance.now();
  let o = 0;
  const idsLen = body.readUInt32LE(o); o += 4;
  const ids = JSON.parse(body.subarray(o, o + idsLen).toString('utf8')); o += idsLen;
  o += header.N ? header.N * 8 : 0;
  const vocab = body.readUInt32LE(o); o += 4;
  const terms = new Array(vocab);
  for (let i = 0; i < vocab; i++) {
    const tl = body.readUInt16LE(o); o += 2;
    terms[i] = body.subarray(o, o + tl).toString('utf8'); o += tl;
    const pc = body.readUInt32LE(o); o += 4;
    o += pc * 12;
  }
  t.decode = performance.now() - s;

  // Map 重建（红队关注的真实成本）
  s = performance.now();
  const map = new Map();
  for (let i = 0; i < terms.length; i++) map.set(terms[i], i);
  t.mapRebuild = performance.now() - s;

  // 结构校验（红队 P1 要求）
  if (ids.length !== header.docCount) throw new Error('ids length != docCount');
  if (o !== body.length) throw new Error('body trailing bytes');

  return { header, ids, vocab, t, bytes: buf.length };
}

// ═══════════════════════════════════════════════════════════
// 4 · 实测
// ═══════════════════════════════════════════════════════════
const TMP = mkdtempSync(join(tmpdir(), 'pm-proto-bm25-'));
try {
  console.log('── 3 · 建索引基线（n=' + RUNS + '）──');
  const tok = createTokenizer({ mode: 'bigram' });
  const build = [];
  for (let i = 0; i < RUNS; i++) { const s = performance.now(); createBm25Index(DOCS, tok); build.push(performance.now() - s); }
  const B = pct(build, 0.5);
  console.log('  建索引 p50 =', B.toFixed(0), 'ms   p95 =', pct(build, 0.95).toFixed(0), 'ms');
  console.log('');

  console.log('── 4 · 序列化 + 热读回（n=' + RUNS + '）──');
  const idx = createBm25Index(DOCS, tok);
  const ser = serialize(idx, DOCS, TMP, 'g1');
  const sizeMB = ser.file.length / 1024 / 1024;
  // ⚠️ 原型里的 postings 是**等量模拟**（真实 postings 在 WeakMap 里取不到），
  //    所以这个文件大小不是真实值。真实值只能按统计量估算：
  //    term 表 ≈ vocab*(2+平均词长+4) + pairs*12 + ids + lens
  const estTerm = idx.vocabSize * (2 + 6 + 4);
  const estPairs = idx.postingsPairs * 12;
  const realEstMB = (estTerm + estPairs) / 1024 / 1024;
  console.log('  文件大小 =', sizeMB.toFixed(2), 'MB  ⚠️ 模拟值，不可当真');
  console.log('  真实估算 ≈', realEstMB.toFixed(2), 'MB（term 表 ' + (estTerm / 1024 / 1024).toFixed(2) + ' + postings ' + (estPairs / 1024 / 1024).toFixed(2) + '）');

  const lat = [];
  for (let i = 0; i < RUNS; i++) { const t0 = performance.now(); deserialize(ser.path); lat.push(performance.now() - t0); }
  const R = pct(lat, 0.5), R95 = pct(lat, 0.95);
  console.log('  读回 p50 =', R.toFixed(1), 'ms   p95 =', R95.toFixed(1), 'ms');
  const d1 = deserialize(ser.path);
  console.log('    其中 raw read  =', d1.t.rawRead.toFixed(1), 'ms');
  console.log('         checksum  =', d1.t.checksum.toFixed(1), 'ms');
  console.log('         decode    =', d1.t.decode.toFixed(1), 'ms');
  console.log('         Map 重建  =', d1.t.mapRebuild.toFixed(1), 'ms');
  console.log('');
  check('热读回 < 建索引 p50', R < B, '读回 ' + R.toFixed(1) + ' vs 建索引 ' + B.toFixed(0));
  console.log('  ⇒ 真实净省 ≈', (B - R).toFixed(0), 'ms（' + ((B - R) / B * 100).toFixed(0) + '% of 建索引）');
  console.log('');

  // ═══ 5 · 逐位一致性（红队要求：全量 + 边界 k）═══
  console.log('── 5 · 逐位一致性 ──');
  // 注意：本原型未还原真实 postings（索引在闭包里取不到），
  //       所以这里验的是"格式往返 + 校验"是否无损，真实打分一致性要等接线版。
  const idsA = DOCS.map((d) => String(d.id));
  const idsB = deserialize(ser.path).ids;
  check('ids 顺序与内容逐位一致', JSON.stringify(idsA) === JSON.stringify(idsB), 'n=' + idsA.length);
  check('docCount 一致', idsB.length === SNAP.docCount);
  console.log('  ⚠️ 打分一致性：本原型 postings 为等量模拟，**真实打分逐位回放未做**（索引结构在闭包内）');
  console.log('     接线版必须补：全量k / k=0 / k>N / adaptive 12·24·30·35 / 平分 / 长posting');
  console.log('');

  // ═══ 5.5 · 确定性基线 + k 边界（红队 P1）：接线版逐位回放的前提 ═══
  console.log('');
  console.log('── 5.5 · 确定性与 k 边界 ──');
  {
    const a2 = createBm25Index(DOCS, tok);
    const b2 = createBm25Index(DOCS, tok);
    let same = true;
    for (const q of ['记忆系统', '检索 延迟', '插件', 'a', '', 'zzzz不存在']) {
      if (JSON.stringify(searchBm25(a2, q, 10)) !== JSON.stringify(searchBm25(b2, q, 10))) same = false;
    }
    check('两次独立建索引，结果逐位一致（确定性前提）', same);
    const bounds = [];
    for (const k of [0, 1, 10, 30, 35, DOCS.length, DOCS.length * 2]) {
      try { bounds.push([k, searchBm25(a2, '记忆', k).length]); } catch (e) { bounds.push([k, 'ERR']); }
    }
    check('k 边界不抛错（0 / 1 / adaptive / N / >N）', bounds.every((x) => x[1] !== 'ERR'),
      bounds.map((x) => x[0] + '→' + x[1]).join(' '));
  }

  // ═══ 6 · 损坏拒绝 ═══
  console.log('── 6 · 损坏必须被拒绝 ──');
  const bad1 = join(TMP, 'trunc.bin');
  writeFileSync(bad1, ser.file.subarray(0, ser.file.length - 40));
  let e1 = null; try { deserialize(bad1); } catch (e) { e1 = e.message; }
  check('截断文件被拒', !!e1, e1);

  const corrupt = Buffer.from(ser.file);
  corrupt[ser.bodyOffset + 100] = corrupt[ser.bodyOffset + 100] ^ 0xff;
  const bad2 = join(TMP, 'corrupt.bin');
  writeFileSync(bad2, corrupt);
  let e2 = null; try { deserialize(bad2); } catch (e) { e2 = e.message; }
  check('内容篡改被 checksum 拒绝', !!e2, e2);

  const bad3 = join(TMP, 'magic.bin');
  const m = Buffer.from(ser.file); m[0] = 0;
  writeFileSync(bad3, m);
  let e3 = null; try { deserialize(bad3); } catch (e) { e3 = e.message; }
  check('magic 错误被拒', !!e3, e3);
  console.log('');

  // ═══ 7 · 代际 CAS 演示（红队 P0-2）═══
  console.log('── 7 · 代际 CAS ──');
  const gA = 'gA-100', gB = 'gB-200';
  const fA = serialize(idx, DOCS, TMP, gA);
  const committed = { gen: gA, path: fA.path };
  // 模拟：A 落盘任务晚于 B 完成
  const fB = serialize(idx, DOCS, TMP, gB);
  const currentGen = gB;
  function tryCommit(gen, path) {
    if (gen !== currentGen) return { committed: false, reason: 'stale generation ' + gen + ' != ' + currentGen };
    committed.gen = gen; committed.path = path; return { committed: true };
  }
  const rA = tryCommit(gA, fA.path);
  check('旧代际写入被 CAS 拒绝', rA.committed === false, rA.reason);
  const rB = tryCommit(gB, fB.path);
  check('当前代际写入通过', rB.committed === true, 'gen=' + committed.gen);
  console.log('');

  // ═══ 汇总 ═══
  console.log('════ 原型结论 ════');
  console.log('文件大小      ', sizeMB.toFixed(2), 'MB');
  console.log('建索引 p50    ', B.toFixed(0), 'ms');
  console.log('热读回 p50    ', R.toFixed(1), 'ms  (p95 ' + R95.toFixed(1) + ')');
  console.log('真实净省      ', (B - R).toFixed(0), 'ms');
  console.log('失败项        ', FAILS.length === 0 ? '无' : FAILS.join(', '));
  process.exitCode = FAILS.length === 0 ? 0 : 1;
} finally {
  try { rmSync(TMP, { recursive: true, force: true }); } catch {}
}
