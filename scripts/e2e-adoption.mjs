#!/usr/bin/env node
/**
 * scripts/e2e-adoption.mjs —— 采纳核验端到端验证
 * [2026-10-24 by Assistant · goal round 2]
 *
 * 验证链条：注入的卡 id → 模拟回复 → isAdopted → commitAdoptions 落盘 → hits 真的 +1
 * 同时验证反例：陪跑卡（回复里没用到）**不许**涨 hits。
 */
import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isAdopted, commitAdoptions } from '../lib/scoring/adoption.js';
import { dataPath } from '../lib/paths.js';

const SRC = dataPath('ingest/engrams.jsonl');
if (!existsSync(SRC)) { console.error('找不到卡库'); process.exit(1); }

const dir = mkdtempSync(join(tmpdir(), 'adopt-'));
const file = join(dir, 'test-engrams.jsonl');

// 造两张卡：一张会被"用到"，一张是陪跑
const cardA = {
  id: 'test-used', title: '9060XT 显存是 16G', summary: 'Windows 探针误报 4G',
  content: '9060XT 真实显存 16GB，WMI 32位整数溢出会报成 4095MB',
  entities: ['9060XT', '显存'], importance: 0.9, is_axiom: true, hits: 0, createdAt: Date.now(),
};
const cardB = {
  id: 'test-bystander', title: '图片压缩参数', summary: 'WebP q80',
  content: '压图用 WebP 质量 80 比较平衡', entities: ['WebP', '压缩'],
  importance: 0.25, is_axiom: false, hits: 0, createdAt: Date.now(),
};
writeFileSync(file, JSON.stringify(cardA) + '\n' + JSON.stringify(cardB) + '\n', 'utf8');

const reply = '这台机器是 9060XT，它的显存实际有 16GB，Windows 的 WMI 会因为 32 位溢出报成 4G，别信那个数。';

// ── 1. 逐卡判定 ──
const ra = isAdopted(cardA, reply);
const rb = isAdopted(cardB, reply);
console.log('[1] 判定');
console.log('    用到的那张:', JSON.stringify(ra));
console.log('    陪跑的那张:', JSON.stringify(rb));

// ── 2. 提交（只应对 A 加 hits）──
const before = readFileSync(file, 'utf8').split('\n').filter(Boolean).length;
const res = commitAdoptions({ cards: [cardA, cardB], reply, file, nowTs: Date.now() });
const after = readFileSync(file, 'utf8').split('\n').filter(Boolean).length;
console.log('[2] 提交结果:', JSON.stringify(res));
console.log('    行数:', before, '→', after);

// ── 3. 读回最新状态（LWW）──
const byId = new Map();
for (const l of readFileSync(file, 'utf8').split('\n')) {
  if (!l) continue; let o; try { o = JSON.parse(l); } catch { continue; }
  if (o && o.id) byId.set(String(o.id), o);
}
const A = byId.get('test-used');
const B = byId.get('test-bystander');
console.log('[3] 读回');
console.log('    被用的  hits=', A && A.hits, ' lastHitAt=', A && A.lastHitAt ? 'set' : 'null', ' reason=', A && A.hitReason);
console.log('    陪跑的  hits=', B && B.hits);

// ── 4. 判定 ──
const checks = [
  ['① 用到的那张被判采纳', ra.used === true],
  ['② 陪跑的那张没被采纳', rb.used === false],
  ['③ 只追加 1 行（只给 A 加了版本行）', after === before + 1],
  ['④ A 的 hits 变成 1', A && Number(A.hits) === 1],
  ['⑤ B 的 hits 仍是 0（马太死锁没发生）', B && Number(B.hits) === 0],
];
console.log('\n[判定]');
let fail = 0;
for (const [n, okv] of checks) { console.log((okv ? '  ✅ ' : '  ❌ ') + n); if (!okv) fail++; }

try { rmSync(dir, { recursive: true, force: true }); } catch {}
process.exit(fail === 0 ? 0 : 1);
