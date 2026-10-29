/**
 * selftest-title-gate.mjs —— 读侧标题闸门验收（2026-10-28 · 老红项）
 *
 * ## 治什么病
 * 体检「标题全部合格」长期红 2 张：`（无标题）` 和半句 `但它能成立`。
 * 根因不是判据错，是**判据没被执行**：
 *   cleanTitle 只去脏（HTML/框线/符号），不判断合不合格；
 *   而读侧有 4 处各自调 cleanTitle，没有一处补 isGoodTitle。
 *
 * ## 反例（照"反例不报=检查是假的"）
 *   ① 喂「（无标题）」⇒ 必须从正文提炼出合格标题
 *   ② 喂半句「但它能成立」⇒ 必须从正文补全成合格标题
 *   ③ 喂纯 HTML 碎片 ⇒ 必须提炼，不许把标签当标题
 *   ④ 提炼也提炼不出来（正文也是垃圾）⇒ **必须保持不合格**（不许伪造标题骗体检）
 */
const LIB = "D:/dsh-plugins/dsh-unified-memory/lib";
let pass = 0, fail = 0;
const fails = [];
function check(group, name, ok, detail) {
  if (ok) { pass++; console.log("  PASS " + name + (detail ? "   " + detail : "")); }
  else { fail++; fails.push(name); console.log("  FAIL " + name + (detail ? "   " + detail : "")); }
}

const { finalizeTitle, readOwnIngest } = await import("file:///" + LIB + "/hypergraph/source.js");
const { isGoodTitle } = await import("file:///" + LIB + "/ingest/normalize.js");

console.log("════ TITLE-GATE SELFTEST · 读侧标题闸门 ════");

// ── A · 两个真实历史脏标题（就是体检里那 2 张）──
console.log("\n── A · 真实历史脏标题 ──");
const a1 = finalizeTitle("（无标题）", '<div class="a"><b>DSH 主进程的真实命令行:</b></div>');
check("A", "A1 「（无标题）」被提炼成合格标题", isGoodTitle(a1) === true, JSON.stringify(a1));
check("A", "A2 提炼结果不含 HTML 标签", !/<[a-zA-Z\/]/.test(a1), JSON.stringify(a1));

const a3 = finalizeTitle("但它能成立", "但它能成立,不是因为记忆系统多厉害,是因为这盘棋就发生在此刻,还没被压缩掉");
check("A", "A3 半句标题被补全成合格标题", isGoodTitle(a3) === true, JSON.stringify(a3));
check("A", "A4 补全后长度合理（≤60）", a3.length <= 60, "len=" + a3.length);

// ── B · 反例：提炼不出来时**不许伪造** ──
console.log("\n── B · 反例（不许伪造标题）──");
const b1 = finalizeTitle("（无标题）", "</");
check("B", "B1 正文也是垃圾时保持不合格（不造假）", isGoodTitle(b1) === false, JSON.stringify(b1));
const b2 = finalizeTitle("", "");
check("B", "B2 全空输入不抛且返回空", typeof b2 === "string" && b2.length === 0, JSON.stringify(b2));
const b3 = finalizeTitle(null, null);
check("B", "B3 null 输入不抛", typeof b3 === "string");

// ── C · 合格标题必须原样透传（闸门不能反过来破坏好数据）──
console.log("\n── C · 好数据不许被动 ──");
const good = "超图三级粗到细管线改造";
check("C", "C1 合格中文标题原样保留", finalizeTitle(good, "随便一段正文") === good, JSON.stringify(finalizeTitle(good, "随便一段正文")));
const en = "Dualpool selftest script for the vector path";
const enOut = finalizeTitle(en, "");
check("C", "C2 合格英文标题不被误杀", isGoodTitle(enOut) === true, JSON.stringify(enOut));

// ── D · 真实卡库全量：读侧出口必须一条不合格都不剩 ──
console.log("\n── D · 真实卡库全量 ──");
const own = readOwnIngest();
const bad = own.cards.filter((c) => !isGoodTitle(String(c.title || "")));
check("D", "D1 真实卡库经读侧出口后 0 张不合格", bad.length === 0,
  bad.length ? bad.slice(0, 3).map((c) => JSON.stringify(c.title)).join(" | ") : "共 " + own.cards.length + " 张");
check("D", "D2 卡数没有因为闸门而减少（不许静默丢卡）", own.cards.length > 1000, "cards=" + own.cards.length);

console.log("\n════ SUMMARY ════");
console.log("  pass=" + pass + " fail=" + fail);
if (fail) console.log("  失败项: " + fails.join(" | "));
process.exit(fail ? 1 : 0);
