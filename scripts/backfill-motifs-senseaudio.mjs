#!/usr/bin/env node
import fs from 'node:fs';
import { dataPath } from '../lib/paths.js';

const ROOT = dataPath('ingest');
const TDAI = dataPath('memory-tencentdb/memory-tdai/records');
const CRED_PATH = '~/.dsh/.credentials.yaml';
const LOG_PATH = join(ROOT, '')_backfill.log';

function log(msg) {
  const line = `[${new Date().toLocaleTimeString()}] ${msg}`;
  console.log(line);
  try {
    fs.appendFileSync(LOG_PATH, line + '\n');
  } catch (e) {}
}

async function run() {
  fs.writeFileSync(LOG_PATH, '=== 回填开始 ===\n');
  log('开始读取 SenseAudio API 凭证...');

  let apiKey = '';
  try {
    const yaml = fs.readFileSync(CRED_PATH, 'utf8');
    for (const l of yaml.split('\n')) {
      if (l.trim().startsWith('SENSEAUDIO_API_KEY:')) {
        apiKey = l.split('SENSEAUDIO_API_KEY:')[1].trim().replace(/^['"]|['"]$/g, '');
        break;
      }
    }
  } catch (e) {
    log('无法读取凭证: ' + e.message);
    process.exit(1);
  }

  if (!apiKey) {
    log('凭证为空');
    process.exit(1);
  }

  const { MOTIF_SYSTEM_PROMPT } = await import('file:///D:/dsh-plugins/dsh-unified-memory/lib/ingest/motifs.js');

  const FILES = [
    ROOT + '/engrams.jsonl',
    ROOT + '/records/2026-10-22.jsonl',
    ROOT + '/records/2026-10-23.jsonl'
  ];

  try {
    if (fs.existsSync(TDAI)) {
      for (const f of fs.readdirSync(TDAI).filter((x) => x.endsWith('.jsonl')).sort()) {
        FILES.push(TDAI + '/' + f);
      }
    }
  } catch (e) {}

  const tasks = [];
  const fileLinesMap = new Map();
  let total = 0, skipped = 0;

  for (const f of FILES) {
    if (!fs.existsSync(f)) continue;
    const lines = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean);
    fileLinesMap.set(f, lines);
    for (let li = 0; li < lines.length; li++) {
      let o = null;
      try { o = JSON.parse(lines[li]); } catch { continue; }
      const id = o.id || o.engram_id || o.fact_id;
      if (!id) continue;
      total++;

      if (Array.isArray(o.motifs) && o.motifs.length > 0) {
        skipped++;
        continue;
      }

      const text = String(o.title || o.scene_name || '') + ' ' + String(o.content || o.summary || '');
      if (text.trim().length < 15) {
        skipped++;
        continue;
      }

      tasks.push({ file: f, lineIdx: li, obj: o, text: text.trim().slice(0, 500) });
    }
  }

  log(`全库总卡数: ${total} | 已有motifs: ${skipped} | 待提取任务: ${tasks.length}`);
  if (tasks.length === 0) {
    log('所有卡片已完成 motifs 提取！');
    return;
  }

  const CONCURRENCY = 12; // 12 并发
  log(`启动 ${CONCURRENCY} 并发通道抽取 (基于 SenseAudio DeepSeek-V4.1-Flash)...`);

  const t0 = Date.now();
  let cursor = 0;
  let done = 0;
  let failed = 0;

  async function extractOne(text, retries = 2) {
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const res = await fetch('https://api.senseaudio.cn/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`
          },
          body: JSON.stringify({
            model: 'deepseek-v4.1-flash',
            messages: [
              { role: 'system', content: MOTIF_SYSTEM_PROMPT },
              { role: 'user', content: text }
            ],
            max_tokens: 1200,
            temperature: 0.1
          })
        });

        if (!res.ok) {
          if (res.status === 429 && attempt < retries) {
            await new Promise(r => setTimeout(r, 1500 * (attempt + 1)));
            continue;
          }
          return [];
        }

        const json = await res.json();
        const content = json.choices?.[0]?.message?.content || '';
        const match = content.match(/\[[\s\S]*?\]/);
        if (match) {
          const arr = JSON.parse(match[0]);
          if (Array.isArray(arr)) {
            return arr.map(x => String(x || '').trim()).filter(Boolean);
          }
        }
        return [];
      } catch (e) {
        if (attempt < retries) {
          await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
        }
      }
    }
    return [];
  }

  // 记录每个文件改动数量，定期刷盘
  let lastFlushedCount = 0;
  function flushToDisk() {
    for (const [f, lines] of fileLinesMap) {
      try {
        fs.writeFileSync(f, lines.join('\n') + '\n', 'utf8');
      } catch (e) {}
    }
    lastFlushedCount = done;
  }

  async function worker() {
    while (true) {
      const idx = cursor++;
      if (idx >= tasks.length) break;

      const task = tasks[idx];
      const ms = await extractOne(task.text);

      if (ms.length > 0) {
        task.obj.motifs = ms;
        const lines = fileLinesMap.get(task.file);
        lines[task.lineIdx] = JSON.stringify(task.obj);
        done++;
      } else {
        failed++;
      }

      const processed = done + failed;
      if (processed % 25 === 0 || processed === tasks.length) {
        const elapsedSec = ((Date.now() - t0) / 1000).toFixed(1);
        const rate = (processed / (Date.now() - t0) * 1000).toFixed(1);
        const remSec = rate > 0 ? Math.round((tasks.length - processed) / rate) : 0;
        log(`进度: ${processed}/${tasks.length} (${((processed/tasks.length)*100).toFixed(1)}%) | 成功: ${done} | 速度: ${rate}张/s | 剩余约: ${remSec}s`);
      }

      // 每提取 50 张自动刷盘一次，杜绝丢失
      if (done - lastFlushedCount >= 50) {
        flushToDisk();
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

  // 最终刷盘
  flushToDisk();
  log('✅ 所有文件持久化完成！');
  const totalSec = ((Date.now() - t0) / 1000).toFixed(1);
  log(`=== 回填结束: 成功 ${done} 张, 失败 ${failed} 张, 总耗时 ${totalSec}s ===`);
}

run().catch(e => {
  log('运行异常崩溃: ' + (e && e.stack || e));
  process.exit(1);
});
