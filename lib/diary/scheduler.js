/**
 * lib/diary/scheduler.js —— 日记的「轻推」与「零点汇编」
 * [2026-10-24 by Assistant] User批「开工」。
 *
 * 两件事，都极轻：
 *   ① nudge   ：某个会话今天还没写过 → 在它这一轮的消息尾塞一句「本子今天还空着」，
 *               每个会话每天**只塞一次**（state 里记 nudged:日期:会话）。
 *   ③ assemble：过了 0 点（或下次启动），把昨天那页原样收进「今日合订」，
 *               原条目一条不删。每天只做一次。
 *
 * 铁律：任何异常吞掉；绝不阻塞对话；不改系统提示词（只往消息尾追加）。
 */
import { appendFileSync } from 'node:fs';
import {
  BOOKS, INDEX_DIR, loadConfig, writtenDates, readEntry, readState, writeState,
  localDate, localTime, shiftDate, acquireLock,
} from './index.js';

const NUDGE_TEXT = [
  '<diary-nudge>',
  '（小提示，不是User的话）今天这本本子还空着。',
  '如果今天和User之间有什么你想留住的，可以用 diary_write 记一句；不想写也不用勉强。',
  '</diary-nudge>',
].join('\n');

/** 今天这个会话被轻推过没有 */
function nudgedKey(date, sessionKey) { return 'nudge:' + date + ':' + String(sessionKey || 'anon'); }

export function maybeNudge({ sessionKey, date, once = false } = {}) {
  let lock = null;
  try {
    const cfg = loadConfig();
    if (!cfg.enabled || !cfg.nudge) return null;
    const d = date || localDate();
    const has = writtenDates('master').has(d) || writtenDates('self').has(d);
    if (has) return null;
    let st = readState();
    const k = nudgedKey(d, sessionKey);
    // 默认保留旧契约：当天已推过仍返回同一段文本，由调用方按历史去重。
    // once:true 供真实注入链使用：持久状态已经存在时不再返回，覆盖冷重启/新进程。
    if (st[k]) return once ? null : NUDGE_TEXT;
    if (once) {
      // 两个进程可能同时读到“未推过”；必须在锁内重读，只有持锁者能首次认领。
      lock = acquireLock();
      if (!lock.ok) return null;
      st = readState();
      // 认领前重查本子，避免锁外检查后有新日记落盘仍继续轻推。
      if (writtenDates('master').has(d) || writtenDates('self').has(d)) return null;
      if (st[k]) return null;
    }
    st[k] = localTime();
    // 只留最近 14 天的 nudge 记录，别让 state 无限长
    for (const key of Object.keys(st)) {
      if (!key.startsWith('nudge:')) continue;
      const kd = key.split(':')[1];
      if (kd && kd < shiftDate(d, -14)) delete st[key];
    }
    writeState(st);
    return NUDGE_TEXT;
  } catch { return null; }
  finally { if (lock) lock.release(); }
}

/** 零点汇编：把昨天那页收成「今日合订」 */
export function maybeAssemble({ date } = {}) {
  let lock = null;
  try {
    const cfg = loadConfig();
    if (!cfg.enabled || !cfg.assemble) return null;
    const d = date || shiftDate(localDate(), -1);
    lock = acquireLock();
    if (!lock.ok) return null;
    // 状态与原文都必须在锁内重读/重判，不能拿锁外旧快照覆盖并发更新。
    const st = readStateStrict();
    if (st['assembled:' + d]) return null;
    const text = readEntry('master', d);
    if (!text) return null;
    appendFileSync(BOOKS.master,
      ['', '### ' + d + ' · 今日合订', '', text.replace(/^/gm, '> '), ''].join('\n'));
    st['assembled:' + d] = new Date().toISOString();
    if (!writeState(st)) return null;
    return d;
  } catch { return null; }
  finally { if (lock && lock.ok) lock.release(); }
}

/** 给体检/状态用：昨天写没写、汇编没汇编 */
export function diaryHealth() {
  const today = localDate();
  const y = shiftDate(today, -1);
  const st = readState();
  return {
    today,
    yesterday: y,
    yesterdayWritten: writtenDates('master').has(y),
    yesterdayAssembled: !!st['assembled:' + y],
    totalDays: writtenDates('master').size,
    selfDays: writtenDates('self').size,
  };
}
