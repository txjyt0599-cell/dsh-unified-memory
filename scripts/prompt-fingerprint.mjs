#!/usr/bin/env node
/**
 * prompt-fingerprint.mjs —— system prompt 指纹（判断重启会不会破缓存）
 * [2026-10-22 by Assistant]
 *
 * 为什么需要：
 *   上游 prefix cache 按 **token 序列** 比对。重启 DSH 后如果 system prompt
 *   逐字节相同，缓存**能命中**（省几十万 token）；只要有一个字节变了，从变化点
 *   往后全部重算（实测 40~70 万 token）。
 *
 *   所以「重启会不会破缓存」= 「system prompt 会不会变」= 可测量的事。
 *
 * 用法：
 *   node scripts/prompt-fingerprint.mjs snapshot   # 重启前：记下当前指纹
 *   node scripts/prompt-fingerprint.mjs diff       # 重启后：和上次快照比
 *   node scripts/prompt-fingerprint.mjs status     # 看最近几条记录
 *
 * 数据来源：~/.dsh/unified-memory/probe/assemble.jsonl（插件每次 assemble 都写一条）
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dataPath } from '../lib/paths.js';

const HOME = process.env.USERPROFILE || 'C:/Users/Administrator';
const PROBE = HOME + '/.dsh/unified-memory/probe/assemble.jsonl';
const SNAP = dataPath('prompt-fingerprint.json');

function readProbe() {
  if (!existsSync(PROBE)) return [];
  const rows = [];
  for (const line of readFileSync(PROBE, 'utf8').split('\n')) {
    if (!line) continue;
    try { rows.push(JSON.parse(line)); } catch {}
  }
  return rows;
}

/** 优先用总 hash；老记录没有 outHash 就退化成 section 名+长度签名。 */
function fingerprintOf(row) {
  if (!row) return null;
  if (row.outHash) return { mode: 'sha1', hash: row.outHash, chars: row.outChars || 0, at: row.at, sections: row.outSections || [] };
  const sig = (row.outSections || []).map((s) => s.name + ':' + s.len).join('|');
  return { mode: 'len-signature', hash: sig, chars: (row.outSections || []).reduce((a, s) => a + (s.len || 0), 0), at: row.at, sections: row.outSections || [] };
}

function cmdSnapshot() {
  const rows = readProbe();
  const latest = rows[rows.length - 1];
  if (!latest) { console.error('❌ 没有 assemble 记录（插件刚装好或还没跑过一轮）'); process.exit(2); }
  const fp = fingerprintOf(latest);
  writeFileSync(SNAP, JSON.stringify(fp, null, 2), 'utf8');
  console.log('📌 已快照: ' + fp.at);
  console.log('   模式: ' + fp.mode + (fp.mode === 'len-signature' ? '（旧探针没有 hash，请先重启一次让新探针生效）' : ''));
  console.log('   指纹: ' + fp.hash.slice(0, 40));
  console.log('   字符: ' + fp.chars + '   节数: ' + fp.sections.length);
  console.log('   → 现在可以去重启，回来跑 diff');
}

function cmdDiff() {
  if (!existsSync(SNAP)) { console.error('❌ 没有快照。先跑 snapshot'); process.exit(2); }
  const before = JSON.parse(readFileSync(SNAP, 'utf8'));
  const rows = readProbe();
  const latest = rows[rows.length - 1];
  if (!latest) { console.error('❌ 没有新的 assemble 记录'); process.exit(2); }
  const after = fingerprintOf(latest);

  console.log('重启前: ' + before.at + '  指纹 ' + String(before.hash).slice(0, 40));
  console.log('重启后: ' + after.at + '  指纹 ' + String(after.hash).slice(0, 40));
  console.log('');

  if (before.mode === 'len-signature' || after.mode === 'len-signature') {
    console.log('⚠️ 有一侧是旧探针（只有长度没有 hash），只能做长度比较');
    console.log('   结论仅供参考；下一次重启后会用真 hash 比对');
  }

  if (String(before.hash) === String(after.hash)) {
    console.log('✅ **指纹完全相同** ⇒ 上游缓存可以命中（前缀没变）');
    console.log('   如果你仍看到全价重算，那原因在**别处**：');
    console.log('     · 上游缓存 TTL 过期（两次请求间隔太久）');
    console.log('     · 会话被 compression 重写过');
    console.log('     · 换过 provider/模型（不同模型不共享缓存）');
    return;
  }

  console.log('❌ **指纹变了** ⇒ 缓存必然失效。差异如下：');
  const bmap = new Map((before.sections || []).map((s) => [s.name, s]));
  const amap = new Map((after.sections || []).map((s) => [s.name, s]));
  const names = new Set([...bmap.keys(), ...amap.keys()]);
  let diffs = 0;
  for (const n of names) {
    const b = bmap.get(n), a = amap.get(n);
    if (!b) { console.log('   + 新增 section: ' + n + '  len=' + a.len); diffs++; continue; }
    if (!a) { console.log('   - 消失 section: ' + n); diffs++; continue; }
    const bh = b.h, ah = a.h;
    if (bh && ah && bh !== ah) { console.log('   ✗ ' + n + '  内容变了（len ' + b.len + ' → ' + a.len + '）'); diffs++; }
    else if (!bh || !ah) { if (b.len !== a.len) { console.log('   ✗ ' + n + '  长度变了（' + b.len + ' → ' + a.len + '）'); diffs++; } }
  }
  if (diffs === 0) console.log('   （各 section 看起来都没变，但总 hash 不同 —— 可能是顺序变了）');
  console.log('');
  console.log('   ⇒ 把上面这几项修成"每次启动逐字节相同"，缓存就能命中。');
}

function cmdStatus() {
  const rows = readProbe();
  if (!rows.length) { console.log('📭 没有记录'); return; }
  console.log('📊 最近 10 次 assemble:');
  rows.slice(-10).forEach((r) => {
    const fp = fingerprintOf(r);
    console.log('  ' + r.at + '  ' + String(fp.hash).slice(0, 20) + '  chars=' + fp.chars + '  ' + fp.mode);
  });
  // 历史上出现过几个不同指纹
  const uniq = new Set(rows.map((r) => fingerprintOf(r).hash));
  console.log('');
  console.log('  历史共 ' + rows.length + ' 条，不同指纹 ' + uniq.size + ' 个' + (uniq.size === 1 ? '  ✅ 一直稳定' : '  ⚠️ 有过变化'));
}

const cmd = process.argv[2];
if (cmd === 'snapshot') cmdSnapshot();
else if (cmd === 'diff') cmdDiff();
else if (cmd === 'status') cmdStatus();
else {
  console.log('用法:');
  console.log('  node scripts/prompt-fingerprint.mjs snapshot   # 重启前');
  console.log('  node scripts/prompt-fingerprint.mjs diff       # 重启后');
  console.log('  node scripts/prompt-fingerprint.mjs status');
}
