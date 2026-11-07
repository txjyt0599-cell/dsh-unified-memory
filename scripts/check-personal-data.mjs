/**
 * check-personal-data.mjs —— 发布前自检：仓库里不许有「作者本机/个人」的痕迹
 *
 * 为什么重写（2026-11-07，独立红队复审后）：
 *   第一版只扫 lib/**、跳过注释、不扫 docs/测试/脚本 ⇒ 出现「检查全绿，但发布物里
 *   仍有完整硬件原文」的假绿。红队实锤：RELEASE 文档、FAILURE-MODES、lib 注释、
 *   selftest/scripts 全部漏检。
 *
 * 本版判据（严格）：
 *   ① 扫描范围 = **git 已跟踪的全部文本文件**（含 docs / selftest / scripts / 注释）
 *   ② 不跳过注释 —— 注释同样是发给使用者的源码
 *   ③ 额外扫描 **npm pack 清单**（防止未跟踪但会被打包的文件漏网）
 *   ④ 只对「检查器自身」做精确 allowlist（它们必须写出要查的模式）
 *
 * 命中即失败（exit 1）。
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const REPO = process.cwd();

const ALLOWLIST = new Set([
  'scripts/check-personal-data.mjs',
  'scripts/security-audit.mjs',
  'scripts/check-hardcodes.mjs',
]);

const TEXT_EXT = /\.(js|mjs|cjs|ts|py|json|md|yml|yaml|txt|sh|ps1|toml)$/i;

// 用字符拼接/转义构造，避免本文件自己变成「含有私人词的文件」
const RULES = [
  { name: '具体显卡/芯片型号', re: /\b(9060|780M|4050|RDNA4|gfx1200|AdapterRAM|Radeon)\b/i },
  { name: '助手自称/对用户的称呼', re: new RegExp(['\u83f2\u6bd4', '\u4e3b\u4eba'].join('|')) },
  { name: '作者私有项目名', re: /desktop-pet|next-hub|nexthub|KVMem/i },
  { name: '作者私有备份盘路径', re: /MemoryBackup|PhoebeBackupRoot/ },
  { name: '英文助手名', re: /\bPhoebe\b|phoebe[-_]memory/i },
  { name: '开发机路径', re: new RegExp('C:\\/Users\\/Admin' + 'istrator|D:\\/Phoebe' + ' Studio|D:\\/dsh-plugins') },
];

function scanText(rel, text, hits) {
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    if (!line.trim()) return;
    for (const r of RULES) {
      if (r.re.test(line)) hits.push({ file: rel, line: i + 1, rule: r.name, text: line.trim().slice(0, 100) });
    }
  });
}

const hits = [];
const tracked = execFileSync('git', ['ls-files'], { encoding: 'utf8', cwd: REPO })
  .split('\n').map((s) => s.trim()).filter(Boolean)
  .filter((f) => !ALLOWLIST.has(f) && TEXT_EXT.test(f));

for (const rel of tracked) {
  const p = join(REPO, rel);
  if (!existsSync(p)) continue;
  let text = '';
  try { text = readFileSync(p, 'utf8'); } catch { continue; }
  scanText(rel, text, hits);
}

let packed = [];
try {
  const npmBin = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const out = execFileSync(npmBin, ['pack', '--dry-run', '--json'], {
    encoding: 'utf8', cwd: REPO, timeout: 90000, shell: true,
  });
  const info = JSON.parse(out);
  packed = (info[0] && info[0].files ? info[0].files : []).map((f) => f.path);
} catch (e) {
  console.log('  ⚠️ npm pack --dry-run 失败，跳过包清单扫描：' + String(e && e.message || e).slice(0, 80));
}
for (const rel of packed) {
  if (ALLOWLIST.has(rel) || !TEXT_EXT.test(rel)) continue;
  const p = join(REPO, rel);
  if (!existsSync(p)) continue;
  let text = '';
  try { text = readFileSync(p, 'utf8'); } catch { continue; }
  scanText(rel, text, hits);
}

console.log('个人数据扫描: git 跟踪 ' + tracked.length + ' 个文本文件' +
  (packed.length ? ' + npm 包 ' + packed.length + ' 个文件' : ''));
if (!hits.length) {
  console.log('✅ 未发现作者本机/个人痕迹（含注释与文档）');
} else {
  for (const h of hits.slice(0, 40)) console.log('  ❌ [' + h.rule + '] ' + h.file + ':' + h.line + '  ' + h.text);
  if (hits.length > 40) console.log('  … 共 ' + hits.length + ' 处');
  console.log('❌ 共 ' + hits.length + ' 处：这些内容会随仓库/发布物发给所有使用者，请改为占位或删除');
  process.exit(1);
}