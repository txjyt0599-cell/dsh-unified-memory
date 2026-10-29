/**
 * selftest-scoring.mjs —— 四股力 / 重要度 / 采纳核验 自测
 * [2026-10-24 by Assistant · Step 1~3 配套]
 */
import { scoreImportance, IMPORTANCE_BASE } from './lib/scoring/importance.js';
import { applyFourForces, recencyOf, strengthOf, halfLifeOf, MAX_HITS, GATE_THRESHOLD } from './lib/scoring/four-forces.js';
import { isAdopted } from './lib/scoring/adoption.js';

let pass = 0, fail = 0;
const T = (n, fn) => { try { fn(); pass++; console.log('  ✓', n); } catch (e) { fail++; console.log('  ✗', n, '—', e && e.message); } };
const ok = (v, m) => { if (!v) throw new Error(m || '期望为真'); };
const eq = (a, b, m) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error((m || '') + ' 期望 ' + JSON.stringify(b) + ' 实际 ' + JSON.stringify(a)); };
const DAY = 86400000;
const now = Date.now();

console.log('\n[scoring selftest]');

// ── A 重要度 ──
T('A1 被纠错的硬件事实 → 高分 + 基石', () => {
  const r = scoreImportance({ text: '9060XT 是 16G 不是 4G，Windows 探针误报', role: 'user' });
  ok(r.importance >= 0.8, '应 >= 0.8，实际 ' + r.importance);
  ok(r.is_axiom === true, '应标基石');
});
T('A2 铁律级决定 → 基石', () => {
  const r = scoreImportance({ text: '以后主路 wGraph 永远设 0，这是铁律', role: 'user' });
  ok(r.is_axiom === true, '应标基石，实际 importance=' + r.importance);
});
T('A2b [白队暗礁1] 带测试环境修饰的硬铁律不被误杀', () => {
  const r = scoreImportance({ text: '以后在测试环境下绝对不准开启公网映射，这是铁律', role: 'user' });
  ok(r.is_axiom === true, '带条件铁律应标基石');
});
T('A2c [白队暗礁2] 弱因果解释句不被误判为硬件基石', () => {
  const r = scoreImportance({ text: '昨天报错是因为我显存配置错了', role: 'user' });
  ok(r.is_axiom === false, '弱解释句不应标基石');
});
T('A3 纯执行流水 → 基础分，不加分', () => {
  const r = scoreImportance({ text: '重启了 DSH', role: 'user' });
  eq(r.importance, IMPORTANCE_BASE);
  ok(r.is_axiom === false);
});
T('A4 Assistant自己的总结 → 不加高分', () => {
  const r = scoreImportance({ text: 'Assistant总结：该插件损坏是因为路径有中文', role: 'assistant' });
  eq(r.importance, IMPORTANCE_BASE);
});
T('A5 数学公式不被误判成纠错', () => {
  const r = scoreImportance({ text: '积分计算的公式是 c=Q/U', role: 'user' });
  eq(r.importance, IMPORTANCE_BASE);
});
T('A6 重要度在 [0.25, 1.0] 区间', () => {
  for (const t of ['纠正一下，是 16G 不是 4G', '好的', '以后都这么干']) {
    const v = scoreImportance({ text: t, role: 'user' }).importance;
    ok(v >= 0.25 && v <= 1.0, '越界: ' + v);
  }
});

// ── B 半衰期三档 ──
T('B1 基石卡不衰减', () => {
  const c = { importance: 0.9, is_axiom: true, createdAt: now - 365 * DAY };
  eq(recencyOf(c, now), 1.0);
});
T('B2 重要卡半衰期 60 天', () => {
  eq(halfLifeOf({ importance: 0.6 }), 60);
  const c = { importance: 0.6, createdAt: now - 60 * DAY };
  const r = recencyOf(c, now);
  ok(Math.abs(r - 0.5) < 0.02, '60 天后应 ≈ 0.5，实际 ' + r.toFixed(3));
});
T('B3 流水卡半衰期 21 天', () => {
  eq(halfLifeOf({ importance: 0.25 }), 21);
  const c = { importance: 0.25, createdAt: now - 21 * DAY };
  const r = recencyOf(c, now);
  ok(Math.abs(r - 0.5) < 0.02, '21 天后应 ≈ 0.5，实际 ' + r.toFixed(3));
});

// ── C 强度 ──
T('C1 hits=0 → 强度 0', () => { eq(strengthOf({ hits: 0, importance: 0.25 }, now), 0); });
T('C2 hits 增长但边际递减（对数）', () => {
  const a = strengthOf({ hits: 1, importance: 0.9, is_axiom: true }, now);
  const b = strengthOf({ hits: 2, importance: 0.9, is_axiom: true }, now);
  const d = strengthOf({ hits: 19, importance: 0.9, is_axiom: true }, now);
  ok(b > a, '2 > 1');
  ok(d <= 1.0, '封顶 1');
  ok((b - a) > (d - strengthOf({ hits: 18, importance: 0.9, is_axiom: true }, now)), '边际应递减');
});
T('C3 强度真的能抗遗忘（老卡 hits 越高分越高）', () => {
  // [Round 15 抓到的真问题] 之前 hits=0 与 hits=20 分数完全相同，强度形同虚设
  const mk = (hits) => applyFourForces({ importance: 0.25, is_axiom: false, createdAt: now - 200 * DAY, hits }, 0.6, now).score;
  const s0 = mk(0), s20 = mk(20);
  ok(s20 > s0 * 1.1, 'hits=20 应比 hits=0 高 10% 以上：' + s0.toFixed(4) + ' vs ' + s20.toFixed(4));
});
T('C4 强度不会超过相关度本身（上封 1.0）', () => {
  const r = applyFourForces({ importance: 1.0, is_axiom: true, createdAt: now, hits: 20 }, 0.8, now);
  ok(r.score <= 0.8 + 1e-9, '不应超过 R=0.8，实际 ' + r.score);
});

// ── D 乘法门控（核心） ──
T('D1 相关度不过门 → 杠杆锁死（哪怕重要度=1、hits=20）', () => {
  const c = { importance: 1.0, is_axiom: true, createdAt: now, hits: MAX_HITS };
  const r = applyFourForces(c, GATE_THRESHOLD - 0.001, now);
  eq(r.gated, false);
  eq(r.score, GATE_THRESHOLD - 0.001);
});
T('D2 同等相关度下，基石卡 > 流水卡', () => {
  const R = 0.8;
  const ax = applyFourForces({ importance: 0.9, is_axiom: true, createdAt: now - 200 * DAY, hits: 5 }, R, now).score;
  const fl = applyFourForces({ importance: 0.25, createdAt: now - 200 * DAY, hits: 0 }, R, now).score;
  ok(ax > fl, '基石 ' + ax.toFixed(3) + ' 应 > 流水 ' + fl.toFixed(3));
});
T('D3 流水卡 180 天后乘数真正降下来（不是被常数托底）', () => {
  const R = 0.8;
  const fresh = applyFourForces({ importance: 0.25, createdAt: Date.now(), hits: 0 }, R, Date.now()).score;
  const oldRes = applyFourForces({ importance: 0.25, createdAt: Date.now() - 180 * DAY, hits: 0 }, R, Date.now());
  const old = oldRes.score;
  ok(old < fresh * 0.85, '180 天后应显著下降：' + old.toFixed(3) + ' vs ' + fresh.toFixed(3));
  // [2026-10-25 白队终审单测] 锁死衰减模型物理常数：180天老流水卡乘数断言落在 [0.34, 0.36]（精准下限 0.350）
  ok(oldRes.parts.mult >= 0.34 && oldRes.parts.mult <= 0.36, '乘数应触达底线 0.35，实际 ' + oldRes.parts.mult);
});
T('D4 高重要但无关的卡，排序仍被锁在后面', () => {
  const hi = applyFourForces({ importance: 1.0, is_axiom: true, createdAt: now, hits: 20 }, 0.01, now).score;
  const lo = applyFourForces({ importance: 0.25, createdAt: now - 30 * DAY, hits: 0 }, 0.5, now).score;
  ok(lo > hi, '相关度高的流水卡应排前：' + lo.toFixed(3) + ' vs ' + hi.toFixed(3));
});

// ── E 采纳核验 ──
T('E1 回复含实体 → 判定采纳', () => {
  const r = isAdopted({ title: '9060XT 显存误报', entities: ['9060XT', '显存'] }, '这台 9060XT 的显存是 16G');
  eq(r.used, true);
});
T('E2 回复无关 → 不采纳（关键：防马太死锁）', () => {
  eq(isAdopted({ title: '9060XT 显存误报', entities: ['9060XT'] }, '今天天气不错，User早点休息').used, false);
});
T('E3 只共享常见词 → 不采纳', () => {
  eq(isAdopted({ title: 'User今天说的问题', entities: [] }, '好的User今天这个问题我看看').used, false);
});
T('E4 空回复 → 不采纳', () => { eq(isAdopted({ entities: ['x'] }, '').used, false); });

// ── [2026-10-29 补] E3 修的是「英文切片碎片白送分」，这两条防修过头 ──
T('E5 英文整词命中 → 仍算采纳（不能被误杀）', () => {
  eq(isAdopted({ title: 'bge-m3 embedding 配置', entities: [] },
    '这里用 bge-m3 做向量').used, true);
});
T('E6 真实中文术语重合 → 仍算采纳', () => {
  eq(isAdopted({ title: '派单回执状态机设计', entities: [] },
    '派单回执这块我按状态机实现了').used, true);
});
T('E7 英文碎片不算重合（us/se/er 不许白送）', () => {
  // 卡片叫 User...，回复里也有 User，但除此之外毫无关系 ⇒ 不采纳
  eq(isAdopted({ title: 'User profile settings', entities: [] },
    '好的 User 我看看别的').used, false);
});

console.log('\n  ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
