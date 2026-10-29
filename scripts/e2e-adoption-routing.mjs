#!/usr/bin/env node
/**
 * e2e-adoption-routing.mjs —— 采纳写盘分流验证
 * [2026-10-24 by Assistant · Round 9]
 *
 * 抓到的真 bug：所有采纳都写进 ingest/engrams.jsonl，
 * 而主库是 engram-relay/engrams.jsonl ⇒ 主库 hits 永远不涨。
 * 本测试锁「三路分流」规则：
 *   pmi: → 自产 engrams
 *   pm:  → 当天 records/YYYY-MM-DD.jsonl
 *   其余 → 主库 engram-relay
 */
import { writeFileSync, readFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commitAdoptions } from '../lib/scoring/adoption.js';

const dir = mkdtempSync(join(tmpdir(), 'route-'));
const fileMain = join(dir, 'main.jsonl');
const fileOwn = join(dir, 'own.jsonl');
const fileL1 = join(dir, 'l1.jsonl');

const mk = (id, extra) => Object.assign({
  id, title: '9060XT 显存 16G', summary: '探针误报 4G',
  content: '9060XT 真实 16GB', entities: ['9060XT'], hits: 0, createdAt: Date.now(),
}, extra || {});

// 模拟三路分流
const cards = [mk('em-abc'), mk('pmi:xyz'), mk('pm:pm_123'), mk('tdai:m_1')];
const reply = '这台 9060XT 的显存是 16G，别信那个 4G';
const own = [], main = [], l1 = [];
for (const c of cards) {
  const id = String(c.id);
  if (id.startsWith('pmi:')) own.push(c);
  else if (id.startsWith('pm:')) l1.push(c);
  else main.push(c);
}
console.log('分流: main=' + main.length + ' own=' + own.length + ' l1=' + l1.length);

for (const [f, list] of [[fileMain, main], [fileOwn, own], [fileL1, l1]]) {
  if (list.length) writeFileSync(f, list.map((c) => JSON.stringify(c)).join('\n') + '\n', 'utf8');
}
const rm = main.length ? commitAdoptions({ cards: main, reply, file: fileMain }) : { bumped: 0 };
const ro = own.length ? commitAdoptions({ cards: own, reply, file: fileOwn }) : { bumped: 0 };
const rl = l1.length ? commitAdoptions({ cards: l1, reply, file: fileL1 }) : { bumped: 0 };
console.log('结果: main=' + rm.bumped + ' own=' + ro.bumped + ' l1=' + rl.bumped);

const readLast = (f) => {
  if (!existsSync(f)) return null;
  const ls = readFileSync(f, 'utf8').split('\n').filter(Boolean);
  return ls.length ? JSON.parse(ls[ls.length - 1]) : null;
};
const m1 = readLast(fileMain), o1 = readLast(fileOwn), l11 = readLast(fileL1);
console.log('main 末条 hits=' + (m1 && m1.hits), ' own 末条 hits=' + (o1 && o1.hits), ' l1 末条 hits=' + (l11 && l11.hits));

let fail = 0;
const check = (n, ok, d) => { console.log((ok ? '  ✅ ' : '  ❌ ') + n + (d ? '   ' + d : '')); if (!ok) fail++; };
check('主库卡被加分（这是原来漏掉的）', m1 && Number(m1.hits) === 1, 'hits=' + (m1 && m1.hits));
check('自产卡被加分', o1 && Number(o1.hits) === 1, 'hits=' + (o1 && o1.hits));
check('L1 卡被加分', l11 && Number(l11.hits) === 1, 'hits=' + (l11 && l11.hits));
check('三路各写各的文件', rm.bumped === 2 && ro.bumped === 1 && rl.bumped === 1,
  'main=' + rm.bumped + ' own=' + ro.bumped + ' l1=' + rl.bumped + '（main 有 2 张：em-abc + tdai:m_1）');

try { rmSync(dir, { recursive: true, force: true }); } catch {}
console.log('\n' + (fail === 0 ? '✅ 全部通过' : '❌ ' + fail + ' 项失败'));
process.exit(fail === 0 ? 0 : 1);
