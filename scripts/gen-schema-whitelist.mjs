#!/usr/bin/env node
/**
 * gen-schema-whitelist.mjs —— 生成真实字段白名单（只读）
 * [2026-10-31 by Assistant · 阶段〇 0.2]
 *
 * 目的：终结「引用不存在字段」这类事故。
 *   eventTs 被三方会审集体当成幻觉字段，实际是**分库覆盖**：
 *     主库 engram-relay = 0%，自产蒸馏卡 = 27.9%
 *   turnCount 才是真正的幻影字段（24.8 万条记录里 0 次作为字段键）。
 *
 * 因此白名单必须记三件事，而不只是「存不存在」：
 *   ① 哪个库  ② 覆盖率  ③ 语义/时间口径
 *
 * 用法：PM_DATA_ROOT=<数据根> node scripts/gen-schema-whitelist.mjs [--out <路径>]
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const REPO = new URL('..', import.meta.url).pathname.replace(/^\//, '');
const LIB = 'file:///' + REPO.replace(/^\/+/, '') + 'lib/';
const { dataPath } = await import(LIB + 'paths.js');

const outIdx = process.argv.indexOf('--out');
const OUT = outIdx >= 0 ? process.argv[outIdx + 1] : 'schema-whitelist.json';

const ROOT = dataPath("");
function scanJsonl(file) {
  const stat = {};
  let n = 0;
  let raw;
  try { raw = readFileSync(file, "utf8"); } catch { return null; }
  for (const line of raw.split('\n')) {
    if (!line) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (!o || typeof o !== "object" || Array.isArray(o)) continue;
    n++;
    for (const k of Object.keys(o)) {
      if (!stat[k]) stat[k] = { present: 0, nonEmpty: 0 };
      stat[k].present++;
      const v = o[k];
      const empty = v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0);
      if (!empty) stat[k].nonEmpty++;
    }
  }
  return { n, stat };
}

const POOLS = [
  { name: "engram-relay", label: "主库（engram）", file: dataPath("engram-relay/engrams.jsonl") },
  { name: "ingest", label: "自产蒸馏卡", file: dataPath("ingest/engrams.jsonl") },
  { name: "hypergraph-topics", label: "超图 topic", file: dataPath("hypergraph/topics.jsonl") },
  { name: "hypergraph-ordinary", label: "超图 ordinary", file: dataPath("hypergraph/ordinary.jsonl") },
];

const out = { generatedAt: new Date().toISOString(), dataRoot: ROOT, pools: {} };
console.log("════ 字段白名单生成 ════");
console.log("数据根:", ROOT);
console.log("");

for (const p of POOLS) {
  if (!existsSync(p.file)) { console.log(p.label, "→ 文件不存在，跳过"); continue; }
  const r = scanJsonl(p.file);
  if (!r) { console.log(p.label, "→ 读取失败"); continue; }
  const fields = {};
  for (const [k, v] of Object.entries(r.stat)) {
    fields[k] = { present: v.present, nonEmpty: v.nonEmpty, coverage: Number((v.nonEmpty / r.n * 100).toFixed(1)) };
  }
  out.pools[p.name] = { label: p.label, file: p.file, records: r.n, fields };
  const top = Object.entries(fields).sort((a, b) => b[1].coverage - a[1].coverage).slice(0, 8);
  console.log(p.label + "  " + r.n + " 条");
  top.forEach(([k, v]) => console.log("   " + k.padEnd(26) + String(v.coverage).padStart(6) + "%"));
  console.log("");
}

// ── 跨库交叉判定：同名不同覆盖率，正是 eventTs 事故的根源 ──
out.crossPool = {};
const allKeys = new Set();
for (const p of Object.values(out.pools)) for (const k of Object.keys(p.fields)) allKeys.add(k);
for (const k of allKeys) {
  const row = {};
  let min = 101, max = -1;
  let missingIn = 0;
  for (const [name, p] of Object.entries(out.pools)) {
    const f = p.fields[k];
    row[name] = f ? f.coverage : null;
    if (f) { min = Math.min(min, f.coverage); max = Math.max(max, f.coverage); }
    else missingIn++;   // 该库连这个键都没有
  }
  // [2026-10-31 修正] 原判据只看 max-min，漏掉了「一个库有、另一个库压根没这个键」。
  //   eventTs 正是这一种：主库不存在，自产卡 28.3% ⇒ 差异算不出来，被静默放过。
  //   而这恰恰是最危险的情形（分库覆盖），必须进表。
  if ((max - min >= 20) || (max > 0 && missingIn > 0)) out.crossPool[k] = row;
}

writeFileSync(OUT, JSON.stringify(out, null, 2) + "\n", "utf8");
console.log("已写出:", OUT);
console.log("");
console.log("=== 跨库覆盖率差异 ≥20% 的字段（必须按库分别引用）===");
const cross = Object.entries(out.crossPool);
if (!cross.length) console.log("  (无)");
else for (const [k, row] of cross) console.log("  " + k.padEnd(22) + JSON.stringify(row));