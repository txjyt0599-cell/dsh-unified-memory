#!/usr/bin/env node
/**
 * scripts/backfill-motifs.mjs —— 批量提取 motifs（默认云端，不占本地显存）
 * [2026-10-23 by Assistant]
 *
 * 用法：
 *   node scripts/backfill-motifs.mjs                 云端，8 并发
 *   node scripts/backfill-motifs.mjs --limit 100     只跑 100 张
 *   node scripts/backfill-motifs.mjs --reset         清空旧 motifs 重填
 *   node scripts/backfill-motifs.mjs --dry           只统计不写
 *   node scripts/backfill-motifs.mjs --local         改用本地 llama-swap（占显存）
 *   node scripts/backfill-motifs.mjs --concurrency 4 调并发
 */
import { extractMotifsLLM } from '../lib/ingest/motifs.js';
import { complete, resolveLlm } from '../lib/ingest/llm.js';
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';

const ROOT = '~/.dsh/unified-memory/ingest';
const TDAI = '~/.dsh/unified-memory/memory-tencentdb/memory-tdai/records';
const BAK = '~/_backups/20261023-p8-motifs-backfill';

const DRY = process.argv.includes('--dry');
const RESET = process.argv.includes('--reset');
const USE_LOCAL = process.argv.includes('--local');
const argNum = (name, def) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? Number(process.argv[i + 1]) || def : def;
};
const LIMIT = argNum('--limit', 999999);
const CONCURRENCY = Math.max(1, Math.min(16, argNum('--concurrency', 8)));

const LOCAL_BASE = 'http://127.0.0.1:<PORT>';
const LOCAL_MODEL = 'qwen3.6-35b-apex-txt';

async function autoUnload() {
  try {
    const r = await fetch(LOCAL_BASE + '/api/models/unload', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: LOCAL_MODEL }),
    });
    return r.ok;
  } catch (e) { return false; }
}

async function main() {
  const ep = USE_LOCAL
    ? resolveLlm({ baseUrl: LOCAL_BASE + '/v1', apiKey: 'local', model: LOCAL_MODEL })
    : resolveLlm({ profilePath: '~/.dsh/profiles/web/cordis.patch.yml' });
  if (!ep) { console.log('❌ 无可用端点'); process.exitCode = 1; return; }
  console.log('端点: ' + (USE_LOCAL ? '[本地] ' : '[云端] ') + ep.model + '  并发: ' + CONCURRENCY);

  // 收集文件
  const FILES = [ROOT + '/engrams.jsonl', ROOT + '/records/2026-10-22.jsonl', ROOT + '/records/2026-10-23.jsonl'];
  try {
    if (existsSync(TDAI)) {
      for (const f of readdirSync(TDAI).filter((x) => x.endsWith('.jsonl')).sort()) FILES.push(TDAI + '/' + f);
    }
  } catch (e) {}

  // 备份 + 扫任务
  if (!DRY) { try { mkdirSync(BAK, { recursive: true }); } catch (e) {} }

  const tasks = [];
  const fileLines = new Map();
  let total = 0, skipped = 0;

  for (const f of FILES) {
    if (!existsSync(f)) continue;
    const lines = readFileSync(f, 'utf8').split('\n').filter(Boolean);
    fileLines.set(f, lines);
    for (let li = 0; li < lines.length; li++) {
      let o = null;
      try { o = JSON.parse(lines[li]); } catch { continue; }
      const id = o.id || o.engram_id || o.fact_id;
      if (!id) continue;
      total++;
      if (Array.isArray(o.motifs) && o.motifs.length) {
        if (!RESET) { skipped++; continue; }
        delete o.motifs;
      }
      const text = String(o.title || o.scene_name || '') + ' ' + String(o.content || o.summary || '');
      if (text.trim().length < 15) { skipped++; continue; }
      tasks.push({ file: f, lineIdx: li, obj: o, text });
    }
  }
  console.log('总卡: ' + total + '  待处理: ' + tasks.length + '  跳过: ' + skipped);

  // 并发执行
  const t0 = Date.now();
  let done = 0, cursor = 0;
  async function worker() {
    while (true) {
      const idx = cursor++;
      if (idx >= tasks.length || done >= LIMIT) return;
      const t = tasks[idx];
      let ms = [];
      try { ms = await extractMotifsLLM(ep, t.text, complete); } catch (e) { ms = []; }
      if (ms.length) {
        t.obj.motifs = ms;
        fileLines.get(t.file)[t.lineIdx] = JSON.stringify(t.obj);
        done++;
        if (done % 25 === 0) process.stdout.write('.');
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

  // 写回
  if (!DRY && done > 0) {
    for (const [f, lines] of fileLines) {
      try { writeFileSync(f, lines.join('\n') + '\n', 'utf8'); } catch (e) {}
    }
  }
  console.log('');
  console.log('成功提取: ' + done + '  耗时: ' + ((Date.now() - t0) / 1000).toFixed(1) + 's');
  if (DRY) console.log('(DRY，未写文件)');
  if (USE_LOCAL) {
    const ok = await autoUnload();
    console.log('显存释放: ' + (ok ? '✅ 已卸载' : '⚠️ 失败'));
  } else {
    console.log('显存释放: 云端模式，无需卸载 ✅');
  }
}

main().catch((e) => { console.error('ERR:', e && e.message || e); process.exitCode = 1; });
