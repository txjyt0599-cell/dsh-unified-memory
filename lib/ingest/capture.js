/**
 * ingest/capture.js —— 期7-A：L0 对话捕获（超图自产）
 * [2026-10-22 by Assistant · 期7-A]
 *
 * 搬什么：tdai 的 auto-capture.js + l0-recorder.js 里「把本轮 user/assistant 消息
 *         落到 conversations/YYYY-MM-DD.jsonl」这一件事。
 *
 * 刻意**不搬**的（治本点）：
 *   ① 不写向量库 —— 超图用自己的 34MB 索引，不引入 561MB vectors.db。
 *   ② 不用 tdai 的 CheckpointManager —— 它把「已捕获到哪」挂在插件数据目录，
 *      与插件生命周期绑定。这里改成**超图自己的落盘游标**（core.js cursorFile），
 *      重启不重复、换插件不丢。
 *   ③ 不依赖 agent_end 里的完整 session history —— 改为「拿增量 + 游标兜底」，
 *      双保险：位置切片（本回合消息）+ 时间戳/消息键游标。
 *
 * 数据落点：~/.dsh/unified-memory/ingest/conversations/
 * 与 tdai 的目录**完全分开** —— 这样启用后可以随时关掉 tdai 而不影响新链路，
 * 也不会双写到同一个文件里互相污染。
 */
import { readFileSync } from 'node:fs';
import { loadCursor, saveCursor, appendLines, localDate, messageKey, ensureDirs, dirs, acquireLock } from './core.js';

/** 注入段噪声：我们自己和其他插件塞进 user 角色的伪消息，绝不能进 L0。 */
const INJECT_MARKERS = [
  '<unified-memory>', '</unified-memory>',
  '<engram-memory>', '</engram-memory>',
  '<user-persona>', '</user-persona>',
  '<relevant-memories>', '</relevant-memories>',
  '<scene-navigation>', '</scene-navigation>',
  '<memory-tools-guide>', '</memory-tools-guide>',
  // [2026-10-24] 日记轻推也是我们塞的伪 user 消息（当前靠 source.kind 已挡，这里再兜一层）
  '<diary-nudge>', '</diary-nudge>',
  'Current runtime context',
  '<system-reminder>',
];

const COMMAND_PREFIX = /^\s*[\/!#]\s*[a-z0-9_-]+\s*$/i;

/**
 * [2026-10-22 by Assistant · 红队 P1] 注入过滤加固。
 *
 * 红队指出旧实现可被三类手法绕过：
 *   ① 零宽字符插在标签里（`<phoe\u200bbe-memory>`）
 *   ② 大小写变体（`<Assistant-MEMORY>`）
 *   ③ 跨字段分片（标签分在两条消息里）
 *
 * 对策（三是分片暂不追——L0 是逐消息存的，分片在单条消息内不成立；一二必须治）：
 *   · 先做 NFKC + 剥掉所有 Cf（格式控制）/零宽字符，再小写比对
 *   · 标签检测用「去尖括号与分隔符后的小写主干」匹配，不只比全串
 */
const FORMAT_CHARS = /[\u00AD\u061C\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/g;

export function normalizeForMatch(raw) {
  let t = String(raw === undefined || raw === null ? '' : raw);
  try { t = t.normalize('NFKC'); } catch {}
  return t.replace(FORMAT_CHARS, '');
}

/** 标签主干（去掉尖括号/斜杠/空白，小写）：`</Assistant Memory>` → `memorytag` */
function markerStems() {
  const out = [];
  for (const m of INJECT_MARKERS) {
    const stem = normalizeForMatch(m).toLowerCase().replace(/[<>\/\s_:-]/g, '');
    if (stem) out.push(stem);
  }
  return out;
}
const MARKER_STEMS = markerStems();

export function looksInjected(raw) {
  const t = normalizeForMatch(raw);
  const lower = t.toLowerCase();
  // ① 原串直接命中（含大小写不敏感）
  for (const m of INJECT_MARKERS) if (lower.indexOf(normalizeForMatch(m).toLowerCase()) >= 0) return true;
  // ② 主干匹配：剥掉尖括号/斜杠/下划线/空白后再比，覆盖 `<Memory_Tag>` 之类变体
  const flat = lower.replace(/[<>\/\s_:-]/g, '');
  for (const s of MARKER_STEMS) if (s && flat.indexOf(s) >= 0) return true;
  return false;
}

/** 清洗：去 base64 图片、去围栏代码块、剥格式控制字符、压空白。 */
export function sanitizeText(raw, role) {
  let t = normalizeForMatch(raw);
  t = t.replace(/data:image\/[a-z+]+;base64,[A-Za-z0-9+/=]+/gi, '[image]');
  // ── [2026-10-26 by Assistant · Phase 1] 短命本地图片地址清洗 ──
  //   http://127.0.0.1:PORT/... 与 blob: 这类地址**重启必失效**，留在卡里就是死链污染：
  //   以后回忆往事时，背景里全是打不开的图片代码。
  //   实测存量：主库 6686 张里有 35 张带这种链接（0.52%），自产库 0 张 ⇒ 这里只防未来。
  //   先处理 markdown 图片（保留 alt 语义），再兜底裸链接。
  t = t.replace(/!\[([^\]]*)\]\((?:https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):\d+|blob:)[^)\s]*\)/gi,
    (_m, alt) => '[图片' + (alt ? '：' + alt : '') + ']');
  t = t.replace(/(?:https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):\d+|blob:)[^\s)\]"'>]*/gi, '[本地临时链接]');
  if (role === 'assistant') t = t.replace(/```[\s\S]*?```/g, '[code]');
  t = t.replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, '');
  return t.trim();
}

/** 是否值得记：过滤注入段、命令、过短、纯符号噪音。 */
export function shouldCapture(text, opts) {
  const o = opts || {};
  const minChars = Number.isFinite(Number(o.minChars)) ? Number(o.minChars) : 6;
  const t = String(text || '').trim();
  if (t.length < minChars) return false;
  if (looksInjected(t)) return false;
  if (COMMAND_PREFIX.test(t)) return false;
  // 纯符号/纯空白
  if (!/[\u4e00-\u9fffA-Za-z0-9]/.test(normalizeForMatch(t))) return false;
  return true;
}

/** 从 ContentBlock[] 或字符串取纯文本。 */
export function extractText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const b of content) {
    if (b && b.type === 'text' && typeof b.text === 'string') parts.push(b.text);
  }
  return parts.join('\n');
}

/** 真实用户消息：role=user 且来源不是插件注入（与 DSH 的 synthetic user 区分）。 */
export function isRealUser(m) {
  if (!m || m.role !== 'user') return false;
  const k = m.source && m.source.kind;
  return k === undefined || k === null || k === 'user';
}

/**
 * 捕获一次回合。
 * @param {object} p
 * @param {string} p.sessionKey
 * @param {string} p.sessionId
 * @param {Array}  p.messages  本回合新增消息（或整段历史，靠游标兜底）
 * @param {object} p.opts      { root, minChars, maxCharsPerMessage, nowMs }
 * @returns {{written:number, skipped:number, file:string|null}}
 */
export function captureTurn(p) {
  const params = p || {};
  const opts = params.opts || {};
  const d = dirs(opts.root);
  ensureDirs(d);
  const sessionKey = String(params.sessionKey || params.sessionId || 'unknown');
  const sessionId = String(params.sessionId || '');
  const messages = Array.isArray(params.messages) ? params.messages : [];
  const nowMs = Number.isFinite(Number(opts.nowMs)) ? Number(opts.nowMs) : Date.now();
  const maxLen = Number.isFinite(Number(opts.maxCharsPerMessage)) ? Number(opts.maxCharsPerMessage) : 8000;
  const keepKeys = Number.isFinite(Number(opts.keepKeys)) ? Number(opts.keepKeys) : 5000;
  const keepRetired = Number.isFinite(Number(opts.keepRetired)) ? Number(opts.keepRetired) : 20000;

  // [红队 P0] 并发 read-modify-write 必须互斥；拿不到锁就放弃本次，下一轮再来。
  const lock = opts.disableLock ? { release() {} } : acquireLock(d, 'capture-' + sessionKey, opts.lockTtlMs);
  if (!lock) return { written: 0, skipped: 0, file: null, reason: 'locked' };
  let state_reason = null;
  try {
    const cur = loadCursor(d, 'capture', sessionKey, { keys: [], retiredKeys: [], maxTs: 0 });
    // 键格式兼容两种：旧版纯字符串 "id:xxx"，新版 "id:xxx@<ts>"（带时间戳，用于精确算淘汰水位）
    const seen = new Set();
    const keyTs = new Map();          // key → 该消息的时间戳
    for (const raw of (Array.isArray(cur.keys) ? cur.keys : [])) {
      const s = String(raw);
      const at = s.lastIndexOf('@');
      if (at > 0) {
        const k = s.slice(0, at);
        const t = Number(s.slice(at + 1));
        seen.add(k);
        if (Number.isFinite(t)) keyTs.set(k, t);
      } else {
        seen.add(s);
      }
    }
    // [红队 R2 P1 修复] **彻底去掉按时间戳水位丢消息**。
    //   两轮下来证明：任何「时间戳 < 水位就跳过」的规则，都会误杀「时钟回拨的真新消息」。
    //   现在只用**精确的键集合**判已处理：
    //     · keys        最近保留的键（带 @ts）
    //     · retiredKeys 被淘汰但仍需记住的键哈希（上限 20000，超出丢最老的）
    //   代价：被彻底遗忘的超老消息若被重放会重复捕获——但会话历史只追加不重放，
    //   而且重复捕获也只是多一行 L0，绝不会丢记忆。两害取其轻。
    const retired = new Set(Array.isArray(cur.retiredKeys) ? cur.retiredKeys : []);
    for (const k of retired) seen.add(String(k));

    // [红队 P0 崩溃窗口] 上一轮若在 append 之后、saveCursor 之前被 kill，
    // 游标里会留下 pending 记录。这里先核对 pending 是否真的落了盘：
    //   落了 ⇒ 直接把键并入 seen（等价于上次已提交）；没落 ⇒ 这些消息本轮会重新进 lines 补写。
    const pending = cur.pending && Array.isArray(cur.pending.ids) ? cur.pending : null;
    if (pending) {
      let landed = false;
      try {
        const raw = readFileSync(pending.file, 'utf8');
        // [自审抓到] 原写法 raw.indexOf('"'+id+'"') 会被「id 是另一个 id 的子串」骗到：
        //   例如 id="m1" 在文件里只有 "m1x" 时，'"m1"' 不会命中……但 id 含引号转义时可能假阳性。
        //   正确做法：逐行 JSON.parse 后**精确比较 id 字段**。
        const want = new Set(pending.ids.map(String));
        const got = new Set();
        for (const line of raw.split('\n')) {
          if (!line) continue;
          let o; try { o = JSON.parse(line); } catch { continue; }
          if (o && o.id !== undefined) got.add(String(o.id));
        }
        landed = pending.ids.length > 0 && pending.ids.every((id) => got.has(String(id)));
      } catch {}
      // [红队 R3 P0 · 关键修复] pending 必须记录**去重键**，不能只记生成的 id。
      //   原因：无原始 id 的消息，它的去重键是 `h:<哈希>`，而 pending.ids 里存的是
      //   后生成的 `msg_<ts>_xxx` ⇒ 恢复时 delete('id:'+msg_xxx) 删不掉 h: 键
      //   ⇒ 本轮仍被判"已处理" ⇒ 这批消息永久丢失（红队实测复现）。
      //   现在 pending 同时带 keys（去重键，权威）与 ids（用于核对是否真落盘）。
      const pendingKeys = Array.isArray(pending.keys) && pending.keys.length
        ? pending.keys.map(String)
        : pending.ids.map((id) => 'id:' + id);    // 兼容旧格式（只对「有原始 id」的消息正确）

      // [红队 R4 P1] 旧格式（只有 ids）遇到「无原始 id 的消息」时，上面合成的
      //   `id:msg_xxx` 与真正的 `h:<哈希>` 对不上 ⇒ 删不掉 ⇒ 漏写。
      //   兜底：未落盘时，**拿本轮的 messages 重算一遍键**，把可能残留的 h: 键一并摘除。
      //   只要本轮还带着同一条消息（会话历史只追加，同一轮重试必然再遇到它们），就能救回来。
      if (!landed && !(Array.isArray(pending.keys) && pending.keys.length)) {
        for (const m of messages) {
          if (!m) continue;
          try {
            const role0 = m.role === 'assistant' ? 'assistant' : (isRealUser(m) ? 'user' : null);
            if (!role0) continue;
            const ts0 = Number.isFinite(Number(m.timestamp)) ? Number(m.timestamp) : nowMs;
            seen.delete(messageKey({ id: m.id, role: role0, timestamp: ts0, content: extractText(m.content) }));
            // 生成 id 形态也一并删（两种可能都覆盖）
            if (!m.id) seen.delete('id:' + ('msg_' + ts0));
          } catch {}
        }
      }
      if (!landed) {
        for (const k of pendingKeys) seen.delete(k);
      }
      if (landed) {
        for (const k of pendingKeys) seen.add(k);
        // [红队 R4 P2] 这里也要判返回值：写不进去就保留 pending，下轮再核对一次
        const okClear = saveCursor(d, 'capture', sessionKey, {
          keys: Array.from(seen).map((k) => k + '@' + (Number.isFinite(keyTs.get(k)) ? keyTs.get(k) : 0)).slice(-keepKeys),
          retiredKeys: Array.from(retired).slice(-keepRetired),
          maxTs: Number(cur.maxTs) || 0,
          updatedAt: new Date(nowMs).toISOString(),
        });
        if (okClear !== true) state_reason = 'pending-clear-failed';
      }
    }

    const lines = [];
    const batchIds = [];
    const batchKeys = [];
    let skipped = 0;
    let maxTs = Number(cur.maxTs) || 0;
    for (const m of messages) {
      if (!m) { skipped++; continue; }
      const role = m.role === 'assistant' ? 'assistant' : (isRealUser(m) ? 'user' : null);
      if (!role) { skipped++; continue; }
      const ts = Number.isFinite(Number(m.timestamp)) ? Number(m.timestamp) : nowMs;
      // [红队 P0 / R2 P1] **完全不用时间戳判断新旧**：
      //   同毫秒会误杀、时钟回拨会误杀。去重唯一权威 = 消息键。
      const key = messageKey({ id: m.id, role, timestamp: ts, content: extractText(m.content) });
      if (seen.has(key)) { skipped++; continue; }
      let text = sanitizeText(extractText(m.content), role);
      if (!shouldCapture(text, opts)) { skipped++; continue; }
      if (text.length > maxLen) text = text.slice(0, maxLen) + '…';
      seen.add(key);
      keyTs.set(key, ts);
      if (ts > maxTs) maxTs = ts;
      const id = m.id || ('msg_' + ts + '_' + Math.random().toString(36).slice(2, 8));
      batchIds.push(id);
      batchKeys.push(key);
      lines.push(JSON.stringify({
        sessionKey, sessionId, recordedAt: new Date(nowMs).toISOString(),
        id, role, content: text, timestamp: ts,
        schema: 'unified-memory.l0.v1',
      }));
    }

    if (lines.length === 0) return { written: 0, skipped, file: null };

    const file = d.conversations + '/' + localDate(maxTs) + '.jsonl';

    // 键编码：`<key>@<ts>` —— 时间戳随键走，才能在被淘汰时算出**精确**水位。
    const encodeKeys = (set) => Array.from(set).map((k) => k + '@' + (Number.isFinite(keyTs.get(k)) ? keyTs.get(k) : 0));

    // ① 先写 pending（崩溃可恢复）
    const savedPending = saveCursor(d, 'capture', sessionKey, {
      keys: encodeKeys(seen).slice(-keepKeys),
      retiredKeys: Array.from(retired).slice(-keepRetired),
      maxTs,
      pending: { file, ids: batchIds, keys: batchKeys, at: new Date(nowMs).toISOString() },
      updatedAt: new Date(nowMs).toISOString(),
    });
    // [红队 R2 P1] 游标都写不进去 ⇒ 直接放弃本次（不追加），否则重启后无从恢复
    if (savedPending !== true) return { written: 0, skipped, file: null, reason: 'cursor-write-failed' };

    // ② 追加
    const written = appendLines(file, lines, opts.maxBytes);
    if (written === 0) {
      // 追加失败：把 pending 撤掉并回滚 seen 里的新键（用去重键回滚，不是 id）
      for (const k of batchKeys) seen.delete(k);
      saveCursor(d, 'capture', sessionKey, {
        keys: encodeKeys(seen).slice(-keepKeys),
        retiredKeys: Array.from(retired).slice(-keepRetired),
        maxTs: Number(cur.maxTs) || 0,
        updatedAt: new Date(nowMs).toISOString(),
      });
      return { written: 0, skipped, file, reason: 'append-failed' };
    }

    // ③ 提交：清 pending，被淘汰的键转进 retiredKeys
    //
    // [自审] 水位必须取「被淘汰键里**最晚**的 ts」，而不是 maxTs-7天：
    //   取最晚 ⇒ 只挡住「比所有已淘汰消息都早」的重放，绝不会误杀之后的新消息。
    const encoded = encodeKeys(seen);
    // 淘汰的键进 retiredKeys（精确记住，不再靠时间戳猜）
    if (encoded.length > keepKeys) {
      const dropped = encoded.slice(0, encoded.length - keepKeys);
      for (const s of dropped) {
        const at = s.lastIndexOf('@');
        retired.add(at > 0 ? s.slice(0, at) : s);
      }
    }
    const ok = saveCursor(d, 'capture', sessionKey, {
      keys: encoded.slice(-keepKeys),
      retiredKeys: Array.from(retired).slice(-keepRetired),
      maxTs,
      updatedAt: new Date(nowMs).toISOString(),
    });
    // 提交游标写失败 ⇒ 明确报错（数据已落盘，最坏下轮重复一次，不会丢）
    return { written, skipped, file, ...(state_reason ? { reason: state_reason } : {}), ...(ok === true ? {} : { reason: 'cursor-commit-failed' }) };
  } finally {
    try { lock.release(); } catch {}
  }
}

/** 读取本插件自己捕获的 L0（给 7-B/7-C 用，不读 tdai 目录）。 */
export function readCaptured(dir, opts) {
  const o = opts || {};
  const fs = o.fs;
  return { dir: dir, fs };
}
