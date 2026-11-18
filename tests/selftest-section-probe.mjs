#!/usr/bin/env node
/** section-render 探针轮转：小阈值隔离测试，不接触生产 probe。 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'pm-section-probe-'));
process.env.PM_DATA_ROOT = join(root, 'data');
process.env.PM_DIARY_ROOT = join(root, 'diary');
try {
  const { createSectionProbeWriter, createSectionRenderer } = await import(new URL('../lib/section.js', import.meta.url).href);
  const file = join(root, 'probe', 'section-render.jsonl');
  const write = createSectionProbeWriter(file, 120);
  write({ seq: 1, text: 'x'.repeat(80) });
  write({ seq: 2, text: 'x'.repeat(80) });
  write({ seq: 3 });
  const archived = readFileSync(file + '.1', 'utf8');
  assert.ok(archived.includes('"seq":2'), '轮转归档应保留触发前内容');
  assert.ok(!archived.includes('"seq":3'), '新记录不得写入旧归档');
  assert.ok(readFileSync(file, 'utf8').includes('"seq":3'), '轮转后当前文件必须继续追加');

  write({ seq: 'fill', text: 'y'.repeat(180) });
  write({ seq: 4 });
  const archived2 = readFileSync(file + '.1', 'utf8');
  assert.ok(archived2.includes('"seq":"fill"'), '第二次轮转应更新唯一 .1');
  assert.ok(!archived2.includes('"seq":2'), '只保留一份历史');
  assert.ok(readFileSync(file, 'utf8').includes('"seq":4'), '第二次轮转后仍写入最新记录');

  const blocked = join(root, 'not-a-directory');
  writeFileSync(blocked, 'x');
  assert.doesNotThrow(() => createSectionProbeWriter(join(blocked, 'probe.jsonl'), 10)({ ok: true }), '探针失败不得抛出');

  const render = createSectionRenderer({ config: { hostAxioms: [] } });
  const a = render({ agent: { session: { id: 'section-probe-test' } } });
  const b = render({ agent: { session: { id: 'section-probe-test' } } });
  assert.equal(a, b, '同状态渲染必须逐字节稳定');
  assert.ok(a.includes('<unified-memory>'), '固定记忆段仍存在');
  console.log('SECTION-PROBE-DONE checks=9 passed=9 failed=0');
} finally {
  rmSync(root, { recursive: true, force: true });
}
