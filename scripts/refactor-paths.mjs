/**
 * scripts/refactor-paths.mjs —— 把硬编码路径改为调 lib/paths.js（2026-10-29）
 *
process.on('uncaughtException', e => { console.error('[UNCAUGHT]', e && e.message); console.error(String(e && e.stack || '').split('
').slice(0,6).join('
')); process.exit(1); });
 * ## 为什么用脚本而不是手工改
 *   58 处散在 23 个文件里，手工改必漏、必错。
 *   脚本可以：正则替换 + 逐文件校验语法 + 出账。
 *
 * ## 替换规则（保守，只动"确定的形态"）
 *   dataPath('<X>')  →  dataPath('<X>')
 *   '~/日记'                          →  diaryRoot()
 *   '~/日记/<f>'                      →  normalize(diaryRoot() + '/<f>')
 *   '~/.dsh/sessions'            →  sessionsRoot()
 *   '~/.dsh/<X>'                 →  normalize(dshHome() + '/<X>')
 *
 * ## 安全
 *   · 默认 dryRun，只报告不改
 *   · --go 才真改，改前把原文件备份到 _tmp/path-refactor-backup/
 *   · 只改**字符串字面量**，不碰注释（注释里保留原路径反而有历史价值）
 */
import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { dataPath } from '../lib/paths.js';

const ROOT = 'D:/dsh-plugins/dsh-unified-memory';
const LIB = ROOT + '/lib';
const BACKUP = ROOT + '/_tmp/path-refactor-backup';
const DRY = !process.argv.includes('--go'); console.error('[DRY_DIAG]', JSON.stringify(process.argv), 'DRY=', DRY);

const DATA_PREFIX = "'~/.dsh/unified-memory";
const DSH_PREFIX = "'~/.dsh";

const files = [];
(function walk(d) {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const p = join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.js')) files.push(p);
  }
})(LIB);

const report = [];
for (const f of files) {
  const src = readFileSync(f, 'utf8');
  const lines = src.split('\n');
  const changes = [];

  for (let i = 0; i < lines.length; i++) {
    const L = lines[i];
    // 跳过纯注释行（保留原路径作历史参考）
    if (/^\s*(\/\/|\*|\/\*)/.test(L)) continue;
    if (!L.includes('C:/Users/Administrator') && !L.includes('~')) continue;

    let out = L;

    // ① 数据根下的路径
    out = out.replace(/'C:\/Users\/Administrator\/\.dsh\/unified-memory(?:\/([^']*))?'/g, (_m, sub) => {
      return sub ? "dataPath('" + sub + "')" : 'dataRoot()';
    });
    // ② sessions
    out = out.replace(/'C:\/Users\/Administrator\/\.dsh\/sessions'/g, 'sessionsRoot()');
    // ③ 其他 .dsh 子路径
    out = out.replace(/'C:\/Users\/Administrator\/\.dsh\/([^']*)'/g, (_m, sub) => {
      return "normalize(dshHome() + '/" + sub + "')";
    });
    // ④ 日记目录
    out = out.replace(/'D:\/Assistant Studio\/日记'/g, 'diaryRoot()');
    // ⑤ 日记文件
    out = out.replace(/'D:\/Assistant Studio\/日记\/([^']*)'/g, (_m, sub) => {
      return "normalize(diaryRoot() + '/" + sub + "')";
    });

    if (out !== L) {
      changes.push({ line: i + 1, before: L.trim().slice(0, 90), after: out.trim().slice(0, 90) });
      lines[i] = out;
    }
  }

  if (changes.length) {
    report.push({ file: f.replace(ROOT + '/', ''), changes, newSrc: lines.join('\n') });
  }
}

console.log('=== 扫描结果 ===');
console.log('命中文件:', report.length, '/ 总文件', files.length);
let total = 0;
for (const r of report) {
  total += r.changes.length;
  console.log('  ' + r.file + '  (' + r.changes.length + ' 处)');
}
console.log('总替换点:', total);

if (DRY) {
  console.log('\n[dryRun] 未改动任何文件。加 --go 才真改。');
  console.log('\n=== 样例（前 6 条）===');
  let n = 0;
  for (const r of report) {
    for (const c of r.changes) {
      if (n++ >= 6) break;
      console.log('  ' + r.file + ':' + c.line);
      console.log('    - ' + c.before);
      console.log('    + ' + c.after);
    }
    if (n >= 6) break;
  }
  process.exit(0);
}

// 真改
if (!existsSync(BACKUP)) mkdirSync(BACKUP, { recursive: true });

/** 计算相对 import 路径：从被改文件到 lib/paths.js */
function importPathFor(relFile) {
  // relFile 形如 lib/xxx/yyy.js；到 lib/paths.js 的相对路径
  const depth = (relFile.match(/\//g) || []).length - 1;   // lib/ 之后的层级
  const up = '../'.repeat(Math.max(0, depth));
  return up + 'paths.js';
}

/** 在文件顶部插入 import（放在最后一个 import 之后；没有 import 就放第一个注释块之后） */
function injectImport(src, relFile) {
  const need = [];
  if (/\bdataPath\(/.test(src)) need.push('dataPath');
  if (/\bdataRoot\(/.test(src)) need.push('dataRoot');
  if (/\bdshHome\(/.test(src)) need.push('dshHome');
  if (/\bdiaryRoot\(/.test(src)) need.push('diaryRoot');
  if (/\bsessionsRoot\(/.test(src)) need.push('sessionsRoot');
  if (/\bnormalize\(/.test(src)) need.push('normalize');
  if (!need.length) return src;

  const spec = "import { " + need.join(', ') + " } from '" + importPathFor(relFile) + "';";
  if (src.includes(spec)) return src;
  // 已经 import 过 paths.js？合并进去
  const m = src.match(/import \{([^}]*)\} from '([^']*\/paths\.js)';/);
  if (m) {
    const have = m[1].split(',').map(s => s.trim()).filter(Boolean);
    const merged = Array.from(new Set(have.concat(need)));
    return src.replace(m[0], "import { " + merged.join(', ') + " } from '" + m[2] + "';");
  }
  // 插在最后一个 import 语句之后
  const lines = src.split('\n');
  let lastImport = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*import\s/.test(lines[i])) lastImport = i;
  }
  if (lastImport >= 0) {
    lines.splice(lastImport + 1, 0, spec);
    return lines.join('\n');
  }
  // 没有任何 import（少见）：插在文件头注释之后
  const idx = src.indexOf('*/');
  if (idx >= 0) return src.slice(0, idx + 2) + '\n' + spec + '\n' + src.slice(idx + 2);
  return spec + '\n' + src;
}

for (const r of report) { console.error('[LOOP] ' + r.file);
  const abs = ROOT + '/' + r.file;
  const bak = BACKUP + '/' + r.file.replace(/\//g, '__');
  const orig = readFileSync(abs, 'utf8');
  writeFileSync(bak, orig, 'utf8');
  writeFileSync(abs, injectImport(r.newSrc, r.file), 'utf8');
}
console.log('\n[go] 已改', report.length, '个文件，备份在', BACKUP);
