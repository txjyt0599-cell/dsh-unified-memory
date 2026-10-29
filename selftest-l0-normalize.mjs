/**
 * selftest-l0-normalize.mjs —— L0 归一化重构的等价性验收（2026-10-28）
 *
 * ## 为什么这个测试必须先写
 * 要把 retriever.js 里一段内联逻辑搬进独立模块，唯一不可接受的结果是
 * **行为变了**（哪怕只差一点点）。所以这个测试的判据是：
 *   新模块的输出 必须与 旧内联实现 **逐位相等**（含 toFixed(4) 的浮点尾数）。
 *
 * ## 反例（照"反例不报=检查是假的"）
 *   故意构造与新实现不一致的"旧式期望值"，断言比较函数必须报错。
 *   如果不报，说明这个等价性测试本身是假的。
 */

import { normalizeL0Rows, saturateScore, DEFAULT_L0_SAT_K, DEFAULT_L0_NORM_CAP, DEFAULT_L0_SEAT_MAX } from './lib/retrieval/l0-normalize.js';

let pass = 0, fail = 0;
const fails = [];
function check(g, name, ok, detail) {
  if (ok) { pass++; console.log('  PASS ' + name + (detail ? '   ' + detail : '')); }
  else { fail++; fails.push(name); console.log('  FAIL ' + name + (detail ? '   ' + detail : '')); }
}

/** 旧实现（从 retriever.js 原样抄下来，作为等价性基准） */
function legacyNormalize(l0Rows, c) {
  const l0SatK = c.l0SatK !== undefined ? Number(c.l0SatK) : 15;
  const l0NormCap = c.l0NormCap !== undefined ? Number(c.l0NormCap) : 0.75;
  let rows = l0Rows;
  if (rows.length > 0 && Number.isFinite(l0SatK) && l0SatK > 0) {
    rows = rows.map(function (row) {
      const raw = Number(row[1]) || 0;
      const norm = Math.min(l0NormCap, raw / (raw + l0SatK));
      return [row[0], Number(norm.toFixed(4)), row[2]];
    });
  }
  const l0SeatMax = Math.min(
    Math.max(1, Number.isFinite(Number(c.l0MaxPerQuery)) ? Number(c.l0MaxPerQuery) : 6),
    rows.length
  );
  if (rows.length > l0SeatMax) rows = rows.slice(0, l0SeatMax);
  return rows;
}

console.log('════ L0-NORMALIZE 等价性验收 ════');

// ── A · 默认参数下逐位相等（真实分数量级）──
console.log('\n── A · 真实分数（BM25 25~40 区间）──');
{
  const rows = [
    ['a', 25.03, { bm25: 25.03 }], ['b', 39.88, { bm25: 39.88 }], ['c', 3.5, { bm25: 3.5 }],
    ['d', 18.2, { bm25: 18.2 }], ['e', 31.4, { bm25: 31.4 }], ['f', 12.0, { bm25: 12.0 }],
    ['g', 40.1, { bm25: 40.1 }], ['h', 7.7, { bm25: 7.7 }],
  ];
  const got = normalizeL0Rows(rows, {});
  const want = legacyNormalize(rows, {});
  check('A', 'A1 输出逐位相等', JSON.stringify(got) === JSON.stringify(want),
    got.length + ' 条');
  check('A', 'A2 席位默认 6', got.length === 6, 'len=' + got.length);
  check('A', 'A3 分数都在 [0,0.75]', got.every(function (r) { return r[1] >= 0 && r[1] <= DEFAULT_L0_NORM_CAP; }));
}

// ── B · 边界：空数组 / 单条 / 刚好 6 条 ──
console.log('\n── B · 边界 ──');
{
  check('B', 'B1 空数组返回空', JSON.stringify(normalizeL0Rows([], {})) === '[]');
  check('B', 'B2 null 不抛且返回空', JSON.stringify(normalizeL0Rows(null, {})) === '[]');
  const one = [['x', 30, {}]];
  check('B', 'B3 单条不截断', normalizeL0Rows(one, {}).length === 1);
  const six = Array.from({ length: 6 }, function (_, i) { return ['s' + i, 20 + i, {}]; });
  check('B', 'B4 刚好 6 条不截断', normalizeL0Rows(six, {}).length === 6);
  const seven = Array.from({ length: 7 }, function (_, i) { return ['s' + i, 20 + i, {}]; });
  check('B', 'B5 7 条截到 6', normalizeL0Rows(seven, {}).length === 6);
}

// ── C · 参数覆盖与旧实现一致 ──
console.log('\n── C · 参数覆盖 ──');
{
  const rows = [['a', 100, {}], ['b', 50, {}], ['c', 10, {}]];
  // 用**线上真实键名**（retriever 里读的是 c.l0SatK / c.l0NormCap / c.l0MaxPerQuery）
  //   注意：模块侧短名由 pick() 兼容，但基准函数只认原名 ——
  //   我第一次给 cases 用短名、给基准函数用原名，等于在比两个不同的东西。
  const cases = [
    { l0SatK: 15, l0NormCap: 0.75, l0MaxPerQuery: 6 },
    { l0SatK: 5, l0NormCap: 0.9, l0MaxPerQuery: 2 },
    { l0SatK: 30, l0NormCap: 0.5, l0MaxPerQuery: 1 },
  ];
  let allSame = true;
  for (const c of cases) {
    const got = JSON.stringify(normalizeL0Rows(rows, c));
    const want = JSON.stringify(legacyNormalize(rows, c));
    if (got !== want) { allSame = false; console.log('    不一致:', c, got, '!==', want); }
  }
  check('C', 'C1 三种参数组合都与旧实现逐位相等', allSame);
}

// ── D · 纯函数性：不许改入参 ──
console.log('\n── D · 纯函数 ──');
{
  const rows = [['a', 25, { bm25: 25 }], ['b', 30, { bm25: 30 }]];
  const snapshot = JSON.stringify(rows);
  normalizeL0Rows(rows, {});
  check('D', 'D1 不改入参数组', JSON.stringify(rows) === snapshot);
  check('D', 'D2 返回的是新数组', normalizeL0Rows(rows, {}) !== rows);
}

// ── E · 饱和函数性质 ──
console.log('\n── E · 饱和性质 ──');
{
  check('E', 'E1 单调递增', saturateScore(10, 15) < saturateScore(20, 15));
  check('E', 'E2 有上限（不会越界）', saturateScore(1e9, 15) <= DEFAULT_L0_NORM_CAP + 1e-9,
    String(saturateScore(1e9, 15)));
  check('E', 'E3 K<=0 时原样返回（防呆）', saturateScore(25, 0) === 25);
  check('E', 'E4 擦边分确实沉底', saturateScore(3.5, 15) < 0.2, String(saturateScore(3.5, 15).toFixed(3)));
  check('E', 'E5 真命中在同量级', saturateScore(25, 15) > 0.6 && saturateScore(25, 15) < 0.65,
    String(saturateScore(25, 15).toFixed(3)));
}

// ── F · 反例：等价性比较本身必须能发现差异 ──
console.log('\n── F · 反例（比较函数必须能抓到不一致）──');
{
  const rows = [['a', 25, {}]];
  const real = JSON.stringify(normalizeL0Rows(rows, {}));
  // 构造一个"故意错一位"的期望值
  const tampered = JSON.stringify([[['a'], 0.1235, [{}]]].map(function (r) { return [r[0][0], r[1], r[2][0]]; }));
  check('F', 'F1 故意错的期望值必须被判为不同（反例）', real !== tampered, 'real=' + real.slice(0, 40));
  // 再验证：真的把 satK 改掉，输出必须变（说明比较有分辨力）
  const changed = JSON.stringify(normalizeL0Rows(rows, { satK: 5 }));
  check('F', 'F2 改参数后输出确实变了（比较有分辨力）', real !== changed, real + ' vs ' + changed);
}

console.log('\n════ SUMMARY ════');
console.log('  pass=' + pass + ' fail=' + fail);
if (fail) console.log('  失败项: ' + fails.join(' | '));
process.exit(fail ? 1 : 0);
