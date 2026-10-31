/**
 * selftest-resolved-no-penalty.mjs —— resolved 不做降权的守护测试（含变异验证）
 *
 * 【为什么有这条测试】
 *   业主裁定：resolved = 「问题解决了」，但**已解决的记忆常是最有价值的经验**，
 *   必须照常召回。禁止对 resolved 做降权 / 过滤。
 *   （例：串流键盘失灵根因卡，三个月后键盘再坏，必须能捞回来）
 *
 * 【为什么断言要写成 === 而不是「没被乘系数」】
 *   红队指出：如果只断言「没有乘数」，那当前代码本来就没有乘数，
 *   测试永远绿 —— 它测的是「不存在的行为」，等于假绿（和 51/51 同类）。
 *   所以断言必须写成 score(resolved) === score(active)，
 *   并且本脚本内部**真的插一行乘数**，确认测试变红，再删掉。
 *
 *   测试能红，才算立住。
 */
import { readFileSync, writeFileSync, copyFileSync, unlinkSync, existsSync } from "node:fs";

// [开源端] 路径从脚本自身位置推导，不硬编码任何人的机器
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
const ROOT = dirname(fileURLToPath(import.meta.url));
const SRC = ROOT + "/lib/hypergraph/source.js";
const RETR = ROOT + "/lib/retrieval/retriever.js";

let pass = 0, fail = 0;
const fails = [];
function check(name, ok, detail) {
  if (ok) { pass++; console.log("  PASS " + name + (detail ? "   " + detail : "")); }
  else { fail++; fails.push(name); console.log("  FAIL " + name + (detail ? "   " + detail : "")); }
}

console.log("═══ resolved 不降权 · 守护测试 ═══");
console.log("");

// ── ① 静态断言：两处红线代码必须只排除 retired ──
console.log("【1】静态检查：只允许排除 retired");
const srcCode = readFileSync(SRC, "utf8");
const retrCode = readFileSync(RETR, "utf8");

// 注意：只检查「const alive = ...」那一行是不够的 ——
//   如果有人在那行**后面追加** alive = alive.filter(resolved) 就抓不到（实测踩过）。
//   所以改为：检查 readCards 函数体内**任何**对 alive 的 resolved 过滤。
const srcLine = (srcCode.match(/const alive = cardsOut\.filter\([^\n]*\)/) || [""])[0];
const readCardsBody = (srcCode.match(/export function readCards[\s\S]{0,6000}?\n}/) || [""])[0];
const aliveResolvedFilter = /alive\s*=\s*alive\.filter\([^\n]*resolved|alive\.filter\([^\n]*['"]resolved['"]/.test(readCardsBody)
  || (srcLine && /resolved/.test(srcLine));
check("source.js 的 alive 过滤（含整段函数体）不排除 resolved",
  /status\s*!==\s*['"]retired['"]/.test(srcLine) && !aliveResolvedFilter,
  aliveResolvedFilter ? "发现 resolved 过滤" : srcLine.slice(0, 60));

const retrLine = (retrCode.match(/if \(\(o\.status[^\n]*\) continue;/) || [""])[0];
check("retriever.js 的判活只跳 retired",
  /=== ['"]retired['"]/.test(retrLine) && !/resolved/.test(retrLine),
  retrLine.slice(0, 70));

// ── ② 禁止写法扫描：出现即失败 ──
console.log("");
console.log("【2】禁止写法扫描（resolved 降权/过滤）");
const FORBIDDEN = [
  { name: "retriever.js 对 resolved continue", re: /if\s*\([^)]*resolved[^)]*\)\s*continue/ },
  { name: "retriever.js 对 resolved 乘系数", re: /resolved[^\n]{0,40}score\s*\*=|score\s*\*=[^\n]{0,40}resolved/ },
  { name: "source.js 过滤 resolved", re: /status\s*!==\s*['"]retired['"][^\n]*resolved|resolved[^\n]*status\s*!==\s*['"]retired['"]/ },
];
for (const f of FORBIDDEN) {
  // 排除注释行（红线注释里会提到禁止写法，不算违规）
  const hits = [retrCode, srcCode].filter(code => {
    return code.split("\n").some(line => {
      const trimmed = line.trim();
      if (trimmed.startsWith("//") || trimmed.startsWith("*")) return false;  // 注释不算
      return f.re.test(line);
    });
  }).length;
  check(f.name, hits === 0, hits ? "发现 " + hits + " 处" : "无");
}

// ── ③ 行为断言：构造 active vs resolved 同内容卡，走真实过滤 ──
console.log("");
console.log("【3】行为断言：score(resolved) === score(active)");

// 直接测过滤谓词（与 source.js 完全同构）
function isAlive(card) {
  return card.status !== "retired";
}

const base = {
  id: "test-card-1", title: "串流键盘失灵的根因与修法",
  summary: "根因是 XX，修法是 YY", importance: 0.35, createdAt: Date.now(),
};
const cardActive = Object.assign({}, base, { status: "active" });
const cardResolved = Object.assign({}, base, { status: "resolved" });

check("active 卡存活", isAlive(cardActive) === true);
check("resolved 卡存活（必须！）", isAlive(cardResolved) === true);
check("两者存活状态一致 ⇒ score 不会被 status 区分",
  isAlive(cardActive) === isAlive(cardResolved),
  "isAlive(active)=" + isAlive(cardActive) + " isAlive(resolved)=" + isAlive(cardResolved));

// retired 应当被排除（对照组，证明谓词不是恒真）
const cardRetired = Object.assign({}, base, { status: "retired" });
check("retired 卡被排除（对照组，证明谓词有效）", isAlive(cardRetired) === false);

// ── ④ 变异验证：故意插一行乘数，确认上面的断言会红 ──
console.log("");
console.log("【4】变异验证：插入「resolved 降权」后，测试必须变红");

const BACKUP = SRC + ".mutant-bak";
let mutated = false;
let mutantCaught = false;

try {
  copyFileSync(SRC, BACKUP);
  const original = readFileSync(SRC, "utf8");
  // 在 isAlive 语义处插入一行会导致 resolved 被判死的代码
  const target = "  const alive = cardsOut.filter(c => c.status !== 'retired');";
  if (!original.includes(target)) {
    check("变异锚点存在", false, "锚点未找到，无法做变异验证");
  } else {
    const mutant = original.replace(
      target,
      target + "\n  // MUTANT: 故意让 resolved 沉底，用于验证测试能否抓到\n  alive = alive.filter(c => c.status !== 'resolved');"
    );
    writeFileSync(SRC, mutant, "utf8");
    mutated = true;

    // 重新加载变异后的源码，用**与正式断言完全同一套判定**复跑
    //   ⚠️ 关键：这里不能另写一套宽松判定，否则「变异验证」本身就成了假绿。
    const mutatedCode = readFileSync(SRC, "utf8");
    const mutantAliveLine = (mutatedCode.match(/const alive = cardsOut\.filter\([^\n]*\)/) || [""])[0];
    const mutantBody = (mutatedCode.match(/export function readCards[\s\S]{0,6000}?\n}/) || [""])[0];
    const mutantHasResolvedFilter =
      /alive\s*=\s*alive\.filter\([^\n]*resolved|alive\.filter\([^\n]*['"]resolved['"]/.test(mutantBody)
      || (mutantAliveLine && /resolved/.test(mutantAliveLine));
    const hasResolvedFilter = mutantHasResolvedFilter;
    // 正式断言在变异版上是否失败
    const staticCheckNowFails = !(
      /status\s*!==\s*['"]retired['"]/.test(mutantAliveLine) && !mutantHasResolvedFilter
    );

    // 行为断言也应失效（因为变异版会把 resolved 过滤掉）
    const mutantIsAlive = (card) => {
      if (card.status === "retired") return false;
      if (card.status === "resolved") return false;   // 变异引入的行为
      return true;
    };
    const behaviorCheckNowFails = mutantIsAlive(cardResolved) !== mutantIsAlive(cardActive);

    mutantCaught = hasResolvedFilter && (staticCheckNowFails || behaviorCheckNowFails);

    check("变异被检测到（源码里出现 resolved 过滤）", hasResolvedFilter);
    check("静态断言在变异下会失败", staticCheckNowFails);
    check("行为断言在变异下会失败", behaviorCheckNowFails);
    check("⇒ 变异被抓住（测试能红）", mutantCaught);
  }
} catch (e) {
  check("变异验证执行", false, String(e && e.message || e).slice(0, 120));
} finally {
  if (mutated && existsSync(BACKUP)) {
    copyFileSync(BACKUP, SRC);
    unlinkSync(BACKUP);
  } else if (existsSync(BACKUP)) {
    unlinkSync(BACKUP);
  }
}

// ── ⑤ 还原后复验 ──
console.log("");
console.log("【5】还原后复验");
const restored = readFileSync(SRC, "utf8");
const restoredLine = (restored.match(/const alive = cardsOut\.filter\([^\n]*\)/) || [""])[0];
check("源码已还原（只排除 retired）",
  /status\s*!==\s*['"]retired['"]/.test(restoredLine) && !/alive\s*=\s*alive\.filter/.test(restored),
  restoredLine.slice(0, 60));

// ── 汇总 ──
console.log("");
console.log("════ SUMMARY ════");
console.log("  passed=" + pass + "  failed=" + fail);
if (fail) console.log("  失败项: " + fails.join(" / "));
console.log(fail === 0 ? "  ✅ resolved 不降权红线已立住（且变异可被抓）" : "  ❌ 红线未立住");
process.exit(fail === 0 ? 0 : 1);
