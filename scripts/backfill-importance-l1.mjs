/**
 * scripts/backfill-importance-l1.mjs —— L1 records（pm: 卡）回填 importance
 * [2026-10-24 by Assistant] A/B 实测抓到：pm: 卡没有 importance ⇒ 兜底中性 0.55
 *   ⇒ 它们永远拿不到「基石」优待，而最贴题的往往正好是它们。
 *
 * 纪律：L1 records 也是 append-only（同 id 后写覆盖），所以**原位压缩 + 重写**，
 *   不做追加（那是上次踩过的坑：追加会把 alive 按行数翻倍）。
 */
import { readFileSync, writeFileSync, renameSync, existsSync, copyFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
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
const REC_DIR = String(opt.dir || '~/.dsh/unified-memory/ingest/records');
if (!existsSync(REC_DIR)) { console.error('找不到目录：' + REC_DIR); process.exit(1); }

const files = readdirSync(REC_DIR).filter((f) => f.endsWith('.jsonl') && !f.includes('.bak')).sort();
let total = 0, touched = 0, axiom = 0;

for (const name of files) {
  const file = REC_DIR + '/' + name;
  const raw = readFileSync(file, 'utf8');
  const lines = raw.split(/\r?\n/).filter(Boolean);
  const byId = new Map();
  for (const line of lines) {
    let o; try { o = JSON.parse(line); } catch { continue; }
    const id = o && (o.id !== undefined ? String(o.id) : null);
    byId.set(id || ('anon:' + byId.size), o);
  }
  const out = [];
  for (const r of byId.values()) {
    total++;
    const v = Number(r && r.importance);
    if (Number.isFinite(v) && r.is_axiom !== undefined) { out.push(JSON.stringify(r)); continue; }
    const s = scoreImportance({ title: r.title || r.scene_name, summary: '', content: r.content, role: 'user' });
    const next = Object.assign({}, r, {
      importance: Number.isFinite(v) ? v : s.importance,
      is_axiom: r.is_axiom === true || s.is_axiom,
      importance_signals: s.signals,
    });
    if (next.is_axiom) axiom++;
    touched++;
    out.push(JSON.stringify(next));
  }
  if (opt.dry === true) { console.log(name, '→', out.length, '条（待写）'); continue; }
  // 备份 + 原子写
  const bdir = '~/.dsh/unified-memory/diary/backups/l1-' + new Date().toISOString().slice(0, 10);
  try { mkdirSync(bdir, { recursive: true }); copyFileSync(file, bdir + '/' + name); } catch {}
  const tmp = file + '.tmp';
  writeFileSync(tmp, out.join('\n') + '\n', 'utf8');
  renameSync(tmp, file);
  console.log(name, '→', out.length, '条已回填');
}
console.log('\n合计记录:', total, ' 回填:', touched, ' 基石:', axiom);
