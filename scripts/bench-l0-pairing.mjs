#!/usr/bin/env node
/**
 * bench-l0-pairing.mjs —— L0 配对/标题段消融（只读）
 * [2026-10-31 by Assistant · 补上消融报告里「配对 ~156ms 未拆」这一块]
 *
 * 消融报告里我写「配对+标题 ≈156ms，未拆」。本脚本把它拆开。
 * 用法：PM_DATA_ROOT=<数据根> node scripts/bench-l0-pairing.mjs
 */
import { performance } from 'node:perf_hooks';
import { readdirSync, readFileSync } from 'node:fs';

const REPO = new URL('..', import.meta.url).pathname.replace(/^\//, '');
const LIB = 'file:///' + REPO.replace(/^\/+/, '') + 'lib/';
const { buildDualAnchorTitle } = await import(LIB + 'hypergraph/l0-rounds.js');
const { dataPath } = await import(LIB + 'paths.js');

const conv = dataPath("memory-tencentdb/memory-tdai/conversations");
const files = readdirSync(conv).filter((f) => f.endsWith(".jsonl")).sort();
const since = Date.now() - 30 * 86400000, now = Date.now();

// 复刻收集（与 l0-rounds 同口径）
const bySession = new Map();
for (const name of files) {
  const pfd = Date.parse(name.slice(0, 10) + "T00:00:00Z");
  if (pfd - 8 * 3600000 + 86400000 < since) continue;
  for (const line of readFileSync(conv + "/" + name, "utf8").split("\n")) {
    if (!line) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    const sk = String(o.sessionKey || o.sessionId || "");
    const ts = o.timestamp;
    const role = String(o.role || "").toLowerCase();
    if (!sk || !Number.isFinite(ts) || ts < since || ts > now || (role !== "user" && role !== "assistant")) continue;
    const c = String(o.content || "").trim(); if (!c) continue;
    let a = bySession.get(sk); if (!a) bySession.set(sk, a = []);
    a.push({ role, content: c, ts, id: String(o.id || "") });
  }
}
let msgN = 0; for (const [, a] of bySession) msgN += a.length;
console.log("sessions =", bySession.size, " messages =", msgN);

const MERGE_HEAD = 10000, STEP_MAX = 15, STEP_KEEP_HEAD = 10, STEP_KEEP_TAIL = 5;
const STEPS_TOTAL_MAX = 3000, STEP_CLIP = 120;

// ① sort
let s = performance.now();
for (const [, a] of bySession) a.sort((x, y) => (x.ts - y.ts) || String(x.id).localeCompare(String(y.id)));
console.log("sort(ts + localeCompare) =", (performance.now() - s).toFixed(0), "ms");

// ② 扫描（只计数）
s = performance.now();
let rounds = 0;
for (const [, a] of bySession) {
  for (let i = 0; i < a.length; i++) {
    if (a[i].role !== "user" || !a[i].content) continue;
    let j = i + 1; while (j < a.length && a[j].role !== "user") j++;
    rounds++;
  }
}
console.log("扫描配对（只计数）       =", (performance.now() - s).toFixed(0), "ms   rounds =", rounds);

// ③ ansText 构造
s = performance.now();
let totalLen = 0;
for (const [, a] of bySession) {
  for (let i = 0; i < a.length; i++) {
    if (a[i].role !== "user" || !a[i].content) continue;
    const answers = [];
    let j = i + 1;
    while (j < a.length && a[j].role !== "user") { if (a[j].role === "assistant" && a[j].content) answers.push(a[j]); j++; }
    let ansText = "";
    if (answers.length === 1) ansText = answers[0].content.slice(0, MERGE_HEAD);
    else if (answers.length > 1) {
      const finalAns = answers[answers.length - 1].content;
      const allSteps = answers.slice(0, -1);
      let picked = allSteps, omitted = 0;
      if (allSteps.length > STEP_MAX) { const h = allSteps.slice(0, STEP_KEEP_HEAD), t = allSteps.slice(-STEP_KEEP_TAIL); omitted = allSteps.length - h.length - t.length; picked = h.concat(t); }
      const arr = []; let chars = 0;
      for (let k = 0; k < picked.length; k++) {
        const one = String(picked[k].content || "").replace(/\s+/g, " ").trim().slice(0, STEP_CLIP);
        const line = "[步骤" + (k + 1) + "] " + one;
        if (chars + line.length + 1 > STEPS_TOTAL_MAX) break;
        arr.push(line); chars += line.length + 1;
      }
      ansText = "【最终答复】\n" + finalAns.slice(0, MERGE_HEAD) + "\n\n【中间过程(" + allSteps.length + "步，已折叠)】\n" + arr.join("\n");
    }
    totalLen += ansText.length;
  }
}
console.log("构造 ansText            =", (performance.now() - s).toFixed(0), "ms   产出", (totalLen / 1024 / 1024).toFixed(1), "MB");

// ④ 标题
s = performance.now();
let tn = 0;
for (const [, a] of bySession) {
  for (let i = 0; i < a.length; i++) {
    if (a[i].role !== "user" || !a[i].content) continue;
    let last = "";
    let j = i + 1;
    while (j < a.length && a[j].role !== "user") { if (a[j].role === "assistant" && a[j].content) last = a[j].content; j++; }
    buildDualAnchorTitle(a[i].content, last);
    tn++;
  }
}
console.log("buildDualAnchorTitle    =", (performance.now() - s).toFixed(0), "ms   n =", tn);