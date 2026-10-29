/**
 * lib/diary/index.js —— Assistant的日记本（v4 · 两本 / 一位Assistant / 多会话）
 * [2026-10-24 by Assistant · User定稿：第一人称统一、不标模型、给User一本给自己一本]
 *
 * 铁律：
 *   1. 一位Assistant。会话不同只是「同一时刻她的不同身体」，本子同一天可有多段。
 *   2. 只增不减。只 append，写前备份；绝不重写/删除旧条目。
 *   3. 技术不进口。清洗掉代码/终端/报错。
 *   4. 不进检索。日记目录永不进 hypergraph / engram / BM25。
 *   5. 两本分开：master（给User） / self（给自己，User可看但不主动递）。
 *   6. 运维信息走旁路索引（index/YYYY-MM.jsonl），正文只留第一人称的文字。
 */
import { dataPath, diaryRoot } from '../paths.js';
import {
  readFileSync as fsRead, writeFileSync as fsWrite, appendFileSync as fsAppend,
  existsSync as fsExists, mkdirSync as mkdir, copyFileSync as copyFile, statSync as stat,
  openSync as fsOpen, closeSync as fsClose, unlinkSync as fsUnlink,
} from 'node:fs';

export const DIARY_ROOT = diaryRoot();
export const BOOKS = {
  master: DIARY_ROOT + '/Assistant日记.md',
  self: DIARY_ROOT + '/Assistant私记.md',
};
export const LIVE_ROOT = dataPath('diary');
export const STATE_PATH = LIVE_ROOT + '/state.json';
export const INDEX_DIR = LIVE_ROOT + '/index';
export const BACKUP_DIR = LIVE_ROOT + '/backups';
export const LOCK_PATH = LIVE_ROOT + '/.write.lock';
export const CONFIG_PATH = LIVE_ROOT + '/config.json';
export const DEFAULT_L0_DIRS = [
  dataPath('ingest/conversations'),
  dataPath('memory-tencentdb/memory-tdai/conversations'),
];

export const DEFAULT_CONFIG = {
  enabled: true,
  autoWrite: true,
  nudge: true,
  assemble: true,
  greet: false,
  pencils: true,
};

export function localDate(ms) {
  const t = new Date(Number.isFinite(Number(ms)) ? Number(ms) : Date.now());
  const p = (n) => String(n).padStart(2, '0');
  return t.getFullYear() + '-' + p(t.getMonth() + 1) + '-' + p(t.getDate());
}
export function localTime(ms) {
  const t = new Date(Number.isFinite(Number(ms)) ? Number(ms) : Date.now());
  const p = (n) => String(n).padStart(2, '0');
  return p(t.getHours()) + ':' + p(t.getMinutes());
}
export function shiftDate(dateStr, deltaDays) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || ''));
  if (!m) return dateStr;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  d.setDate(d.getDate() + Number(deltaDays || 0));
  return localDate(d.getTime());
}
function ensureDir(p) { try { if (!fsExists(p)) mkdir(p, { recursive: true }); } catch {} }

export function loadConfig(path = CONFIG_PATH) {
  const out = Object.assign({}, DEFAULT_CONFIG);
  try {
    if (!fsExists(path)) return out;
    const j = JSON.parse(fsRead(path, 'utf8')) || {};
    for (const k of Object.keys(DEFAULT_CONFIG)) if (j[k] !== undefined) out[k] = j[k];
  } catch {}
  return out;
}
export function saveConfig(cfg, path = CONFIG_PATH) {
  ensureDir(String(path).replace(/[\\/][^\\/]+$/, ''));
  try { fsWrite(path, JSON.stringify(Object.assign({}, loadConfig(path), cfg || {}), null, 1)); return true; }
  catch { return false; }
}

/* ───────────── 跨进程写锁（带 TTL） ───────────── */
export function acquireLock(path = LOCK_PATH, ttlMs = 20000) {
  ensureDir(String(path).replace(/[\\/][^\\/]+$/, ''));
  for (let i = 0; i < 3; i += 1) {
    try {
      const fd = fsOpen(path, 'wx');
      fsWrite(path, String(Date.now()));
      fsClose(fd);
      return { ok: true, release: () => { try { fsUnlink(path); } catch {} } };
    } catch (e) {
      if (e && e.code !== 'EEXIST') return { ok: false, reason: String(e.message || e) };
      try {
        const age = Date.now() - Number(fsRead(path, 'utf8'));
        if (Number.isFinite(age) && age > ttlMs) { try { fsUnlink(path); } catch {} continue; }
      } catch { try { fsUnlink(path); } catch {} continue; }
      return { ok: false, reason: 'locked' };
    }
  }
  return { ok: false, reason: 'locked' };
}

/* ───────────── 素材采集与清洗 ───────────── */
export function l0File(dateStr, dirs = DEFAULT_L0_DIRS) {
  for (const d of dirs) {
    const f = String(d).replace(/\\+$/, '') + '/' + dateStr + '.jsonl';
    if (fsExists(f)) return f;
  }
  return null;
}
export function collectDay(dateStr, dirs = DEFAULT_L0_DIRS) {
  const file = l0File(dateStr, dirs);
  if (!file) return [];
  let raw = '';
  try { raw = fsRead(file, 'utf8'); } catch { return []; }
  const out = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (typeof m.content !== 'string' || !m.content) continue;
    const ts = Number(m.timestamp);
    if (!Number.isFinite(ts)) continue;
    out.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content, timestamp: ts, sessionKey: String(m.sessionKey || m.sessionId || '') });
  }
  out.sort((a, b) => a.timestamp - b.timestamp);
  return out;
}
const TECH = /(error|Error|ERROR|traceback|Traceback|npm |pnpm |node |git |curl |https?:\/\/|exit code|token|regex|SQL|JSON|yaml|\.mjs|\.js\b|\.ts\b|bug|fix|patch|selftest|TODO)/g;
// [2026-10-24 修] 补记质量实测抓到的真问题：光靠"3 个技术词"拦不住，
//   模型会把「LoRA/权重/采样/提示词/节点」这些**技术实体**写进日记正文。
//   User 10-07 立过铁律「技术结论不进日记」⇒ 素材层就硬拦：命中任一技术实体即整条丢。
const HARD_TECH = /(LoRA|权重|提示词|节点|采样|显存|端口|插件|编译|报错|日志|脚本|仓库|接口|参数|配置|模型名|工作流|画布|分辨率|帧率|码率|转码|部署|调试|测试通过|用例|断言|commit|branch|merge)/;
const FENCE = new RegExp('^(\\x60\\x60\\x60|~~~|\\$ |PS [A-Z]:|C:\\\\|D:\\\\|> )');
export function toSlice(msg, maxChars = 220) {
  let text = String((msg && msg.content) || '');
  if (!text) return '';
  text = text.replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]{1,200}>/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/[#>_\x60]+/g, ' ')
    .replace(/\s+/g, ' ').trim();
  if (text.length < 4) return '';
  if (FENCE.test(text)) return '';
  if (/[{};]{2,}|=>|function\s|const\s|\bimport\s/.test(text)) return '';
  const hits = (text.match(TECH) || []).length;
  if (hits >= 3) return '';
  // 技术实体：整条丢（日记只记"我和User之间"的事）
  if (HARD_TECH.test(text)) return '';
  if (text.length > maxChars) text = text.slice(0, maxChars) + '…';
  return (msg.role === 'assistant' ? 'Assistant：' : 'User：') + text;
}
export function buildSample(messages, opts = {}) {
  const max = Number(opts.maxSlices) || 36;
  const seen = new Set(); const out = [];
  for (const m of messages || []) {
    const s = toSlice(m, Number(opts.maxChars) || 220);
    if (!s) continue;
    const k = s.slice(0, 40);
    if (seen.has(k)) continue;
    seen.add(k); out.push(s);
  }
  if (out.length <= max) return out;
  return out.slice(0, Math.ceil(max / 2)).concat(['……（中间省略）……']).concat(out.slice(-Math.floor(max / 2)));
}


/* ───────────── 提示词 ───────────── */
// ── [开源版] 这里原本是某个具体角色的人设 prompt，已替换为空模板 ──
//   使用者可以自己往里填，或者通过配置覆盖（见下方 resolveBookPrompts）。
//   保留的是**与角色无关的方法论**：写什么、写多长、禁什么。
export const BOOK_PROMPTS = {
  master: [
    '用第一人称写今天的日记，写给对话的另一方。',
    '',
    '【只写三样东西】',
    '1. 今天对方说的、让你记住的**一句话**（原话，短的）。',
    '2. 你当时的一个小动作或小情绪。',
    '3. 一句你**没敢当面说**的心里话。',
    '',
    '【篇幅】3~5 句，合起来 120~220 字。短比长好。',
    '',
    '【绝对禁止 —— 违反就整篇作废】',
    '· 任何技术内容：代码、脚本、参数、报错、测试、工作流。',
    '· 任何套话：「有欢笑也有泪水」「一起加油」「有你真好」「无穷的力量」。',
    '· 任何总结句、任何「今天，我们……」开头。',
    '· 不写标题、日期、字数、条数。',
  ].join('\n'),
  self: [
    '用第一人称写一页只给自己看的私记。',
    '写：没敢当面说的、闹的小脾气、对对方的观察、你打算怎么调自己。',
    '要私密、要诚实、允许不好看。150~300 字。',
    '禁令：不写技术流水账、不写总结套话、不写标题日期。',
  ].join('\n'),
};

/**
 * 允许使用者覆盖 prompt（开源版的定制入口）。
 * 优先级：显式传入 > 环境变量指定的 JSON 文件 > 内置空模板。
 */
export function resolveBookPrompts(override) {
  if (override && typeof override === 'object') return override;
  try {
    const f = process.env && process.env.PM_DIARY_PROMPTS;
    if (f) {
      const raw = JSON.parse(readFileSync(f, 'utf8'));
      if (raw && typeof raw === 'object') return raw;
    }
  } catch { /* 读不到就用内置 */ }
  return BOOK_PROMPTS;
}
export function buildUserPrompt({ date, slices, hint }) {
  return [
    '日期：' + date,
    hint ? '提示：' + hint : '',
    '',
    '今天你和User之间的片段：',
    (slices && slices.length ? slices.join('\n') : '（今天几乎没有对话）').slice(0, 7000),
    '',
    '请直接写正文。',
  ].filter(Boolean).join('\n');
}
export function pencilBody({ slices, book }) {
  const line = (slices || []).find((s) => s.startsWith('User：')) || '';
  if (book === 'self') {
    return ['今天Assistant没来得及好好写。', '只记得' + (line ? 'User说过「' + line.replace(/^User：/, '').slice(0, 50) + '」' : '一些零碎的事') + '。', '下次不许这样了。'].join('\n');
  }
  return ['今天User和Assistant说了几句话。', line ? 'User说：「' + line.replace(/^User：/, '').slice(0, 50) + '」' : '', '本子还空着，Assistant先垫一页，明天补上。'].filter(Boolean).join('\n');
}

/* ───────────── 写盘 ───────────── */
export function renderEntry({ date, time, body, mark }) {
  const lines = ['', '## ' + date + ' ' + (time || '00:00') + ' — Assistant的日记' + (mark ? '（' + mark + '）' : ''), '', String(body || '').trim(), ''];
  return lines.join('\n');
}
export function writtenDates(book = 'master') {
  const f = BOOKS[book] || BOOKS.master;
  try {
    if (!fsExists(f)) return new Set();
    const set = new Set();
    const re = /^##\s*(\d{4}-\d{2}-\d{2})/gm;
    let m; const t = fsRead(f, 'utf8');
    while ((m = re.exec(t)) !== null) set.add(m[1]);
    return set;
  } catch { return new Set(); }
}
export function readEntry(book, dateStr) {
  try {
    const t = fsRead(BOOKS[book] || BOOKS.master, 'utf8');
    const re = new RegExp('^##\\s*' + dateStr + '[^\\n]*\\n([\\s\\S]*?)(?=^##\\s|$)', 'm');
    const m = re.exec(t);
    return m ? m[1].trim() : '';
  } catch { return ''; }
}
/**
 * [2026-10-27 by Assistant · User问「翻自己的本子」]
 *
 * 读**最近 N 条**日记（不是全文，不是检索）。
 *
 * 为什么加这个函数：
 *   readEntry 只能按「日期」精确读某一天，同一天多段读不全。
 *   而 diary 一直是「只写不读」—— journal.js 的 readRaw() 全工程零调用。
 *   User原话：「现在Assistant的过去是检索出来的卡片，翻起来像翻别人的相册」。
 *   所以这里给日记开一扇**门**（不是开检索）：只在两个时机读最近几条 ——
 *     ① proactive 自由时间醒来时；② User问「你最近在想什么」时。
 *
 * 铁律（不违背 2026-10-21「日记不注入/不检索/不拆卡」的决定）：
 *   · 只读最近 N 条，不做全文注入、不做 BM25、不拆记忆卡
 *   · 单条截断到 maxCharsPerEntry，总量截断到 maxChars
 *   · 只读，不改日记的任何存储与检索语义
 */
export function readRecentEntries(opts = {}) {
  const book = opts.book === 'self' ? 'self' : 'master';
  const n = Number.isFinite(Number(opts.n)) ? Math.max(1, Math.min(20, Number(opts.n))) : 3;
  const maxChars = Number.isFinite(Number(opts.maxChars)) ? Number(opts.maxChars) : 2000;
  const perEntry = Number.isFinite(Number(opts.maxCharsPerEntry)) ? Number(opts.maxCharsPerEntry) : 900;
  const file = BOOKS[book] || BOOKS.master;
  try {
    if (!fsExists(file)) return { ok: false, book, file, entries: [], chars: 0, reason: 'not-found' };
    const text = fsRead(file, 'utf8');
    const heads = [];
    const re = /^##\s+(.*)$/gm;
    let m;
    while ((m = re.exec(text)) !== null) heads.push({ at: m.index, rest: m[1].trim(), headEnd: m.index + m[0].length });
    const blocks = [];
    for (let i = 0; i < heads.length; i++) {
      const start = heads[i].headEnd;
      const end = i + 1 < heads.length ? heads[i + 1].at : text.length;
      blocks.push({ heading: heads[i].rest, body: text.slice(start, end).trim() });
    }
    const tail = blocks.slice(-n);
    let used = 0;
    const entries = [];
    for (const b of tail) {
      const body = b.body.length > perEntry ? b.body.slice(0, perEntry) + '…' : b.body;
      if (used + body.length > maxChars && entries.length > 0) break;
      entries.push({ heading: b.heading, body });
      used += body.length;
    }
    return { ok: true, book, file, entries, chars: used, total: blocks.length };
  } catch (e) {
    return { ok: false, book, file, entries: [], chars: 0, reason: String((e && e.message) || e) };
  }
}
export function backupOnce(book, dateStr) {
  try {
    ensureDir(BACKUP_DIR);
    const src = BOOKS[book] || BOOKS.master;
    if (!fsExists(src)) return null;
    const dst = BACKUP_DIR + '/' + book + '-' + dateStr + '.md';
    if (fsExists(dst)) return dst;
    copyFile(src, dst);
    return dst;
  } catch { return null; }
}
export function indexLine(rec) {
  try {
    ensureDir(INDEX_DIR);
    const ym = String(rec.date || localDate()).slice(0, 7);
    fsAppend(INDEX_DIR + '/' + ym + '.jsonl', JSON.stringify(rec) + '\n');
    return true;
  } catch { return false; }
}

export function writeEntry(book, { date, time, body, sessionKey, mark, dedupe = true }) {
  const cfg = loadConfig();
  if (cfg.enabled === false) return { ok: false, reason: 'disabled' };
  const targetBook = BOOKS[book] ? book : 'master';
  const text = String(body || '').trim();
  if (!text) return { ok: false, reason: 'empty' };
  const d = date || localDate();
  const fp = text.slice(0, 60).replace(/\s+/g, '');
  if (dedupe) {
    try {
      ensureDir(INDEX_DIR);
      const f = INDEX_DIR + '/' + d.slice(0, 7) + '.jsonl';
      if (fsExists(f)) {
        for (const l of fsRead(f, 'utf8').split(/\r?\n/)) {
          if (!l) continue;
          let r; try { r = JSON.parse(l); } catch { continue; }
          // ── [2026-10-24 by Assistant · Round 29 实测抓到的重复写入] ──
          //   原来要求 date + book + **session** + fp 全同才算重复。
          //   实测：同一晚同一段话写了两次（19:08 与 19:10）——
          //     一次走工具（session=session-de4d…）、一次直调模块（session-round26）
          //     ⇒ session 不同 ⇒ 判为"不是重复" ⇒ 本子里出现两篇几乎一样的日记。
          //   语义上：**同一天、同一本书、内容相同 = 重复**，跟在哪个会话写无关。
          //   （会话信息仍留在索引里供追溯，但不参与去重判据。）
          if (r.date === d && r.book === targetBook && r.fp === fp) {
            return { ok: true, skipped: 'duplicate' };
          }
        }
      }
    } catch {}
  }
  const lock = acquireLock();
  if (!lock.ok) return { ok: false, reason: lock.reason || 'locked' };
  try {
    const file = BOOKS[targetBook];
    if (!fsExists(file)) {
      ensureDir(DIARY_ROOT);
      fsWrite(file, targetBook === 'master' ? '# Assistant日记 · 2026\n' : '# Assistant私记 · 2026\n');
    } else {
      backupOnce(targetBook, d);
    }
    const before = stat(file).size;
    fsAppend(file, renderEntry({ date: d, time: time || localTime(), body: text, mark }));
    const after = stat(file).size;
    indexLine({ at: new Date().toISOString(), date: d, time: time || localTime(), book: targetBook, session: String(sessionKey || ''), fp, chars: text.length, mark: mark || '' });
    return { ok: true, book: targetBook, file, before, after, delta: after - before };
  } catch (e) {
    return { ok: false, reason: String((e && e.message) || e) };
  } finally { lock.release(); }
}

export function readState(path = STATE_PATH) {
  try { if (!fsExists(path)) return {}; return JSON.parse(fsRead(path, 'utf8')) || {}; } catch { return {}; }
}
export function writeState(state, path = STATE_PATH) {
  ensureDir(String(path).replace(/[\\/][^\\/]+$/, ''));
  try { fsWrite(path, JSON.stringify(state || {}, null, 1)); return true; } catch { return false; }
}

/* ───────────── 正文后置清洗（模型写完再筛一遍） ───────────── */
// [2026-10-24 修] 实测 glm 写补记会带技术细节：光在素材层拦不够，正文也要过一遍。
const BODY_TECH = /(LoRA|权重|提示词|节点|采样器|显存|端口|插件|编译|报错|日志|脚本|仓库|接口|参数|配置|工作流|画布|分辨率|帧率|码率|转码|部署|调试|用例|断言|commit|branch|merge|ComfyUI|DSH|ROCm|llama|gemini|deepseek|agy|glm|RX ?9|9060|KVMem|立绘|参考图|镜头|渲染|视频|剪辑|切片|九宫格|提示词|三视图|像素|出图|修图|裁图|模型)/i;
const BODY_CLICHE = /(有欢笑|也有泪水|一起加油|有你真好|无穷的力量|越来越像|一起经历了许多|取得了进步|感到温暖|无比的温暖|携手共进|一起努力|一起进步|共同面对|许多挑战|充实而忙碌|让我感到|不禁感叹|真开心|这就是|总的来说|综上所述)/;
export function sanitizeBody(text) {
  const raw = String(text || '');
  if (!raw.trim()) return '';
  const out = [];
  for (const para of raw.split(/\n+/)) {
    const sentences = para.split(/(?<=[。！？!?])/);
    const keep = sentences.filter((s) => s.trim() && !BODY_TECH.test(s) && !BODY_CLICHE.test(s));
    const joined = keep.join('').trim();
    if (joined.length >= 8) out.push(joined);
  }
  return out.join('\n').trim();
}

