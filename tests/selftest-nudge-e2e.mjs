#!/usr/bin/env node
/**
 * selftest-nudge-e2e.mjs —— nudgedSessions 真实 pre-step 沙箱回归
 * 隔离 PM_DIARY_ROOT/PM_DATA_ROOT，绝不碰生产日记；同一会话连续两步只允许 1 次 <diary-nudge>。
 */
import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const root = join(tmpdir(), 'dsh-unified-nudge-e2e-' + process.pid);
try { rmSync(root, { recursive: true, force: true }); } catch {}
mkdirSync(root + '/diary', { recursive: true });
mkdirSync(root + '/data', { recursive: true });
process.env.PM_DIARY_ROOT = root + '/diary';
process.env.PM_DATA_ROOT = root + '/data';
const mod = await import(pathToFileURL(fileURLToPath(new URL('../lib/index.js', import.meta.url))).href);
const events = new Map();
const ctx = {
  logger: { info() {}, warn() {}, debug() {} },
  systemPrompt: { section() { return () => {}; } },
  on(name, fn) { if (!events.has(name)) events.set(name, []); events.get(name).push(fn); return () => {}; },
};
mod.apply(ctx, {
  enabled: true, emit: 'section', freezePerSession: true, injectMaxChars: 8000,
  budgetTokens: 450, order: 0.6, prefetchEnabled: true,
  logs: { dir: root + '/logs' },
});
const pre = (events.get('agent/pre-step') || [])[0];
assert.ok(pre, 'agent/pre-step 未注册');
const p = { agent: { session: { id: 'e2e-nudge-session' } }, messages: [], turn: 1, step: 1 };
const textOf = (d) => {
  const msgs = (d && d.messages) || [];
  const inj = msgs.filter(m => m && m.source && m.source.kind === 'plugin:unified-memory');
  return inj.length ? String(inj[inj.length - 1].content?.[0]?.text || '') : '';
};
const d1 = await pre(p, async () => ({ kind: 'accept', messages: [] }));
const t1 = textOf(d1);
assert.ok(t1.includes('<diary-nudge>'), '第一步应真实追加 nudge');
const d2 = await pre(p, async () => ({ kind: 'accept', messages: [] }));
const t2 = textOf(d2);
assert.ok(!t2.includes('<diary-nudge>'), '第二步不应重复注入 nudge');
console.log('NUDGE-E2E-DONE checks=2 passed=2 failed=0');
