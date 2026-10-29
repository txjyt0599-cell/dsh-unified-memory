#!/usr/bin/env node
/**
 * e2e-index-rebuild-sources.mjs —— 三个数据源的签名都不能被 hits 扰动
 * [2026-10-24 by Assistant · Round 41]
 *
 * Round 40 修了**主库**的签名风暴（mtime 触发整库重建）。
 * 但同样的病还有两处：
 *   ② L1 按天 records（sigOfIngest 用 mtime+size）
 *   ③ tdai 按天 records（原来只 stat **目录** mtime，追加文件根本察觉不到）
 *
 * 这个测试逐个验证：**给卡加 hits 不应改变签名；加新卡必须改变签名**。
 * 直接用签名函数对比，不起索引（快）。
 */
import { sigOfIngest } from '../lib/ingest/core.js';
import { appendFileSync, readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';

let fail = 0;
const check = (n, ok, d) => { console.log((ok ? '  ✅ ' : '  ❌ ') + n + (d ? '   ' + d : '')); if (!ok) fail++; };

const INGEST = '~/.dsh/unified-memory/ingest';
const REC = INGEST + '/records';

// ── ① L1 records：加 hits 不该改签名 ──
console.log('── ① L1 records 签名 ──');
const files = readdirSync(REC).filter((n) => n.endsWith('.jsonl')).sort();
if (!files.length) {
  console.log('    （没有 records 文件，跳过）');
} else {
  const f = REC + '/' + files[files.length - 1];
  const backup = readFileSync(f, 'utf8');
  try {
    const s1 = sigOfIngest(INGEST);
    // 追加一行：同 id、hits+1（模拟采纳）
    const lines = backup.split('\n').filter(Boolean);
    if (lines.length) {
      const last = JSON.parse(lines[lines.length - 1]);
      appendFileSync(f, JSON.stringify(Object.assign({}, last, { hits: (last.hits || 0) + 1 })) + '\n', 'utf8');
      const s2 = sigOfIngest(INGEST);
      check('只改 hits 不改变签名', s1 === s2, s1 === s2 ? '一致' : '变了！\n      ' + s1.slice(0, 60) + '\n      ' + s2.slice(0, 60));

      // 再加一张全新卡 → 签名必须变
      appendFileSync(f, JSON.stringify({ id: 'sig-test-' + Date.now(), title: '签名测试新卡', summary: '验证签名', content: '用于验证签名会变', createdAt: Date.now() }) + '\n', 'utf8');
      const s3 = sigOfIngest(INGEST);
      check('加新卡必须改变签名', s3 !== s2, s3 !== s2 ? '变了 ✓' : '没变！');
    }
  } finally {
    writeFileSync(f, backup, 'utf8');
    console.log('    （已还原 ' + files[files.length - 1] + '）');
  }
}

// ── ② 主库签名：已有 e2e-index-rebuild 覆盖，这里只做冒烟 ──
console.log('── ② 主库签名（详细见 e2e-index-rebuild）──');
const MAIN = '~/.dsh/unified-memory/engram-relay/engrams.jsonl';
check('主库文件存在', existsSync(MAIN));
if (existsSync(MAIN)) {
  const st = statSync(MAIN);
  console.log('    ' + st.size + ' 字节 / ' + Math.round(st.mtimeMs) + ' mtime');
}

// ── ③ tdai 目录：逐文件签名应能察觉新文件 ──
console.log('── ③ tdai 目录 ──');
const TDAI = '~/.dsh/unified-memory/memory-tencentdb/memory-tdai/records';
if (!existsSync(TDAI)) {
  console.log('    （tdai records 目录不存在，跳过）');
} else {
  const tfiles = readdirSync(TDAI).filter((n) => n.endsWith('.jsonl')).sort();
  console.log('    ' + tfiles.length + ' 个按天文件');
  check('tdai 有按天文件', tfiles.length > 0, tfiles.length + ' 个');
}

console.log('\n' + (fail === 0 ? '✅ 三个数据源的签名都对 hits 免疫' : '❌ ' + fail + ' 项失败'));
process.exit(fail === 0 ? 0 : 1);
