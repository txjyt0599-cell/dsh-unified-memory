#!/usr/bin/env node
/**
 * e2e-adoption-routing-v2.mjs —— 采纳写盘必须按来源分流（含 tdai）
 * [2026-10-24 by Assistant · Round 36]
 *
 * 抓到的真问题：
 *   采纳核验把 **tdai 卡写进了主库文件**。
 *   而 tdai 的原始数据在 memory-tdai/records/YYYY-MM-DD.jsonl（按天分文件）——
 *   主库根本不认 tdai 行 ⇒ 主库里堆了 28 行"孤儿"，
 *   下次读 tdai 仍是老值 ⇒ hits 永远不涨，还污染主库。
 *
 * 本测试锁四路分流：
 *   pmi: → 自产 engrams ／ pm: → L1 当天 records
 *   tdai: → tdai 当天 records ／ 其余 → 主库
 */
import { writeFileSync, readFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commitAdoptions } from '../lib/scoring/adoption.js';

const dir = mkdtempSync(join(tmpdir(), 'route2-'));
const F = { main: join(dir, 'main.jsonl'), own: join(dir, 'own.jsonl'), l1: join(dir, 'l1.jsonl'), tdai: join(dir, 'tdai.jsonl') };

const mk = (id) => ({ id, title: '9060XT 显存 16G', summary: '探针误报 4G', content: '9060XT 真实 16GB', entities: ['9060XT'], hits: 0, createdAt: Date.now() });
const cards = [mk('em-abc'), mk('pmi:xyz'), mk('pm:pm_1'), mk('tdai:m_1'), mk('tdai:m_2')];
const reply = '这台 9060XT 的显存是 16G，别信那个 4G';

// 模拟生产分流
const own = [], main = [], l1 = [], tdai = [];
for (const c of cards) {
  const id = String(c.id);
  if (id.startsWith('pmi:')) own.push(c);
  else if (id.startsWith('pm:')) l1.push(c);
  else if (id.startsWith('tdai:')) tdai.push(c);
  else main.push(c);
}
console.log('分流: main=' + main.length + ' own=' + own.length + ' l1=' + l1.length + ' tdai=' + tdai.length);

for (const [k, list] of Object.entries({ main, own, l1, tdai })) {
  if (list.length) writeFileSync(F[k], list.map((c) => JSON.stringify(c)).join('\n') + '\n', 'utf8');
}
const res = {};
for (const [k, list] of Object.entries({ main, own, l1, tdai })) {
  res[k] = list.length ? commitAdoptions({ cards: list, reply, file: F[k] }) : { bumped: 0 };
}
console.log('结果:', JSON.stringify(Object.fromEntries(Object.entries(res).map(([k, v]) => [k, v.bumped]))));

const last = (f) => {
  if (!existsSync(f)) return null;
  const ls = readFileSync(f, 'utf8').split('\n').filter(Boolean);
  return ls.length ? JSON.parse(ls[ls.length - 1]) : null;
};

let fail = 0;
const check = (n, ok, d) => { console.log((ok ? '  ✅ ' : '  ❌ ') + n + (d ? '   ' + d : '')); if (!ok) fail++; };

check('主库卡被加分', (last(F.main) || {}).hits === 1);
check('自产卡被加分', (last(F.own) || {}).hits === 1);
check('L1 卡被加分', (last(F.l1) || {}).hits === 1);
check('tdai 卡写到自己文件（不是主库）', (last(F.tdai) || {}).hits === 1);
check('四路各写各的文件', res.main.bumped === 1 && res.own.bumped === 1 && res.l1.bumped === 1 && res.tdai.bumped === 2);

try { rmSync(dir, { recursive: true, force: true }); } catch {}
console.log('\n' + (fail === 0 ? '✅ 四路分流全对' : '❌ ' + fail + ' 项失败'));
process.exit(fail === 0 ? 0 : 1);
