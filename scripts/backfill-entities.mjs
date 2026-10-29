#!/usr/bin/env node
/**
 * scripts/backfill-entities.mjs —— 期8.3.1：存量卡 entities 回填
 * [2026-10-23 by Assistant · 期8.3.1]
 *
 * 背景：生产卡 9083 张，零 entities 字段 => 超图只能走 graph.js 的 deriveEntities
 *       退化路径（标题滑窗抽词元），产出「在和」「用户」这类噪声。
 *       新卡已在 extract.js / distill.js 自产 entities（同规则），
 *       本脚本把存量补成同一口径，让新卡与旧卡在二部图里可比。
 *
 * 手法（关键约束：append-only，不原地重写整文件）：
 *   参照 distill.js 的 retireLines 套路 —— 对要改的卡追加一条同名同 id 的
 *   新版本行到文件末尾（last-write-wins）。原行一字不动，可回滚。
 *
 * 用法：
 *   node scripts/backfill-entities.mjs --dry          # 只预演
 *   node scripts/backfill-entities.mjs                # 真跑（前自动备份）
 *   node scripts/backfill-entities.mjs --root=<dir>   # 指定 ingest 根
 */
import { readFileSync, existsSync, readdirSync, writeFileSync, mkdirSync, copyFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirs } from '../lib/ingest/core.js';
import { extractEntities } from '../lib/ingest/entities.js';
import { dataPath } from '../lib/paths.js';
import { join } from 'node:path';
import { tmpdir as osTmpdir } from 'node:os';

const argv = process.argv.slice(2);
const has = (f) => argv.some((a) => a === f || a.startsWith(f + '='));
const val = (f, dflt) => {
  const hit = argv.find((a) => a === f || a.startsWith(f + '='));
  if (!hit) return dflt;
  const i = hit.indexOf('=');
  return i < 0 ? dflt : hit.slice(i + 1);
};

const DRY = has('--dry');
const ROOT = val('--root', dataPath('ingest'));
const BACKUP_DIR = val('--backup', join(osTmpdir(), '20261023-p8-entities'));
const MAX_ENTITIES = Number(val('--max', '12'));

function sha256(file) {
  try { return createHash('sha256').update(readFileSync(file)).digest('hex'); }
  catch { return 'unreadable'; }
}

function readJsonl(file) {
  const rows = [];
  let raw = '';
  try { raw = readFileSync(file, 'utf8'); } catch { return { rows, raw: '' }; }
  const lines = raw.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const s = lines[i].trim();
    if (!s) continue;
    let o = null;
    try { o = JSON.parse(s); } catch { continue; }
    if (!o || typeof o !== 'object') continue;
    rows.push({ idx: i, obj: o, text: s });
  }
  return { rows, raw };
}

function targetFiles(d) {
  const out = [];
  if (existsSync(d.records)) {
    try {
      for (const n of readdirSync(d.records).filter((f) => f.endsWith('.jsonl')).sort()) {
        out.push({ file: d.records + '/' + n, kind: 'records', name: n });
      }
    } catch {}
  }
  if (existsSync(d.engrams)) out.push({ file: d.engrams, kind: 'engrams', name: 'engrams.jsonl' });
  return out;
}

const d = dirs(ROOT);
if (!existsSync(d.records) && !existsSync(d.engrams)) {
  console.error('X ingest 根不存在或既无 records/ 也无 engrams.jsonl: ' + ROOT);
  console.error('   用 --root=<dir> 指定正确的 ingest 根。');
  process.exit(1);
}

const files = targetFiles(d);
console.log('期8.3.1 · 存量 entities 回填' + (DRY ? '（--dry 预演，不动盘）' : '（真跑）'));
console.log('  ingest 根: ' + ROOT);
console.log('  目标文件: ' + files.length + ' 个');

const plan = [];
let scannedCards = 0;
let alreadyHas = 0;
let needFill = 0;
let emptyAfterRule = 0;

for (const f of files) {
  const { rows } = readJsonl(f.file);
  // [2026-10-23 幂等补丁] 先扫一遍「本文件里哪些 id 已经有 entities」。
  //   回填是 append-only：同一张卡的**原行**永远没有 entities，若只看当前行，
  //   第二次运行会给已回填过的卡再追加一条版本行 => 文件无限膨胀。
  //   判据改成「该 id 在文件任意一行上已有非空 entities => 整张卡跳过」。
  const idsWithEnt = new Set();
  for (const r of rows) {
    if (Array.isArray(r.obj.entities) && r.obj.entities.length > 0) {
      const k = String(r.obj.id || r.obj.fact_id || '');
      if (k) idsWithEnt.add(k);
    }
  }
  let total = 0; let missing = 0; const todo = [];
  for (const r of rows) {
    total++;
    const hasE = Array.isArray(r.obj.entities);
    if (hasE && r.obj.entities.length > 0) { alreadyHas++; continue; }
    const k = String(r.obj.id || r.obj.fact_id || '');
    if (k && idsWithEnt.has(k)) continue;   // 本卡已有回填行
    missing++;
    const ents = extractEntities(r.obj, { maxEntities: MAX_ENTITIES });
    if (ents.length === 0) { emptyAfterRule++; continue; }
    todo.push({ obj: r.obj, entities: ents });
  }
  scannedCards += total;
  needFill += todo.length;
  if (todo.length) plan.push({ file: f.file, kind: f.kind, name: f.name, todo, total, missing });
}

console.log('');
console.log('  · 扫描卡片总数: ' + scannedCards);
console.log('  · 已有 entities: ' + alreadyHas);
console.log('  · 缺 entities（待回填）: ' + needFill);
console.log('  · 规则抽不出实体（跳过）: ' + emptyAfterRule);
console.log('');

if (needFill === 0) {
  console.log('  -> 无需回填，退出。');
  process.exit(0);
}

{
  let shown = 0;
  for (const p of plan) {
    for (const t of p.todo) {
      if (shown >= 8) break;
      const title = String(t.obj.title || t.obj.content || t.obj.scene_name || '').slice(0, 42);
      console.log('  [' + p.kind + '] ' + title);
      console.log('       -> ' + JSON.stringify(t.entities));
      shown++;
    }
    if (shown >= 8) break;
  }
  console.log('');
}

if (DRY) {
  console.log('  --dry 结束：未写入任何文件。去掉 --dry 才会真跑。');
  console.log('  真跑前会自动备份到: ' + BACKUP_DIR);
  process.exit(0);
}

{
  let ok = 0; let fail = 0; const manifest = [];
  try { mkdirSync(BACKUP_DIR, { recursive: true }); } catch {}
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  for (const p of plan) {
    const base = p.kind + '__' + p.name.replace(/[\\/]/g, '_');
    const dst = BACKUP_DIR + '/' + stamp + '__' + base;
    try {
      copyFileSync(p.file, dst);
      let sz = 0; try { sz = statSync(p.file).size; } catch {}
      manifest.push(base + '  ' + sha256(p.file) + '  ' + sz + 'B');
      ok++;
    } catch (e) { fail++; manifest.push(base + '  BACKUP-FAILED: ' + String(e && e.message)); }
  }
  try {
    writeFileSync(BACKUP_DIR + '/' + stamp + '__BACKUP-MANIFEST.txt',
      '期8.3.1 回填前备份（' + new Date().toISOString() + '）\n'
      + '来源 ingest 根: ' + ROOT + '\n'
      + '文件  改前sha256  大小\n' + manifest.join('\n') + '\n', 'utf8');
  } catch {}
  console.log('  · 备份: ' + ok + ' 个成功' + (fail ? '，' + fail + ' 个失败' : '') + ' -> ' + BACKUP_DIR);
  if (fail) { console.error('X 有文件备份失败，拒绝继续（不能无备份改盘）。'); process.exit(1); }
}

const t0 = process.hrtime.bigint();
let writtenLines = 0; let fileTouched = 0;
for (const p of plan) {
  const nowIso = new Date().toISOString();
  const out = [];
  for (const t of p.todo) {
    const row = Object.assign({}, t.obj, {
      entities: t.entities,
      entitiesBackfilledAt: nowIso,
      updatedAt: nowIso,
    });
    out.push(JSON.stringify(row));
  }
  if (out.length === 0) continue;
  try {
    const raw = readFileSync(p.file, 'utf8');
    const needNl = raw.length > 0 && !raw.endsWith('\n');
    writeFileSync(p.file, (needNl ? '\n' : '') + out.join('\n') + '\n', { flag: 'a', encoding: 'utf8' });
    writtenLines += out.length;
    fileTouched++;
  } catch (e) {
    console.error('  X 写入失败（跳过该文件）: ' + p.file + '  ' + String(e && e.message));
  }
}
const t1 = process.hrtime.bigint();
const ms = Number(t1 - t0) / 1e6;

console.log('');
console.log('  · 已追加版本行: ' + writtenLines + ' 行，涉及文件 ' + fileTouched + ' 个');
console.log('  · 耗时: ' + ms.toFixed(1) + ' ms（' + (writtenLines ? (ms / writtenLines).toFixed(3) : '0') + ' ms/行）');
console.log('  OK 回填完成。原行未改动；回滚 = 用备份目录里的同名文件覆盖。');
process.exit(0);
