/**
 * lib/scoring/cold-archive.mjs —— 冷宫归档（Step 4 · 新陈代谢最后一块）
 * [2026-10-24 by Assistant · goal round 3]
 *
 * 为什么需要它：
 *   四股力只解决「排序时谁该沉底」，但卡片**总量**还是在涨。
 *   User要陪很多年，1 万张卡时向量空间会拥挤（Hubness 灾难），
 *   检索再准也会被稀释。所以必须有一个「物理冷宫」：
 *   长期没被用过、也不重要的卡，搬到冷宫文件，退出活跃索引。
 *
 * 判据（红白双队 + Assistant的保守修正）：
 *   · 基石（is_axiom）        —— **永不进冷宫**
 *   · importance >= 0.55      —— 不进（重要决定）
 *   · 近 60 天内被用过        —— 不进（hits>0 或有 lastHitAt 在窗口内）
 *   · 剩下：ageDays > 60 且 importance < 0.4 且 hits == 0  ⇒ 进冷宫
 *
 * 纪律：
 *   · **只搬不删**（User铁律）：移到 cold_archive.jsonl，原文件保留 active 卡
 *   · 搬之前整体备份
 *   · 搬完写一份对账（搬了多少条、多少字节），可回滚
 *   · 默认 dry-run，必须显式 --apply 才动盘
 */
import { readFileSync, writeFileSync, appendFileSync, existsSync, copyFileSync, mkdirSync, renameSync, statSync } from 'node:fs';

export const COLD_ARCHIVE_PATH = '~/.dsh/unified-memory/engram-relay/cold_archive.jsonl';
export const BACKUP_DIR = '~/.dsh/unified-memory/diary/backups';

/** 一条卡该不该进冷宫 */
export function shouldArchive(card, nowTs, opts) {
  const o = opts || {};
  const ageDays = Number(o.ageDays) || 60;
  const impMax = Number(o.impMax) || 0.4;
  if (!card) return { archive: false, why: 'no-card' };
  if (card.is_axiom === true) return { archive: false, why: 'axiom' };
  const imp = Number(card.importance);
  // 重要卡（>=0.55）直接保留
  if (Number.isFinite(imp) && imp >= 0.55) return { archive: false, why: 'important' };

  // ── [2026-10-25 红队终审核定平反 · 恢复Assistant原版优雅机制] ──
  //   白队误以为 hits > 0 会把老卡晋升成 is_axiom 基石卡，产生"吃火锅永不衰减"的担忧。
  //   红队逐像素对账平反：hits > 0 仅代表「留在活跃库物理不搬迁」，绝不等于修改 is_axiom！
  //   老卡平时在四股力下依然严格受半衰期约束（乘数 0.350 沉底不打扰）；
  //   只要User与Assistant真正产生过共鸣与采纳（hits > 0），它就属于User生命线的一部分，
  //   永不粗暴物理搬离主库，想聊时随时凭相关度一票唤醒！
  if (Number(card.hits) > 0) return { archive: false, why: 'used-before' };
  const last = Number(card.lastHitAt) || 0;
  if (last > 0 && (nowTs - last) < ageDays * 86400000) return { archive: false, why: 'recent-hit' };
  const created = Number(card.createdAt) || 0;
  if (!created) return { archive: false, why: 'no-time' };
  const days = (nowTs - created) / 86400000;
  if (days < ageDays) return { archive: false, why: 'too-new:' + Math.floor(days) + 'd' };
  if (Number.isFinite(imp) && imp >= impMax) return { archive: false, why: 'imp=' + imp };
  return { archive: true, why: 'cold:' + Math.floor(days) + 'd' };
}

/**
 * 跑一轮冷宫归档。
 * @param {{file?:string, coldFile?:string, apply?:boolean, nowTs?:number, ageDays?:number, impMax?:number}} p
 */
export function runColdArchive(p) {
  const params = p || {};
  const file = String(params.file || '~/.dsh/unified-memory/engram-relay/engrams.jsonl');
  const coldFile = String(params.coldFile || COLD_ARCHIVE_PATH);
  const apply = params.apply === true;
  const nowTs = Number(params.nowTs) || Date.now();
  const opts = { ageDays: params.ageDays, impMax: params.impMax };

  if (!existsSync(file)) return { ok: false, reason: 'not-found: ' + file };
  const raw = readFileSync(file, 'utf8');
  const lines = raw.split(/\r?\n/).filter(Boolean);
  const byId = new Map();
  for (const line of lines) {
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (!o || !o.id) continue;
    byId.set(String(o.id), { line, card: o });
  }

  const stay = [];
  const move = [];
  const reasons = {};
  for (const [id, ent] of byId) {
    const c = ent.card;
    if ((c.status || 'active') === 'retired') { stay.push(ent.line); continue; }
    const d = shouldArchive(c, nowTs, opts);
    if (d.archive) { move.push(ent.line); reasons[d.why] = (reasons[d.why] || 0) + 1; }
    else stay.push(ent.line);
  }

  const before = statSync(file).size;
  const result = {
    ok: true,
    apply,
    total: byId.size,
    stay: stay.length,
    move: move.length,
    reasons,
    bytesBefore: before,
    bytesAfter: Buffer.byteLength(stay.join('\n') + '\n'),
  };
  if (!apply) return Object.assign(result, { note: 'dry-run（加 --apply 才动盘）' });

  // 备份
  try {
    mkdirSync(BACKUP_DIR, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    copyFileSync(file, BACKUP_DIR + '/engrams-before-coldarchive-' + ts + '.jsonl');
  } catch (e) { return { ok: false, reason: 'backup-failed: ' + (e && e.message) }; }

  // 搬（只增：冷宫 append）
  if (move.length) appendFileSync(coldFile, move.join('\n') + '\n', 'utf8');
  // 活跃库原位重写（原子）
  const tmp = file + '.cold.tmp';
  writeFileSync(tmp, stay.join('\n') + '\n', 'utf8');
  renameSync(tmp, file);

  const after = statSync(file).size;
  return Object.assign(result, {
    bytesAfter: after,
    coldFile,
    coldDelta: Buffer.byteLength(move.join('\n') + '\n'),
  });
}

/**
 * 回捞：把冷宫里的卡捞回活跃库（万一误搬 / User突然想起要翻旧账）
 * 只增不删原则：冷宫**不清空**（保留历史），活跃库追加一份。
 */
export function restoreFromArchive(ids, opts) {
  const o = opts || {};
  const file = String(o.file || '~/.dsh/unified-memory/engram-relay/engrams.jsonl');
  const coldFile = String(o.coldFile || COLD_ARCHIVE_PATH);
  if (!existsSync(coldFile)) return { ok: false, reason: 'no-cold-file' };
  const want = new Set((ids || []).map(String));
  if (!want.size) return { ok: false, reason: 'no-ids' };
  const cold = readFileSync(coldFile, 'utf8').split(/\r?\n/).filter(Boolean);
  const picked = [];
  const seen = new Set();
  for (const line of cold) {
    let c; try { c = JSON.parse(line); } catch { continue; }
    if (!c || !want.has(String(c.id))) continue;
    if (seen.has(String(c.id))) continue;
    seen.add(String(c.id));
    picked.push(line);
  }
  if (!picked.length) return { ok: false, reason: 'not-found-in-cold' };
  appendFileSync(file, picked.join('\n') + '\n', 'utf8');
  return { ok: true, restored: picked.length, ids: [...seen] };
}

