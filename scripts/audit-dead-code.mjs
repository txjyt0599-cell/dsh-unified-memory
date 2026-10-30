#!/usr/bin/env node
/**
 * audit-dead-code.mjs —— 死代码/零接线扫描
 * [2026-10-24 by Assistant · Round 25]
 *
 * 这个项目反复栽在「声明了但没人用」上：
 *   · freeze + snapshots 在 section.js 里躺了几个月（真正的冻结在别处）
 *   · scorer / byTopic / claude 余额字段 都是先声明后遗忘
 *   · graphIncidence 路径、gateBoost 参数、readOwnIngest 都是"函数在但没人调"
 *
 * 做法（保守，只报高置信度的）：
 *   ① 顶层 const/let 声明后，在整个文件里**只出现一次** ⇒ 疑似未使用
 *   ② import 的具名符号，在文件里只出现一次（就是 import 那行）⇒ 未使用
 * 只报不修 —— 人工判断哪是真的死代码。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'lib');
const files = [];
function walk(d) {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    if (e.name === 'node_modules') continue;
    const p = join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.(js|mjs)$/.test(e.name)) files.push(p);
  }
}
walk(ROOT);

const findings = [];
for (const f of files) {
  const src = readFileSync(f, 'utf8');
  const rel = f.replace(ROOT + '/', '');
  // ① 顶层声明只出现一次
  for (const m of src.matchAll(/^\s{0,4}(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=/gm)) {
    const name = m[1];
    if (name.length < 3) continue;
    // 全词统计出现次数
    const re = new RegExp('\\b' + name.replace(/\$/g, '\\$') + '\\b', 'g');
    const count = (src.match(re) || []).length;
    if (count === 1) {
      const line = src.slice(0, m.index).split('\n').length;
      findings.push({ file: rel, line, kind: '声明未使用', name });
    }
  }
  // ② import 具名符号未使用
  for (const m of src.matchAll(/^import\s*\{([^}]+)\}\s*from/gm)) {
    const names = m[1].split(',').map((x) => x.trim().split(/\s+as\s+/).pop().trim()).filter(Boolean);
    for (const n of names) {
      if (!n || n.length < 3) continue;
      const re = new RegExp('\\b' + n.replace(/\$/g, '\\$') + '\\b', 'g');
      const count = (src.match(re) || []).length;
      if (count === 1) {
        const line = src.slice(0, m.index).split('\n').length;
        findings.push({ file: rel, line, kind: '导入未使用', name: n });
      }
    }
  }
}

console.log('══ 死代码扫描（' + files.length + ' 个文件）══\n');
if (!findings.length) {
  console.log('  ✅ 没发现高置信度死代码');
} else {
  const byKind = new Map();
  for (const x of findings) byKind.set(x.kind, (byKind.get(x.kind) || 0) + 1);
  console.log('  发现 ' + findings.length + ' 处：' + [...byKind.entries()].map(([k, v]) => k + ' ' + v).join(' / ') + '\n');
  for (const x of findings) {
    console.log('  · [' + x.kind + '] ' + x.file + ':' + x.line + '  ' + x.name);
  }
}
// ── [2026-10-24 by Assistant · Round 38] 模块级"零接线"审计 ──
//   上面的扫描看的是**文件内部**的未使用符号；这里看的是**整个文件有没有被别处引用**。
//   实测抓到：propagate.js 全库零调用（向量索引跑不起来，λ 无从标定）——
//     它是"预留但未接"的模块，保留合理，但**必须显式标注**，
//     否则读代码的人会以为功能已经在跑。
console.log('');
console.log('── 模块级零接线 ──');
// ── [2026-10-24 by Assistant · Round 38 修正（两个 Windows 坑）] ──
//   坑① ROOT 在本脚本里是 .../lib，rel 应是 "backends/engram.js"（不带 lib/ 前缀），
//        原来写 filter(f => f.startsWith('lib/')) ⇒ 全被过滤 ⇒ 永远报"每个模块都被引用"。
//   坑② Windows 上 join() 返回**反斜杠**路径，而 replace(ROOT + '/', '') 用的是正斜杠
//        ⇒ 替换不到 ⇒ 路径保持绝对形式 ⇒ 后面的匹配全失败。
//        ⇒ 统一把分隔符归一成 '/' 再处理。
const norm = (s) => String(s).replace(/\\/g, '/');
const libFiles = files.map((f) => norm(f).replace(norm(ROOT) + '/', ''));
const referenced = new Set();
for (const f of files) {
  const s = readFileSync(f, 'utf8');
  for (const lf of libFiles) {
    if (norm(ROOT) + '/' + lf === norm(f)) continue;
    const name = lf.split('/').pop().replace(/\.(js|mjs)$/, '');
    if (new RegExp("from\\s+['\"][^'\"]*/" + name + "\\.(js|mjs)['\"]").test(s)) referenced.add(lf);
  }
}
const orphans = libFiles.filter((f) => !referenced.has(f) && !/index\.(js|mjs)$/.test(f));
if (!orphans.length) {
  console.log('  ✅ 每个模块都被引用');
} else {
  let silent = 0;
  for (const f of orphans) {
    const body = readFileSync(ROOT + '/' + f, 'utf8');
    const annotated = /未接线|零调用|unwired/.test(body);
    if (!annotated) silent++;
    console.log('  · ' + f + (annotated ? '   （已标注「未接线」✓）' : '   ⚠ **零引用且未标注**'));
  }
  console.log('\n  未标注的零引用模块: ' + silent + ' 个' + (silent ? '（建议补一句「本模块未接线」）' : ''));
  // [Round 38] 局限说明：本检查只认 **静态 import 语句**（from 后跟相对路径）。
  //   若模块被"包装后调用"（如 ingest/index.js 里 `createConsolidation(...)` 而 import 写在别处），
  //   仍会被误报。⇒ 看到报警先 grep 一次模块名，再判断。
  console.log('  （局限：只认静态 import；包装调用会误报，请 grep 模块名复核）');
}

console.log('\n（只报不修 —— 有些是刻意保留的 API，需人工判断）');
process.exit(0);
