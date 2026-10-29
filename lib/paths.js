/**
 * lib/paths.js —— 统一路径解析（2026-10-29 · 为开源/移植而加）
 *
 * ## 为什么要有这个文件
 *   原来 85 个模块里有 58 处硬编码：
 *     '~/.dsh/unified-memory/ingest/engrams.jsonl'
 *     '~/日记'
 *   ⇒ 换台机器全错，别人 clone 下来跑不起来。
 *   ⇒ 这个文件是**唯一**知道"数据在哪"的地方，别的模块只许调它，不许自己拼。
 *
 * ## 解析顺序（从高到低，谁先命中用谁）
 *   ① 环境变量 PM_DATA_ROOT     —— 显式指定，最高优先级
 *   ② 环境变量 DSH_HOME         —— DSH 主目录（默认 ~/.dsh）
 *   ③ os.homedir()/.dsh          —— 从用户主目录推导（跨机器通用）
 *   ④ 兜底 '~/.dsh'  —— 只在都失败时用，且会告警
 *
 * ## 铁律
 *   ⛔ 本文件之外**不许**再出现 'C:/Users/' 或 '~' 这类硬编码
 *      （scripts/check-hardcodes.mjs 会扫，违反即红）
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

/** 取一个非空环境变量；没有就返回空串（不抛） */
function env(name) {
  try {
    const v = process.env && process.env[name];
    return v === undefined || v === null ? '' : String(v);
  } catch { return ''; }
}

/**
 * DSH 主目录。默认 ~/.dsh，可用 DSH_HOME 覆盖。
 * @returns {string} 正斜杠路径，无尾斜杠
 */
export function dshHome() {
  const explicit = env('DSH_HOME').trim();
  if (explicit) return normalize(explicit);
  let home = '';
  try { home = homedir() || ''; } catch { home = ''; }
  if (home) return normalize(join(home, '.dsh'));
  // 兜底：只在推导失败时用（极少见），并在日志里能看出来
  return '~/.dsh';
}

/**
 * 本插件的**数据根**。默认 <DSH_HOME>/unified-memory，可用 PM_DATA_ROOT 覆盖。
 * @returns {string}
 */
export function dataRoot() {
  const explicit = env('PM_DATA_ROOT').trim();
  if (explicit) return normalize(explicit);
  return normalize(join(dshHome(), 'unified-memory'));
}

/**
 * 在数据根下拼一个路径。**别的地方要数据文件，一律走这个。**
 * @param {...string} parts
 * @returns {string}
 */
export function dataPath(...parts) {
  return normalize(join(dataRoot(), ...parts.map(String).filter(Boolean)));
}

/**
 * 日记根目录（用户可见的"本子"放在工作区里，不在数据目录）。
 * 默认 <PM_WORKSPACE>/日记，可用 PM_DIARY_ROOT 覆盖。
 * @returns {string}
 */
export function diaryRoot() {
  // ① 显式指定最高优先
  const explicit = env('PM_DIARY_ROOT').trim();
  if (explicit) return normalize(explicit);
  // ② 工作区 + 日记（本机就是 ~/日记）
  const ws = env('PM_WORKSPACE').trim();
  if (ws) return normalize(join(ws, '日记'));
  // ③ 都未配置 ⇒ 退到数据目录下的 diary（保证任何机器都能跑，不崩）
  //    ⚠️ 这是"能跑"的兜底，不是"User本子"的真实位置。
  //       实现机请设 PM_DIARY_ROOT 或 PM_WORKSPACE。
  return normalize(join(dataRoot(), 'diary'));
}

/**
 * 会话文件根目录（DSH 的会话存储）。默认 <DSH_HOME>/sessions。
 * @returns {string}
 */
export function sessionsRoot() {
  const explicit = env('PM_SESSIONS_ROOT').trim();
  if (explicit) return normalize(explicit);
  return normalize(join(dshHome(), 'sessions'));
}

/** 把一个路径里的反斜杠统一成正斜杠，并去掉尾部斜杠 */
export function normalize(p) {
  let s = String(p || '').replace(/\\/g, '/');
  while (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1);
  return s;
}

/** 默认日记本文件名（供 backend 拼完整路径） */
export const DIARY_FILENAME = 'Assistant日记.md';

/** 日记本的完整路径列表（journal backend 用） */
export function diaryPaths() {
  const explicit = env('PM_DIARY_FILE').trim();
  if (explicit) return [normalize(explicit)];
  return [normalize(join(diaryRoot(), DIARY_FILENAME))];
}

export default { dshHome, dataRoot, dataPath, diaryRoot, sessionsRoot, normalize, diaryPaths, DIARY_FILENAME };
