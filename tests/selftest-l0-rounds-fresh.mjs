#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRetriever } from '../lib/retrieval/retriever.js';

const root = mkdtempSync(join(tmpdir(), 'l0fresh-'));
const dirA = join(root, 'old-dir');   // 停更旧目录：最后两份文件停在 28/27 天前
const dirB = join(root, 'new-dir');   // 活跃目录：3 天前 ~ 今天
const now = Date.now();
const DAY = 86400000;
function mk(dir) { try { writeFileSync(join(dir, '.keep'), ''); } catch {} }
import { mkdirSync } from 'node:fs';
mkdirSync(dirA, { recursive: true }); mkdirSync(dirB, { recursive: true });
function localDay(ts) {
  const d = new Date(ts);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function round(id, user, answer, ts) {
  return [
    JSON.stringify({ id: id + '-u', sessionKey: 'session-test', role: 'user', content: user, timestamp: ts }),
    JSON.stringify({ id: id + '-a', sessionKey: 'session-test', role: 'assistant', content: answer, timestamp: ts + 1 }),
  ].join('\n') + '\n';
}
function appendRound(dir, ts, id, user, answer) {
  writeFileSync(join(dir, localDay(ts) + '.jsonl'), round(id, user, answer, ts), { flag: 'a' });
}
const ts28 = now - 28 * DAY, ts27 = now - 27 * DAY;
const ts3 = now - 3 * DAY, ts2 = now - 2 * DAY, ts1 = now - 1 * DAY, ts0 = now - 60000;
appendRound(dirA, ts28, 'a28', '旧目录二十八天前', '旧目录二十八天前结论');
appendRound(dirA, ts27, 'a27', '旧目录二十七天前', '旧目录二十七天前结论');
appendRound(dirB, ts3, 'b3', '三天前旧轮次', '三天前结论');
appendRound(dirB, ts2, 'b2', '两天前轮次', '两天前结论');
appendRound(dirB, ts1, 'b1', '昨天轮次', '昨天结论');
appendRound(dirB, ts0, 'b0', '今天第一轮', '今天结论');
const r = createRetriever({ l0Enabled: true, l0RecentDays: 30, conversationsDir: [dirA, dirB], l0RefreshMs: 0 }, {});
await r.warmup();
const before = r.health().l0 && r.health().l0.rounds;
assert.ok(before >= 6, 'warmup should load 6 rounds, got ' + before);
// 这次调用本身会触发 15s 刷新（l0RefreshMs:0）；旧代码会在这里丢掉 3 天前卡。
const firstRounds = r.recentRounds({ sinceMs: 30 * DAY, limit: 10, perSessionCap: 10 });
const oldRound = firstRounds.find(x => x.user === '三天前旧轮次');
assert.ok(oldRound && r.getCard(oldRound.id), '3-day round must exist after refresh');
const oldId = oldRound.id;
appendRound(dirB, now, 'b0b', '第二轮最新', '第二轮最新答案');
const y = r.recentRounds({ sinceMs: 6 * 3600e3, excludeSessionId: 'session-other' });
assert.ok(y.length >= 1 && y[0].user === '第二轮最新', 'latest round refreshed after append');
assert.ok(y[0].answer.includes('第二轮最新答案'), 'latest answer visible');
const after = r.health().l0 && r.health().l0.rounds;
assert.ok(r.health().l0 && r.health().l0.refreshedAt > 0, 'recentRounds must actually refresh (refreshedAt)');
assert.ok(after >= before, 'refresh must not shrink L0 history: before=' + before + ' after=' + after);
assert.ok(r.getCard(oldId), '3-day round must survive dual-dir refresh: ' + oldId);
rmSync(root, { recursive: true, force: true });
console.log('L0-ROUNDS-FRESH-DONE checks=7 passed=7 failed=0');
