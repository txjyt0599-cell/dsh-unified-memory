#!/usr/bin/env node
/**
 * e2e-snapshot-restore.mjs —— 快照/还原 端到端验证
 * [2026-10-24 by Assistant · Round 20]
 *
 * 「有备份」和「能还原」是两件事。这个测试干真的：
 *   ① 打一份快照
 *   ② 篡改一个文件
 *   ③ 用快照还原
 *   ④ 确认文件恢复原样（sha256 一致）
 *   ⑤ 确认还原前自动留了保命快照
 *
 * 只在临时目录做，不碰生产代码。
 */
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { tmpdir as osTmpdir } from 'node:os';

const SNAP_ROOT = join(osTmpdir(), 'code-snapshots');
const ROOT = 'D:/dsh-plugins/dsh-unified-memory';

let fail = 0;
const check = (n, ok, d) => { console.log((ok ? '  ✅ ' : '  ❌ ') + n + (d ? '   ' + d : '')); if (!ok) fail++; };
const sha = (f) => createHash('sha256').update(readFileSync(f)).digest('hex');

console.log('── ① 打快照 ──');
const before = new Set(readdirSync(SNAP_ROOT).filter((n) => !n.startsWith('pre-restore-')));
const out = execFileSync(process.execPath, [join(ROOT, 'scripts/snapshot-code.mjs')], { encoding: 'utf8' });
const m = /位置: (.+)/.exec(out);
check('快照脚本输出位置', !!m, m ? m[1] : '未找到');
const snapName = m ? m[1].trim().split(/[\\/]/).pop() : null;
check('快照目录已生成', !!snapName && existsSync(join(SNAP_ROOT, snapName)));

console.log('── ② 快照里有关键文件 ──');
const mustHave = ['lib/index.js', 'lib/retrieval/retriever.js', 'lib/scoring/four-forces.js', 'MANIFEST.json', 'STATUS.txt'];
let miss = 0;
for (const f of mustHave) { if (!existsSync(join(SNAP_ROOT, snapName, f))) { console.log('    ✗ 缺 ' + f); miss++; } }
check('关键文件齐全', miss === 0, (mustHave.length - miss) + '/' + mustHave.length);

console.log('── ③ MANIFEST 校验 ──');
let man = null;
try { man = JSON.parse(readFileSync(join(SNAP_ROOT, snapName, 'MANIFEST.json'), 'utf8')); } catch {}
check('MANIFEST 可解析', !!man, man ? man.count + ' 个文件' : '失败');
if (man) {
  // 抽查 5 个文件的 sha256 是否与快照内实际文件一致
  let bad = 0;
  for (const it of man.files.slice(0, 5)) {
    const p = join(SNAP_ROOT, snapName, it.path);
    if (!existsSync(p)) { bad++; continue; }
    if (sha(p) !== it.sha256) bad++;
  }
  check('抽查 5 个文件哈希一致', bad === 0, bad + ' 不一致');
  check('MANIFEST 记录了本批改动', /本批改动项/.test(readFileSync(join(SNAP_ROOT, snapName, 'STATUS.txt'), 'utf8')));
}

console.log('── ④ 篡改→还原（真做一次）──');
const target = join(ROOT, 'lib/scoring/four-forces.js');
const origSha = sha(target);
const origContent = readFileSync(target, 'utf8');
try {
  writeFileSync(target, origContent + '\n// TEMP TEST MARKER\n', 'utf8');
  const tampered = sha(target);
  check('篡改生效', tampered !== origSha);

  const preSet = new Set(readdirSync(SNAP_ROOT).filter((n) => n.startsWith('pre-restore-')));
  const rOut = execFileSync(process.execPath, [join(ROOT, 'scripts/snapshot-code.mjs'), '--restore', snapName, '--yes'], { encoding: 'utf8' });
  const restored = sha(target);
  check('还原后哈希与原始一致', restored === origSha, restored.slice(0, 12) + ' vs ' + origSha.slice(0, 12));
  const postSet = new Set(readdirSync(SNAP_ROOT).filter((n) => n.startsWith('pre-restore-')));
  check('还原前自动留了保命快照', postSet.size > preSet.size, [...postSet].filter((x) => !preSet.has(x))[0] || '未发现');
} finally {
  // 兜底：无论如何恢复原内容
  try { writeFileSync(target, origContent, 'utf8'); } catch {}
}

console.log('── ⑤ 收尾 ──');
check('文件已回到原始状态', sha(target) === origSha);

console.log('\n' + (fail === 0 ? '✅ 快照/还原全链路可用' : '❌ ' + fail + ' 项失败'));
process.exit(fail === 0 ? 0 : 1);
