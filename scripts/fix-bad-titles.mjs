#!/usr/bin/env node
/**
 * scripts/fix-bad-titles.mjs —— 存量坏标题清洗（期8.3.2）
 * [2026-10-23 by Assistant · p8-titlefix]
 *
 * 背景：
 *   昨天给 normalize.js 加了坏标题闸门，但**闸门装错了字段** —— L1 卡根本没有
 *   title 字段，只有 scene_name。生产因此照产 29 张坏卡：
 *     4 字泛称（对抗审查/团队恢复/系统调试/反例实测）
 *     session id / UUID（e48e0c35-fde6-…、会话：304d3b5a-…）
 *     英文叙述（Investigation of … / Fixing bugs in G… / Running bench test）
 *   闸门已修（sanitizeTitle 下沉到所有产卡点），但**存量数据仍是坏的**，必须清洗。
 *
 * 做法（append-only，绝不原地改历史行）：
 *   ① 扫 records/*.jsonl 与 engrams.jsonl，按 id 取**最新版本**（last-write-wins）
 *   ② 用**同一条** sanitizeTitle 规则修正（判据只有一份，与生产同源）
 *   ③ 以 append 方式写新版本行（旧行原样保留 ⇒ 可回滚）
 *   ④ title 与 scene_name 两处都处理（这批卡很多 title 为空、标题在 scene_name）
 *   ⑤ --dry 只报告不动盘；非 dry 执行前自动备份
 *
 * 铁律：
 *   - 只 append，不 rewrite、不 delete
 *   - 提不出合格标题的卡**不写新版本**（宁缺毋滥，留待人工，不造垃圾标题）
 *
 * [2026-10-23 · Lead 裁定后] 新增两处收尾：
 *   - MANUAL_TITLES 三道护栏（--check-manual 自检 / 命中打日志 / 顶部注释标一次性）
 *   - 英文标题降级放行后，本脚本对纯英文卡不再依赖人工表（sanitizeTitle 已能自动提炼）
 */
import { readFileSync, readdirSync, appendFileSync, existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { sanitizeTitle, isGoodTitle, isGoodEnglishTitle } from '../lib/ingest/normalize.js';

const ING = '~/.dsh/unified-memory/ingest';
const BACKUP_DIR = '~/_backups/20261023-p8-titles-fix';

const dry = process.argv.includes('--dry');
const checkManual = process.argv.includes('--check-manual');
const only = (() => {
  const i = process.argv.indexOf('--only');
  return i >= 0 ? String(process.argv[i + 1] || '') : '';
})();

// ══════════════════════════════════════════════════════════════════
// MANUAL_TITLES —— **一次性清库用的临时措施**（Lead 2026-10-23 裁定：保留 + 加护栏）
//
//  ⚠️ 这张表**不可扩展**，也不是设计的一部分：
//     它是为 2026-10-23 那批「纯英文正文卡」手工核定的一次性补救。
//     **新卡不应依赖它** —— 新卡标题应由 sanitizeTitle 自动产出
//     （含英文降级放行分支，见 lib/ingest/normalize.js 的 isGoodEnglishTitle）。
//     而不是在这里打补丁。
//
//  三道护栏（Lead 要求）：
//     ① --check-manual：校验每条 id 在库里仍存在、且标题仍对得上 content ⇒ 防幽灵条目
//     ② 命中时打日志，输出用了哪几条 id
//     ③ 顶部这段注释写清「一次性 / 临时 / 新卡不依赖」
// ══════════════════════════════════════════════════════════════════
const MANUAL_TITLES = {
  '<card-id>_zrytfx': 'dualpool 自测脚本路径错位是既有 bug',
  '<card-id>_vqsgx9': 'Graph.js 超级节点 bug 已修复',
  '<card-id>_zx9t8n': 'bench-p8 退化夹具导致两项失败已修复',
  '<card-id>_q3dazb': 'bench-p8 基准测试 40 项全通过',
};
/** 每条人工标题对应的**校验关键词**：用于确认标题仍对得上 content（护栏 ①）。 */
const MANUAL_KEYWORDS = {
  '<card-id>_zrytfx': ['dualpool', 'scripts', 'restart-batch'],
  '<card-id>_vqsgx9': ['Graph.js', 'super-node'],
  '<card-id>_zx9t8n': ['Graph.js', 'fixture', 'bench-p8'],
  '<card-id>_q3dazb': ['Bench test', '40'],
};
/** 命中日志：记录本轮用到了哪几条 id（护栏 ②）。 */
const manualHits = [];

const log = (s) => process.stdout.write(s + '\n');

function readJsonl(p) {
  try {
    return readFileSync(p, 'utf8').split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter((x) => x && typeof x === 'object');
  } catch { return []; }
}

/** 按 id 取最新版本（last-write-wins；无 id 的跳过）。 */
function latestById(rows) {
  const m = new Map();
  for (const r of rows) {
    const id = String(r.id || '').trim();
    if (!id) continue;
    m.set(id, r);
  }
  return m;
}

/** 坏标题判据（isGoodTitle：中文≥6字含中文；无中文时走英文降级分支）。 */
function badTitle(t) {
  const s = String(t || '').trim();
  if (!s) return false;
  return !isGoodTitle(s);
}

/** 决定一张卡的新标题：返回 {changed,...} 或 null（不该改）或 {unfixable:true}。 */
function fixOne(o, isEngram) {
  const content = String(o.content || o.summary || '');
  const curTitle = String(o.title || '').trim();
  const curScene = String(o.scene_name || '').trim();
  // 展示标题：engram 用 title，L1 用 scene_name（这批卡 title 常为空）
  const shown = curTitle || curScene;
  if (!badTitle(shown)) return null;

  const fixed = sanitizeTitle(shown, content);
  // 规则提不出 ⇒ 查人工核定表（一次性措施）
  if (!fixed) {
    const manual = MANUAL_TITLES[String(o.id || '').trim()];
    if (manual && isGoodTitle(manual)) {
      const m = Object.assign({}, o);
      if (isEngram) { m.title = manual; if (curScene) m.scene_name = manual; }
      else { m.scene_name = manual; if (curTitle) m.title = manual; }
      m.updatedAt = new Date().toISOString();
      // 护栏 ②：每次用到人工表都要留下痕迹
      manualHits.push({ id: String(o.id || '').trim(), shown, manual });
      return { changed: true, shown, fixed: manual, manual: true, next: m };
    }
    return { unfixable: true, shown };
  }

  const next = Object.assign({}, o);
  if (isEngram) { next.title = fixed; if (curScene) next.scene_name = fixed; }
  else { next.scene_name = fixed; if (curTitle) next.title = fixed; }
  next.updatedAt = new Date().toISOString();
  return { changed: true, shown, fixed, next };
}

/** 护栏 ①：--check-manual —— 校验人工表每条 id 仍存在、标题仍对得上 content。 */
function runCheckManual() {
  log('══════ MANUAL_TITLES 护栏自检 ══════');
  log('用途：确认这张**一次性**人工表的每一条都没变成「幽灵」');
  log('  （幽灵 = id 已从库里消失，或 content 已变、标题对不上了）');
  log('');
  const ids = Object.keys(MANUAL_TITLES);
  log('表内条目: ' + ids.length + ' 条');
  log('');
  const live = new Map();
  let files = [];
  try { files = readdirSync(ING + '/records').filter((f) => f.endsWith('.jsonl')).sort(); } catch {}
  for (const f of files) {
    for (const [id, o] of latestById(readJsonl(ING + '/records/' + f))) live.set(id, { file: f, o });
  }
  if (existsSync(ING + '/engrams.jsonl')) {
    for (const [id, o] of latestById(readJsonl(ING + '/engrams.jsonl'))) {
      if (!live.has(id)) live.set(id, { file: 'engrams.jsonl', o });
    }
  }
  log('库内最新卡: ' + live.size + ' 张');
  log('');
  let bad = 0;
  for (const id of ids) {
    const title = MANUAL_TITLES[id];
    const kws = MANUAL_KEYWORDS[id] || [];
    const hit = live.get(id);
    if (!hit) {
      log('  [BAD] ' + id + '  库中已不存在（幽灵条目）  标题=' + JSON.stringify(title));
      bad++;
      continue;
    }
    const content = String(hit.o.content || hit.o.summary || '');
    // 关键词校验**大小写不敏感**：实测 content 里写的是 'Dualpool'，表里写 'dualpool' ⇒ 假阳性。
    const low = content.toLowerCase();
    const miss = kws.filter((k) => low.indexOf(String(k).toLowerCase()) < 0);
    if (miss.length) {
      log('  [BAD] ' + id + '  标题与 content 对不上（缺关键词: ' + miss.join(', ') + '）');
      log('        标题=' + JSON.stringify(title));
      log('        content=' + JSON.stringify(content.slice(0, 90)));
      bad++;
      continue;
    }
    const cur = String(hit.o.scene_name || hit.o.title || '');
    const auto = badTitle(cur) ? sanitizeTitle(cur, content) : null;
    log('  [OK]  ' + id + '  ' + hit.file + '  人工标题=' + JSON.stringify(title)
      + (auto ? '   [注: 现可自动提炼=' + JSON.stringify(auto) + '，人工条目可退役]' : '   [当前已是人工标题]'));
  }
  log('');
  if (bad === 0) {
    log('护栏自检通过：0 条幽灵（' + ids.length + '/' + ids.length + ' 仍对得上）');
  } else {
    log('护栏自检失败：' + bad + ' 条需要处理');
  }
  return bad === 0 ? 0 : 1;
}

function run() {
  log('══════ 存量坏标题清洗（期8.3.2）══════');
  log('模式: ' + (dry ? 'DRY（只报告，不写盘）' : '执行'));
  log('数据根: ' + ING);
  log('备份桶: ' + BACKUP_DIR);
  log('');

  let files = [];
  try { files = readdirSync(ING + '/records').filter((f) => f.endsWith('.jsonl')).sort(); } catch {}
  if (only) files = files.filter((f) => f.indexOf(only) >= 0);

  const plan = [];
  const unfixable = [];
  let scanned = 0;

  // ── L1 records ──
  for (const f of files) {
    const rows = readJsonl(ING + '/records/' + f);
    for (const [id, o] of latestById(rows)) {
      scanned++;
      const r = fixOne(o, false);
      if (!r) continue;
      if (r.unfixable) { unfixable.push({ file: f, id, shown: r.shown }); continue; }
      plan.push({ file: f, id, shown: r.shown, fixed: r.fixed, next: r.next, kind: 'L1' });
    }
  }
  // ── engrams ──
  const engPath = ING + '/engrams.jsonl';
  if (existsSync(engPath) && (!only || only === 'engrams')) {
    for (const [id, o] of latestById(readJsonl(engPath))) {
      scanned++;
      const r = fixOne(o, true);
      if (!r) continue;
      if (r.unfixable) { unfixable.push({ file: 'engrams.jsonl', id, shown: r.shown }); continue; }
      plan.push({ file: 'engrams.jsonl', id, shown: r.shown, fixed: r.fixed, next: r.next, kind: 'EG' });
    }
  }

  log('扫描最新卡: ' + scanned + ' 张');
  log('需修正:     ' + plan.length + ' 张');
  log('提不出标题（不动，留待人工）: ' + unfixable.length + ' 张');
  log('');
  const byShown = new Map();
  for (const p of plan) byShown.set(p.shown, (byShown.get(p.shown) || 0) + 1);
  log('── 形态归类（去重后的坏标题 → 出现张数）──');
  for (const [s, n] of byShown) log('  ' + String(n).padStart(3) + ' 张  ' + JSON.stringify(s));
  log('');
  log('── 修正样例（前 20 条）──');
  for (const p of plan.slice(0, 20)) log('  [' + p.kind + '] ' + JSON.stringify(p.shown) + '  →  ' + JSON.stringify(p.fixed));
  if (unfixable.length) {
    log('');
    log('── 提不出合格标题（保留原样，不造垃圾标题）──');
    for (const u of unfixable.slice(0, 20)) log('  ' + u.file + ' ' + u.id + ' ' + JSON.stringify(u.shown));
  }
  // 护栏 ②：用到了人工表就必须显式列出（这张表是一次性措施，用一次少一次）
  if (manualHits.length) {
    log('');
    log('── 本轮命中了 MANUAL_TITLES 人工表（一次性临时措施）──');
    for (const h of manualHits) log('  ' + h.id + '  ' + JSON.stringify(h.shown) + '  →  ' + JSON.stringify(h.manual));
    log('  共 ' + manualHits.length + ' 条。若这类卡反复出现，应去修 sanitizeTitle，而不是往表里补条目。');
  }

  if (dry) {
    log('');
    log('DRY 结束：未写任何文件。去掉 --dry 即执行（执行前会自动备份）。');
    return 0;
  }
  if (plan.length === 0) { log(''); log('无需修正，退出。'); return 0; }

  // ── 备份 ──
  try { mkdirSync(BACKUP_DIR, { recursive: true }); } catch {}
  const stamp = Date.now();
  for (const f of files) {
    const src = ING + '/records/' + f;
    const dst = BACKUP_DIR + '/records-' + f + '.fix-' + stamp;
    try { copyFileSync(src, dst); log('备份: ' + dst); } catch (e) { log('备份失败 ' + src + ': ' + e.message); return 2; }
  }
  try {
    copyFileSync(engPath, BACKUP_DIR + '/engrams.jsonl.fix-' + stamp);
    log('备份: engrams.jsonl.fix-' + stamp);
  } catch (e) { log('备份失败 engrams: ' + e.message); return 2; }

  // ── append 新版本行 ──
  const byFile = new Map();
  for (const p of plan) {
    if (!byFile.has(p.file)) byFile.set(p.file, []);
    byFile.get(p.file).push(p);
  }
  let wrote = 0;
  for (const [f, list] of byFile) {
    const p = f === 'engrams.jsonl' ? engPath : ING + '/records/' + f;
    const lines = list.map((x) => JSON.stringify(x.next)).join('\n') + '\n';
    try { appendFileSync(p, lines, 'utf8'); wrote += list.length; log('写入 ' + f + ': +' + list.length + ' 行'); }
    catch (e) { log('写盘失败 ' + p + ': ' + e.message); return 2; }
  }
  log('');
  log('完成：新版本行 ' + wrote + ' 行（旧行原样保留，可回滚）。');
  return 0;
}

// 护栏 ① 入口：--check-manual 走自检（只读），否则走正常清洗流程。
// 注意用 process.exitCode 而非 process.exit()：后者会丢掉尚未 flush 的 stdout，
//   表现为「rc=0 但输出 0 字节」—— 本轮铁律点名的失败形态。
const rc = checkManual ? runCheckManual() : run();
process.exitCode = rc;