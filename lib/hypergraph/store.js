import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync, readdirSync, unlinkSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { HARD } from './types.js';

/**
 * 分片存储：每片 = 一段 Episode 及其超边，JSONL。
 * 原子写：tmp + rename。读：全片载入内存（17 片 ~98KB，够小）。
 */

export function shardPath(root, idx) {
  return join(root, 'episodes', String(idx).padStart(4, '0') + '.jsonl');
}

export function writeShard(root, idx, payload) {
  const file = shardPath(root, idx);
  mkdirSync(join(root, 'episodes'), { recursive: true });
  const tmp = file + '.tmp';
  const body = payload.map(o => JSON.stringify(o)).join('\n') + '\n';
  writeFileSync(tmp, body, 'utf8');
  if (existsSync(file)) { try { unlinkSync(file); } catch {} }
  renameSync(tmp, file);
  return { file, bytes: Buffer.byteLength(body, 'utf8'), records: payload.length };
}

export function readShards(root, count) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const f = shardPath(root, i);
    if (!existsSync(f)) continue;
    for (const line of readFileSync(f, 'utf8').split('\n')) {
      if (!line) continue;
      try { out.push(JSON.parse(line)); } catch {}
    }
  }
  return out;
}

export function writeManifest(root, manifest) {
  const file = join(root, 'manifest.json');
  const tmp = file + '.tmp';
  writeFileSync(tmp, JSON.stringify(manifest, null, 2), 'utf8');
  if (existsSync(file)) { try { unlinkSync(file); } catch {} }
  renameSync(tmp, file);
  return { file, bytes: Buffer.byteLength(JSON.stringify(manifest), 'utf8') };
}

export function readManifest(root) {
  const file = join(root, 'manifest.json');
  if (!existsSync(file)) return null;
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
}

export function listShards(root) {
  const dir = join(root, 'episodes');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(f => f.endsWith('.jsonl')).sort();
}

/* ==========================================================================
 * 期2 补修（P0）：全局记录文件
 * --------------------------------------------------------------------------
 * episode / fedge 是「属于某个分片」的记录；topic / eedge / oedge 是【全局】
 * 记录（不归属任何 episode 分片）。原先它们只在 manifest.counts 里出现，
 * 索引里一条都没有 —— 这是 P0 bug。现改为各写一份独立的 JSONL。
 *
 * 为什么单独文件而不是塞进最后一片：
 *   ① 片 = 纯 Episode 语义，塞全局记录会污染「片」的定义；
 *   ② 增量重建只重写脏片，塞进片的全局记录会在「该片不脏」时变陈旧；
 *   ③ 期3 Stage1 要单读 Topic，独立文件一次 readFile 即可，不必扫 17 片。
 * ========================================================================== */

/** 三个全局文件名（相对 root） */
export const GLOBAL_FILES = Object.freeze({
  topics:   'topics.jsonl',
  eedges:   'eedges.jsonl',
  ordinary: 'ordinary.jsonl',
});

/** 记录类型 → 全局文件名（readAllRecords 用） */
export const GLOBAL_TYPE_TO_FILE = Object.freeze({
  topic: GLOBAL_FILES.topics,
  eedge: GLOBAL_FILES.eedges,
  oedge: GLOBAL_FILES.ordinary,
});

/**
 * 原子写一个全局 JSONL 文件（tmp + rename，与分片同款）。
 * @returns {{file:string, bytes:number, records:number}}
 */
export function writeGlobal(root, fileName, records) {
  mkdirSync(root, { recursive: true });
  const file = join(root, fileName);
  const tmp = file + '.tmp';
  const body = records.length
    ? records.map(o => JSON.stringify(o)).join('\n') + '\n'
    : '';
  writeFileSync(tmp, body, 'utf8');
  if (existsSync(file)) { try { unlinkSync(file); } catch {} }
  renameSync(tmp, file);
  return { file, bytes: Buffer.byteLength(body, 'utf8'), records: records.length };
}

/**
 * 读一个全局 JSONL 文件。文件不存在 ⇒ 返回 []（fail-open，不抛）。
 * @returns {Array<object>}
 */
export function readGlobal(root, fileName) {
  const file = join(root, fileName);
  if (!existsSync(file)) return [];
  const out = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue;
    try { out.push(JSON.parse(line)); } catch {}
  }
  return out;
}

/** 读三类全局记录，分别返回（避免调用方自己再按 type 过滤） */
export function readGlobals(root) {
  return {
    topics: readGlobal(root, GLOBAL_FILES.topics),
    eedges: readGlobal(root, GLOBAL_FILES.eedges),
    ordinary: readGlobal(root, GLOBAL_FILES.ordinary),
  };
}

/**
 * 读「四类记录」全量：episode / fedge（来自 17 片）+ topic / eedge / oedge（来自 3 个全局文件）。
 * 期3 检索只调这一个函数。
 * @returns {{episodes:Array, factEdges:Array, episodeEdges:Array, topics:Array, ordinaryEdges:Array, byType:Record<string,number>}}
 */
export function readAllRecords(root, shardCount) {
  const shardRecs = readShards(root, shardCount ?? listShards(root).length);
  const g = readGlobals(root);
  const episodes = [], factEdges = [];
  for (const r of shardRecs) {
    if (r.type === 'episode') episodes.push(r);
    else if (r.type === 'fedge') factEdges.push(r);
  }
  const episodeEdges = g.eedges.filter(r => r.type === 'eedge');
  const topics = g.topics.filter(r => r.type === 'topic');
  const ordinaryEdges = g.ordinary.filter(r => r.type === 'oedge');
  return {
    episodes, factEdges, episodeEdges, topics, ordinaryEdges,
    byType: {
      episode: episodes.length,
      fedge: factEdges.length,
      eedge: episodeEdges.length,
      topic: topics.length,
      oedge: ordinaryEdges.length,
    },
  };
}

/** 全局文件体积（health 用；缺文件记 0，不抛） */
export function globalBytes(root) {
  const out = {};
  for (const [k, f] of Object.entries(GLOBAL_FILES)) {
    const p = join(root, f);
    out[k] = existsSync(p) ? statSync(p).size : 0;
  }
  return out;
}
