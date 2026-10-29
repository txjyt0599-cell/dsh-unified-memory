#!/usr/bin/env node
/**
 * selftest-autorefresh.mjs —— 索引自动保鲜（坑6）自测
 * [2026-10-22 by Assistant]
 *
 * 锁住的合同（这些是「索引跟不上数据」这个老毛病不再复发的机器判据）：
 *   A · 源没变 ⇒ 不重建（零成本、不写盘）
 *   B · 源变了（追加/改写）⇒ 重建，且索引条数跟上
 *   C · 参数变了 ⇒ 重建（否则索引与建图规则不符）
 *   D · 重建失败 ⇒ 不更新签名（下一轮自动重试，不静默放弃）
 *   E · status() 能一眼看出 stale / 上次重建时间 / 错误
 *   F · ghostCards 场景：源删掉卡后重建，索引里不再有幽灵
 */
import { mkdtempSync, rmSync, writeFileSync, appendFileSync, readFileSync, existsSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createAutoRefresh, sourceSignature, indexSignature } from './lib/hypergraph/auto-refresh.js';
import { readManifest, readAllRecords } from './lib/hypergraph/store.js';

const R = [];
const check = (g, n, ok, d) => { R.push({ g, n, ok: !!ok, d: d === undefined ? '' : String(d) }); };

const root = mkdtempSync(join(tmpdir(), 'pm-ar-'));
const indexRoot = join(root, 'idx');
const source = join(root, 'engrams.jsonl');
const tdaiDir = join(root, 'records');
import { mkdirSync } from 'node:fs';
mkdirSync(tdaiDir, { recursive: true });

// 造 10 张同一天的卡（能凑出 Episode）
function makeCards(n, dayOffset = 0) {
  const base = 1792500000000 + dayOffset * 86400000;
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({
      kind: 'note', layer: 'project', projectId: 'p1',
      title: '自动保鲜测试卡 ' + i,
      summary: '摘要 ' + i,
      content: '内容 ' + i + '，用于验证索引自动重建。',
      links: [], causes: [], effects: [],
      id: 'ar' + (dayOffset * 1000 + i),
      createdAt: base + i * 60000,
      hits: 0, lastHitAt: null,
    });
  }
  return out;
}
const writeSrc = (cards) => writeFileSync(source, cards.map((c) => JSON.stringify(c)).join('\n') + '\n', 'utf8');

writeSrc(makeCards(10));

const ar = createAutoRefresh({ indexRoot, source, tdaiDir, enabled: true, intervalMs: 60000 });

// ── A · 首次重建 ──
console.log('── A · 首次重建 ──');
const r1 = ar.ensureFresh();
check('A', 'A1 首次重建成功', r1.ok && r1.action === 'rebuilt', JSON.stringify(r1.action));
check('A', 'A2 索引已落盘', existsSync(join(indexRoot, 'manifest.json')));
const man1 = readManifest(indexRoot);
check('A', 'A3 episode 已生成', man1 && man1.counts && man1.counts.episodes > 0, man1 && JSON.stringify(man1.counts));

// ── A2 · 源没变 ⇒ 不重建 ──
console.log('── B · 源没变不重建 ──');
const before = readManifest(indexRoot).builtAt;
const r2 = ar.ensureFresh();
check('B', 'B1 源没变 ⇒ action=unchanged', r2.action === 'unchanged', r2.action);
const after = readManifest(indexRoot).builtAt;
check('B', 'B2 builtAt 未变（确实没写盘）', before === after, before + ' vs ' + after);

// ── C · 源追加 ⇒ 重建 ──
console.log('── C · 源变了要重建 ──');
appendFileSync(source, JSON.stringify({
  kind: 'note', layer: 'project', projectId: 'p1',
  title: '新增卡', summary: '追加触发重建', content: '追加一条卡，索引必须跟上。',
  links: [], causes: [], effects: [], id: 'ar999', createdAt: 1792500000000 + 3600000,
  hits: 0, lastHitAt: null,
}) + '\n', 'utf8');
// 确保 mtime 至少变化（某些文件系统精度粗）
const now = new Date();
utimesSync(source, now, now);
const r3 = ar.ensureFresh();
check('C', 'C1 追加后触发重建', r3.ok && r3.action === 'rebuilt', r3.action);
check('C', 'C2 重建后源签名已更新', ar.status().sourceSig === ar.status().lastRebuiltSig, JSON.stringify({ cur: ar.status().sourceSig, last: ar.status().lastRebuiltSig }));
check('C', 'C3 stale=false', ar.status().stale === false);

// ── D · force 无条件重建 ──
console.log('── D · force ──');
const r4 = ar.ensureFresh({ force: true });
check('D', 'D1 force=true 无条件重建', r4.ok && r4.action === 'rebuilt', r4.action);

// ── E · 失败不更新签名 ──
console.log('── E · 失败不更新签名 ──');
{
  // 把源文件删掉 → buildAndPersist 会读失败
  const badAr = createAutoRefresh({ indexRoot: join(root, 'idx2'), source: join(root, 'nope.jsonl'), tdaiDir, enabled: true });
  const rb = badAr.ensureFresh();
  check('E', 'E1 源不存在 ⇒ 明确失败', rb.ok === false, JSON.stringify(rb.action));
  check('E', 'E2 失败时 lastSig 未更新（下轮会重试）', badAr.status().lastRebuiltSig === null, String(badAr.status().lastRebuiltSig));
  check('E', 'E3 错误信息留痕', typeof badAr.status().lastError === 'string' && badAr.status().lastError.length > 0, badAr.status().lastError && badAr.status().lastError.slice(0, 40));
}

// ── F · 源删卡 ⇒ 索引不留幽灵 ──
console.log('── F · 幽灵卡 ──');
{
  const cards = makeCards(10);
  writeSrc(cards);
  const now2 = new Date();
  utimesSync(source, now2, now2);
  ar.ensureFresh();
  // 判据用「被删掉的卡是否还在索引里」，而不是 episode 条数
  //   （Episode 是按天/窗口聚的，10 张和 5 张可能都只聚成 1 个 Episode ⇒ 条数不降，
  //    用条数当判据会误报。真正该验的是"被删的卡不再被索引引用"= 无幽灵卡。）
  const idxCards = () => {
    const man = readManifest(indexRoot);
    const rec = readAllRecords(indexRoot, (man.shards || []).length);
    const ids = new Set();
    for (const ep of rec.episodes) for (const cid of (ep.cardIds || [])) ids.add(String(cid));
    return ids;
  };
  const beforeIds = idxCards();
  check('F', 'F1 重建后索引含全部 10 张卡', beforeIds.size === 10, 'n=' + beforeIds.size + ' 样例=' + Array.from(beforeIds).slice(0, 3).join(','));

  // 删掉后 5 张（模拟源被清理）
  writeSrc(cards.slice(0, 5));
  const now3 = new Date(Date.now() + 1000);
  utimesSync(source, now3, now3);
  ar.ensureFresh();
  const afterIds = idxCards();
  const ghosts = Array.from(afterIds).filter((id) => id.startsWith('ar') && Number(id.slice(2)) >= 5);
  check('F', 'F2 被删的卡不再出现在索引里（无幽灵）', ghosts.length === 0, 'ghosts=' + JSON.stringify(ghosts));
  check('F', 'F3 留下的卡还在', afterIds.size >= 1, 'n=' + afterIds.size);
}

// ── G · 签名函数本身 ──
console.log('── G · 签名 ──');
{
  const s1 = sourceSignature({ source, tdaiDir });
  const s2 = sourceSignature({ source, tdaiDir });
  check('G', 'G1 同状态同签名', s1 === s2, s1);
  const s3 = sourceSignature({ source, tdaiDir, opts: { windowTurns: 999 } });
  check('G', 'G2 参数变化改变签名', s3 !== s1, s1 + ' vs ' + s3);
  const idx1 = indexSignature(indexRoot);
  check('G', 'G3 indexSignature 能读 manifest（builtAt 归一成毫秒）', idx1 && idx1.builtAt > 0, JSON.stringify(idx1 && { shards: idx1.shardCount, builtAt: idx1.builtAt }));
}

// ── 汇总 ──
let pass = 0;
for (const r of R) { if (r.ok) pass++; else console.log('  ❌ ' + r.g + '/' + r.n + (r.d ? '  ← ' + r.d : '')); }
console.log('');
console.log('总计 ' + R.length + ' 项，通过 ' + pass + ' 项' + (pass === R.length ? '  ✅ 全绿' : '  ❌ 有失败'));
try { rmSync(root, { recursive: true, force: true }); } catch {}
process.exitCode = pass === R.length ? 0 : 1;
