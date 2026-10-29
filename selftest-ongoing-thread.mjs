/**
 * selftest-ongoing-thread.mjs —— P1 体温交接可用性验收（2026-10-28）
 *
 * ## 治什么病
 * 原实现把写盘塞在 runDistill 主体里，而 runDistill 在 llm:off 时第 429 行就返回；
 * ingest 的 kickDistill 更是连 LLM 通道都没有就 return。
 * ⇒ 本机 llm:off 期间，ongoing-thread.json **结构性地永不更新**。
 * 实证：文件停在 11:04，而 11:30 之后已经跑了两轮。
 *
 * ## 反例（照淋雨家 P2 铁律：反例不报 = 检查是假的）
 *   B1：拿掉 LLM 通道调 runDistill ⇒ 必须 reason='no-llm'
 *   B2：但 writeOngoingThread **照样必须写成功** —— 这正是"解耦"的证据
 *   C1：没有 user 消息 ⇒ 必须 ok=false 且不写盘（不能凭空编一条交接）
 */
import { readFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const LIB = "D:/dsh-plugins/dsh-unified-memory/lib";
let pass = 0, fail = 0;
const fails = [];
function check(group, name, ok, detail) {
  if (ok) { pass++; console.log("  PASS " + name + (detail ? "   " + detail : "")); }
  else { fail++; fails.push(name); console.log("  FAIL " + name + (detail ? "   " + detail : "")); }
}

const dm = await import("file:///" + LIB + "/ingest/distill.js");
console.log("════ ONGOING-THREAD SELFTEST · P1 体温交接 ════");

const root = mkdtempSync(join(tmpdir(), "ot-"));

// ── A · 正常写盘 ──
console.log("\n── A · 正常写 ──");
const fresh = [
  { role: "user", content: "Assistant，把记忆系统的 P1 交接做一下，下一步做 verify" },
  { role: "assistant", content: "好的User，Assistant先看清楚它为什么没更新。" },
];
const w1 = dm.writeOngoingThread({ root, fresh, sessionId: "sess-A", eventTs: 111, nowIso: "2026-10-28T00:00:00Z" });
check("A", "A1 写入成功", w1.ok === true, JSON.stringify(w1));
const f1 = join(root, "ongoing-thread.json");
check("A", "A2 文件真的落盘了", existsSync(f1));
let j1 = null;
try { j1 = JSON.parse(readFileSync(f1, "utf8")); } catch { /* 下面报 */ }
check("A", "A3 是合法 JSON", !!j1);
check("A", "A4 pending 取自最后一条 user", !!(j1 && j1.pending && j1.pending.indexOf("P1 交接") >= 0), j1 && j1.pending);
check("A", "A5 vibe 取自最后一条 assistant", !!(j1 && j1.vibe && j1.vibe.indexOf("没更新") >= 0), j1 && j1.vibe);
check("A", "A6 next 抓到「下一步」线索", !!(j1 && j1.next && j1.next.indexOf("下一步") >= 0), j1 && j1.next);
check("A", "A7 chars 与实际正文一致", !!(j1 && j1.chars === (j1.pending + j1.vibe + j1.next).length), j1 && ("chars=" + j1.chars));
check("A", "A8 只含三要素（没有额外字段爆炸）", !!(j1 && Object.keys(j1).length <= 8), j1 && Object.keys(j1).join(","));

// ── B · 核心：没有 LLM 也必须能写（这就是修复点）──
console.log("\n── B · 无 LLM 通道（本次修复的核心）──");
const rNoLlm = await dm.runDistill({ llm: null, opts: { root, minDistillMessages: 1, disableLock: true } });
check("B", "B1 runDistill 无 LLM 时确实直接返回 no-llm", rNoLlm && rNoLlm.reason === "no-llm", JSON.stringify(rNoLlm));
const w2 = dm.writeOngoingThread({ root, fresh, sessionId: "sess-B", eventTs: 222, nowIso: "2026-10-28T01:00:00Z" });
check("B", "B2 **同一条件下 writeOngoingThread 照样写成功**（解耦证据）", w2.ok === true, JSON.stringify(w2));
let j2 = null;
try { j2 = JSON.parse(readFileSync(f1, "utf8")); } catch { /* */ }
check("B", "B3 盘上内容已更新到第二次", !!(j2 && j2.sessionId === "sess-B" && j2.eventTs === 222), j2 && (j2.sessionId + "/" + j2.eventTs));

// ── C · 反例：没有 user 消息不许凭空造 ──
console.log("\n── C · 反例 ──");
const before = existsSync(f1) ? readFileSync(f1, "utf8") : "";
const w3 = dm.writeOngoingThread({ root, fresh: [{ role: "assistant", content: "只有 AI 自己在说话" }], sessionId: "sess-C" });
check("C", "C1 无 user 消息时 ok=false", w3.ok === false && w3.reason === "no-user", JSON.stringify(w3));
const after = existsSync(f1) ? readFileSync(f1, "utf8") : "";
check("C", "C2 且没有覆盖已有文件（不许把上一次的好数据写坏）", before === after);
const w4 = dm.writeOngoingThread({ root, fresh: [] });
check("C", "C3 空数组同样不写", w4.ok === false);
const w5 = dm.writeOngoingThread({ root, fresh: null });
check("C", "C4 null fresh 不抛", w4 !== null && w5.ok === false);
let threw = false;
try { dm.writeOngoingThread({}); } catch { threw = true; }
check("C", "C5 无参数不抛", threw === false);

// ── D · 截断纪律（≤100 字意图）──
console.log("\n── D · 截断纪律 ──");
const longFresh = [
  { role: "user", content: "这是一句特别特别长的话".repeat(30) },
  { role: "assistant", content: "AI 也说了很长很长的话".repeat(30) },
];
const w6 = dm.writeOngoingThread({ root, fresh: longFresh, sessionId: "sess-D" });
const j6 = JSON.parse(readFileSync(f1, "utf8"));
check("D", "D1 超长输入仍能写", w6.ok === true);
check("D", "D2 pending ≤46 字", j6.pending.length <= 46, "len=" + j6.pending.length);
check("D", "D3 vibe ≤34 字", j6.vibe.length <= 34, "len=" + j6.vibe.length);
check("D", "D4 总量 ≤100 字（含 next）", j6.chars <= 100, "chars=" + j6.chars);

// ── E · 脏数据清洗（实测抓到过 HTML 卡片碎片混进 vibe）──
console.log("\n── E · 清洗 ──");
const dirtyFresh = [
  { role: "user", content: "把这事做完" },
  { role: "assistant", content: '**成功了!两处现在解析到完全同一个文件。** <div id="vcp-root" style="background:#fffaf2"><span class="badge">徽章</span></div> 后面还有正常的话' },
];
const w7 = dm.writeOngoingThread({ root, fresh: dirtyFresh, sessionId: "sess-E" });
const j7 = JSON.parse(readFileSync(f1, "utf8"));
check("E", "E1 清洗后仍能写", w7.ok === true);
check("E", "E2 vibe 里没有 HTML 标签", !/<[a-zA-Z\/]/.test(j7.vibe), JSON.stringify(j7.vibe));
check("E", "E3 vibe 里没有 markdown 星号", j7.vibe.indexOf("**") < 0, JSON.stringify(j7.vibe));
check("E", "E4 vibe 保留了人话", j7.vibe.indexOf("成功了") >= 0, JSON.stringify(j7.vibe));
check("E", "E5 长度仍受限 ≤34", j7.vibe.length <= 34, "len=" + j7.vibe.length);

try { rmSync(root, { recursive: true, force: true }); } catch { /* 清理失败不影响结论 */ }

console.log("\n════ SUMMARY ════");
console.log("  pass=" + pass + " fail=" + fail);
if (fail) console.log("  失败项: " + fails.join(" | "));
process.exit(fail ? 1 : 0);
