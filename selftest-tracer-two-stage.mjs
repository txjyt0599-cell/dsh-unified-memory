/**
 * selftest-tracer-two-stage.mjs —— 回溯电梯「二级降级」守护测试
 *
 * 【业主定调 2026-10-31】
 *   「改走二级降级肯定比一次跑两个好」
 *   ⇒ 一级 message_ids 精确取；失败才降级 sessionId+grep；绝不两条并跑。
 *
 * 【这条测试要证明】
 *   A. resolveSourceRef 优先级：有 message_ids 就先报它（改前是 sessionId 占死）
 *   B. 一级能命中：按 id 精确取回原文，backend='verbatim-index'
 *   C. 一级失败能降级：id 查不到时，退回 sessionId+grep（backend 不是 verbatim-index）
 *   D. 只跑一条路：一级命中时，不走 grep 通道
 *   E. 无 id 无 sessionId 时明确 unresolved，不伪装命中
 */
import { readFileSync, readdirSync } from "node:fs";

// [开源端] 路径从脚本自身位置推导，不硬编码任何人的机器
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
const ROOT_DIR = dirname(fileURLToPath(import.meta.url));
const LIB = ROOT_DIR + "/lib";

const T = await import("file:///" + LIB + "/retrieval/source-tracer.js");
const V = await import("file:///" + LIB + "/ingest/verbatim-lookup.js");
const { dataPath } = await import("file:///" + LIB + "/paths.js");

let pass = 0, fail = 0, skip = 0;
const fails = [];
function check(name, ok, detail) {
  if (ok) { pass++; console.log("  PASS " + name + (detail ? "   " + detail : "")); }
  else { fail++; fails.push(name); console.log("  FAIL " + name + (detail ? "   " + detail : "")); }
}
// [开源端] 纯净安装没有任何用户会话数据 ⇒ 依赖真实数据的断言应 SKIP 而非 FAIL
function skipCheck(name, reason) {
  skip++;
  console.log("  SKIP " + name + (reason ? "   " + reason : ""));
}

console.log("═══ 回溯电梯 · 二级降级守护测试 ═══");
console.log("");

// ── A. 优先级 ──
console.log("【A】resolveSourceRef 优先级：message_ids 必须先");
const cardBoth = { id: "c1", sessionId: "session-abc", source_message_ids: ["m1", "m2"] };
const r1 = T.resolveSourceRef(cardBoth);
check("两者都有时报 message_ids", r1.kind === "message_ids", "kind=" + r1.kind);
check("同时带回 sessionId 供降级", r1.sessionId === "session-abc");

const cardSidOnly = { id: "c2", sessionId: "session-abc" };
const r2 = T.resolveSourceRef(cardSidOnly);
check("只有 sessionId 时报 session", r2.kind === "session");

const cardIdOnly = { id: "c3", source_message_ids: ["m9"] };
const r3 = T.resolveSourceRef(cardIdOnly);
check("只有 message_ids 时也 resolvable", r3.resolved === true && r3.kind === "message_ids");

const r4 = T.resolveSourceRef({ id: "c4" });
check("都没有时 unresolved（不伪装命中）", r4.resolved === false && r4.kind === "legacy_unresolved");

// ── 取真实数据 ──
V.buildVerbatimIndex();
const st = V.verbatimStats();
console.log("");
console.log("  索引: " + st.messages + " 条 / " + st.sessions + " 会话");

let realIds = [], realSid = "", realText = "";
try {
  const d = dataPath("ingest/conversations");
  const files = readdirSync(d).filter((f) => f.endsWith(".jsonl")).sort();
  const lines = readFileSync(d + "/" + files[files.length - 1], "utf8").split("\n").filter(Boolean);
  const bucket = [];
  for (const line of lines) {
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.id && String(o.role) === "user") {
      if (!realSid) realSid = String(o.sessionId || o.sessionKey || "");
      if (!realText) realText = String(o.content || "");
      bucket.push(String(o.id));
      if (bucket.length >= 3) break;
    }
  }
  realIds = bucket;
} catch {}
const hasReal = realIds.length > 0 && !!realSid;
if (hasReal) check("取到真实 id + sessionId", true, "ids=" + realIds.length);
else skipCheck("取到真实 id + sessionId", "纯净端无会话数据");

// ── B. 一级命中 ──
console.log("");
console.log("【B】一级精确取（backend 必须是 verbatim-index）");
if (realIds.length) {
  const hit = T.traceSourceSnippets({ sessionId: realSid, messageIds: realIds, maxSnippets: 3 });
  check("一级命中 status=hit", hit.status === "hit", "status=" + hit.status);
  check("backend=verbatim-index", hit.backend === "verbatim-index", "backend=" + hit.backend);
  check("拿回原文片段", hit.snippets.length > 0, "n=" + hit.snippets.length);
  check("片段含真实原话", hit.snippets.some((s) => s.includes(realText.slice(0, 8))));
  check("一级很快（<200ms）", hit.elapsedMs < 200, hit.elapsedMs + "ms");

  // ── D. 只跑一条路：一级命中时不走 grep ──
  const withGrep = T.traceSourceSnippets({ sessionId: realSid, messageIds: realIds, grep: "完全不匹配的词zzz", maxSnippets: 3 });
  // 传了 grep ⇒ 一级内部会用 grep 过滤 id 里的内容；若都不匹配，一级空 ⇒ 降级
  // 这是设计内的：有 grep 就按 grep 筛
  check("传 grep 时按 grep 过滤（不匹配则降级）", withGrep.backend !== "verbatim-index" || withGrep.matches > 0,
    "backend=" + withGrep.backend + " matches=" + withGrep.matches);
}

// ── C. 一级失败能降级 ──
console.log("");
console.log("【C】一级失败必须降级（不能直接失败）");
const badId = ["00000000-0000-0000-0000-000000000000"];
const degraded = T.traceSourceSnippets({ sessionId: realSid, messageIds: badId, grep: "的", maxSnippets: 2 });
check("id 查不到时不报 verbatim-index", degraded.backend !== "verbatim-index", "backend=" + degraded.backend);
check("降级后仍尝试了二级（有 status）", !!degraded.status, "status=" + degraded.status);

// ── E. 边界 ──
console.log("");
console.log("【E】边界");
const noSidNoId = T.traceSourceSnippets({ grep: "x" });
check("无 id 无 sessionId → no_session_id", noSidNoId.status === "no_session_id", noSidNoId.status);

const emptyIds = T.traceSourceSnippets({ sessionId: realSid, messageIds: [], grep: "的" });
check("空 id 数组不崩且走二级", emptyIds.backend !== "verbatim-index", "backend=" + emptyIds.backend);

// ── 源码层：确认没有「两条并跑」 ──
console.log("");
console.log("【F】结构纪律：一级命中必须 early-return");
const src = readFileSync(LIB + "/retrieval/source-tracer.js", "utf8");
const idxOne = src.indexOf("一级：按 message_ids 精确取原文");
const idxReturn = src.indexOf("backend: 'verbatim-index'");
const idxTwo = src.indexOf("通道 A：本地活跃纯文本会话池");
check("一级在二级之前", idxOne > 0 && idxTwo > idxOne, "一级@" + idxOne + " 二级@" + idxTwo);
check("一级命中处有 return（不落到二级）", idxReturn > idxOne && idxReturn < idxTwo);

console.log("");
console.log("════ SUMMARY ════");
console.log("  passed=" + pass + "  failed=" + fail + (skip ? "  skipped=" + skip : ""));
if (fail) console.log("  失败: " + fails.join(" / "));
if (skip) console.log("  （SKIP = 依赖真实会话数据的断言，纯净安装下预期跳过）");
console.log(fail === 0 ? "  ✅ 二级降级链路已立住" : "  ❌ 未立住");
process.exit(fail === 0 ? 0 : 1);
