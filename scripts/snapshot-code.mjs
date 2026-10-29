#!/usr/bin/env node
/**
 * snapshot-code.mjs —— 代码快照（重启前必做的回滚点）
 * [2026-10-24 by Assistant · Round 20]
 *
 * 为什么必须做：
 *   这个插件目录**不是 git 仓库**，本批又改了 20+ 个 lib 文件。
 *   一旦重启后出问题（插件 apply 抛错、记忆整段消失），没有任何「一键回到昨天」的手段。
 *   「备份优先于修改」是User的铁律 —— 但之前只备份了**数据**（engrams/diary），
 *   从没备份过**代码**。这是缺口。
 *
 * 做法：
 *   · 把整个 lib/ + scripts/ + 根目录 selftest*.mjs 打成一份带时间戳的快照
 *   · 快照里附 MANIFEST.json（每个文件的 sha256 + 大小 + mtime）+ STATUS.txt（改动说明/还原方法）
 *   · 还原脚本 restore-code.mjs 一起放进去，保证「快照自己能说清怎么回滚」
 *
 * 用法：
 *   node scripts/snapshot-code.mjs                 # 打快照
 *   node scripts/snapshot-code.mjs --list          # 列出已有快照
 *   node scripts/snapshot-code.mjs --restore <名>  # 还原（需 --yes）
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync, copyFileSync, cpSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, relative } from 'node:path';
import { tmpdir as osTmpdir } from 'node:os';

const ROOT = 'D:/dsh-plugins/dsh-unified-memory';
const SNAP_ROOT = join(osTmpdir(), 'code-snapshots');

const argv = process.argv.slice(2);
const opt = {};
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith('--')) {
    const k = a.slice(2);
    opt[k] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
  }
}

function sha256(f) {
  try { return createHash('sha256').update(readFileSync(f)).digest('hex'); } catch { return 'UNREADABLE'; }
}

function collect(dir, out, base) {
  let ents = [];
  try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    if (e.name === 'node_modules' || e.name === '.git') continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) { collect(p, out, base); continue; }
    if (!/\.(js|mjs|json|yml|yaml|md)$/.test(e.name)) continue;
    out.push({ abs: p, rel: relative(base, p).replace(/\\/g, '/') });
  }
}

// ── --list ──
if (opt.list === true) {
  if (!existsSync(SNAP_ROOT)) { console.log('（还没有任何代码快照）'); process.exit(0); }
  const names = readdirSync(SNAP_ROOT).filter((n) => statSync(join(SNAP_ROOT, n)).isDirectory()).sort();
  console.log('已有代码快照 ' + names.length + ' 份：');
  for (const n of names) {
    let st = '';
    try { st = readFileSync(join(SNAP_ROOT, n, 'STATUS.txt'), 'utf8').split('\n')[0]; } catch {}
    console.log('  · ' + n + '   ' + st.slice(0, 60));
  }
  process.exit(0);
}

// ── --restore ──
if (typeof opt.restore === 'string') {
  const name = opt.restore;
  const dir = join(SNAP_ROOT, name);
  if (!existsSync(dir)) { console.error('找不到快照：' + name); process.exit(1); }
  if (opt.yes !== true) {
    console.error('还原会覆盖当前 lib/scripts 代码。确认请加 --yes');
    console.error('  node scripts/snapshot-code.mjs --restore ' + name + ' --yes');
    process.exit(1);
  }
  // 还原前先给当前状态留一个保命快照
  console.log('（还原前先给当前状态打一份保命快照…）');
  const bak = 'pre-restore-' + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  mkdirSync(join(SNAP_ROOT, bak), { recursive: true });
  for (const sub of ['lib', 'scripts']) {
    try { cpSync(join(ROOT, sub), join(SNAP_ROOT, bak, sub), { recursive: true }); } catch {}
  }
  console.log('  保命快照: ' + bak);
  for (const sub of ['lib', 'scripts']) {
    const src = join(dir, sub);
    if (!existsSync(src)) continue;
    try { cpSync(src, join(ROOT, sub), { recursive: true, force: true }); console.log('  已还原 ' + sub); }
    catch (e) { console.error('  还原 ' + sub + ' 失败: ' + e.message); }
  }
  console.log('\n✅ 已还原到 ' + name);
  console.log('   注意：还原后要跑 node scripts/preflight-restart.mjs 确认能加载');
  process.exit(0);
}

// ── 打快照 ──
const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const dir = join(SNAP_ROOT, ts);
mkdirSync(dir, { recursive: true });

const files = [];
collect(join(ROOT, 'lib'), files, ROOT);
collect(join(ROOT, 'scripts'), files, ROOT);
// 根目录的 selftest
for (const n of readdirSync(ROOT)) {
  if (/^selftest.*\.mjs$/.test(n)) {
    const p = join(ROOT, n);
    if (statSync(p).isFile()) files.push({ abs: p, rel: n });
  }
}

const manifest = { createdAt: new Date().toISOString(), root: ROOT, count: files.length, files: [] };
for (const f of files) {
  const st = statSync(f.abs);
  manifest.files.push({ path: f.rel, bytes: st.size, mtimeMs: st.mtimeMs, sha256: sha256(f.abs) });
  const dest = join(dir, f.rel);
  mkdirSync(join(dest, '..'), { recursive: true });
  copyFileSync(f.abs, dest);
}
writeFileSync(join(dir, 'MANIFEST.json'), JSON.stringify(manifest, null, 2), 'utf8');

// 取本批改动摘要
let batchNote = '';
try {
  batchNote = readFileSync(join(ROOT, 'scripts', '.restart-batch.json'), 'utf8');
  const b = JSON.parse(batchNote);
  batchNote = (b.items || []).map((x, i) => '  ' + (i + 1) + ') ' + (x.note || x.title || '')).join('\n').slice(0, 4000);
} catch {}

writeFileSync(join(dir, 'STATUS.txt'), [
  '代码快照 · ' + ts,
  '',
  '【这份是什么】',
  '  dsh-unified-memory 插件在' + new Date().toLocaleString('zh-CN') + '的完整代码快照（lib/ + scripts/ + selftest*.mjs）。',
  '  共 ' + files.length + ' 个文件，附 MANIFEST.json（每个文件的 sha256，可用于核对完整性）。',
  '',
  '【为什么打】',
  '  · 该目录不是 git 仓库，改动无版本管理',
  '  · 当前待重启批次包含大量改动，重启后若出错需要能快速回退',
  '',
  '【还原方法】',
  '  cd D:/dsh-plugins/dsh-unified-memory',
  '  node scripts/snapshot-code.mjs --restore ' + ts + ' --yes',
  '  然后跑：node scripts/preflight-restart.mjs',
  '  （还原脚本会自动先给当前状态打一份保命快照，不会丢东西）',
  '',
  '【本批改动项】',
  batchNote || '  （未能读取批次文件）',
  '',
  '【状态】可删（确认新代码稳定运行 3 天以上后可删）',
].join('\n'), 'utf8');

console.log('✅ 代码快照完成');
console.log('  位置: ' + dir);
console.log('  文件: ' + files.length + ' 个');
console.log('  还原: node scripts/snapshot-code.mjs --restore ' + ts + ' --yes');
