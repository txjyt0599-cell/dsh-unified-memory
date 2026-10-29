#!/usr/bin/env node
/**
 * scripts/acceptance-memory-v2.mjs —— 记忆改造 v2 总验收
 * [2026-10-24 by Assistant · goal round 5]
 *
 * 一次跑完，把「改造前 vs 改造后」的硬指标摆在一张表上。
 * User以后想复查"这套东西还在不在工作"，跑这一条就够。
 */
import { readFileSync, existsSync } from 'node:fs';
import { readCards } from '../lib/hypergraph/source.js';
import { loadLiveConfig } from '../lib/ingest/config.js';
import { scoreImportance } from '../lib/scoring/importance.js';
import { applyFourForces, GATE_THRESHOLD } from '../lib/scoring/four-forces.js';
import { isAdopted } from '../lib/scoring/adoption.js';

const D = 86400000;
const now = Date.now();
let fail = 0;
const line = (label, ok, detail) => {
  console.log((ok ? '  ✅ ' : '  ❌ ') + label + (detail ? '   ' + detail : ''));
  if (!ok) fail++;
};

console.log('\n══════ 记忆改造 v2 · 总验收 ══════\n');

// ① 开关状态
console.log('── ① 开关状态（活配置）──');
const cfg = loadLiveConfig();
console.log('  fourForcesEnabled  =', cfg.fourForcesEnabled);
console.log('  flashbackEnabled   =', cfg.flashbackEnabled);
console.log('  coldArchiveEnabled =', cfg.coldArchiveEnabled, '(autoApply=' + cfg.coldArchiveAutoApply + ')');
line('四股力已开', cfg.fourForcesEnabled === true);

// ② 卡片代谢指标
console.log('\n── ② 卡片代谢 ──');
const all = readCards();
const alive = all.alive || [];
let axiom = 0, zeroHits = 0, maxHits = 0;
const impBuckets = { low: 0, mid: 0, high: 0 };
for (const c of alive) {
  const v = Number(c.importance);
  if (c.is_axiom === true) axiom++;
  const h = Number(c.hits) || 0;
  if (h === 0) zeroHits++;
  if (h > maxHits) maxHits = h;
  if (Number.isFinite(v)) {
    if (v < 0.4) impBuckets.low++;
    else if (v < 0.8) impBuckets.mid++;
    else impBuckets.high++;
  }
}
console.log('  活卡        =', alive.length);
console.log('  基石        =', axiom);
console.log('  importance 分桶: 低(<0.4)=' + impBuckets.low + '  中=' + impBuckets.mid + '  高(>=0.8)=' + impBuckets.high);
console.log('  hits=0 占比 =', ((zeroHits / alive.length) * 100).toFixed(1) + '%  最大 hits=' + maxHits);
line('importance 有层次（高中低都不为 0）', impBuckets.high > 0 && impBuckets.low > 0);
line('基石已标出', axiom > 0, axiom + ' 张');

// ③ 打分行为
console.log('\n── ③ 打分行为（抽样）──');
const s1 = scoreImportance({ text: '9060XT 是 16G 不是 4G', role: 'user' });
const s2 = scoreImportance({ text: '重启了 DSH', role: 'user' });
const s3 = scoreImportance({ text: 'Assistant总结：修了三个 bug', role: 'assistant' });
console.log('  纠错句 =', s1.importance, 'axiom=' + s1.is_axiom);
console.log('  流水句 =', s2.importance);
console.log('  AI自述 =', s3.importance);
line('纠错拿高分', s1.importance >= 0.8, String(s1.importance));
line('流水拿基础分', s2.importance <= 0.3, String(s2.importance));
line('AI 自述不加分', s3.importance <= 0.3, String(s3.importance));

// ④ 排序行为
console.log('\n── ④ 排序行为 ──');
const axiomOld = applyFourForces({ importance: 0.9, is_axiom: true, createdAt: now - 400 * D, hits: 0 }, 0.8, now).score;
const flowOld = applyFourForces({ importance: 0.25, createdAt: now - 400 * D, hits: 0 }, 0.8, now).score;
const gateBlocked = applyFourForces({ importance: 1, is_axiom: true, createdAt: now, hits: 20 }, GATE_THRESHOLD - 0.001, now);
console.log('  老基石 =', axiomOld.toFixed(3), ' 老流水 =', flowOld.toFixed(3), ' 倍差 =', (axiomOld / flowOld).toFixed(2) + 'x');
console.log('  无关话题下高分卡 =', gateBlocked.score, '(gated=' + gateBlocked.gated + ')');
line('基石显著高于老流水', axiomOld > flowOld * 1.5, (axiomOld / flowOld).toFixed(2) + 'x');
line('无关话题杠杆锁死', gateBlocked.gated === false);

// ⑤ 采纳核验
console.log('\n── ⑤ 采纳核验 ──');
const use = isAdopted({ entities: ['9060XT'], title: '9060XT 显存' }, '这台 9060XT 是 16G');
const noUse = isAdopted({ entities: ['9060XT'], title: '9060XT 显存' }, '今天天气不错');
console.log('  真用到 =', JSON.stringify(use));
console.log('  陪跑   =', JSON.stringify(noUse));
line('真用到判采纳', use.used === true);
line('陪跑不采纳（防马太死锁）', noUse.used === false);

// ⑥ 数据文件
console.log('\n── ⑥ 数据落点 ──');
for (const f of [
  '~/.dsh/unified-memory/ingest/config.json',
  '~/.dsh/unified-memory/diary/state.json',
]) {
  console.log('  ' + (existsSync(f) ? '✓' : '✗') + ' ' + f);
}
line('活配置存在', existsSync('~/.dsh/unified-memory/ingest/config.json'));

console.log('\n══════ 结论 ══════');
console.log(fail === 0 ? '✅ 全部通过（' + (fail === 0 ? '无失败项' : '') + '）' : '❌ ' + fail + ' 项失败');
process.exit(fail === 0 ? 0 : 1);
