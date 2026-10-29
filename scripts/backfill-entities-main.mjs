#!/usr/bin/env node
/**
 * backfill-entities-main.mjs —— 主库 entities/motifs 回填
 * [2026-10-24 by Assistant · Round 13]
 *
 * 抓到的缺口：原有 backfill-entities.mjs 只扫 ingest 自产库（records + engrams），
 *   **主库 engram-relay/engrams.jsonl 的 5735 张卡完全没回填**。
 *   而代码注释写着"entities 已落地覆盖 90%+" —— 那句话对自产库成立，对主库不成立。
 *
 * 后果：主库卡在图里只能靠 deriveEntities 退化路径（标题滑窗，产「在和/用户」噪声），
 *       真 entities 一次都没进过图 ⇒ 跨卡联想质量差。
 *
 * 纪律：
 *   · 复用同一个 extractEntities（口径必须一致，不许另写一套）
 *   · 只补缺失的卡，已有 entities 的跳过（幂等）
 *   · 原地压缩写（同 id 只留最后一行），避免上次"追加导致 alive 翻倍"的坑
 *   · 默认 dry-run，--apply 才落盘，落前备份
 */
import { readFileSync, writeFileSync, renameSync, existsSync, copyFileSync, mkdirSync, statSync } from 'node:fs';
import { extractEntities } from '../lib/ingest/entities.js';
import { extractMotifs } from '../lib/ingest/motifs.js';

const argv = process.argv.slice(2);
const opt = {};
for (let i = 0; i < argv.length; i += 1) {
  const a = argv[i];
  if (a.startsWith('--')) {
    const k = a.slice(2);
    const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
    opt[k] = v;
  }
}
const APPLY = opt.apply === true;
const FILE = String(opt.file || '~/.dsh/unified-memory/engram-relay/engrams.jsonl');
if (!existsSync(FILE)) { console.error('找不到：' + FILE); process.exit(1); }

const raw = readFileSync(FILE, 'utf8');
const byId = new Map();
let bad = 0;
for (const line of raw.split(/\r?\n/)) {
  if (!line) continue;
  let o; try { o = JSON.parse(line); } catch { bad++; continue; }
  if (!o || o.id === undefined || o.id === null) continue;
  byId.set(String(o.id), o);
}

let aliveCount = 0, hasEnt = 0, filled = 0, entEmpty = 0, motifsFilled = 0;
const out = [];
for (const [id, c] of byId) {
  const isAlive = (c.status || 'active') !== 'retired';
  if (isAlive) aliveCount++;
  const e0 = Array.isArray(c.entities) ? c.entities : [];
  const m0 = Array.isArray(c.motifs) ? c.motifs : [];
  if (e0.length > 0) { hasEnt++; out.push(JSON.stringify(c)); continue; }
  if (!isAlive) { out.push(JSON.stringify(c)); continue; }

  const title = String(c.title || '');
  const content = String(c.content || c.summary || '');
  let ents = [];
  try { ents = extractEntities({ title, content, scene_name: title, summary: String(c.summary || '') }) || []; } catch { ents = []; }
  let motifs = m0;
  if (!motifs.length) {
    try { motifs = extractMotifs(title + ' ' + content) || []; } catch { motifs = []; }
  }
  if (ents.length === 0) entEmpty++;
  if (motifs.length) motifsFilled++;
  const next = Object.assign({}, c, { entities: ents, motifs: motifs });
  out.push(JSON.stringify(next));
  filled++;
}

const before = statSync(FILE).size;
console.log('[主库 entities 回填]' + (APPLY ? '（真跑）' : '（dry-run）'));
console.log('  文件      : ' + FILE);
console.log('  去重后卡  : ' + byId.size + '（活 ' + aliveCount + '）');
console.log('  已有实体  : ' + hasEnt);
console.log('  待补      : ' + filled);
console.log('  补完仍空  : ' + entEmpty + '（纯中文结论句，抽不出专有名词 —— 属正常边界）');
console.log('  补出情境  : ' + motifsFilled);
console.log('  坏行      : ' + bad);

if (!APPLY) { console.log('\n（加 --apply 才落盘）'); process.exit(0); }

const dir = '~/.dsh/unified-memory/diary/backups';
try { mkdirSync(dir, { recursive: true }); } catch {}
const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
try { copyFileSync(FILE, dir + '/engrams-before-entities-' + ts + '.jsonl'); }
catch (e) { console.error('备份失败，停止：' + (e && e.message)); process.exit(1); }

const tmp = FILE + '.ent.tmp';
writeFileSync(tmp, out.join('\n') + '\n', 'utf8');
renameSync(tmp, FILE);
const after = statSync(FILE).size;
console.log('\n已写回：' + before + ' → ' + after + ' 字节，' + out.length + ' 行');
