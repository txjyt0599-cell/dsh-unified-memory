/**
 * lib/dispatch/ledger.js —— 派单台账（Write-Ahead 三步 + 原子落盘 + 崩溃恢复）
 * [2026-10-28 · 派单回执状态机 v1 接线]
 *
 * ## 为什么自己存一份
 * journal（agent-team :1178）的 message schema 只有
 *   { id, senderId, senderName, targetId, content }
 * —— **没有 taskId、没有 sentAt、没有 ackMsgId**。
 * 所以"只读 journal 就够了"不成立：算不出"投了多久还没回执"。
 * 结论：**只存 journal 缺的列**，绝不重复存 messageId/targetId/投递状态（避免两份真相）。
 *
 * ## Write-Ahead 三步（防孤儿映射）
 *   ① 投递前先落盘 status=pending（含 taskId/sentAt）
 *   ② 投递成功 ⇒ 更新 confirmed + 绑定 messageId
 *   ③ 投递抛错 ⇒ 更新 aborted（直接结案，不进在途监控）
 *   崩溃恢复：pending 超过 T 仍无 confirmed/aborted ⇒ 转 aborted + crashed_during_dispatch
 *
 * ## 原子写
 * 临时文件 + rename。绝不直接覆写台账（半截文件 = 全部在途单丢失）。
 */

import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { STATE, DEFAULTS, nextLedgerState, findCrashedPending } from './state-machine.js';
import { dataPath } from '../paths.js';

const SCHEMA = 'Assistant-dispatch-ledger.v1';

/** 台账默认位置 */
export const DEFAULT_LEDGER_PATH = dataPath('dispatch/dispatch-active.json');

/**
 * @param {object} opts { path, logger }
 */
export function createLedger(opts) {
  const o = opts || {};
  const file = String(o.path || DEFAULT_LEDGER_PATH);
  const log = o.logger || null;
  const maxClosed = Number(o.maxClosed) || 50;

  let state = { schema: SCHEMA, records: [], closed: [] };

  function load() {
    try {
      if (!existsSync(file)) return state;
      const raw = readFileSync(file, 'utf8');
      const j = JSON.parse(raw);
      if (j && j.schema === SCHEMA && Array.isArray(j.records)) {
        state = { schema: SCHEMA, records: j.records, closed: Array.isArray(j.closed) ? j.closed : [] };
      }
    } catch (e) {
      // 台账损坏不能拖垮主流程；但必须留痕（不能静默）
      try { log && log.miss && log.miss({ level: 'dispatch-ledger-load', reason: String(e && e.message || e) }); } catch {}
    }
    return state;
  }

  /** 原子写：临时文件 + rename（同盘 rename 是原子的） */
  function flush() {
    try {
      const dir = dirname(file);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      const tmp = file + '.tmp-' + process.pid + '-' + Date.now();
      writeFileSync(tmp, JSON.stringify(state, null, 1), 'utf8');
      renameSync(tmp, file);
      return true;
    } catch (e) {
      try { log && log.miss && log.miss({ level: 'dispatch-ledger-flush', reason: String(e && e.message || e) }); } catch {}
      return false;
    }
  }

  /** ① 投递前：写 pending（Write-Ahead） */
  function begin(taskId, payload) {
    const p = payload || {};
    const rec = {
      taskId: String(taskId),
      status: STATE.PENDING,
      sentAt: Number(p.sentAt) || Date.now(),
      targetName: String(p.targetName || ''),
      subject: String(p.subject || '').slice(0, 200),
      eventCountBefore: Number(p.eventCountBefore) || 0,
      messageId: null,
      ackMsgId: null,
      note: '',
    };
    state.records.push(rec);
    flush();
    return rec;
  }

  /** ②/③ 投递结果回填 */
  function settle(taskId, event, payload) {
    const i = state.records.findIndex(function (r) { return r && r.taskId === taskId; });
    if (i < 0) return null;
    state.records[i] = nextLedgerState(state.records[i], event, payload);
    flush();
    return state.records[i];
  }

  /** 销账：移出在途、进 closed（保留五元组跳转键） */
  function close(taskId, payload) {
    const p = payload || {};
    const i = state.records.findIndex(function (r) { return r && r.taskId === taskId; });
    if (i < 0) return null;
    const rec = state.records[i];
    const closedRec = {
      taskId: rec.taskId,
      srcSessionId: String(p.srcSessionId || rec.srcSessionId || ''),
      dstSessionId: String(p.dstSessionId || rec.dstSessionId || ''),
      sentAt: Number(rec.sentAt) || 0,
      closedAt: Number(p.now) || Date.now(),
      reqMsgId: rec.messageId || null,
      ackMsgId: String(p.ackMsgId || '') || null,
      oneLineVerdict: String(p.verdict || '').slice(0, 200),
      targetName: rec.targetName,
      subject: rec.subject,
    };
    state.records.splice(i, 1);
    state.closed.push(closedRec);
    while (state.closed.length > maxClosed) state.closed.shift();
    flush();
    return closedRec;
  }

  /** 崩溃恢复：pending 超时 ⇒ aborted */
  function recoverCrashed(now, ttlMs) {
    const crashed = findCrashedPending(state.records, now, ttlMs || DEFAULTS.pendingCrashMs);
    for (const c of crashed) settle(c.taskId, 'scan-crashed', { now: now || Date.now() });
    if (crashed.length) {
      try { log && log.wake && log.wake({ level: 'dispatch-ledger-recovered', n: crashed.length }); } catch {}
    }
    return crashed;
  }

  function list() { return state.records.slice(); }
  function listClosed() { return state.closed.slice(); }
  function find(taskId) {
    return state.records.find(function (r) { return r && r.taskId === taskId; }) || null;
  }
  /** 在途单中超过阈值的（供对账扫描） */
  function dueForScan(now, deadlineMs) {
    const n = Number(now) || Date.now();
    const d = Number(deadlineMs) || DEFAULTS.sampleIntervalMs;
    return state.records.filter(function (r) {
      return r && (r.status === STATE.CONFIRMED || r.status === STATE.IN_PROGRESS) && n - Number(r.sentAt) >= d;
    });
  }

  load();
  try { recoverCrashed(Date.now()); } catch {}

  return {
    begin, settle, close, recoverCrashed, list, listClosed, find, dueForScan,
    load, flush,
    get path() { return file; },
  };
}

export default { createLedger, DEFAULT_LEDGER_PATH, SCHEMA };
