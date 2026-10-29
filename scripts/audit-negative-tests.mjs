#!/usr/bin/env node
/**
 * scripts/audit-negative-tests.mjs —— 反例覆盖率审计（P2 · 2026-10-28）
 *
 * ## 它治什么病
 * 淋雨家那句「没有会失败的检查的规矩 = 一句口号」，换个说法就是：
 * **只有正例的测试只证明"能跑通"，不证明"错了会报"。**
 * 我们 30 多套 verify 里大量是正例（能不能搜出来 / 能不能写进去），
 * 一旦判据写错（例如我用字面 \n 去匹配真换行），正例照样全绿，而功能是坏的。
 * 本次 P0 就真实踩到了这个坑。
 *
 * ## 判据（两道）
 *   A 每套测试必须至少 1 条**负例**（喂脏数据/畸形输入/不该发生的路径，断言必须不通过）
 *      识别方式：调用 check/T 时把第 2~3 个参数直接写成字面量 false，
 *      即 check('X','名字', false) —— 这是"这条断言在验一个必然为假的结论"，
 *      只有反例才这么写。覆盖率 = 有负例的套件 / 总套件。
 *   B 反过来：如果一个文件里**只有正例**（一条字面 false 都没有），
 *      它就是本次审计的点名对象，输出清单。
 *
 * ## 用法
 *   node scripts/audit-negative-tests.mjs                # 人读报告
 *   node scripts/audit-negative-tests.mjs --json         # 机器读
 *   node scripts/audit-negative-tests.mjs --min 0.30     # 自定义门槛（默认 0.30）
 *   node scripts/audit-negative-tests.mjs --strict       # 覆盖率低于门槛则 exit 1
 *
 * ## 反例验收（反例不报 = 这个审计器是假的）
 *   --selftest 会造两个假文件：一个有负例、一个没有，
 *   断言审计器对前者判"有"、对后者判"无"。它必须通过。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const ROOT = process.env.PHOEBE_MEM_ROOT || (fs.existsSync('D:/dsh-plugins/dsh-unified-memory/lib')
  ? 'D:/dsh-plugins/dsh-unified-memory' : process.cwd());

const argv = process.argv.slice(2);
const AS_JSON = argv.includes('--json');
const STRICT = argv.includes('--strict');
const SELFTEST = argv.includes('--selftest');
const MIN = (() => { const i = argv.indexOf('--min'); return i > -1 ? Number(argv[i + 1]) : 0.30; })();

/** 统计一个文件里的 check 调用数与"负例式"调用数 */
function scanFile(file) {
  let src = '';
  try { src = fs.readFileSync(file, 'utf8'); } catch { return null; }
  // check(...) / T(...) 调用：抓整段括号内的文本（粗抓，够用）
  const calls = [];
  const re = /\b(check|T)\s*\(/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    // 从 '(' 起做括号配平，取完整实参串
    let i = m.index + m[0].length - 1;
    let depth = 0, j = i;
    let inStr = null;
    for (; j < src.length; j++) {
      const ch = src[j];
      if (inStr) { if (ch === inStr && src[j - 1] !== '\\') inStr = null; continue; }
      if (ch === '"' || ch === "'" || ch === '`') { inStr = ch; continue; }
      if (ch === '(') depth++;
      else if (ch === ')') { depth--; if (depth === 0) { j++; break; } }
    }
    calls.push(src.slice(i, j));
  }
  // ── 负例判据（第三版 · 双条件）──
  //   前两版都错在同一个方向：想用静态文本"猜"语义，结果一版太松（把 catch 兜底
  //   和属性取反当成反例 ⇒ 36.4% 的虚假繁荣），一版太紧（把自己写的真反例也漏掉
  //   ⇒ 6.8% 的虚假萧条）。这本身就是"判据只该有一份、且必须可验证"的教训。
  //
  //   现在用**双条件**，满足任一即为反例：
  //     ① 显式声明：断言名里带反例语义词（作者自己说这是反例）
  //     ② 断言坏输入：值表达式含 === false / !== true，且**不在 catch / 兜底分支里**
  //   同时排除：catch 里写死的 false（那是"出错就报红"，不是反例）。
  // [2026-10-28 二次修正] 补「不触发/不降权/不受影响/不误伤」——
  //   我自己的纠错反例写的是「都不触发降权」，旧词表识别不出，于是刚写的反例
  //   被自己的审计器判成"没有反例"。判据漏词 = 覆盖率统计骗人。
  // [2026-10-28 三次修正] 再补「不能/硬凑/不可/只会/应为空」——
  //   反转测试最爱的写法就是"不能硬凑""应为空""只会返回…"，
  //   旧词表只认"不*"，于是 e2e-memory-value 那条真正的反例（库外话题不能硬凑）
  //   被漏掉了。判据漏词 = 覆盖率统计骗人（今天第 4 次同类）。
  const NEG_WORDS = /反例|负例|不该|不应|不会被|必须不|不命中|不写|不抛|不许|拒绝|应为\s*false|假数据|脏数据|坏输入|失效|拦下|误报|不触发|不降权|不受影响|不误伤|不该被|不能|硬凑|不可|只会|应为空|必须空|不得/;
  const isCatchGuard = (idx) => {
    const before = src.slice(Math.max(0, idx - 400), idx);
    return /catch\s*(\([^)]*\))?\s*\{[^{}]*$/.test(before) ||
           /(assemble 失败|失败\s*\+|兜底|异常时)/.test(before.slice(-120));
  };
  const negativeCalls = calls.filter((c) => {
    const idx = src.indexOf(c);
    if (idx >= 0 && isCatchGuard(idx)) return false;
    // ① 显式声明反例 —— 只认**实参里的断言名**，不认旁边的注释
    //   （第一版拿整段调用文本去测，把"上方注释写了反例"也算进去了，等于让注释
    //     替断言背书；注释可以骗人，断言名不行）
    const argNames = (c.match(/"[^"]{2,80}"|'[^']{2,80}'|`[^`]{2,80}`/g) || []).join(' ');
    if (NEG_WORDS.test(argNames)) return true;
    // ② 对坏输入断言 false
    const afterName = c.replace(/^\s*\(\s*(?:"[^"]*"|'[^']*'|`[^`]*`)\s*,/, '');
    return /===\s*false/.test(afterName) || /!==\s*true/.test(afterName) ||
           /(^|,)\s*false\s*(,|\))/.test(afterName);
  });
  return { total: calls.length, negative: negativeCalls.length, file };
}

function targets() {
  const out = [];
  try {
    for (const n of fs.readdirSync(ROOT)) {
      if (/^selftest.*\.mjs$/.test(n)) out.push(path.join(ROOT, n));
    }
  } catch { /* ROOT 不在就当空 */ }
  try {
    const sd = path.join(ROOT, 'scripts');
    for (const n of fs.readdirSync(sd)) {
      if (/^(e2e|selftest).*\.mjs$/.test(n)) out.push(path.join(sd, n));
    }
  } catch { /* 无 scripts 目录 */ }
  return out;
}

// ── 自检：审计器自己必须能分辨"有反例/没反例" ──
if (SELFTEST) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nau-'));
  const good = path.join(dir, 'selftest-good.mjs');
  const bad = path.join(dir, 'selftest-bad.mjs');
  fs.writeFileSync(good, 'check("A","正常例", x === 1);\ncheck("B","反例", y === 2, false);\n');
  fs.writeFileSync(bad, 'check("A","只有正例甲", x === 1);\ncheck("B","只有正例乙", y === 2);\n');
  const g = scanFile(good), b = scanFile(bad);
  const ok = g && b && g.negative >= 1 && b.negative === 0 && g.total === 2 && b.total === 2;
  console.log('[selftest] 有反例文件 negative=' + (g && g.negative) + '（应 >=1）');
  console.log('[selftest] 无反例文件 negative=' + (b && b.negative) + '（应 0）');
  console.log(ok ? '[selftest] PASS —— 审计器能分辨' : '[selftest] FAIL —— 审计器分不出反例，等于假检查');
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ }
  process.exit(ok ? 0 : 1);
}

const rows = [];
for (const f of targets()) {
  const r = scanFile(f);
  if (!r || r.total === 0) continue;
  rows.push({ file: path.relative(ROOT, f).replace(/\\/g, '/'), total: r.total, negative: r.negative, has: r.negative > 0 });
}

const covered = rows.filter((r) => r.has).length;
const ratio = rows.length ? covered / rows.length : 0;
const missing = rows.filter((r) => !r.has).sort((a, b) => b.total - a.total);

if (AS_JSON) {
  console.log(JSON.stringify({ files: rows.length, covered, ratio: Number(ratio.toFixed(3)), min: MIN, pass: ratio >= MIN, missing: missing.map((x) => x.file) }, null, 2));
} else {
  console.log('\n[反例覆盖率审计]  根目录 ' + ROOT);
  console.log('  含断言的套件: ' + rows.length + ' 套');
  console.log('  其中含反例 : ' + covered + ' 套  (' + (ratio * 100).toFixed(1) + '%)');
  console.log('  门槛       : ' + (MIN * 100).toFixed(0) + '%');
  console.log('');
  console.log('  已有反例（按数量排前 8）:');
  for (const r of rows.filter((x) => x.has).sort((a, b) => b.negative - a.negative).slice(0, 8)) {
    console.log('    ✓ ' + r.file + '  负例 ' + r.negative + '/' + r.total);
  }
  if (missing.length) {
    console.log('');
    console.log('  ⛔ 全是正例、一条负例都没有（按断言数排前 12）:');
    for (const r of missing.slice(0, 12)) console.log('    · ' + r.file + '  断言 ' + r.total);
    if (missing.length > 12) console.log('    … 另有 ' + (missing.length - 12) + ' 套');
  }
  console.log('');
  // ── 附：反例样本"唯一性"抽查（今天踩到的假绿）──
  //   实测踩坑：我写了 3 种坏形态（缺字段/空数组/脏类型）当反例，
  //   但三张卡 title+content 完全一样 ⇒ 被 dedupeTitles 合并成 1 张，
  //   断言输出 "1/1 一致" —— **看上去全过，其实只测了 1/3**。
  //   判据很土但有效：反例代码里若出现 "N/N 一致" 这类自比，样本必须带唯一标记。
  console.log('');
  console.log('  反例样本唯一性抽查:');
  let uniqWarn = 0;
  for (const r of rows.filter((x) => x.has)) {
    let src = '';
    try { src = fs.readFileSync(path.join(ROOT, r.file), 'utf8'); } catch { continue; }
    // 造多张卡却不给唯一内容的（ID 里带循环变量的除外）
    // 只关心"往记忆库里造卡"的循环（appendFileSync 到 engrams/records），
    // 纯内存构造的测试夹具（MUST_CATCH 之类）不涉及去重合并，不纳入。
    const makesCards = /(appendFileSync|writeFileSync)\([^)]*(engrams|records)[^)]*\.jsonl/.test(src);
    const loops = /for\s*\(/.test(src);
    const hasUniq = /Date\.now\(\)|randomUUID|Math\.random|slice\(-\d\)|\[String\(i\)\]|uniq|\+\s*id\b|id\s*\+/.test(src);
    if (makesCards && loops && !hasUniq) {
      uniqWarn++;
      console.log('    ⚠️ ' + r.file + ' —— 循环造卡但没有唯一化，可能被去重合并成假绿');
    }
  }
  if (uniqWarn === 0) console.log('    ✓ 未发现"循环造样本却没唯一化"的套件');

  console.log('');
  console.log(ratio >= MIN ? '  ✅ 覆盖率达标' : '  ⚠️ 覆盖率 ' + (ratio * 100).toFixed(1) + '% 低于门槛 —— 这些套件只证明"能跑通"，证明不了"错了会报"');
}
if (STRICT && ratio < MIN) process.exit(1);
