/**
 * selftest-verbatim-anchor.mjs —— 原文锚点（source_message_ids + verbatim）守护测试
 *
 * 【为什么有它】
 *   卡片是「抽取式」，可读性实测只有 49-74%（「谁」只有 56%）。
 *   修法：给卡加两样东西
 *     ① source_message_ids  指针 → 能按 id 回查原文（原文 99.8% 仍在 conversations）
 *     ② verbatim            内联原话片段 → 不依赖外部文件
 *
 * 【这条测试要证明什么】
 *   A. 取值规则：verbatim 必须优先「用户的实质发言」，不能是纯语气词/助手口癖
 *   B. 指针可用：写进去的 id，能用 verbatim-lookup 真的查回原文
 *   C. 隐私边界：不含 id 的卡不会崩，回退到 inline
 *   D. 查不到就 null，绝不猜（与 framestore「宁慢勿错」同一条）
 */
import { readFileSync, readdirSync } from "node:fs";

// [开源端] 路径从脚本自身位置推导，不硬编码任何人的机器
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
const ROOT_DIR = dirname(fileURLToPath(import.meta.url));
const LIB = ROOT_DIR + "/lib";

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

console.log("═══ 原文锚点 · 守护测试 ═══");
console.log("");

// ── A. verbatim 取值规则（复刻 distill 里的实现）──
console.log("【A】verbatim 取材规则");
function pickVerbatim(fresh) {
  const isMeaningful = (m) => {
    const t = String(m && m.content || "").replace(/\s+/g, " ").trim();
    if (t.length < 6) return false;
    if (/^[\u4e00-\u9fa5]{2,4}[~～!！…]{1,3}/.test(t) && t.length < 20) return false;
    return true;
  };
  const users = fresh.filter((m) => String(m.role) === "user" && isMeaningful(m));
  const anys = fresh.filter(isMeaningful);
  const pick = users.length ? users[users.length - 1] : (anys.length ? anys[0] : null);
  if (!pick) return "";
  return String(pick.content).replace(/\s+/g, " ").trim().slice(0, 30);
}

check("优先取 user 发言",
  pickVerbatim([
    { role: "assistant", content: "我先查一下真实路径再下结论" },
    { role: "user", content: "原文这么多被删不太可能，你是不是查错路径了" },
  ]) === "原文这么多被删不太可能，你是不是查错路径了");

check("跳过纯语气词（<6 字）",
  pickVerbatim([
    { role: "user", content: "好" },
    { role: "user", content: "动手吧" },
    { role: "user", content: "这个方向要重新评估一下" },
  ]) === "这个方向要重新评估一下");

check("跳过助手口癖开头的发言",
  pickVerbatim([
    { role: "assistant", content: "哎呀呀~（站起来）好，动手" },
    { role: "assistant", content: "索引建成四万六千条消息" },
  ]) === "索引建成四万六千条消息");

check("截断到 30 字", pickVerbatim([
  { role: "user", content: "这是一段很长很长很长很长很长很长很长很长很长很长很长很长很长的原话内容" },
]).length === 30);

check("全无实质内容时返回空串",
  pickVerbatim([{ role: "user", content: "好" }, { role: "assistant", content: "哎呀呀~" }]) === "");

// ── B. 指针可用：真实数据端到端 ──
console.log("");
console.log("【B】指针回查（真实 conversations 数据）");
const st = V.buildVerbatimIndex();
const hasData = st.messages > 0;
if (hasData) check("索引建起来了", st.messages > 1000, st.messages + " 条消息 / " + st.sessions + " 会话");
else skipCheck("索引建起来了", "纯净端无会话数据（" + st.dirs + " 个目录）");

// 从索引里挑一条真实 id
let realId = "", realContent = "";
try {
  const d = dataPath("ingest/conversations");
  const files = readdirSync(d).filter((f) => f.endsWith(".jsonl")).sort();
  if (files.length) {
    const lines = readFileSync(d + "/" + files[files.length - 1], "utf8").split("\n").filter(Boolean);
    for (const line of lines) {
      let o; try { o = JSON.parse(line); } catch { continue; }
      if (o.id && String(o.role) === "user") { realId = String(o.id); realContent = String(o.content); break; }
    }
  }
} catch {}
if (realId) check("取到真实 user 消息 id", true, realId.slice(0, 36));
else skipCheck("取到真实 user 消息 id", "纯净端无会话数据");

if (realId) {
  const got = V.lookupOne(realId);
  check("按 id 查回原文", !!got && got.content === realContent,
    got ? "内容一致" : "未命中");

  const r = V.resolveCardVerbatim({ source_message_ids: [realId] });
  check("resolveCardVerbatim 走 pointer 路径", r.ok && r.source === "pointer", "source=" + r.source);
  check("返回的全文含原文", String(r.full).includes(realContent.slice(0, 10)));
}

// ── C. 隐私/降级边界 ──
console.log("");
console.log("【C】降级边界");
const noId = V.resolveCardVerbatim({ verbatim: "只有内联片段没有指针" });
check("无指针时回退 inline", noId.ok && noId.source === "inline", "source=" + noId.source);

const emptyCard = V.resolveCardVerbatim({});
check("空卡不崩且返回 none", emptyCard.ok === false && emptyCard.source === "none");

const badId = V.resolveCardVerbatim({ source_message_ids: ["不存在的id"], verbatim: "兜底片段" });
check("指针失效时回退 verbatim", badId.ok && badId.source === "inline");

// ── D. 查不到就是 null，不猜 ──
console.log("");
console.log("【D】查不到不猜");
check("不存在的 id → null", V.lookupOne("00000000-0000-0000-0000-000000000000") === null);
check("空 id → null", V.lookupOne("") === null);
check("null 入参不崩", V.lookupOne(null) === null);

// ── 汇总 ──
console.log("");
console.log("════ SUMMARY ════");
console.log("  passed=" + pass + "  failed=" + fail + (skip ? "  skipped=" + skip : ""));
if (fail) console.log("  失败: " + fails.join(" / "));
if (skip) console.log("  （SKIP = 依赖真实会话数据的断言，纯净安装下预期跳过）");
console.log(fail === 0 ? "  ✅ 原文锚点链路已立住" : "  ❌ 未立住");
process.exit(fail === 0 ? 0 : 1);
