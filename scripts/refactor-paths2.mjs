import fs from 'node:fs';
import path from 'node:path';

const ROOT = 'D:/dsh-plugins/dsh-unified-memory';
const BACKUP = ROOT + '/_tmp/path-refactor-backup';
const DRY = !process.argv.includes('--go');

// 递归找 js
const files = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.js')) files.push(p);
  }
})(ROOT + '/lib');

const rel = (p) => p.slice(ROOT.length + 1).replace(/\\/g, '/');
const depthOf = (r) => (r.match(/\//g) || []).length - 1;
const pathsImport = (r) => (depthOf(r) > 0 ? '../'.repeat(depthOf(r)) : './') + 'paths.js';

const report = [];
for (const f of files) {
  const r = rel(f);
  if (r === 'lib/paths.js') continue;
  const src = fs.readFileSync(f, 'utf8');
  const lines = src.split('\n');
  const changes = [];
  let need = {};

  for (let i = 0; i < lines.length; i++) {
    let L = lines[i];
    if (/^\s*(\/\/|\*|\/\*)/.test(L)) continue;
    const orig = L;

    // 数据根
    L = L.replace(/'C:\/Users\/Administrator\/\.dsh\/unified-memory(?:\/([^']*))?'/g, (m, sub) => {
      need[sub ? 'dataPath' : 'dataRoot'] = 1;
      return sub ? "dataPath('" + sub + "')" : 'dataRoot()';
    });
    // sessions
    L = L.replace(/'C:\/Users\/Administrator\/\.dsh\/sessions'/g, () => { need.sessionsRoot = 1; return 'sessionsRoot()'; });
    // 其他 .dsh 子路径
    L = L.replace(/'C:\/Users\/Administrator\/\.dsh\/([^']*)'/g, (m, sub) => {
      need.normalize = 1; need.dshHome = 1;
      return "normalize(dshHome() + '/" + sub + "')";
    });
    // 日记目录
    L = L.replace(/'D:\/Assistant Studio\/日记'/g, () => { need.diaryRoot = 1; return 'diaryRoot()'; });
    // 日记文件
    L = L.replace(/'D:\/Assistant Studio\/日记\/([^']*)'/g, (m, sub) => {
      need.diaryRoot = 1; need.normalize = 1;
      return "normalize(diaryRoot() + '/" + sub + "')";
    });

    if (L !== orig) { changes.push({ line: i + 1, before: orig.trim().slice(0, 80), after: L.trim().slice(0, 80) }); lines[i] = L; }
  }

  if (changes.length) {
    const keys = Object.keys(need).sort();
    let out = lines.join('\n');
    // 合并 import
    const re = /import \{([^}]*)\} from '([^']*paths\.js)';/;
    const m = out.match(re);
    if (m) {
      const have = m[1].split(',').map(s => s.trim()).filter(Boolean);
      const merged = Array.from(new Set(have.concat(keys))).sort();
      out = out.replace(m[0], "import { " + merged.join(', ') + " } from '" + m[2] + "';");
    } else {
      const spec = "import { " + keys.join(', ') + " } from '" + pathsImport(r) + "';";
      const ls = out.split('\n');
      let li = -1;
      for (let i = 0; i < ls.length; i++) if (/^\s*import\s/.test(ls[i])) li = i;
      if (li >= 0) ls.splice(li + 1, 0, spec);
      else ls.unshift(spec);
      out = ls.join('\n');
    }
    report.push({ file: r, changes, newSrc: out, importSpec: keys.join(',') });
  }
}

console.log('=== 文件:', report.length, ' 替换点:', report.reduce((s, x) => s + x.changes.length, 0));
for (const x of report) console.log('  ' + x.file + '  (' + x.changes.length + ')  import: ' + x.importSpec);

if (DRY) { console.log('\n[dryRun] 加 --go 才真改'); process.exit(0); }

fs.mkdirSync(BACKUP, { recursive: true });
let ok = 0, bad = [];
for (const x of report) {
  const abs = ROOT + '/' + x.file;
  const orig = fs.readFileSync(abs, 'utf8');
  fs.writeFileSync(BACKUP + '/' + x.file.replace(/\//g, '__'), orig, 'utf8');
  fs.writeFileSync(abs, x.newSrc, 'utf8');
  ok++;
}
console.log('\n[go] 已写', ok, '个文件');
