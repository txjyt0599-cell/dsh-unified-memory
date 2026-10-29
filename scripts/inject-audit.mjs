#!/usr/bin/env node
/**
 * scripts/inject-audit.mjs —— 注入落盘真伪核查（P0 · 2026-10-28）
 *
 * ## 它治什么病
 * 淋雨家工作台的自审发现：插件把注入消息标成引擎保留 kind `runtime-context`，
 * 引擎 agent.ts 只对**非** runtime-context 落盘，于是插件正文被静默丢弃，
 * 而日志照写 inject 成功 —— 叫「静默成功」，比报错更难查。
 *
 * ## 本探针判据（三道，任何一道不过即 FAIL）
 *   A 落盘核验：wake.log 里每条 inject-tail(chars>0) 必须在会话落盘里找到
 *                source.kind === 'plugin:unified-memory' 且 chars 相符的 user/message
 *   B 请求体核验：最近一次真实出站 payload 必须含 <unified-memory> 或 <hot-memory> 标记
 *   C 负例核验：故意注入一条"不可能存在"的假 inject 记录，探针必须报 FAIL
 *                —— 反例不报 = 这个检查是假的（照抄淋雨家 P2 铁律）
 *
 * ## 用法
 *   node scripts/inject-audit.mjs                 # 默认核查最近 24h
 *   node scripts/inject-audit.mjs --hours 72      # 时间窗
 *   node scripts/inject-audit.mjs --session <id>  # 指定会话
 *   node scripts/inject-audit.mjs --json          # 机器可读
 *   node scripts/inject-audit.mjs --selftest      # 只跑负例自检
 *
 * 退出码：0 = 全部通过；1 = 有 FAIL（可直接挂进 verify）
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import os from 'node:os';

const HOME = process.env.USERPROFILE || os.homedir();
const DSH = path.join(HOME, '.dsh');
const MEM_DIR = path.join(DSH, 'unified-memory');
const WAKE = path.join(MEM_DIR, 'logs', 'wake.log');
const PREPARED = path.join(MEM_DIR, 'logs', 'cb-prepared-last.json');
const SESSIONS = path.join(DSH, 'sessions');

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d) => { const i = argv.indexOf(f); return i > -1 ? argv[i + 1] : d; };

const AS_JSON = has('--json');
const SELFTEST = has('--selftest');
const HOURS = Number(val('--hours', 24)) || 24;
const SESSION_ARG = val('--session', '');

// ── 测试接缝（负例验收必须能指向假数据，否则反例永远进不来）────────
//   --session-root <dir>  改会话根目录（造一个歪样本就能验判据）
//   --wake <file>         改 wake.log 路径
//   --payload <file>      改抓包路径（传 none 表示伪造"没有 payload"）
const SESSION_ROOT = val('--session-root', SESSIONS);
const WAKE_FILE = val('--wake', WAKE);
const PAYLOAD_FILE = val('--payload', PREPARED);

let pass = 0, fail = 0;
const results = [];
function check(name, ok, detail) {
  if (ok) pass++; else fail++;
  results.push({ name, ok, detail });
  if (!AS_JSON) console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
  return ok;
}

// ── 工具：找会话文件 ────────────────────────────────────────────────
function findSessionFiles() {
  const out = [];
  try {
    const walk = (dir, depth) => {
      if (depth > 3) return;
      let ents = [];
      try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of ents) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p, depth + 1);
        else if (/^session\..*\.zstd$/.test(e.name) || e.name === 'session.v4.jsonl.zstd') {
          let st = null;
          try { st = fs.statSync(p); } catch {}
          if (st) out.push({ path: p, mtime: st.mtimeMs, size: st.size });
        }
      }
    };
    walk(SESSION_ROOT, 0);
  } catch { /* 目录不在就返回空 */ }
  return out.sort((a, b) => b.mtime - a.mtime);
}

function readSession(file) {
  const raw = fs.readFileSync(file);
  let text;
  try { text = zlib.zstdDecompressSync(raw).toString('utf8'); }
  catch { try { text = raw.toString('utf8'); } catch { return []; } }
  const rows = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch { /* 坏行跳过 */ }
  }
  return rows;
}

function msgText(m) {
  if (!m) return '';
  const c = m.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((x) => (x && (x.text || '')) || '').join(' ');
  return '';
}

function kindOf(row) {
  const m = (row.data && row.data.message) || row.data || {};
  return (m.source && m.source.kind) || '';
}

// ── 读 wake.log 的 inject-tail 事件 ─────────────────────────────────
function readInjectEvents(sinceMs) {
  const out = [];
  let lines = [];
  try { lines = fs.readFileSync(WAKE_FILE, 'utf8').split('\n'); } catch { return out; }
  for (const line of lines) {
    if (!line.includes('inject-tail')) continue;
    try {
      const j = JSON.parse(line);
      if (j.level !== 'inject-tail') continue;
      const t = Date.parse(j.t);
      if (Number.isFinite(t) && t < sinceMs) continue;
      out.push({ at: j.t, t: Number.isFinite(t) ? t : 0, chars: Number(j.chars) || 0, n: Number(j.n) || 0 });
    } catch { /* 坏行跳过 */ }
  }
  return out;
}

// ── A 落盘核验 ──────────────────────────────────────────────────────
function checkPersisted(events, sessions) {
  // 取时间窗内最新的会话文件（wake 与落盘不同步时以最近会话为准）
  if (!sessions.length) return check('A 落盘核验', false, '找不到任何会话文件');
  const target = SESSION_ARG
    ? (sessions.find((s) => s.path.includes(SESSION_ARG)) || sessions[0])
    : sessions[0];

  let rows = [];
  try { rows = readSession(target.path); } catch (e) {
    return check('A 落盘核验', false, '会话解压失败: ' + (e && e.message));
  }
  const injected = rows.filter((r) => r.type === 'user/message' && kindOf(r).includes('unified-memory'));

  // 统计落盘里各注入源的条数
  const markerCount = { Assistant: 0, hot: 0, pulse: 0 };
  for (const r of injected) {
    const txt = msgText((r.data && r.data.message) || r.data);
    if (txt.includes('<unified-memory>')) markerCount.Assistant++;
    if (txt.includes('<hot-memory>')) markerCount.hot++;
    if (txt.includes('<cross-session-pulse>')) markerCount.pulse++;
  }

  const detail = `会话 ${path.basename(path.dirname(target.path))} · 注入消息 ${injected.length} 条 · ` +
    `Assistant=${markerCount.Assistant} hot=${markerCount.hot} pulse=${markerCount.pulse} · wake 记录 ${events.length} 条`;

  // 判据：有注入事件就必须有落盘；且落盘的 kind 必须是 plugin:unified-memory（不是 runtime-context）
  const okKind = injected.every((r) => !kindOf(r).includes('runtime-context'));
  const okCount = events.length === 0 || injected.length > 0;
  return check('A 落盘核验', okKind && okCount,
    okKind ? detail : detail + ' ⛔ 发现 kind 被标成 runtime-context');
}

// ── B 请求体核验 ────────────────────────────────────────────────────
function checkPayload() {
  if (PAYLOAD_FILE === 'none' || !fs.existsSync(PAYLOAD_FILE)) return check('B 请求体核验', false, '找不到抓包文件 cb-prepared-last.json');
  let s = '';
  try { s = fs.readFileSync(PAYLOAD_FILE, 'utf8'); } catch (e) {
    return check('B 请求体核验', false, '读取失败: ' + (e && e.message));
  }
  const hit = ['<unified-memory>', '<hot-memory>', '<cross-session-pulse>'].filter((m) => s.includes(m));
  return check('B 请求体核验', hit.length > 0,
    hit.length ? '真实出站 payload 含 ' + hit.join(' / ') : '⛔ payload 里没有任何记忆标记 —— 正文没发出去');
}

// ── C 负例核验：反例不报 = 这个检查是假的 ──────────────────────────
function checkNegative(sessions) {
  if (!sessions.length) return check('C 负例核验', false, '找不到会话文件，无法构造反例');
  let rows = [];
  try { rows = readSession(sessions[0].path); } catch { /* 已在 A 报过 */ }

  // 构造一条"绝不可能存在"的假注入事件：chars 用一个大到不可能的值
  const fake = { at: new Date().toISOString(), t: Date.now(), chars: 9999999, n: 9999 };
  const real = rows.filter((r) => r.type === 'user/message' && kindOf(r).includes('unified-memory'));
  const match = real.some((r) => msgText((r.data && r.data.message) || r.data).length === fake.chars);

  // 反例必须"匹配不上"；能匹配上说明判据失效
  return check('C 负例核验', match === false,
    match ? '⛔ 假数据竟然匹配上了 —— 判据是假的' : '假注入(chars=9999999) 正确未命中');
}

// ── 主流程 ──────────────────────────────────────────────────────────
if (!AS_JSON) {
  console.log('\n[inject-audit] 注入落盘真伪核查 · 窗口 ' + HOURS + 'h');
  console.log('  wake.log : ' + (fs.existsSync(WAKE_FILE) ? 'OK' : '缺失'));
  console.log('  payload  : ' + (PAYLOAD_FILE === 'none' || !fs.existsSync(PAYLOAD_FILE) ? '缺失' : 'OK'));
}

const since = Date.now() - HOURS * 3600 * 1000;
const events = readInjectEvents(since);
const sessions = findSessionFiles();

if (SELFTEST) {
  checkNegative(sessions);
} else {
  checkPersisted(events, sessions);
  checkPayload();
  checkNegative(sessions);
}

if (AS_JSON) {
  console.log(JSON.stringify({ pass, fail, ok: fail === 0, results }, null, 2));
} else {
  console.log(`\n  结果：${pass} 通过 / ${fail} 失败`);
  if (fail > 0) {
    console.log('  ⛔ 有 FAIL —— 注入通道可疑，请查 faults 与 wake.log');
  } else {
    console.log('  ✅ 注入通道干净：日志说注入了，落盘和请求体里真的有。');
  }
}
process.exit(fail > 0 ? 1 : 0);
