#!/usr/bin/env node
/**
 * scripts/migrate-engrams-v2.mjs —— 存量 engram 迁移到 v2 schema（期8.1）
 * [2026-10-23 by Assistant]
 *
 * 白队终裁 §9.4：
 *   「必须跑一次批处理迁移，实施保守降级，彻底消灭双轨制。
 *     55 张卡跑批处理连 1 秒都用不到。若只对新卡生效，
 *     代码里就必须永远维护两套逻辑（带 status 的 / 不带的），给未来重构埋巨坑。」
 *
 * 注入字段（逐字照白队）：
 *   status:        "active"
 *   scope_tags:    ["global"]
 *   confidence:    0.5
 *   is_tentative:  false
 *   （in_degree 不落盘，是内存派生态，见 DESIGN §四）
 *
 * 用法：
 *   node scripts/migrate-engrams-v2.mjs --dry     # 只报告，不写
 *   node scripts/migrate-engrams-v2.mjs           # 备份后实际写入
 */
import { readFileSync, writeFileSync, copyFileSync, existsSync, statSync } from 'node:fs';
import { LEGACY_DEFAULTS, normalizeEngramV2 } from '../lib/ingest/belief.js';

const FILE = '~/.dsh/unified-memory/ingest/engrams.jsonl';
const DRY = process.argv.includes('--dry');

if (!existsSync(FILE)) {
  console.error('❌ 文件不存在: ' + FILE);
  process.exitCode = 1;
} else {
  const raw = readFileSync(FILE, 'utf8');
  const lines = raw.split('\n').filter(Boolean);
  const out = [];
  let migrated = 0, already = 0, broken = 0;

  for (const line of lines) {
    let o;
    try { o = JSON.parse(line); } catch { broken++; out.push(line); continue; }
    const needs = !('status' in o) || !('scope_tags' in o) || !('confidence' in o);
    if (needs) {
      const n = normalizeEngramV2(o);
      delete n._v2;
      // 保守：只注入白队指定的五字段，不额外发明字段
      n.status = LEGACY_DEFAULTS.status;
      n.scope_tags = LEGACY_DEFAULTS.scope_tags.slice();
      n.confidence = LEGACY_DEFAULTS.confidence;
      n.is_tentative = LEGACY_DEFAULTS.is_tentative;
      if (!Array.isArray(n.supporting_facts)) n.supporting_facts = [];
      if (!Array.isArray(n.refute_by)) n.refute_by = [];
      if (!Array.isArray(n.supersedes)) n.supersedes = [];
      if (typeof n.trace !== 'string') n.trace = '';
      migrated++;
      out.push(JSON.stringify(n));
    } else {
      already++;
      out.push(line);
    }
  }

  console.log('文件: ' + FILE);
  console.log('大小: ' + statSync(FILE).size + ' B');
  console.log('总行数: ' + lines.length);
  console.log('  待迁移: ' + migrated);
  console.log('  已是v2: ' + already);
  console.log('  无法解析: ' + broken);

  if (DRY) {
    console.log('\n[--dry] 未写入任何内容。');
  } else if (migrated === 0) {
    console.log('\n无需迁移。');
  } else {
    const bak = FILE + '.bak-p8-migrate-' + Date.now();
    copyFileSync(FILE, bak);
    console.log('\n备份: ' + bak);
    writeFileSync(FILE, out.join('\n') + '\n', 'utf8');
    console.log('✅ 已迁移 ' + migrated + ' 张卡，新大小 ' + statSync(FILE).size + ' B');

    // 迁移后自检：全部应有 status/scope_tags/confidence
    const check = readFileSync(FILE, 'utf8').split('\n').filter(Boolean);
    let bad = 0;
    for (const l of check) {
      try {
        const o = JSON.parse(l);
        if (!('status' in o) || !('scope_tags' in o) || !('confidence' in o)) bad++;
      } catch { bad++; }
    }
    console.log(bad === 0 ? '✅ 自检：所有卡均带 v2 字段' : '❌ 自检：仍有 ' + bad + ' 张缺字段');
    process.exitCode = bad === 0 ? 0 : 1;
  }
}
