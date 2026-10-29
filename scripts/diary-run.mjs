/**
 * scripts/diary-run.mjs —— 日记本驱动器（补记 / 汇编 / 体检）
 * [2026-10-24 by Assistant] User批「开工 补记」。
 *
 * 用法：
 *   node scripts/diary-run.mjs backfill --days 2026-10-19..2026-10-23 [--book master] [--dry]
 *   node scripts/diary-run.mjs backfill --auto [--max 7]           # 自动找缺页
 *   node scripts/diary-run.mjs assemble --date 2026-10-23
 *   node scripts/diary-run.mjs status
 *
 * 纪律：
 *   - 补记一律标「补记」；模型全挂就用铅笔模板，标「代笔」。
 *   - 只 append，不重写；同一天已有条目就跳过（不重复补）。
 *   - 不碰检索库。
 */
import { existsSync } from 'node:fs';
import * as D from '../lib/diary/index.js';
import { resolveLlm, complete, llmLabel } from '../lib/ingest/llm.js';

const argv = process.argv.slice(2);
const cmd = argv[0] || 'status';
const opt = {};
for (let i = 1; i < argv.length; i += 1) {
  const a = argv[i];
  if (a.startsWith('--')) {
    const k = a.slice(2);
    const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
    opt[k] = v;
  }
}

const ep = resolveLlm({ profilePath: '~/.dsh/profiles/web/cordis.patch.yml' });
console.log('[diary] llm =', llmLabel(ep));

function parseRange(s) {
  const m = /^(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})$/.exec(String(s || ''));
  if (!m) return [String(s)];
  const out = [];
  let cur = m[1];
  for (let i = 0; i < 400; i += 1) {
    out.push(cur);
    if (cur === m[2]) break;
    cur = D.shiftDate(cur, 1);
  }
  return out;
}

async function makeEntry(date, book) {
  const msgs = D.collectDay(date);
  const slices = D.buildSample(msgs, { maxSlices: 36 });
  if (!slices.length) return { ok: false, reason: 'no-material', slices: 0 };
  const body = await complete(ep, D.BOOK_PROMPTS[book] || D.BOOK_PROMPTS.master, D.buildUserPrompt({ date, slices }));
  if (!body || !String(body).trim()) {
    return { ok: true, body: D.pencilBody({ slices, book }), mark: '代笔', slices: slices.length };
  }
  // [2026-10-24 修] 正文后置清洗：模型仍会漏技术细节（实测 LoRA/权重/采样器），这里再筛一次
  const clean = D.sanitizeBody ? D.sanitizeBody(body) : String(body).trim();
  if (!clean || clean.length < 40) {
    return { ok: true, body: D.pencilBody({ slices, book }), mark: '代笔', slices: slices.length };
  }
  return { ok: true, body: clean, mark: '补记', slices: slices.length };
}

async function backfill(dates, book, dry) {
  const done = D.writtenDates(book);
  for (const d of dates) {
    if (done.has(d)) { console.log('  -', d, 'skipped (already has entry)'); continue; }
    const r = await makeEntry(d, book);
    if (!r.ok) { console.log('  -', d, 'skipped:', r.reason); continue; }
    if (dry) { console.log('  -', d, 'DRY', r.mark, r.body.slice(0, 60).replace(/\n/g, ' ')); continue; }
    const w = D.writeEntry(book, { date: d, body: r.body, mark: r.mark, sessionKey: 'backfill', dedupe: false });
    console.log('  -', d, w.ok ? ('written +' + w.delta + 'B (' + r.mark + ', slices=' + r.slices + ')') : ('FAILED ' + w.reason));
  }
}

function autoMissing(book, max) {
  const done = D.writtenDates(book);
  const today = D.localDate();
  const out = [];
  for (let i = Number(max) || 7; i >= 1; i -= 1) {
    const d = D.shiftDate(today, -i);
    if (!done.has(d) && D.l0File(d)) out.push(d);
  }
  return out;
}

async function assemble(date) {
  const text = D.readEntry('master', date);
  if (!text) { console.log('[assemble] no entry for', date); return; }
  const state = D.readState();
  const key = 'assembled:' + date;
  if (state[key]) { console.log('[assemble] already assembled', date); return; }
  const file = D.BOOKS.master;
  const lock = D.acquireLock();
  try {
    const block = ['', '### ' + date + ' · 今日合订', '', text.replace(/^/gm, '> '), ''].join('\n');
    if (!lock.ok) { console.log('[assemble] lock busy, skip'); return; }
    const { appendFileSync } = await import('node:fs');
    appendFileSync(file, block);
    state[key] = new Date().toISOString();
    D.writeState(state);
    console.log('[assemble] appended 今日合订 for', date);
  } finally { if (lock.ok) lock.release(); }
}

if (cmd === 'backfill') {
  const book = opt.book === 'self' ? 'self' : 'master';
  const dates = opt.auto ? autoMissing(book, opt.max) : parseRange(opt.days);
  console.log('[backfill]', dates.join(', '), '→ book =', book);
  await backfill(dates, book, opt.dry === true);
} else if (cmd === 'assemble') {
  await assemble(String(opt.date || D.shiftDate(D.localDate(), -1)));
} else if (cmd === 'status') {
  const cfg = D.loadConfig();
  console.log('[diary] config', JSON.stringify(cfg));
  for (const b of ['master', 'self']) {
    const f = D.BOOKS[b];
    const set = D.writtenDates(b);
    console.log(' -', b, f, existsSync(f) ? ('exists, dates=' + set.size) : 'not created', ' latest=', [...set].sort().pop() || '-');
  }
  console.log(' - missing (auto):', autoMissing('master', 10).join(', ') || 'none');
} else {
  console.log('用法: backfill --days A..B | backfill --auto [--max 7] | assemble --date D | status');
}
