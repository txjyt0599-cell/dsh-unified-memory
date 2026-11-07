/**
 * shard-files.js —— **唯一**的会话分片枚举器（活跃 + 归档）
 * [2026-11-03 by Assistant · 红队第一批：数据可见性契约]
 *
 * ## 为什么必须有它
 * P1-a 把轮转改成切分片（YYYY-MM-DD-000N.jsonl）并保留 3 份，超出的搬进 _archive/。
 * 但 lib 里 19 处读取点全都只写 f.endsWith('.jsonl')，而 _archive/ 是**子目录**，
 * 于是被搬进去的分片依然退出读视野 —— 红队实测：轮转前 5 条，归档后只剩 1 条。
 *
 * 更糟的是同一个「哪些文件算数据」的判定散落在 19 个地方，口径天然会漂。
 * 本模块把它收敛成**一处**：所有读者（L0 索引、verbatim、崩溃回捞、蒸馏窗口、
 * 统计）都必须经这里拿文件清单。
 *
 * ## 排序契约（很重要，别改）
 * 按**消息时序**排：同一逻辑日，分片（-000N）在前、当前主文件在后；
 * 跨日按日期升序。这与字符串序 '-' < '.' 天然一致，所以 sort() 即可，
 * 但归档子目录必须**单独**排进来，不能只靠目录扫描。
 *
 *  2026-11-01.jsonl
 *  2026-11-02-0001.jsonl
 *  2026-11-02-0002.jsonl
 *  2026-11-02.jsonl        ← 当前主文件永远在该日最后
 *  2026-11-03.jsonl
 *
 * ## 返回形态
 * [{ dir, name, path, size, mtimeMs, archived }]
 */
import { readdirSync, statSync, existsSync } from 'node:fs';

export const ARCHIVE_DIR_NAME = '_archive';

/** 只认这个后缀 —— 唯一判定点 */
function isDataFile(name) {
  return typeof name === 'string' && name.endsWith('.jsonl');
}

function listOneDir(dir, archived) {
  let names = [];
  try { names = readdirSync(dir); } catch { return []; }
  const out = [];
  for (const name of names) {
    if (!isDataFile(name)) continue;
    const path = dir + '/' + name;
    let st;
    try { st = statSync(path); } catch { continue; }
    if (!st.isFile()) continue;         // 目录伪装成 .jsonl 的不算数据
    out.push({ dir, name, path, size: st.size, mtimeMs: st.mtimeMs, archived: archived === true });
  }
  return out;
}

/**
 * 列出一个会话目录下的**全部**数据文件（活跃 + 归档），按时序排好。
 * @param {string} convDir 会话目录
 * @param {{ includeArchive?: boolean }} [opts] includeArchive 默认 true
 * @returns {Array<{dir:string,name:string,path:string,size:number,mtimeMs:number,archived:boolean}>}
 */
export function listShardFiles(convDir, opts) {
  const o = opts || {};
  const dirs = Array.isArray(convDir) ? convDir : (convDir ? [String(convDir)] : []);
  const includeArchive = o.includeArchive !== false;
  const out = [];
  for (const dir of dirs) {
    const d = String(dir || '');
    if (!d) continue;
    const live = listOneDir(d, false);
    let arch = [];
    if (includeArchive) {
      const av = d + '/' + ARCHIVE_DIR_NAME;
      if (existsSync(av)) arch = listOneDir(av, true);
    }
    // 合并后统一排序：先按 name 的"日期前缀"，分片在前、主文件在后
    out.push(...live, ...arch);
  }
  out.sort(compareDataFiles);
  return out;
}

/** 从文件名提取逻辑日与分片号，用于稳定排序 */
function parseName(name) {
  const n = String(name || '');
  const m = /^(\d{4}-\d{2}-\d{2})(?:-(\d{1,6}))?\.jsonl$/.exec(n);
  if (!m) return { day: n, shard: 0, isMain: true };
  return { day: m[1], shard: m[2] ? Number(m[2]) : -1, isMain: !m[2] };
}

/**
 * 排序契约：同一逻辑日内，分片号升序在前、主文件最后；跨日按日升序。
 * 不满足日期格式的名字按原字符串序排在最前（兼容历史脏文件）。
 */
export function compareDataFiles(a, b) {
  const pa = parseName(a && a.name), pb = parseName(b && b.name);
  const da = /^\d{4}-\d{2}-\d{2}$/.test(pa.day), db = /^\d{4}-\d{2}-\d{2}$/.test(pb.day);
  if (da && db) {
    if (pa.day !== pb.day) return pa.day < pb.day ? -1 : 1;
    // 分片 -1 表示主文件 → 排最后
    const sa = pa.isMain ? Number.MAX_SAFE_INTEGER : pa.shard;
    const sb = pb.isMain ? Number.MAX_SAFE_INTEGER : pb.shard;
    if (sa !== sb) return sa < sb ? -1 : 1;
  } else if (da !== db) {
    return da ? 1 : -1;                  // 脏名排在合法日文件之前
  }
  return pa.day < pb.day ? -1 : (pa.day > pb.day ? 1 : 0);
}

/** 只要名字（旧代码大多是「按名遍历」，给它保留最小改动面） */
export function listShardNames(convDir, opts) {
  return listShardFiles(convDir, opts).map((f) => f.name);
}

/** 统计：活跃 vs 归档各几个、总字节 */
export function shardStats(convDir, opts) {
  const files = listShardFiles(convDir, opts);
  let live = 0, arch = 0, bytes = 0;
  for (const f of files) { if (f.archived) arch++; else live++; bytes += f.size; }
  return { total: files.length, live, archived: arch, bytes };
}
