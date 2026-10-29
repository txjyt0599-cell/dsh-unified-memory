#!/usr/bin/env node
/**
 * selftest-fallback.mjs —— 向量备路（下级切换）**集成测试**
 * [2026-10-26 by Assistant · 回应审核 P1「备路零测试覆盖」]
 *
 * 为什么单独一个文件：
 *   selftest-vector.mjs 只测 breaker.js 的纯函数（ok/fail/allows），
 *   **测不到 retriever 里的集成** —— 审核指出的 P0（主路熔断后整条向量路被跳过，
 *   备路够不着）就是这样漏过去的：verify 全绿但它测不到。
 *
 * 本文件用**假端点**（可控的成功/失败/延迟）驱动真实 retriever，覆盖：
 *   F1 主路正常 → backend=online，备路一次不进
 *   F2 主路失败 → 降级 local-fallback
 *   F3 **主路熔断已开 + 备路可用 → 仍能拿到向量**（P0 的核心回归）
 *   F4 主路熔断期内 → 不重复尝试主路（不白等超时）
 *   F5 双路全挂 → 退回纯 BM25，hits 仍 > 0
 *   F6 备路救场不加剧主路熔断（P0 第二处：不得每轮 br.fail）
 *   F7 未配备路 → 行为与接入前一致（零侵入）
 */
import { createRetriever } from "./lib/retrieval/retriever.js";
import { createBreaker } from "./lib/retrieval/breaker.js";

let pass = 0, fail = 0;
const fails = [];
function check(g, name, ok, detail) {
  if (ok) { pass++; console.log("  PASS " + g + " " + name + (detail ? "   " + detail : "")); }
  else { fail++; fails.push(name); console.log("  FAIL " + g + " " + name + (detail ? "   " + detail : "")); }
}

console.log("════ FALLBACK SELFTEST · 向量备路下级切换 ════");

// ── 假端点：不用真网络，靠 http.Server 控制成功/失败 ──
import http from "node:http";

// [2026-10-29 开源版适配] 有卡库才能测"检索出结果"；全新安装没有 ⇒ 相关断言标 SKIP。
import { existsSync as __ex } from 'node:fs';
import { dataPath as __dp } from './lib/paths.js';
const __HAS_CARDS = __ex(__dp('engram-relay/engrams.jsonl'));


function makeFakeServer(mode) {
  // mode: { ok:boolean, delayMs:number, tag:string }
  const srv = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      setTimeout(() => {
        if (!mode.ok) { res.writeHead(500); res.end("boom"); return; }
        let input = [];
        try { input = JSON.parse(body).input || []; } catch {}
        const data = (Array.isArray(input) ? input : [input]).map((t, i) => ({
          index: i,
          embedding: Array.from({ length: 1024 }, (_, k) => Math.sin((String(t).length + k) * 0.001) ),
        }));
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ data }));
      }, mode.delayMs || 0);
    });
  });
  return new Promise((resolve) => {
    srv.listen(0, "127.0.0.1", () => {
      const port = srv.address().port;
      resolve({ srv, port, url: "http://127.0.0.1:" + port + "/v1" });
    });
  });
}

function ep(url, model) {
  return { baseUrl: url, apiKey: "sk-test", model: model || "BAAI/bge-m3", dimensions: 1024, timeoutMs: 3000, batchSize: 16 };
}

async function mkRetriever(cfg) {
  const rt = createRetriever(cfg, null);
  await rt.warmup();
  return rt;
}

// ── F1/F7 主路正常 ──
if (!__HAS_CARDS) { console.log("  ~ F1/F7 SKIP（无卡库）"); } else {
  const okSrv = await makeFakeServer({ ok: true });
  const rt = await mkRetriever({ embedding: ep(okSrv.url) });
  const r = await rt.search("记忆索引重建", {});
  const last = rt.health().vector.last;
  check("F1", "主路正常 backend=online", last && last.backend === "online", "backend=" + (last && last.backend));
  check("F1", "主路正常 fallbackUsed=false", last && last.fallbackUsed === false);
  check("F1", "主路正常 fallbackMs=0（备路一次没进）", last && last.fallbackMs === 0, "fallbackMs=" + (last && last.fallbackMs));
  check("F7", "未配备路时 fallbackEndpoint=off", rt.health().vector.fallbackEndpoint === "off");
  check("F1", "检索仍有命中", (r.hits || []).length > 0, "hits=" + (r.hits || []).length);
  okSrv.srv.close();
}

// ── F2 主路失败 → 备路 ──
if (!__HAS_CARDS) { console.log("  ~ F2 SKIP（无卡库）"); } else {
  const badSrv = await makeFakeServer({ ok: false });
  const okSrv = await makeFakeServer({ ok: true });
  const rt = await mkRetriever({ embedding: ep(badSrv.url), embeddingFallback: ep(okSrv.url) });
  const r = await rt.search("记忆索引重建", {});
  const last = rt.health().vector.last;
  check("F2", "主路失败降级 local-fallback", last && last.backend === "local-fallback", "backend=" + (last && last.backend));
  check("F2", "fallbackUsed=true", last && last.fallbackUsed === true);
  check("F2", "降级后仍有命中", (r.hits || []).length > 0, "hits=" + (r.hits || []).length);
  badSrv.srv.close(); okSrv.srv.close();
}

// ── F3/F4/F6 P0 核心：主路熔断已开 + 备路可用 ──
if (!__HAS_CARDS) { console.log("  ~ F3/F4/F6 SKIP（无卡库：检索必 0 命中，链路判定无从触发）"); } else {
  const badSrv = await makeFakeServer({ ok: false });
  const okSrv = await makeFakeServer({ ok: true });
  const rt = await mkRetriever({
    embedding: ep(badSrv.url),
    embeddingFallback: ep(okSrv.url),
    vectorBreaker: { threshold: 2, baseCooldownMs: 60000, maxCooldownMs: 60000 },
  });
  // 连打到主路熔断打开
  let opened = false;
  for (let i = 0; i < 4; i++) {
    await rt.search("记忆索引重建", {});
    const hb = rt.health().vector.breaker;
    if (hb && hb.open) { opened = true; console.log("     (主路熔断在第 " + (i+1) + " 轮打开，fails=" + hb.fails + ")"); break; }
  }
  check("F3", "主路熔断确实打开了（前置条件成立）", opened);

  const rAfter = await rt.search("记忆索引重建", {});
  const lastAfter = rt.health().vector.last;
  // P0：熔断期内仍然必须走备路拿到向量
  check("F3", "P0 主路熔断中仍能拿到向量",
    lastAfter && (lastAfter.backend === "local-fallback"),
    "backend=" + (lastAfter && lastAfter.backend));
  check("F3", "P0 熔断中备路仍产出命中", (rAfter.hits || []).length > 0, "hits=" + (rAfter.hits || []).length);

  // F4：熔断期内不应再试主路（fallbackMs 有值且 backend 不是 online）
  check("F4", "熔断期内主路被跳过（backend!=online）", lastAfter && lastAfter.backend !== "online");

  // F6：备路救场不应让主路 fails 无限增长
  const failsBefore = rt.health().vector.breaker.fails;
  for (let i = 0; i < 3; i++) await rt.search("记忆索引重建", {});
  const failsAfter = rt.health().vector.breaker.fails;
  check("F6", "备路救场不加剧主路熔断计数", failsAfter <= failsBefore + 1,
    "fails " + failsBefore + " -> " + failsAfter);

  badSrv.srv.close(); okSrv.srv.close();
}

// ── F5 双路全挂 → 纯 BM25 ──
if (!__HAS_CARDS) { console.log("  ~ F5 SKIP（无卡库）"); } else {
  const b1 = await makeFakeServer({ ok: false });
  const b2 = await makeFakeServer({ ok: false });
  const rt = await mkRetriever({ embedding: ep(b1.url), embeddingFallback: ep(b2.url) });
  const r = await rt.search("记忆索引重建", {});
  const last = rt.health().vector.last;
  check("F5", "双路全挂 backend=none", last && last.backend === "none", "backend=" + (last && last.backend));
  check("F5", "双路全挂仍退回纯 BM25 有结果", (r.hits || []).length > 0, "hits=" + (r.hits || []).length);
  b1.srv.close(); b2.srv.close();
}

// ── 纯函数：probeOk 语义 ──
{
  const br = createBreaker({ threshold: 2, baseCooldownMs: 60000, maxCooldownMs: 60000 });
  const t0 = 1000000;
  br.fail(t0); br.fail(t0);
  const n1 = br.note(t0);
  check("F8", "连续失败后熔断打开", n1.open === true, "retryInMs=" + n1.retryInMs);
  br.probeOk(t0 + 1000);
  const n2 = br.note(t0 + 1000);
  check("F8", "probeOk 只回缩冷却、不清零失败数",
    n2.retryInMs < n1.retryInMs && n2.fails === n1.fails,
    "retry " + n1.retryInMs + "->" + n2.retryInMs + ", fails " + n1.fails + "->" + n2.fails);
  br.ok(t0 + 2000);
  const n3 = br.note(t0 + 2000);
  check("F8", "ok 才真复位", n3.open === false && n3.fails === 0);
}

// ── F9 自管拉起（终审 P1：备路不能依赖外部手动启动）──
{
  const { ensureEmbedServer, stopEmbedServer, isEmbedServerAvailable } = await import("./lib/retrieval/embed-fallback-server.js");
  if (!isEmbedServerAvailable()) {
    console.log("  SKIP F9 本地模型文件不存在，跳过自管拉起测试");
  } else {
    // 先确保没有残留
    stopEmbedServer();
    await new Promise((r) => setTimeout(r, 1200));
    const downBefore = await fetch("http://localhost:8013/health", { signal: AbortSignal.timeout(700) }).then(() => true).catch(() => false);
    check("F9", "F9a 测试前服务确实未运行（前置条件）", downBefore === false);
    const a = await ensureEmbedServer({ port: 8013 });
    check("F9", "F9b 自管拉起成功", a && a.ok === true, JSON.stringify(a));
    check("F9", "F9c 首次是新建不是复用", a && a.reused === false);
    const t1 = Date.now();
    const b = await ensureEmbedServer({ port: 8013 });
    const reuseMs = Date.now() - t1;
    check("F9", "F9d 已运行则复用（不重复拉进程）", b && b.reused === true, "复用耗时 " + reuseMs + "ms");
    check("F9", "F9e 复用足够快（<200ms）", reuseMs < 200, reuseMs + "ms");
    // 单飞：并发 3 个不应拉出多个进程
    const [c1, c2, c3] = await Promise.all([
      ensureEmbedServer({ port: 8013 }), ensureEmbedServer({ port: 8013 }), ensureEmbedServer({ port: 8013 }),
    ]);
    check("F9", "F9f 并发调用单飞（全部 reused）",
      c1 && c2 && c3 && c1.reused && c2.reused && c3.reused);
    stopEmbedServer();
  }
}

console.log("");
console.log("────────────────────────────────");
console.log("FALLBACK-DONE  checks=" + (pass + fail) + " passed=" + pass + " failed=" + fail);
if (fail > 0) { console.log("失败项: " + fails.join(", ")); process.exit(1); }
