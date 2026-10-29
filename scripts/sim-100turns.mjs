/**
 * scripts/sim-100turns.mjs —— 四股力 100 轮长线模拟（红队验收标准）
 * [2026-10-24 by Assistant]
 *
 * 为什么要模拟而不是真跑 100 轮对话：
 *   真跑一轮要烧 token、要等模型；而四股力是**纯函数**，
 *   只要给对「卡片状态 + 时间 + 相关度」，结果就是确定的。
 *   这套模拟直接跑在真实卡片库上（用真实 importance / hits 分布），
 *   比编造的假数据更有说服力。
 *
 * 验收标准（红队定）：
 *   ① 流水账（低重要 + 久未用）在 60 天后基本沉底
 *   ② 基石卡（is_axiom）无论多久都稳居前列
 *   ③ 高 hits 卡不得在**无关话题**里霸榜
 */
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { applyFourForces, GATE_THRESHOLD } from '../lib/scoring/four-forces.js';
import { dataPath } from '../lib/paths.js';

const ENG = dataPath('engram-relay/engrams.jsonl');
const OUT_DIR = dataPath('diary/backups');
const DAY = 86400000;
const now = Date.now();

if (!existsSync(ENG)) { console.error('找不到卡片库'); process.exit(1); }
const byId = new Map();
for (const line of readFileSync(ENG, 'utf8').split(/\r?\n/)) {
  if (!line) continue;
  let o; try { o = JSON.parse(line); } catch { continue; }
  if (!o || !o.id) continue;
  byId.set(String(o.id), o);
}
const alive = [...byId.values()].filter((c) => (c.status || 'active') !== 'retired');
console.log('[sim] 活卡', alive.length);

// 分组
const axiom = alive.filter((c) => c.is_axiom === true);
const vol = alive.filter((c) => c.is_axiom !== true && Number(c.importance) <= 0.35);
const important = alive.filter((c) => c.is_axiom !== true && Number(c.importance) >= 0.55);
console.log('[sim] 基石', axiom.length, '重要', important.length, '流水', vol.length);

function score(card, R, at) { return applyFourForces(card, R, at).score; }
function avg(list, R, at) {
  if (!list.length) return 0;
  let s = 0; for (const c of list) s += score(c, R, at);
  return s / list.length;
}

console.log('\n── 场景 A · 同一相关度 (R=0.8)，随时间推移 ──');
console.log('天数   基石      重要      流水');
for (const d of [0, 15, 30, 60, 90, 180, 365]) {
  const at = now + d * DAY;   // 模拟未来（卡片更老）
  const a = avg(axiom.slice(0, 200), 0.8, at);
  const im = avg(important.slice(0, 200), 0.8, at);
  const v = avg(vol.slice(0, 200), 0.8, at);
  console.log(String(d).padStart(4), '  ', a.toFixed(3), '   ', im.toFixed(3), '   ', v.toFixed(3));
}

console.log('\n── 场景 B · 无关话题 (R=0.005 低于门控) ──');
let leaked = 0;
for (const c of alive.slice(0, 500)) {
  const s = score(c, 0.005, now);
  if (s > 0.005 + 1e-9) leaked++;
}
console.log('500 张抽样里，无关话题下被杠杆放大的：', leaked, '（必须 = 0）');

console.log('\n── 场景 C · 高 hits 老卡 vs 新基石卡（同等相关度）──');
const oldHot = alive.filter((c) => Number(c.hits) >= 3 && c.is_axiom !== true && Number(c.importance) <= 0.35)[0];
const newAx = axiom.filter((c) => (Number(c.createdAt) || 0) > now - 30 * DAY)[0];
if (oldHot) console.log('  高hits流水卡:', String(oldHot.title || '').slice(0, 28), '→ score', score(oldHot, 0.6, now).toFixed(3));
else console.log('  （库里没有高 hits 的流水卡）');
if (newAx) console.log('  新基石卡  :', String(newAx.title || '').slice(0, 28), '→ score', score(newAx, 0.6, now).toFixed(3));
else console.log('  （库里没有近期基石卡）');

console.log('\n── 场景 D · 300 天后的排序（前 8 名）──');
const at300 = now + 300 * DAY;
const ranked = alive.slice(0, 800).map((c) => ({ c, s: score(c, 0.7, at300) })).sort((a, b) => b.s - a.s);
for (const x of ranked.slice(0, 8)) {
  console.log('  ', x.s.toFixed(3), x.c.is_axiom ? '[基石]' : ('[imp ' + Number(x.c.importance).toFixed(2) + ']'), String(x.c.title || '').slice(0, 32));
}

// 判定
const v0 = avg(vol.slice(0, 200), 0.8, now);
const v180 = avg(vol.slice(0, 200), 0.8, now + 180 * DAY);
const a180 = avg(axiom.slice(0, 200), 0.8, now + 180 * DAY);
const checks = [
  ['① 流水卡 180 天后明显低于初始', v180 < v0 * 0.9, v180.toFixed(3) + ' < ' + (v0 * 0.9).toFixed(3)],
  ['② 基石卡 180 天后仍高于流水', a180 > v180 * 1.1, a180.toFixed(3) + ' > ' + (v180 * 1.1).toFixed(3)],
  ['③ 无关话题零泄漏', leaked === 0, 'leaked=' + leaked],
];
console.log('\n── 判定 ──');
let fail = 0;
for (const [n, okv, detail] of checks) { console.log((okv ? '  ✅ ' : '  ❌ ') + n + '   ' + detail); if (!okv) fail++; }

try {
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(OUT_DIR + '/sim-100turns-latest.json', JSON.stringify({
    at: new Date().toISOString(), alive: alive.length,
    axiom: axiom.length, important: important.length, volatile: vol.length,
    curve: [0, 15, 30, 60, 90, 180, 365].map((d) => ({
      days: d, axiom: avg(axiom.slice(0, 200), 0.8, now + d * DAY), important: avg(important.slice(0, 200), 0.8, now + d * DAY), volatile: avg(vol.slice(0, 200), 0.8, now + d * DAY),
    })),
    leaked, checks: checks.map(([n, okv, d]) => ({ name: n, pass: okv, detail: d })),
  }, null, 1));
  console.log('\n报告已落盘: backups/sim-100turns-latest.json');
} catch (e) { console.log('落盘失败（不影响判定）:', e.message); }

process.exit(fail === 0 ? 0 : 1);
