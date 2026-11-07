/**
 * shadow-decay.js —— 衰减模型影子对比（只记录，不影响排序）
 * [2026-11-04 by Assistant · 总纲 §12 项 3「shadow 模式（新旧并行算分）」]
 * [2026-11-07 P1-8 红队修复]
 *
 * ⚠️ 定位（红队 P1-8 定调）：**本日志只作「敏感性观察」**——
 *   它只记录「换一组参数，排序会不会变」，**不含任何质量标签**
 *   （没有 queryId↔金标准相关性、没有用户纠正/memory_get/采纳结果的联结）。
 *   ⇒ 因此**绝不能**据此宣称「某组参数提升了效果 / 调参有收益」。
 *   要支撑「攒实盘数据后校准参数」，必须离线把匿名 queryId 与相关性标注/真实使用联结，
 *   补齐质量标签后才允许下结论。
 *
 * 基准修正（红队 P1-8 病灶）：
 *   原来基准组硬编码 {linBase:30, linPerHit:1}（注释写「当前生产值」），
 *   生产调参后日志仍拿旧基准比 ⇒ 比较失真。
 *   现在基准 = **运行时生效的生产参数**：
 *     ① 优先用调用方传入的 baseOpts.linBase / baseOpts.linPerHit（retriever 从 cordis 生效配置透传）；
 *     ② 其次读 profile 里 retrieval 段的 linBase / linPerHit（best-effort，解析失败忽略）；
 *     ③ 都没有才回退到 LIN.BASE / LIN.PER_HIT（=30/1，与旧硬编码同值，保证零回归）。
 *
 * 开关：retrieval.decayShadowEnabled（默认 false）
 */
import { readFileSync, existsSync } from 'node:fs';
import { dshHome } from '../paths.js';
import { rerankWithFourForces, LIN } from '../scoring/four-forces.js';

/** 生产参数缺失时的兜底（=旧硬编码 30/1，保证行为可预期） */
export const FALLBACK_PROD = Object.freeze({ linBase: LIN.BASE, linPerHit: LIN.PER_HIT });

/**
 * 候选参数组（相对生产基准的倍率，而不是写死绝对值）。
 * 这样生产基准一改，候选组自动跟着平移，比较才有效。
 */
export const SHADOW_VARIANTS = [
  { name: 'prod', baseFactor: 1, perHitFactor: 1, note: '生产基准（当前生效参数）' },
  { name: 'base_x1.5', baseFactor: 1.5, perHitFactor: 1, note: '更长初始寿命' },
  { name: 'perhit_x2', baseFactor: 1, perHitFactor: 2, note: '使用加成更快' },
  { name: 'base_x2', baseFactor: 2, perHitFactor: 1, note: '更宽容' },
  { name: 'base_x0.7', baseFactor: 0.7, perHitFactor: 1, note: '更严格' },
];

const posNum = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
};

/** best-effort：从 profile 的 retrieval 段读 linBase/linPerHit（读不到就返回 null） */
function readProfileLinearParams() {
  try {
    const p = process.env.PM_PROFILE_PATH || (dshHome() + '/profiles/web/cordis.patch.yml');
    if (!existsSync(p)) return null;
    const src = readFileSync(p, 'utf8');
    const lb = [...src.matchAll(/^\s*linBase\s*:\s*([0-9]+(?:\.[0-9]+)?)\s*$/gm)].pop();
    const lph = [...src.matchAll(/^\s*linPerHit\s*:\s*([0-9]+(?:\.[0-9]+)?)\s*$/gm)].pop();
    if (!lb && !lph) return null;
    const out = {};
    if (lb) out.linBase = Number(lb[1]);
    if (lph) out.linPerHit = Number(lph[1]);
    return out;
  } catch { return null; }
}

/**
 * 解析生产基准（运行时生效值）。
 * @param {object} baseOpts 调用方传入的生产参数（含 linBase/linPerHit）
 * @returns {{linBase:number, linPerHit:number, source:string}}
 */
export function resolveProdBaseline(baseOpts) {
  const o = baseOpts || {};
  const cfg = readProfileLinearParams() || {};
  const fromOptsBase = posNum(o.linBase);
  const fromOptsPer = posNum(o.linPerHit);
  const cfgBase = posNum(cfg.linBase);
  const cfgPer = posNum(cfg.linPerHit);
  const linBase = fromOptsBase != null ? fromOptsBase : (cfgBase != null ? cfgBase : FALLBACK_PROD.linBase);
  const linPerHit = fromOptsPer != null ? fromOptsPer : (cfgPer != null ? cfgPer : FALLBACK_PROD.linPerHit);
  const source = (fromOptsBase != null || fromOptsPer != null)
    ? 'runtime-opts'
    : ((cfgBase != null || cfgPer != null) ? 'profile-file' : 'fallback');
  return { linBase, linPerHit, source };
}

/**
 * 跑一次影子对比。**绝不抛异常，绝不影响调用方**。
 * @param {Array} list 融合后的候选（给 rerankWithFourForces 的原始入参）
 * @param {Map} cardsById
 * @param {number} nowTs
 * @param {object} baseOpts 生产参数（含 query/timeWindow 等）
 * @returns {object|null} 对比结果，失败返回 null
 */
export function runShadowDecay(list, cardsById, nowTs, baseOpts) {
  try {
    if (!Array.isArray(list) || list.length === 0) return null;
    const idOf = (raw) => (Array.isArray(raw) ? String(raw[0]) : String(raw && raw.id));
    const baseline = resolveProdBaseline(baseOpts);
    const round2 = (n) => Math.round(n * 100) / 100;
    const rows = SHADOW_VARIANTS.map((v) => ({
      name: v.name,
      linBase: Math.max(1, round2(baseline.linBase * v.baseFactor)),
      linPerHit: Math.max(0, round2(baseline.linPerHit * v.perHitFactor)),
    }));
    const orders = {};
    for (const v of rows) {
      const opts = Object.assign({}, baseOpts, {
        linearDecay: true,
        linBase: v.linBase,
        linPerHit: v.linPerHit,
        withParts: false,                 // 只要顺序，不要明细（省内存）
      });
      const out = rerankWithFourForces(list, cardsById, nowTs, opts);
      orders[v.name] = out.map(idOf);
    }
    const prodName = 'prod';              // 基准行 = 与生产同参（由 resolveProdBaseline 决定）
    const prod = orders[prodName] || [];
    const prodTop = prod.slice(0, 10);
    const detail = {};
    for (const v of rows) {
      if (v.name === prodName) continue;
      const cur = orders[v.name] || [];
      const curTop = cur.slice(0, 10);
      const inter = prodTop.filter((id) => curTop.includes(id)).length;
      detail[v.name] = {
        top1Changed: (prod[0] || null) !== (cur[0] || null),
        top10Overlap: prodTop.length > 0 ? Number((inter / prodTop.length).toFixed(3)) : null,
        fullOrderChanged: JSON.stringify(prod) !== JSON.stringify(cur),
        curTop1: cur[0] || null,
      };
    }
    return {
      n: list.length,
      baseline,                           // 本次比较所用的生产基准与来源
      prodTop1: prod[0] || null,
      variants: detail,
      // ── 红队 P1-8：明确标注这是敏感性观察，不是质量结论 ──
      sensitivityOnly: true,
      qualityLabels: false,
      note: '敏感性观察：仅看排序变化，无质量标签/真实使用联结，禁止据此宣称任何参数提升效果',
    };
  } catch (e) {
    return { error: String(e && e.message || e).slice(0, 120) };
  }
}

export default { runShadowDecay, SHADOW_VARIANTS, resolveProdBaseline, FALLBACK_PROD };
