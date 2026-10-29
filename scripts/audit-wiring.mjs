#!/usr/bin/env node
/**
 * scripts/audit-wiring.mjs —— 零接线审计（新增开关/字段有没有消费者）
 * [2026-10-24 by Assistant]
 *
 * 这个项目出过好几次「开关写了、函数写了、但没人调」的事故
 * （scorer 是死代码、byTopic 算了没人用、claude 余额字段没人读…）。
 * 每次加完功能跑一遍这个，能立刻抓出「看着做了其实没接」。
 *
 * 判据：每个目标字段在 lib/ 下的**非注释**出现次数 > 0（含定义处，但定义处通常也是消费链起点）。
 * 更严的一档可以加「排除定义文件」，暂时够用。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = 'D:/dsh-plugins/dsh-unified-memory';
const files = [];
function walk(d) {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const p = join(d, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p); }
    else if (/\.(js|mjs)$/.test(e.name)) files.push(p);
  }
}
walk(join(ROOT, 'lib'));
const all = files.map((f) => ({ f: f.replace(ROOT + '/', ''), s: readFileSync(f, 'utf8') }));

const TARGETS = [
  'fourForcesEnabled', 'flashbackEnabled',
  'coldArchiveEnabled', 'coldArchiveAutoApply', 'coldArchiveAgeDays', 'coldArchiveImpMax', 'coldArchiveIntervalMs',
  'importance', 'is_axiom', 'importance_signals', 'hits', 'lastHitAt',
  'injectedIds', 'lastInjectedIds',
  'relGate', 'bucketWidth', 'penaltyFlux',
  'cleanTitle', 'isDirtyTitle', 'stripHtml',
  // [Round 11] L1 写入侧也必须有 importance —— 加进审计，防止再漏
  'scoreImportance',
];

let problems = 0;
console.log('── 零接线审计（' + TARGETS.length + ' 个字段）──');
for (const t of TARGETS) {
  const hits = [];
  for (const { f, s } of all) {
    const lines = s.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].includes(t)) continue;
      if (/^\s*(\/\/|\*|\/\*)/.test(lines[i])) continue;   // 跳过注释
      hits.push(f + ':' + (i + 1));
    }
  }
  const uniq = [...new Set(hits)];
  if (uniq.length === 0) { console.log('  ✗ 零接线: ' + t); problems++; }
  else console.log('  ✓ ' + t.padEnd(22) + ' ' + uniq.length + ' 处  ' + uniq.slice(0, 2).join(', '));
}
console.log('\n' + (problems === 0 ? '✅ 全部有消费点' : '❌ ' + problems + ' 个字段零接线'));
process.exit(problems === 0 ? 0 : 1);
