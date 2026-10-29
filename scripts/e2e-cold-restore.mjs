#!/usr/bin/env node
/** scripts/e2e-cold-restore.mjs —— 冷宫回捞验证 */
import { writeFileSync, readFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runColdArchive, restoreFromArchive } from '../lib/scoring/cold-archive.mjs';

const D = 86400000, now = Date.now();
const dir = mkdtempSync(join(tmpdir(), 'coldr-'));
const file = join(dir, 'e.jsonl'), cold = join(dir, 'c.jsonl');
const mk = (id, o) => JSON.stringify(Object.assign({ id, title: id, summary: 's', content: 'c', status: 'active', importance: 0.25, hits: 0, createdAt: now - 200 * D }, o));
writeFileSync(file, [mk('keep', { is_axiom: true }), mk('a'), mk('b')].join('\n') + '\n');

runColdArchive({ file, coldFile: cold, apply: true, nowTs: now });
const act1 = readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).id);
const r = restoreFromArchive(['a'], { file, coldFile: cold });
const act2 = readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).id);
const coldLeft = existsSync(cold) ? readFileSync(cold, 'utf8').split('\n').filter(Boolean).length : 0;

console.log('搬走后活跃:', act1.join(','), ' 回捞:', JSON.stringify(r));
console.log('回捞后活跃:', act2.join(','), ' 冷宫保留:', coldLeft);

const checks = [
  ['① 回捞成功', r.ok === true && r.restored === 1],
  ['② a 回到活跃库', act2.includes('a')],
  ['③ 冷宫**不清空**（只增不删）', coldLeft === 2],
  ['④ 原来的基石还在', act2.includes('keep')],
];
let fail = 0;
console.log('\n[判定]');
for (const [n, okv] of checks) { console.log((okv ? '  ✅ ' : '  ❌ ') + n); if (!okv) fail++; }
try { rmSync(dir, { recursive: true, force: true }); } catch {}
process.exit(fail === 0 ? 0 : 1);
