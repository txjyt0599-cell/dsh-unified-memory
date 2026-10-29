#!/usr/bin/env node
/**
 * scripts/e2e-cold-archive.mjs —— 冷宫归档端到端验证（临时库，不动生产）
 * [2026-10-24 by Assistant · Step 4]
 *
 * 生产库最老卡才 45 天，按 60 天阈值天然搬不动 —— 这是**正确行为**，
 * 但不能因此就说"功能没问题"。这里用合成的临时库验证：
 *   ① 该搬的真的搬走了（老流水）
 *   ② 不该搬的一样都不动（基石 / 重要 / 用过的 / 新的）
 *   ③ 冷宫是 append（只增不删），活跃库只减掉被搬的
 *   ④ 搬完总数守恒：活跃 + 冷宫 = 原活跃
 */
import { writeFileSync, readFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runColdArchive } from '../lib/scoring/cold-archive.mjs';

const D = 86400000;
const now = Date.now();
const dir = mkdtempSync(join(tmpdir(), 'cold-'));
const file = join(dir, 'engrams.jsonl');
const coldFile = join(dir, 'cold.jsonl');

const mk = (id, over) => JSON.stringify(Object.assign({
  id, title: '测试卡 ' + id, summary: 's', content: 'c',
  status: 'active', importance: 0.25, hits: 0, createdAt: now - 200 * D,
}, over));

const cards = [
  mk('axiom-old', { is_axiom: true, importance: 0.9 }),
  mk('important-old', { importance: 0.6 }),
  mk('used-old', { hits: 5 }),
  mk('fresh-flow', { createdAt: now - 5 * D }),
  mk('cold-flow-1'),
  mk('cold-flow-2'),
  mk('retired-old', { status: 'retired' }),
];
writeFileSync(file, cards.join('\n') + '\n', 'utf8');

const before = readFileSync(file, 'utf8').split('\n').filter(Boolean).length;
const dry = runColdArchive({ file, coldFile, apply: false, nowTs: now });
const res = runColdArchive({ file, coldFile, apply: true, nowTs: now });

const afterActive = readFileSync(file, 'utf8').split('\n').filter(Boolean);
const afterCold = existsSync(coldFile) ? readFileSync(coldFile, 'utf8').split('\n').filter(Boolean) : [];
const idsActive = new Set(afterActive.map((l) => JSON.parse(l).id));
const idsCold = new Set(afterCold.map((l) => JSON.parse(l).id));

console.log('dry-run:', JSON.stringify({ move: dry.move, reasons: dry.reasons }));
console.log('apply  :', JSON.stringify({ move: res.move, reasons: res.reasons, stay: res.stay }));
console.log('活跃库:', afterActive.length, ' 冷宫:', afterCold.length);

const checks = [
  ['① 基石没被搬', idsActive.has('axiom-old') && !idsCold.has('axiom-old')],
  ['② 重要卡没被搬', idsActive.has('important-old') && !idsCold.has('important-old')],
  ['③ 用过的没被搬', idsActive.has('used-old') && !idsCold.has('used-old')],
  ['④ 新卡没被搬', idsActive.has('fresh-flow') && !idsCold.has('fresh-flow')],
  ['⑤ 已退休的没被搬', idsActive.has('retired-old') && !idsCold.has('retired-old')],
  ['⑥ 两张老流水被搬走', idsCold.has('cold-flow-1') && idsCold.has('cold-flow-2') && !idsActive.has('cold-flow-1')],
  ['⑦ 冷宫数是 2', afterCold.length === 2],
  ['⑧ 守恒：活跃 + 冷宫 = 原数', afterActive.length + afterCold.length === before],
  ['⑨ dry-run 不落盘（且预测数与 apply 一致）', dry.move === res.move],
];
console.log('\n[判定]');
let fail = 0;
for (const [n, okv] of checks) { console.log((okv ? '  ✅ ' : '  ❌ ') + n); if (!okv) fail++; }

try { rmSync(dir, { recursive: true, force: true }); } catch {}
process.exit(fail === 0 ? 0 : 1);
