#!/usr/bin/env node
/**
 * make-pilot-set.mjs —— 生成 30 条 pilot 标注样本（只读，不写数据根）
 * [2026-10-31 by Assistant · 红队六审只批准的 pilot 范围]
 *
 * 为什么是 30 不是 400：
 *   红队明确不批 400 条。先标 30 条验证「判据能不能用」，
 *   再决定要不要扩到 400。标 400 条后才发现判据不可用 = 白标。
 *
 * 分层原则（避免 30 条全是同一类）：
 *   · 好卡（importance 高 / kind=decision）
 *   · 坏卡（标题碎片 / 表格残片）
 *   · 过程噪音（kind=note + layer=session）
 *   · 兜底样本（随机）
 *
 * 用法：PM_DATA_ROOT=<数据根> node scripts/make-pilot-set.mjs [--out <文件>]
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const REPO = new URL('..', import.meta.url).pathname.replace(/^\//, '');
const LIB = 'file:///' + REPO.replace(/^\/+/, '') + 'lib/';
const { dataPath } = await import(LIB + 'paths.js');

const outIdx = process.argv.indexOf('--out');
const OUT = outIdx >= 0 ? process.argv[outIdx + 1] : 'pilot-set-30.jsonl';

const f = dataPath('engram-relay/engrams.jsonl');
if (!existsSync(f)) { console.log("找不到主库:", f); process.exit(2); }

const rows = [];
for (const line of readFileSync(f, 'utf8').split('\n')) {
  if (!line) continue;
  let o; try { o = JSON.parse(line); } catch { continue; }
  rows.push(o);
}

// ── 确定性伪随机（固定种子，任何人都能复现同一批样本）──
let seed = 20261031;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };

const RE_FRAG = /^[a-zA-Z"'\uFFFD]/;
const RE_TBL = /[|`]|<div|class=/;
const isFrag = (o) => RE_FRAG.test(String(o.title || "")) || RE_TBL.test(String(o.title || ""));
const isNote = (o) => o.kind === "note" && o.layer === "session";
const isGood = (o) => Number(o.importance) >= 0.9 && String(o.title || "").length >= 6 && !isFrag(o);

const used = new Set();
function pick(pred, n, label) {
  const pool = rows.filter((o) => pred(o) && !used.has(o.id));
  const out = [];
  while (out.length < n && pool.length) {
    const i = Math.floor(rnd() * pool.length);
    const o = pool.splice(i, 1)[0];
    used.add(o.id);
    out.push(o);
  }
  console.log("  " + label.padEnd(22) + out.length + " 条");
  return out.map((o) => ({ bucket: label, o }));
}

console.log("════ 生成 pilot 样本 ════");
console.log("总卡数:", rows.length);
console.log("分层抽样:");
const buckets = [
  ...pick(isGood, 8, "好卡(imp>=0.9)"),
  ...pick(isFrag, 8, "坏卡(碎片/残片)"),
  ...pick((o) => isNote(o) && !isFrag(o), 8, "过程噪音(note)"),
  ...pick(() => true, 6, "兜底随机"),
];

// —— 输出：带空白标注字段，供人工填写 ——
const lines = buckets.map(({ bucket, o }, i) => JSON.stringify({
  seq: i + 1,
  bucket,
  id: o.id,
  title: String(o.title || ""),
  summary: String(o.summary || "").slice(0, 200),
  content: String(o.content || "").slice(0, 300),
  kind: o.kind,
  layer: o.layer,
  importance: o.importance,
  createdAt: o.createdAt,
  eventTs: o.eventTs ?? null,          // 历史卡多半为 null，见 FIELD-AUDIT-FINAL
  label: "",                            // A / B / C / ?
  note: "",                             // 判据编号 U1/U2/U3/D1-D5
}));

writeFileSync(OUT, lines.join("\n") + "\n", "utf8");
console.log("");
console.log("已写出:", OUT, "共", lines.length, "条");
console.log("");
console.log("标注方法：");
console.log("  1. 先给它一个真实提问（模拟检索场景），记在 note 里");
console.log("  2. 按手册判 A / B / C / ?");
console.log("  3. 判据编号写 U1-U3 或 D1-D5");
console.log("  4. 拿不准就标 ?，不要硬判 —— 弃权率本身是重要指标");