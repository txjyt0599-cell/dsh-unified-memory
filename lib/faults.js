/**
 * lib/faults.js —— 统一故障登记簿
 * [2026-10-26 by Assistant · Phase 3]
 *
 * ## 为什么要它
 * 前几轮审计反复抓到同一件事：全库 163 处 catch {} —— 解压失败、文件不存在、
 * 权限问题、超时，全被吞成一个"没有结果"。而"没有结果"和"查过但没有"在语义上
 * 完全不同，模型会据此自信地说错话。
 *
 * 参考 dsh-world 的 Faults：不是把所有异常都变成致命错误（那会让记忆拖垮回合），
 * 而是**把它们记下来**，让运维和控制台能看见"刚才哪里坏了"。
 *
 * ## 铁律
 *   ① record() **绝不抛**（它自己也在保护别的错误，不能成为新的错误源）
 *   ② 环形缓冲，最多 20 条，绝不无限增长
 *   ③ 只存 message + 调用点，**不存完整堆栈/大对象**（避免爆内存）
 *
 * ## 用法
 *   import { recordFault } from '../faults.js';
 *   try { ... } catch (e) { recordFault('retriever', 'zstd', e); }
 */

const CAP = 20;
const entries = [];

/** 从调用栈取一行定位：**跳过本文件自己的帧**，取第一个真实调用点。失败返回空串。 */
function callerWhere() {
  try {
    const stack = String(new Error().stack || '').split('\n');
    for (let i = 1; i < stack.length; i += 1) {
      const line = String(stack[i] || '').trim();
      if (!line || line.indexOf('faults.js') >= 0) continue;
      return line.replace(/^at\s+/, '').slice(0, 120);
    }
    return '';
  } catch { return ''; }
}

/**
 * 登记一条故障。绝不抛。
 * @param {string} module  模块名（retriever / distill / source-tracer / ...）
 * @param {string} op      操作名（可粗，例如 'catch' / 'zstd' / 'append'）
 * @param {unknown} error  异常对象或任意值
 * @returns {boolean} 是否登记成功
 */
export function recordFault(module, op, error) {
  try {
    const message = error instanceof Error
      ? (error.message || error.name || 'error')
      : String(error === undefined ? 'undefined' : error);
    entries.push({
      at: new Date().toISOString(),
      module: String(module || '?').slice(0, 32),
      op: String(op || 'catch').slice(0, 40),
      message: String(message).slice(0, 300),
      where: callerWhere(),
    });
    while (entries.length > CAP) entries.shift();
    return true;
  } catch { return false; }
}

/** 全部故障，**最新在前**。 */
export function listFaults() {
  try { return entries.slice().reverse(); } catch { return []; }
}

/** 最近 ms 毫秒内的故障（默认 1 小时），最新在前。 */
export function recentFaults(ms) {
  const span = Number.isFinite(Number(ms)) ? Number(ms) : 60 * 60 * 1000;
  const cutoff = Date.now() - span;
  try {
    return entries.filter((f) => {
      const t = Date.parse(f.at);
      return Number.isFinite(t) ? t >= cutoff : true;
    }).reverse();
  } catch { return []; }
}

/** 按 module 聚合计数（体检展示用）。 */
export function faultSummary() {
  const out = {};
  try {
    for (const f of entries) out[f.module] = (out[f.module] || 0) + 1;
  } catch { /* 聚合失败不影响调用方 */ }
  return out;
}

/** 清空（测试用）。 */
export function clearFaults() {
  try { entries.length = 0; } catch { /* ignore */ }
  return true;
}

export default { recordFault, listFaults, recentFaults, faultSummary, clearFaults };
