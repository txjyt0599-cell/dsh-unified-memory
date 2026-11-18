#!/usr/bin/env node
/**
 * selftest-nudge-e2e.mjs —— nudge 真实 pre-step 沙箱回归
 * 唯一临时根；覆盖同进程、全新进程、ready 后同闸并发、锁失败重试和配置/日记边界。
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const root = mkdtempSync(join(tmpdir(), 'pm-nudge-e2e-'));
process.env.PM_DIARY_ROOT = join(root, 'diary');
process.env.PM_DATA_ROOT = join(root, 'data');
mkdirSync(process.env.PM_DIARY_ROOT, { recursive: true });
mkdirSync(process.env.PM_DATA_ROOT, { recursive: true });
const moduleUrl = new URL('../lib/index.js', import.meta.url).href;
const childCode = `
import { existsSync } from 'node:fs';
const events = new Map();
const mod = await import('${moduleUrl}');
const ctx = {
  logger: { info() {}, warn() {}, debug() {} },
  systemPrompt: { section() { return () => {}; } },
  on(name, fn) { if (!events.has(name)) events.set(name, []); events.get(name).push(fn); return () => {}; },
};
mod.apply(ctx, {
  enabled: true, emit: 'section', freezePerSession: true, injectMaxChars: 8000,
  budgetTokens: 450, order: 0.6, prefetchEnabled: true,
  logs: { dir: process.env.PM_DATA_ROOT + '/logs' },
});
const pre = (events.get('agent/pre-step') || [])[0];
if (!pre) throw new Error('agent/pre-step 未注册');
if (process.env.NUDGE_TEST_GATE) {
  console.log('NUDGE_READY=1');
  const deadline = Date.now() + 15000;
  while (!existsSync(process.env.NUDGE_TEST_GATE)) {
    if (Date.now() > deadline) throw new Error('等待同闸放行超时');
    await new Promise(r => setTimeout(r, 10));
  }
}
const decision = await pre({
  agent: { session: { id: process.env.NUDGE_TEST_SESSION } }, messages: [], turn: 1, step: 1,
}, async () => ({ kind: 'accept', messages: [] }));
const injected = ((decision && decision.messages) || []).some(m =>
  m && m.source && m.source.kind === 'plugin:unified-memory'
  && String(m.content && m.content[0] && m.content[0].text || '').includes('<diary-nudge>'));
console.log('NUDGE_RESULT=' + JSON.stringify({ nudge: injected }));
process.exit(0);
`;

function startChild(session, gate = '') {
  let readyResolve, readyReject;
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  let readySeen = false;
  const readyTimer = setTimeout(() => readyReject(new Error('child ready timeout: ' + session)), 20000);
  const done = new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', childCode], {
      env: { ...process.env, NUDGE_TEST_SESSION: session, NUDGE_TEST_GATE: gate },
      timeout: 25000,
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', d => {
      stdout += d;
      if (!readySeen && stdout.includes('NUDGE_READY=1')) {
        readySeen = true;
        clearTimeout(readyTimer);
        readyResolve();
      }
    });
    child.stderr.on('data', d => { stderr += d; });
    child.on('error', reject);
    child.on('close', code => {
      const line = stdout.split(/\r?\n/).find(x => x.startsWith('NUDGE_RESULT='));
      if (code !== 0 || !line) {
        if (!readySeen) { clearTimeout(readyTimer); readyReject(new Error('child exited before ready')); }
        return reject(new Error('child failed code=' + code + ' stdout=' + stdout + ' stderr=' + stderr));
      }
      if (!gate && !readySeen) { clearTimeout(readyTimer); readySeen = true; readyResolve(); }
      resolve(JSON.parse(line.slice('NUDGE_RESULT='.length)).nudge === true);
    });
  });
  return { ready, done };
}

let dispose = null;
try {
  const D = await import(new URL('../lib/diary/index.js', import.meta.url).href);
  const normalizedRoot = root.replace(/\\/g, '/');
  assert.ok([D.BOOKS.master, D.BOOKS.self, D.STATE_PATH, D.LOCK_PATH].every(p => String(p).startsWith(normalizedRoot)),
    'BOOKS/STATE_PATH/LOCK_PATH 必须全部位于唯一沙箱');

  const mod = await import(moduleUrl);
  const events = new Map();
  const ctx = {
    logger: { info() {}, warn() {}, debug() {} },
    systemPrompt: { section() { return () => {}; } },
    on(name, fn) { if (!events.has(name)) events.set(name, []); events.get(name).push(fn); return () => {}; },
  };
  dispose = mod.apply(ctx, {
    enabled: true, emit: 'section', freezePerSession: true, injectMaxChars: 8000,
    budgetTokens: 450, order: 0.6, prefetchEnabled: true,
    logs: { dir: join(root, 'logs') },
  });
  const pre = (events.get('agent/pre-step') || [])[0];
  assert.ok(pre, 'agent/pre-step 未注册');
  const p = { agent: { session: { id: 'e2e-nudge-session' } }, messages: [], turn: 1, step: 1 };
  const textOf = d => {
    const msgs = (d && d.messages) || [];
    const inj = msgs.filter(m => m && m.source && m.source.kind === 'plugin:unified-memory');
    return inj.length ? String(inj[inj.length - 1].content?.[0]?.text || '') : '';
  };
  const d1 = await pre(p, async () => ({ kind: 'accept', messages: [] }));
  assert.ok(textOf(d1).includes('<diary-nudge>'), '第一步应真实追加 nudge');
  const d2 = await pre(p, async () => ({ kind: 'accept', messages: [] }));
  assert.ok(!textOf(d2).includes('<diary-nudge>'), '同进程第二步不应重复注入');
  const bad = await pre({ agent: { session: { id: 'e2e-no-message-array' } }, messages: [] }, async () => ({ kind: 'accept' }));
  assert.equal(bad.messages, undefined, '非数组 decision.messages 应保持原样');
  const badKey = 'nudge:' + D.localDate() + ':e2e-no-message-array';
  assert.equal(D.readStateStrict()[badKey], undefined, '无可注入边界时不得提前写 claim');

  assert.equal(await startChild('e2e-nudge-restart').done, true, '新会话首次进程应注入');
  assert.equal(await startChild('e2e-nudge-restart').done, false, '全新进程必须读取持久状态并去重');

  // 四个进程都完成 import/apply 后，才由同闸放行；不是无序 spawn 造成的隐式串行。
  const gate = join(root, 'race.gate');
  const runners = Array.from({ length: 4 }, () => startChild('e2e-nudge-race', gate));
  await Promise.all(runners.map(r => r.ready));
  // 在四个进程都已 ready 后放置“死进程陈锁”，同闸做 stale takeover 概率回归；
  // 这不是对所有接管交错序列的形式化证明。
  const dead = spawnSync(process.execPath, ['-e', ''], { encoding: 'utf8' });
  assert.equal(dead.status, 0);
  assert.throws(() => process.kill(dead.pid, 0), undefined, 'stale fixture PID 必须已退出');
  writeFileSync(D.LOCK_PATH, JSON.stringify({ token: 'stale-dead-owner', pid: dead.pid, createdAt: Date.now() - 60000 }), 'utf8');
  writeFileSync(gate, 'go');
  const race = await Promise.all(runners.map(r => r.done));
  assert.equal(race.filter(Boolean).length, 1, '四个已 ready 进程同闸放行只能有一个认领者');
  const raceKey = 'nudge:' + D.localDate() + ':e2e-nudge-race';
  const raceState = JSON.parse(readFileSync(D.STATE_PATH, 'utf8'));
  assert.equal(Object.keys(raceState).filter(k => k === raceKey).length, 1, 'state 必须恰好一个 race key');
  assert.equal(existsSync(D.LOCK_PATH), false, '竞争结束后锁必须释放');

  // 默认接口保留旧幂等文本；once 才启用跨进程 at-most-once。
  const { maybeNudge } = await import(new URL('../lib/diary/scheduler.js', import.meta.url).href);
  const legacyFirst = maybeNudge({ sessionKey: 'e2e-legacy-contract' });
  assert.ok(legacyFirst && maybeNudge({ sessionKey: 'e2e-legacy-contract' }) === legacyFirst,
    '默认 maybeNudge 旧语义必须保持');
  assert.ok(maybeNudge({ sessionKey: 'e2e-once-a', date: '2030-01-01', once: true }));
  assert.equal(maybeNudge({ sessionKey: 'e2e-once-a', date: '2030-01-01', once: true }), null,
    'once 第二次必须返回 null');
  assert.ok(maybeNudge({ sessionKey: 'e2e-once-b', date: '2030-01-01', once: true }), '不同 session 独立');
  assert.ok(maybeNudge({ sessionKey: 'e2e-once-a', date: '2030-01-02', once: true }), '不同 date 独立');

  const held = D.acquireLock(D.LOCK_PATH, 5000);
  assert.ok(held.ok, '测试应能持有全局日记锁');
  const retryKey = 'nudge:' + D.localDate() + ':e2e-lock-retry';
  assert.equal(maybeNudge({ sessionKey: 'e2e-lock-retry', once: true }), null, '锁占用时不得返回文本');
  assert.equal(D.readStateStrict()[retryKey], undefined, '锁占用失败不得写 claim');
  assert.equal(held.release(), true, '真实持有者应能释放自己的锁');
  assert.ok(maybeNudge({ sessionKey: 'e2e-lock-retry', once: true }), '释放后必须允许重试');

  writeFileSync(D.CONFIG_PATH, JSON.stringify({ enabled: true, nudge: false }), 'utf8');
  const offKey = 'nudge:' + D.localDate() + ':e2e-nudge-off';
  assert.equal(maybeNudge({ sessionKey: 'e2e-nudge-off', once: true }), null, '开关关闭不得轻推');
  assert.equal(D.readStateStrict()[offKey], undefined, '开关关闭不得写 claim');
  writeFileSync(D.CONFIG_PATH, JSON.stringify({ enabled: true, nudge: true }), 'utf8');

  writeFileSync(D.BOOKS.master, '## 2030-01-03 00:00 — Assistant的日记\n\n已经写过。\n', 'utf8');
  const writtenKey = 'nudge:2030-01-03:e2e-already-written';
  assert.equal(maybeNudge({ sessionKey: 'e2e-already-written', date: '2030-01-03', once: true }), null,
    '已有日记不得轻推');
  assert.equal(D.readStateStrict()[writtenKey], undefined, '已有日记不得写 claim');
  JSON.parse(readFileSync(D.STATE_PATH, 'utf8'));

  console.log('NUDGE-E2E-DONE all assertions passed');
} finally {
  try { if (typeof dispose === 'function') await dispose(); } catch {}
  rmSync(root, { recursive: true, force: true });
}
