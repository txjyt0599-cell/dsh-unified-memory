/**
 * lib/retrieval/l0-normalize.js —— L0 原话卡的量纲归一与席位上限（2026-10-28 · 结构重构）
 *
 * ## 为什么单独成模块
 * 这段逻辑原来长在 retriever.js 的 search() 体内（一个 1125 行的函数），
 * 它是**纯计算**：输入一批 [id, bm25分, parts]，输出归一化并截断后的同形数组。
 * 没有副作用、不碰 state、不读时钟 —— 正是最该被抽出来单独测的那类代码。
 *
 * ## 它治什么病（实测数据，都写在原注释里）
 * 病灶：l0Rows 的 row[1] 是 **BM25 原始分**（25~40），
 *       而普通卡是 **归一化/RRF 分**（0.5~1.0）
 *       ⇒ L0 天生赢 30 倍，普通精炼卡在数学上**没有赢的可能**。
 *       实测：25 条 picked 里 L0 占 14 条，预算 792/800 被吃满。
 *
 * 两个修法：
 *   ① **饱和函数** s/(s+K) 归一量纲，不用 s/max
 *      —— s/max 在某次 L0 最高分才 3.5 时会虚高到 1.0，照样压普通卡一头，等于没归。
 *      饱和函数把"绝对值多相关"映射成绝对量级：3.5→0.19（沉底）/ 25→0.63（真命中）。
 *   ② **席位上限**：归一化解决量纲，不解决"3049 条原话 vs 2000 条精炼卡"的数量压制。
 *      实测「这几天记忆」L0 占 14/25；给上限后强制让位（默认 6 席）。
 */

/** 默认饱和系数 K（可配 l0SatK 覆盖） */
export const DEFAULT_L0_SAT_K = 15;
/** 默认归一化上限（可配 l0NormCap 覆盖） */
export const DEFAULT_L0_NORM_CAP = 0.75;
/** 默认每查询 L0 席位上限（可配 l0MaxPerQuery 覆盖） */
export const DEFAULT_L0_SEAT_MAX = 6;

/**
 * 饱和归一化：把 BM25 原始分压到与普通卡同量级。
 * @param {number} raw   BM25 原始分
 * @param {number} satK  饱和系数 K（越大压得越狠）
 * @param {number} cap   归一化上限（防止满分卡越界抢 Top1）
 * @returns {number} 归一化分数
 */
export function saturateScore(raw, satK, cap) {
  const r = Number(raw) || 0;
  const k = Number(satK);
  if (!Number.isFinite(k) || k <= 0) return r;
  const c = Number.isFinite(Number(cap)) ? Number(cap) : DEFAULT_L0_NORM_CAP;
  return Math.min(c, r / (r + k));
}

/**
 * 对一批 L0 行做归一化 + 席位截断。**纯函数**（不改入参）。
 *
 * @param {Array<[string, number, object]>} rows  原 L0 行
 * @param {object} cfg   { satK, normCap, seatMax }
 * @returns {Array<[string, number, object]>} 新数组（原数组不变）
 */
export function normalizeL0Rows(rows, cfg) {
  const list = Array.isArray(rows) ? rows : [];
  if (list.length === 0) return [];
  const c = cfg || {};
  // 兼容两套参数名：模块内部用短名，调用方传的是配置对象原名（l0SatK / l0NormCap / l0MaxPerQuery）
  const pick = function (a, b, dflt) {
    if (c[a] !== undefined) return Number(c[a]);
    if (c[b] !== undefined) return Number(c[b]);
    return dflt;
  };
  const satK = pick('satK', 'l0SatK', DEFAULT_L0_SAT_K);
  const normCap = pick('normCap', 'l0NormCap', DEFAULT_L0_NORM_CAP);
  const seatMaxRaw = pick('seatMax', 'l0MaxPerQuery', DEFAULT_L0_SEAT_MAX);

  // ① 量纲归一
  let out = list;
  if (Number.isFinite(satK) && satK > 0) {
    out = out.map(function (row) {
      const raw = Number(row[1]) || 0;
      const norm = saturateScore(raw, satK, normCap);
      return [row[0], Number(norm.toFixed(4)), row[2]];
    });
  }
  // ② 席位截断（至少 1 席，最多不超过实际条数）
  const seatMax = Math.min(Math.max(1, Number.isFinite(seatMaxRaw) ? seatMaxRaw : DEFAULT_L0_SEAT_MAX), out.length);
  if (out.length > seatMax) out = out.slice(0, seatMax);
  return out;
}

export default { saturateScore, normalizeL0Rows, DEFAULT_L0_SAT_K, DEFAULT_L0_NORM_CAP, DEFAULT_L0_SEAT_MAX };
