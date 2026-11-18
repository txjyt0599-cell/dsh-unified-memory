/**
 * selftest-l0-incremental.mjs —— P1-b L0 索引增量保鲜
 * [2026-11-03 by Assistant] agy 红队口径验收。
 *
 * 核心断言：增量查询与全量重建 **100% 一致**，
 *   覆盖 追加 / 半行 carry / 截断 / 替换 / 迟到重复消息 五种现场。
 * 另断言：绝不返回 null、失败保留旧索引并退避（禁永久锁死）。
 */
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, truncateSync, rmSync, readdirSync, readFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getL0IndexCached, l0CacheStats, resetL0Cache } from '../lib/hypergraph/l0-cache.js';
import { buildL0Index, l0IngestText } from '../lib/hypergraph/source.js';

let pass = 0, fail = 0;
const ok = (n, c, extra) => { if (c) { pass++; console.log('  PASS ' + n); } else { fail++; console.log('  FAIL ' + n + (extra ? '  -> ' + extra : '')); } };

/** 把索引拍成可比较的稳定形态 */
function snap(index) {
  const out = [];
  for (const [k, arr] of [...index.entries()].sort((a, b) => String(a[0]).localeCompare(String(b[0])))) {
    out.push(k + ' :: ' + arr.map((m) => String(m.id) + '@' + m._ts).join(','));
  }
  return out.join('\n');
}
const line = (id, ts, extra) => JSON.stringify(Object.assign({ id, sessionKey: 's1', timestamp: ts, role: 'user', content: 'c' + id }, extra || {}));

const root = mkdtempSync(join(tmpdir(), 'l0inc-'));
try {
  const conv = join(root, 'conv');
  mkdirSync(conv, { recursive: true });
  const f1 = join(conv, '2026-11-02.jsonl');

  // 起始 5 条
  writeFileSync(f1, [1, 2, 3, 4, 5].map((i) => line('m' + i, 1000 + i)).join('\n') + '\n');
  resetL0Cache();
  const idx0 = getL0IndexCached(conv, { minRefreshMs: 0 });
  ok('首次返回非 null', idx0 instanceof Map && idx0.size > 0, 'size=' + (idx0 && idx0.size));

  // ── 1. 追加 → 增量与全量一致 ──
  appendFileSync(f1, [6, 7].map((i) => line('m' + i, 1000 + i)).join('\n') + '\n');
  const idx1 = getL0IndexCached(conv, { minRefreshMs: 0 });
  const full1 = buildL0Index(conv);
  ok('① 追加后 增量 == 全量', snap(idx1) === snap(full1), 'inc=' + idx1.size + ' full=' + full1.size);
  ok('① 新消息真的进来了', snap(idx1).includes('m7'));

  // ── 2. 半行 carry：写半截不应被解析 ──
  const half = line('m8', 1008).slice(0, 20);
  appendFileSync(f1, half);
  const idx2 = getL0IndexCached(conv, { minRefreshMs: 0 });
  ok('② 半行不被解析', !snap(idx2).includes('m8'), '出现了半截 id');
  ok('② 半行时 增量 == 全量', snap(idx2) === snap(buildL0Index(conv)));

  // 补完整行 → 应出现
  appendFileSync(f1, line('m8', 1008).slice(20) + '\n');
  const idx3 = getL0IndexCached(conv, { minRefreshMs: 0 });
  ok('② 补全后 m8 出现', snap(idx3).includes('m8'));
  ok('② 补全后 增量 == 全量', snap(idx3) === snap(buildL0Index(conv)));

  // ── 3. 截断 → 必须全量重建，且一致 ──
  truncateSync(f1, 0);
  writeFileSync(f1, [line('t1', 2001), line('t2', 2002)].join('\n') + '\n');
  const idx4 = getL0IndexCached(conv, { minRefreshMs: 0 });
  ok('③ 截断后 增量 == 全量', snap(idx4) === snap(buildL0Index(conv)), 'size=' + idx4.size);
  ok('③ 截断后旧消息不再谎报', !snap(idx4).includes('m1@'));

  // ── 4. 替换（同长度不同内容）→ 必须重建 ──
  const a = [line('r1', 3001), line('r2', 3002)].join('\n') + '\n';
  const b = [line('x1', 4001), line('x2', 4002)].join('\n') + '\n';
  writeFileSync(f1, a);
  getL0IndexCached(conv, { minRefreshMs: 0 });
  writeFileSync(f1, b);                     // 长度恰好相同，只有 mtime/size 一样
  // [2026-11-16 by Assistant · 测试确定性] 同毫秒内两次同长写会让 mtimeMs 完全相同，
  // 增量缓存合法地判「没变」；这里显式把 mtime 推进 5ms，让用例真正测「mtime 变 ⇒ 必须全量」。
  try { utimesSync(f1, new Date(), new Date(Date.now() + 5)); } catch {}
  const idx5 = getL0IndexCached(conv, { minRefreshMs: 0 });
  ok('④ 同长替换后 增量 == 全量', snap(idx5) === snap(buildL0Index(conv)));
  ok('④ 替换后旧内容没残留', !snap(idx5).includes('r1@'));

  // ── 5. 迟到重复消息（另一文件同 id 同 ts）→ 去重一致 ──
  writeFileSync(f1, [line('d1', 5001), line('d2', 5002)].join('\n') + '\n');
  resetL0Cache();
  getL0IndexCached(conv, { minRefreshMs: 0 });
  const f2 = join(conv, '2026-11-03.jsonl');
  writeFileSync(f2, line('d1', 5001) + '\n');          // 迟到重复
  const idx6 = getL0IndexCached(conv, { minRefreshMs: 0 });
  const full6 = buildL0Index(conv);
  ok('⑤ 迟到重复 增量 == 全量', snap(idx6) === snap(full6));
  const ids6 = [];
  for (const arr of idx6.values()) for (const m of arr) ids6.push(String(m.id));
  ok('⑤ 重复消息只入一次', ids6.filter((x) => x === 'd1').length === 1, 'count=' + ids6.filter((x) => x === 'd1').length);

  // ── 6. 文件消失 → 重建，且不返回 null ──
  rmSync(f2);
  const idx7 = getL0IndexCached(conv, { minRefreshMs: 0 });
  ok('⑥ 文件消失后仍是非 null Map', idx7 instanceof Map);
  ok('⑥ 文件消失后 增量 == 全量', snap(idx7) === snap(buildL0Index(conv)));

  // ── 7. 可观测性字段齐全 ──
  const st = l0CacheStats();
  ok('⑦ 暴露 builtAt/lastRefresh/lastError/stale/mode',
    ['builtAt', 'lastRefresh', 'lastError', 'stale', 'mode', 'refreshes'].every((k) => k in st),
    JSON.stringify(Object.keys(st)));

  // ── 8. 空目录不炸、不返回 null ──
  const empty = join(root, 'empty'); mkdirSync(empty);
  resetL0Cache();
  const idx8 = getL0IndexCached(empty, { minRefreshMs: 0 });
  ok('⑧ 空目录返回空 Map 而不是 null', idx8 instanceof Map && idx8.size === 0);

  // ── 9. 不存在的目录也不炸 ──
  const idx9 = getL0IndexCached(join(root, 'nope'), { minRefreshMs: 0 });
  ok('⑨ 不存在目录返回 Map', idx9 instanceof Map);

  // ── 10. l0IngestText 与全量语义一致（同一函数）──
  const idxM = new Map();
  const tgt = { index: idxM, seenMsgId: new Set(), messages: 0 };
  const n1 = l0IngestText(line('z1', 9001) + '\n' + line('z1', 9001) + '\n', tgt);
  ok('⑩ 同一函数内去重生效', n1 === 1, 'added=' + n1);

  // ── ⑪ verbatim-lookup 保质：不再「一次建完永不更新」──
  const vl = await import('../lib/ingest/verbatim-lookup.js');
  ok('⑪ ensureVerbatimIndex 已导出', typeof vl.ensureVerbatimIndex === 'function');
  const s1 = vl.ensureVerbatimIndex({ minRefreshMs: 0 });
  if (s1 && s1.messages > 0) ok('⑪ 索引确实建成（messages>0）', true, JSON.stringify(s1));
  else console.log('  SKIP ⑪ 索引确实建成（stranger 环境无数据）  ' + JSON.stringify(s1));
  const t1 = Date.now();
  vl.ensureVerbatimIndex({ minRefreshMs: 60000 });      // 节流窗口内应直接复用
  const dt = Date.now() - t1;
  ok('⑪ 节流生效（复用不重建）', dt < 50, dt + 'ms');
  const probe = vl.lookupMany(['__不存在的id__']);
  ok('⑪ 查不到返回空对象而不是炸', probe && typeof probe === 'object');
} finally {
  try { resetL0Cache(); rmSync(root, { recursive: true, force: true }); } catch {}
}

console.log('');
console.log('L0INC-DONE  checks=' + (pass + fail) + '  passed=' + pass + '  failed=' + fail);
process.exit(fail === 0 ? 0 : 1);
