#!/usr/bin/env node
/**
 * scripts/concurrency-probe.mjs —— 真·跨进程并发验证（红队 R3 P1 要求）
 * [2026-10-22 by Assistant]
 *
 * 为什么要子进程：Node 单线程 + 同步 fs，`Promise.all` 里的两个 capture 实际顺序执行，
 *   用它证明不了锁在真并发下有効。这里起 **8 个独立 node 进程**同时打同一个 session。
 *
 * 两个阶段：
 *   ① 争抢写入：8 进程各写 2 条，检查无重复行、无静默丢、全部到齐
 *   ② 显式锁竞争：一个进程持锁 3 秒，4 个进程同时抢 ⇒ 必须全部报 locked，且零越权写入
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dirs, ensureDirs } from '../lib/ingest/core.js';

const N = 8;
const CAPTURE_URL = 'file:///D:/dsh-plugins/dsh-unified-memory/lib/ingest/capture.js';
const CORE_URL = 'file:///D:/dsh-plugins/dsh-unified-memory/lib/ingest/core.js';
const root = mkdtempSync(join(tmpdir(), 'pm-conc-'));
const d = dirs(root);
ensureDirs(d);

let fail = 0;
const ok = (n, c, dd) => { console.log((c ? '  ✅ ' : '  ❌ ') + n + (dd === undefined ? '' : '   ' + dd)); if (!c) fail++; };

const collect = () => {
  const ids = [];
  if (existsSync(d.conversations)) {
    for (const f of readdirSync(d.conversations).filter((x) => x.endsWith('.jsonl'))) {
      for (const line of readFileSync(d.conversations + '/' + f, 'utf8').split('\n')) {
        if (!line) continue;
        try { ids.push(JSON.parse(line).id); } catch {}
      }
    }
  }
  return ids;
};
const spawnP = (file, args) => new Promise((resolve) => {
  const p = spawn(process.execPath, [file, root, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = '';
  p.stdout.on('data', (c) => { out += c; });
  p.stderr.on('data', (c) => { err += c; });
  p.on('close', () => resolve({ out, err }));
});
const lastJson = (s) => { try { return JSON.parse(s.split('\n').filter(Boolean).pop()); } catch { return null; } };

// ── 子进程脚本 ──
writeFileSync(join(root, 'writer.mjs'), `
import { captureTurn } from '${CAPTURE_URL}';
const root = process.argv[2];
const idx = Number(process.argv[3]);
const T = 1793300000000;
try {
  const out = captureTurn({
    sessionKey: 'conc',
    messages: [
      { id: 'm' + idx + 'a', role: 'user', content: '并发探针消息 ' + idx + 'A，内容足够长以通过过滤条件。', timestamp: T + idx * 10 },
      { id: 'm' + idx + 'b', role: 'assistant', content: '并发探针消息 ' + idx + 'B，内容足够长以通过过滤条件。', timestamp: T + idx * 10 + 1 },
    ],
    opts: { root },
  });
  console.log(JSON.stringify(out));
} catch (e) { console.log(JSON.stringify({ error: String(e && e.message || e) })); }
`, 'utf8');

writeFileSync(join(root, 'holder.mjs'), `
import { acquireLock, dirs } from '${CORE_URL}';
const root = process.argv[2];
const l = acquireLock(dirs(root), 'capture-conc', 60000);
console.log(l ? 'HELD' : 'BUSY');
await new Promise(r => setTimeout(r, 3000));
if (l) l.release();
`, 'utf8');

writeFileSync(join(root, 'trier.mjs'), `
import { captureTurn } from '${CAPTURE_URL}';
const root = process.argv[2];
const T = 1793400000000;
try {
  const out = captureTurn({
    sessionKey: 'conc',
    messages: [{ id: 'x' + process.argv[3], role: 'user', content: '持锁期间尝试写入，必须被明确拒绝而不是并发踩踏。', timestamp: T + Number(process.argv[3]) }],
    opts: { root },
  });
  console.log(JSON.stringify(out));
} catch (e) { console.log(JSON.stringify({ error: String(e && e.message || e) })); }
`, 'utf8');

// ── 阶段 1 ──
console.log('阶段 1：起 ' + N + ' 个真实子进程同时写');
const runs = await Promise.all(Array.from({ length: N }, (_, i) => spawnP(join(root, 'writer.mjs'), [String(i)])));
const parsed = runs.map((r) => lastJson(r.out) || { error: r.err.slice(0, 80) });
console.log('  各进程: ' + JSON.stringify(parsed.map((r) => r.error ? 'ERR' : (r.reason || ('w' + r.written)))));
ok('没有子进程报错', parsed.every((r) => !r.error), JSON.stringify(parsed.filter((r) => r.error).map((r) => r.error)));
const ids = collect();
const written = parsed.reduce((a, r) => a + (r.written || 0), 0);
ok('至少一个进程写入成功', written > 0, 'total=' + written);
ok('落盘无重复 id', new Set(ids).size === ids.length, 'rows=' + ids.length);
ok('落盘行数 = 各进程 written 之和', ids.length === written, 'rows=' + ids.length + ' written=' + written);
ok('被拒进程都有明确 reason', parsed.every((r) => (r.written || 0) > 0 || r.reason));

// 反复重试直到到齐
for (let round = 0; round < 15; round++) await Promise.all(Array.from({ length: N }, (_, i) => spawnP(join(root, 'writer.mjs'), [String(i)])));
const ids2 = collect();
ok('反复重试后 16 条全部到齐', new Set(ids2).size === N * 2, 'uniq=' + new Set(ids2).size);
ok('且仍无重复行', ids2.length === new Set(ids2).size, 'rows=' + ids2.length);

// ── 阶段 2：显式锁竞争 ──
console.log('');
console.log('阶段 2：显式锁竞争（持锁 3 秒，4 进程同时抢）');
const holderP = spawnP(join(root, 'holder.mjs'), []);
await new Promise((r) => setTimeout(r, 500));
const tries = await Promise.all([0, 1, 2, 3].map((i) => spawnP(join(root, 'trier.mjs'), ['t' + i])));
const holderOut = (await holderP).out.trim();
const parsedTries = tries.map((r) => lastJson(r.out) || {});
console.log('  持锁方: ' + holderOut);
console.log('  抢锁方: ' + JSON.stringify(parsedTries.map((x) => x.reason || ('w' + x.written))));
ok('持锁方确实拿到锁', holderOut === 'HELD', holderOut);
ok('持锁期间其他进程全部报 locked', parsedTries.every((x) => x.reason === 'locked'), JSON.stringify(parsedTries.map((x) => x.reason)));
ok('持锁期间零越权写入', parsedTries.every((x) => (x.written || 0) === 0));
const after = lastJson((await spawnP(join(root, 'trier.mjs'), ['after'])).out) || {};
ok('锁释放后能正常写入', (after.written || 0) === 1, JSON.stringify(after));

console.log('');
console.log(fail === 0 ? '✅ 跨进程并发验证通过' : '❌ 有 ' + fail + ' 项失败');
try { rmSync(root, { recursive: true, force: true }); } catch {}
process.exitCode = fail === 0 ? 0 : 1;
