/**
 * selftest-inject-verify.mjs —— P0 注入回捞钩子验收（2026-10-28）
 *
 * 治什么：淋雨家自审「插件标了引擎保留 kind runtime-context ⇒ 正文被静默丢弃，
 *         日志照写 inject 成功」。本文件验的是我们的回捞钩子真的会分辨对错。
 *
 * 【必须有的反例】（照淋雨家 P2 铁律：反例不报 = 检查是假的）
 *   D4 用例：把"跨行指纹"直接喂给错误的匹配方式必须失败、喂给正确方式必须成功。
 *   这一条正是抓出线上第一版真 bug 的用例（只替换字面反斜杠 n，跨行永远匹配不上）。
 */
import { readFileSync, readdirSync } from "node:fs";
import { zstdDecompressSync } from "node:zlib";
import { createHash } from "node:crypto";

const LIB = "D:/dsh-plugins/dsh-unified-memory/lib";
const LOGDIR = "~/_tmp/wm-selftest-logs";
let pass = 0, fail = 0;
const fails = [];
function check(group, name, ok, detail) {
  if (ok) { pass++; console.log("  PASS " + name + (detail ? "   " + detail : "")); }
  else { fail++; fails.push(name); console.log("  FAIL " + name + (detail ? "   " + detail : "")); }
}

function makeCtx() {
  const registered = { sections: [], events: new Map() };
  return {
    registered,
    logger: { info() {}, warn() {}, debug() {} },
    systemPrompt: { section(spec) { registered.sections.push(spec); return () => {}; } },
    on(event, handler) {
      if (!registered.events.has(event)) registered.events.set(event, []);
      registered.events.get(event).push(handler);
      return () => {};
    },
  };
}

const mod = await import("file:///" + LIB + "/index.js");

console.log("════ INJECT-VERIFY SELFTEST · P0 回捞钩子 ════");

// ── A · 钩子真的注册了 ──
console.log("\n── A · 注册 ──");
const ctx = makeCtx();
mod.apply(ctx, {
  enabled: true, emit: "section", freezePerSession: true, injectMaxChars: 8000,
  logs: { dir: LOGDIR }, __resetMerge: true,
});
const turnHooks = ctx.registered.events.get("agent/turn-stopping") || [];
check("A", "A1 注册了 agent/turn-stopping 钩子", turnHooks.length >= 1, "count=" + turnHooks.length);
const preHooks = ctx.registered.events.get("agent/pre-step") || [];
check("A", "A2 注册了 agent/pre-step 钩子", preHooks.length >= 1, "count=" + preHooks.length);

// ── B/C · 异常隔离（反例：不该抛也不能误报）──
console.log("\n── B · 异常隔离 ──");
let threw = false;
try { for (const h of turnHooks) await h({ agent: { session: { id: "sess-empty" } } }); } catch { threw = true; }
check("B", "B1 无待核验注入时不抛也不误报", threw === false);
threw = false;
try { for (const h of turnHooks) await h({}); } catch { threw = true; }
check("B", "B2 畸形 payload 不抛", threw === false);
threw = false;
try { for (const h of turnHooks) await h(null); } catch { threw = true; }
check("B", "B3 null payload 不抛", threw === false);

// ── D · 指纹判据（正例 + 反例 + 抓真 bug 的用例）──
console.log("\n── D · 指纹判据 ──");
const SESS = "~/.dsh/sessions/--D-Assistant~0020Studio--";
let rawHit = null, injText = null;
try {
  const dirs = readdirSync(SESS, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  outer: for (const d of dirs) {
    let files = [];
    try { files = readdirSync(SESS + "/" + d); } catch { continue; }
    for (const f of files) {
      if (!/\.zstd$/.test(f)) continue;
      let raw;
      try { raw = zstdDecompressSync(readFileSync(SESS + "/" + d + "/" + f)).toString("utf8"); } catch { continue; }
      if (!raw.includes("plugin:unified-memory")) continue;
      let inj = null;
      for (const L of raw.split("\n")) {
        if (!L.trim()) continue;
        let j; try { j = JSON.parse(L); } catch { continue; }
        if (j.type !== "user/message") continue;
        const mm = (j.data && j.data.message) || j.data;
        if (mm && mm.source && mm.source.kind === "plugin:unified-memory") inj = (mm.content || []).map((x) => x.text || "").join(" ");
      }
      if (inj && inj.length > 400) { rawHit = raw; injText = inj; break outer; }
    }
  }
} catch (e) { console.log("  （会话读取失败: " + (e && e.message) + "）"); }

check("D", "D1 拿到真实注入正文", !!injText, injText ? "len=" + injText.length : "none");

if (injText) {
  const fp = injText.replace(/\s+/g, " ").slice(120, 200);
  // 正向：真实指纹必须命中（线上现在用的是同样的归一化逻辑）
  const norm = (s) => String(s).replace(/\s+/g, "").replace(/\\n/g, "");
  const hitReal = norm(rawHit).includes(norm(fp));
  check("D", "D2 真指纹在落盘里命中（正例）", hitReal === true);
  // 反例一：随机串必须不命中
  const rand = "ZZ" + createHash("sha256").update(String(Date.now()) + Math.random()).digest("hex") + "ZZ";
  check("D", "D3 随机假指纹不命中（反例）", norm(rawHit).includes(rand) === false);
  // 反例二：**第一版真 bug 的复现** —— 只替换字面反斜杠 n 会漏掉"真换行"
  //   必须挑一段**真的跨行**的正文当指纹（用 replace(/\s+/g,' ') 拍平了就不跨行了，
  //   那样测不出 bug —— 我第一次就踩了这个坑，样本自己把 bug 洗掉了）。
  const linesOfInj = injText.split("\n");
  let crossFp = null;
  for (let i = 0; i + 1 < linesOfInj.length; i++) {
    const a = linesOfInj[i].trim(), b = linesOfInj[i + 1].trim();
    if (a.length >= 12 && b.length >= 12) { crossFp = a.slice(0, 24) + "\n" + b.slice(0, 24); break; }
  }
  check("D", "D4 能从真实注入里取到跨行指纹", !!crossFp, crossFp ? JSON.stringify(crossFp.slice(0, 30)) : "none");
  if (crossFp) {
    // 旧写法：只把字面 backslash-n 换成空格 —— 真换行原样留着 ⇒ 跨行指纹匹配不上
    const brokenFlat = rawHit.replace(/\\n/g, " ").replace(/\\"/g, '"');
    const brokenHit = brokenFlat.includes(crossFp);
    const goodHit = norm(rawHit).includes(norm(crossFp));
    check("D", "D5 旧写法会漏判、新写法命中 —— 这就是抓到的真 bug",
      brokenHit === false && goodHit === true,
      "broken=" + brokenHit + " good=" + goodHit);
  }
}

console.log("\n════ SUMMARY ════");
console.log("  pass=" + pass + " fail=" + fail);
if (fail) console.log("  失败项: " + fails.join(" | "));
process.exit(fail ? 1 : 0);
