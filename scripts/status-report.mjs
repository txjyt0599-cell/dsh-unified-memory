#!/usr/bin/env node
/**
 * status-report.mjs —— 项目状态总报告（可重复运行）
 * [2026-10-24 by Assistant · Round 35]
 *
 * 为什么要它：
 *   改了 30+ 轮之后，"现在到底是什么状态"已经说不清了。
 *   手写文档会过期，所以做成**能重复跑的报告** —— 每次跑都是当下真实状态。
 *
 * 它把散落在各处的关键指标汇总成一张表：
 *   卡片规模 / 字段覆盖 / 代谢状态 / 检索能力 / 测试规模 / 运行环境
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { readCards, readTdaiRecords, readOwnIngest } from '../lib/hypergraph/source.js';
import { loadLiveConfig } from '../lib/ingest/config.js';

const ROOT = 'D:/dsh-plugins/dsh-unified-memory';
const WAKE = '~/.dsh/unified-memory/logs/wake.log';

const line = (k, v) => console.log('  ' + String(k).padEnd(26) + v);

console.log('══════ dsh-unified-memory · 状态报告 ══════');
console.log('  生成时间: ' + new Date().toLocaleString('zh-CN'));

// ── ① 卡片规模 ──
console.log('');
console.log('── ① 卡片规模 ──');
const engram = readCards().alive;
const tdai = (readTdaiRecords().cards || []);
const own = (readOwnIngest().cards || []);
const all = [...engram, ...tdai, ...own];
line('主库 engram', engram.length);
line('tdai 历史', tdai.length);
line('自产（L1+蒸馏）', own.length);
line('合计', all.length);

// ── ② 字段覆盖 ──
console.log('');
console.log('── ② 关键字段覆盖 ──');
const cover = (name, fn) => {
  const hit = all.filter((c) => { try { return fn(c); } catch { return false; } }).length;
  line(name, hit + '/' + all.length + ' (' + ((hit / all.length) * 100).toFixed(1) + '%)');
};
cover('有 importance', (c) => Number.isFinite(Number(c.importance)));
cover('有 entities', (c) => Array.isArray(c.entities) && c.entities.length > 0);
cover('有 createdAt', (c) => Number(c.createdAt) > 0);
cover('有标题（非占位）', (c) => String(c.title || '').trim().length > 2 && !/^（无标题）$/.test(String(c.title)));

// ── ③ 代谢状态 ──
console.log('');
console.log('── ③ 代谢状态 ──');
const axiom = all.filter((c) => c.is_axiom === true).length;
const withHits = all.filter((c) => Number(c.hits) > 0).length;
const impBuckets = { low: 0, mid: 0, high: 0 };
for (const c of all) {
  const v = Number(c.importance);
  if (!Number.isFinite(v)) continue;
  if (v < 0.4) impBuckets.low++; else if (v < 0.8) impBuckets.mid++; else impBuckets.high++;
}
line('基石卡', axiom);
line('被用过（hits>0）', withHits);
line('importance 低/中/高', impBuckets.low + ' / ' + impBuckets.mid + ' / ' + impBuckets.high);

// ── ④ 开关 ──
console.log('');
console.log('── ④ 活配置开关 ──');
try {
  const c = loadLiveConfig();
  line('四股力', c.fourForcesEnabled === true ? '开' : '关');
  line('闪回联想', c.flashbackEnabled === true ? '开' : '关');
  line('冷宫归档', c.coldArchiveEnabled === true ? '开（' + (c.coldArchiveAutoApply ? '自动搬' : '仅统计') + '）' : '关');
} catch (e) { line('活配置', '读取失败'); }

// ── ⑤ 测试规模 ──
console.log('');
console.log('── ⑤ 测试与工具规模 ──');
const cnt = (re) => { try { return readdirSync(ROOT + '/scripts').filter((n) => re.test(n)).length; } catch { return 0; } };
line('selftest（根 + scripts）', readdirSync(ROOT).filter((n) => /^selftest.*\.mjs$/.test(n)).length + cnt(/^selftest.*\.mjs$/));
line('e2e 端到端', cnt(/^e2e-.*\.mjs$/));
line('bench 基准', cnt(/^bench-.*\.mjs$/));
line('audit 审计', cnt(/^audit-.*\.mjs$/));
line('lib 模块文件', (function () {
  let n = 0;
  const walk = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) { if (e.name === 'node_modules') continue; const p = d + '/' + e.name; if (e.isDirectory()) walk(p); else if (/\.(js|mjs)$/.test(e.name)) n++; } };
  walk(ROOT + '/lib'); return n;
})());

// ── ⑥ 运行环境 ──
console.log('');
console.log('── ⑥ 运行环境 ──');
if (existsSync(WAKE)) {
  const arr = readFileSync(WAKE, 'utf8').split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const pf = arr.filter((o) => o.level === 'prefetch' && Number.isFinite(o.ms)).map((o) => o.ms).sort((a, b) => a - b);
  if (pf.length) {
    line('检索 p50 / p90', pf[Math.floor(pf.length / 2)] + 'ms / ' + pf[Math.floor(pf.length * 0.9)] + 'ms');
    line('检索样本数', pf.length);
  }
  const ad = arr.filter((o) => o.level === 'adoption');
  if (ad.length) {
    const last = ad[ad.length - 1];
    line('最近一次采纳', 'bumped=' + last.bumped + ' 组=' + JSON.stringify(last.groups || []));
  }
} else {
  line('日志', '找不到 wake.log');
}

console.log('');
console.log('══════════════════════════════════════════');

// ── ⑦ [2026-10-25] 落盘 reports/status-latest.json ──
try {
  const repDir = ROOT + '/reports';
  if (!existsSync(repDir)) mkdirSync(repDir, { recursive: true });
  const statusData = {
    generatedAt: new Date().toISOString(),
    cards: {
      total: all.length,
      engram: engram.length,
      tdai: tdai.length,
      own: own.length,
      axioms: axiom,
    },
    files: {
      libFiles: (function () {
        let n = 0;
        const walk = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) { if (e.name === 'node_modules') continue; const p = d + '/' + e.name; if (e.isDirectory()) walk(p); else if (/\.(js|mjs)$/.test(e.name)) n++; } };
        walk(ROOT + '/lib'); return n;
      })(),
    },
    tests: {
      // [2026-10-26] 27 → 28：新增 e2e-resolution-lifecycle.mjs（问题生命周期）
      // [2026-10-26] 29 → 30：新增 e2e-distill-isolation.mjs（蒸馏并发归属隔离）
      verifySuites: 30,
    },
  };
  writeFileSync(repDir + '/status-latest.json', JSON.stringify(statusData, null, 2) + '\n', 'utf8');
  console.log('  已落盘最新动态报告: reports/status-latest.json');
} catch (e) {
  console.log('  落盘动态报告失败: ' + String(e && e.message || e));
}
