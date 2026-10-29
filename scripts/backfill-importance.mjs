/**
 * scripts/backfill-importance.mjs —— 存量卡 important / is_axiom 回填
 * [2026-10-24 by Assistant · 红队提醒的老数据兼容]
 *
 * 问题：JSONL 里躺着的 5,735 张老卡，importance 一水 0.6（或 undefined），没有 is_axiom。
 *       不处理直接上乘法门控 ⇒ 老卡全走同一条衰减通道，等于没改。
 *
 * 做法（不重写全库，只追加版本行 —— LWW 读方语义）：
 *   ① 命中硬件/环境铁律的老卡 ⇒ importance 0.9 + is_axiom（免疫时间衰减）
 *   ② 其余 importance 缺失/固定 0.6 且 hits=0 且超过 14 天 ⇒ 降为 0.35（进 21 天通道自然代谢）
 *   ③ 已经有 is_axiom / importance_signals 的卡 ⇒ 跳过（幂等）
 *
 * 用法：node scripts/backfill-importance.mjs [--dry] [--file <path>]
 */
import { readFileSync, existsSync, appendFileSync, copyFileSync, mkdirSync } from 'node:fs';
import { scoreImportance } from '../lib/scoring/importance.js';

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

const FILE = String(opt.file || '~/.dsh/unified-memory/ingest/engrams.jsonl');
if (!existsSync(FILE)) { console.error('找不到卡片文件：' + FILE); process.exit(1); }

// 先备份
if (opt.dry !== true) {
  const dir = '~/.dsh/unified-memory/diary/backups';
  try { mkdirSync(dir, { recursive: true }); } catch {}
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  try { copyFileSync(FILE, dir + '/engrams-before-importance-' + ts + '.jsonl'); } catch {}
}

const now = Date.now();
const rows = readFileSync(FILE, 'utf8').split(/\r?\n/).filter(Boolean);
const latest = new Map();
for (const line of rows) {
  let o; try { o = JSON.parse(line); } catch { continue; }
  if (!o || !o.id) continue;
  latest.set(String(o.id), o);   // LWW：后写的覆盖
}

const out = [];
let axiom = 0, demoted = 0, skipped = 0, kept = 0;
for (const [id, card] of latest) {
  if (card.status === 'retired' || card.status === 'refuted') { skipped++; continue; }
  if (card.is_axiom === true && Number.isFinite(Number(card.importance))) { skipped++; continue; }
  const hits = Number(card.hits) || 0;
  const ageDays = (now - (Number(card.createdAt) || 0)) / 86400000;
  const s = scoreImportance({ title: card.title, summary: card.summary, content: card.content, role: 'user' });
  let next = null;
  if (s.is_axiom) {
    next = Object.assign({}, card, { importance: Math.max(0.9, s.importance), is_axiom: true, importance_signals: s.signals });
    axiom++;
  } else if (hits === 0 && ageDays > 14) {
    next = Object.assign({}, card, { importance: 0.35, is_axiom: false, importance_signals: s.signals });
    demoted++;
  } else if (Number(card.importance) === 0.6 || card.importance === undefined) {
    next = Object.assign({}, card, { importance: s.importance, is_axiom: s.is_axiom, importance_signals: s.signals });
    kept++;
  } else {
    skipped++;
  }
  if (next) out.push(JSON.stringify(next));
}

console.log('卡片总数（去重后）:', latest.size);
console.log('  升级为基石:', axiom);
console.log('  降为流水 0.35:', demoted);
console.log('  重算保留:', kept);
console.log('  跳过:', skipped);
console.log('  待追加行数:', out.length);

if (opt.dry === true) { console.log('（--dry：不落盘）'); process.exit(0); }
if (out.length) {
  appendFileSync(FILE, out.join('\n') + '\n', 'utf8');
  console.log('已追加版本行 →', FILE);
}
