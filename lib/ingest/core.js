/**
 * ingest/core.js —— 写入侧搬迁（期7）的地基：路径 / 游标 / 原子写 / 去重哈希。
 * [2026-10-22 by Assistant · 期7]
 *
 * 设计取舍（治本，不是照搬）：
 *   旧三套写入各有自己的游标与目录，重启即丢内存 buffer（L1 覆盖率 2.9% 的真因）。
 *   这里统一：**一份游标格式 + 一个原子写 + 一个去重键**，三样能力共用，
 *   且数据目录属于**超图自己**（~/.dsh/unified-memory/ingest），
 *   删掉 tdai / engram-relay 之后历史仍在、新数据照产。
 */
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync, appendFileSync, unlinkSync, statSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dataPath } from '../paths.js';

export const DEFAULT_INGEST_ROOT = dataPath('ingest');

/**
 * 旧源路径（**纯记录用，零业务读取**）。
 *
 * [2026-10-22 by Assistant · 关旧自检] 这个常量现在**没有任何代码读它**，
 * 保留只为两件事：① 迁移期人工对照；② 体检脚本展示「旧库在哪」。
 * 业务链路（capture/extract/distill）全部只走自己的 ingest 根 —— 删掉旧插件后功能不受影响。
 * （legacy-off-sim.mjs 会静态审计这一点：ingest/ 下出现对旧路径的业务读取即判失败。）
 */
export const LEGACY_DIRS = {
  tdaiL0: dataPath('memory-tencentdb/memory-tdai/conversations'),
  tdaiL1: dataPath('memory-tencentdb/memory-tdai/records'),
  engram: dataPath('engram-relay/engrams.jsonl'),
};

export function dirs(root) {
  const r = String(root || DEFAULT_INGEST_ROOT).replace(/\\+$/, '');
  return {
    root: r,
    conversations: r + '/conversations',
    records: r + '/records',
    cursor: r + '/cursor',
    logs: r + '/logs',
    engrams: r + '/engrams.jsonl',
  };
}

export function ensureDirs(d) {
  for (const p of [d.root, d.conversations, d.records, d.cursor, d.logs]) {
    try { if (!existsSync(p)) mkdirSync(p, { recursive: true }); } catch {}
  }
}

/** 本地日期 YYYY-MM-DD（按机器本地时区，不是 UTC——否则凌晨的记录会跨日错位） */
export function localDate(ms) {
  const t = new Date(Number.isFinite(Number(ms)) ? Number(ms) : Date.now());
  const p = (n) => String(n).padStart(2, '0');
  return t.getFullYear() + '-' + p(t.getMonth() + 1) + '-' + p(t.getDate());
}

export function sha1_16(s) {
  try { return createHash('sha1').update(String(s || ''), 'utf8').digest('hex').slice(0, 16); }
  catch { return 'nohash'; }
}

/** 消息去重键：同一条消息在「双写期」「重启重放」下都必须只算一次。 */
export function messageKey(m) {
  const id = m && m.id ? String(m.id) : '';
  if (id) return 'id:' + id;
  return 'h:' + sha1_16([m && m.role, m && m.timestamp, m && m.content].join('\u0000'));
}

/** 原子写：先写 .tmp 再 rename（Windows 目标已存在时先 unlink）。失败不抛，返回 false。 */
export function atomicWriteJson(file, obj) {
  return atomicWriteText(file, JSON.stringify(obj, null, 1));
}

export function atomicWriteText(file, text) {
  const tmp = file + '.tmp-' + process.pid + '-' + Math.random().toString(36).slice(2, 7);
  try {
    writeFileSync(tmp, text, 'utf8');
    // [2026-10-22 by Assistant · 红队 P1] 去掉「先 unlink 再 rename」的空窗：
    //   那个写法有一个瞬间文件不存在，此刻崩溃或并发读会看到「游标丢失」。
    //   Node 在 Windows 上 renameSync 走 MoveFileEx(REPLACE_EXISTING)，目标存在也能覆盖，
    //   所以先直接 rename；只有真失败（跨卷/被占用）才退回 unlink+rename。
    try {
      renameSync(tmp, file);
      return true;
    } catch {
      try { if (existsSync(file)) unlinkSync(file); } catch {}
      renameSync(tmp, file);
      return true;
    }
  } catch {
    try { if (existsSync(tmp)) unlinkSync(tmp); } catch {}
    return false;
  }
}

/**
 * [2026-10-22 by Assistant · 红队 P0] 跨进程互斥锁（**落盘锁**，带 TTL 自愈）。
 *
 * 为什么必须有：capture / extract / distill 的「读游标 → 算增量 → 追加 → 写游标」
 *   全是 read-modify-write。两个调用撞上会各自读旧游标、各自追加、后写者覆盖前写者
 *   ⇒ 重复写或丢键（红队实验复现）。
 *
 * 为什么不用内存锁：插件被 hot-reload 后会重建成新的模块实例，内存 Map 跟着丢；
 *   而在同一进程里，同步 fs 代码本身不会被打断 —— 真正的风险是**多实例/重载**。
 *   落盘锁能同时覆盖两种情形。
 *
 * 语义：拿锁 → 执行 → 释放。拿不到（别的持有者且未超 TTL）⇒ 直接放弃本次（返回 null），
 *   由下一轮重来 —— 宁可晚一轮，也不要写坏游标。
 * TTL 自愈：持有者被 kill 后留下的锁文件超时即视为无效。
 */
export function acquireLock(d, name, ttlMs) {
  const file = d.cursor + '/.lock-' + String(name || 'global').replace(/[^A-Za-z0-9_.-]/g, '_');
  // [自审] TTL 必须覆盖「真跑的最坏耗时」：extract/distill 要等 LLM，
  //   实测一次 20~50s，限流重试后最坏 3 次×(45s 超时+7s 退避)≈2.5min。
  //   默认给 10 分钟，宁可多等也不让两个写入方同时踩游标。
  const ttl = Number(ttlMs) || 600000;
  const now = Date.now();
  const token = process.pid + '-' + now + '-' + Math.random().toString(36).slice(2, 8);

  const readHolder = () => {
    try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
  };

  try {
    if (existsSync(file)) {
      const holder = readHolder();
      const at = Number(holder && holder.at) || 0;
      if (at && now - at < ttl) return null;      // 有活的持有者 ⇒ 放弃本次
      // 超时（或文件损坏）⇒ 原子改写抢占：先写 tmp 再 rename，避免两个抢锁者互相踩
      const tmp = file + '.take-' + token;
      try {
        writeFileSync(tmp, JSON.stringify({ pid: process.pid, at: now, name, token }), 'utf8');
        renameSync(tmp, file);
      } catch { try { unlinkSync(tmp); } catch {} }
    } else {
      writeFileSync(file, JSON.stringify({ pid: process.pid, at: now, name, token }), 'utf8');
    }
    // 复核：只有确认「锁文件里的 token 是自己」才算拿到（否则被别人抢先了）
    const confirm = readHolder();
    if (!confirm || confirm.token !== token) return null;
    let released = false;
    return {
      token,
      /** 心跳：长任务中途续期，避免被当成残留锁强夺 */
      touch() {
        try {
          const cur = readHolder();
          if (cur && cur.token === token) {
            writeFileSync(file, JSON.stringify({ pid: process.pid, at: Date.now(), name, token }), 'utf8');
          }
        } catch {}
      },
      release() {
        if (released) return;
        released = true;
        try {
          const cur = readHolder();
          if (!cur || cur.token === token) unlinkSync(file);   // 只删自己的锁
        } catch {}
      },
    };
  } catch {
    return null;
  }
}

export function readJson(file, fallback) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return fallback; }
}

/** 轮转：单文件超 maxBytes 就改成 .1（只留一份历史），防止无限增长。 */
export function rotateIfBig(file, maxBytes) {
  try {
    if (!existsSync(file)) return;
    if (statSync(file).size <= (maxBytes || 16 * 1024 * 1024)) return;
    const bak = file + '.1';
    try { if (existsSync(bak)) unlinkSync(bak); } catch {}
    try { renameSync(file, bak); } catch {}
  } catch {}
}

/**
 * [2026-10-22 by Assistant · 红队 P0-3] 写入侧源签名（供检索层判断"要不要后台重建"）。
 *
 * 为什么放在 core 而不是 retriever：两边必须用**同一个算法**，否则测试过了线上不过。
 * 关键教训：只 stat records **目录** 没用 —— 往已存在的日文件里追加，目录 mtime 不变。
 * 所以这里逐文件 stat（mtime + size），并把 engrams.jsonl 一起算。
 */
export function sigOfIngest(root) {
  const d = dirs(root);
  const parts = [];
  let files = 0;
  try {
    const all = readdirSync(d.records).filter((n) => n.endsWith('.jsonl'));
    // [自审] 必须设上限：这是每次检索都要跑的 hot path，不能随使用年数无限涨。
    //   按文件名（YYYY-MM-DD）排序取**最近 90 天**——L0 检索窗口本来就是 30 天，
    //   90 天已远超；更早的日文件变化只影响历史卡，不值得每轮 stat。
    const names = all.sort().slice(-90);
    for (const n of names) {
      try {
        const st = statSync(d.records + '/' + n);
        files++;
        // ── [2026-10-24 by Assistant · Round 41 同一个坑的第二、三处] ──
        //   原来这里用 mtime+size。而**采纳核验会给 L1 卡追加 hits** ⇒ size 变
        //   ⇒ 签名变 ⇒ 触发整库重建。和主库那次是**同一个病**，
        //   只是主库先被发现（Round 40）。
        //   ⇒ 换成内容指纹：只哈希「id + 标题」，不看 hits。
        parts.push(n + ':' + contentSigOfJsonl(d.records + '/' + n, st));
      } catch {}
    }
  } catch {}
  try {
    const st = statSync(d.engrams);
    parts.push('engrams:' + contentSigOfJsonl(d.engrams, st));
  } catch {}
  return 'i' + files + '|' + parts.join(';');
}

/**
 * [2026-10-24 by Assistant · Round 41] jsonl 的**内容指纹**（只取影响索引的字段）。
 *
 * 背景：采纳核验每轮给命中卡 hits+1（追加一行）⇒ mtime/size 都变
 *   ⇒ 索引签名变 ⇒ 整库重建（1.5 秒）。Round 40 修了主库，这里是 L1/自产的同类问题。
 *
 * 做法与主库一致：只喂 **id + 标题 + 摘要**，hits/importance/lastHitAt 一律不喂。
 * 性能：mtime 做快速短路 —— 文件没写过就直接复用上次结果，不读盘。
 */
const _sigCache = new Map();
function contentSigOfJsonl(file, st) {
  const key = Math.round(st.mtimeMs) + ':' + st.size;
  const hit = _sigCache.get(file);
  if (hit && hit.key === key && hit.sig) return hit.sig;
  try {
    const h = createHash('sha1');
    const byId = new Map();
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (!line) continue;
      let o; try { o = JSON.parse(line); } catch { continue; }
      if (!o || o.id === undefined || o.id === null) continue;
      byId.set(String(o.id), o);
    }
    for (const id of [...byId.keys()].sort()) {
      const c = byId.get(id) || {};
      h.update(id + '\u0001' + String(c.title || c.scene_name || '') + '\u0001' + String(c.summary || '') + '\u0001');
    }
    const sig = 'c' + byId.size + '-' + h.digest('hex').slice(0, 10);
    _sigCache.set(file, { key, sig });
    return sig;
  } catch (e) {
    return 'f' + Math.round(st.mtimeMs) + ':' + st.size;   // 兜底：宁可多建
  }
}

export function appendLines(file, lines, maxBytes) {
  if (!Array.isArray(lines) || lines.length === 0) return 0;
  try {
    rotateIfBig(file, maxBytes);
    appendFileSync(file, lines.join('\n') + '\n', 'utf8');
    return lines.length;
  } catch { return 0; }
}

/**
 * 落盘游标 —— 治本点之一。
 *
 * 为什么必须落盘：旧实现把「已处理到哪」放在内存里，进程一重启 buffer 全丢，
 * 于是提取器永远只处理「最近的记忆」，覆盖率掉到 2.9%。
 *
 * 每类能力各一份游标，互不干扰：capture 按 session 分文件，extract/distill 各一份全局。
 * 每次推进都走 atomicWriteJson —— 写坏游标只会丢一轮，不会丢整段历史。
 */
export function cursorFile(d, kind, sessionKey) {
  const safe = String(sessionKey || 'global').replace(/[^A-Za-z0-9_.-]/g, '_').slice(-96);
  return d.cursor + '/' + kind + (sessionKey ? ('-' + safe) : '') + '.json';
}

export function loadCursor(d, kind, sessionKey, fallback) {
  return readJson(cursorFile(d, kind, sessionKey), fallback || {});
}

export function saveCursor(d, kind, sessionKey, value) {
  return atomicWriteJson(cursorFile(d, kind, sessionKey), value);
}
