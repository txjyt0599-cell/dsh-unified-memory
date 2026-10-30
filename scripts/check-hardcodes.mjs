#!/usr/bin/env node
/**
 * check-hardcodes.mjs —— 扫出**会跟着发布跑**的硬编码路径
 *
 * [2026-10-30 by Assistant · 开源版第三轮自测发现]
 *
 * 这一轮是什么逼出来的（三个都是"别人装了就会碰到"）：
 *   ① cordis.patch.yml 里写了 '~/.dsh/unified-memory/logs'
 *      —— Node 不展开 ~，它变成**相对路径**，于是在工作目录下真建出一个叫 "~" 的目录，
 *         日志/索引全写进去了。使用者只会觉得"记忆插件没生效"。
 *   ② lib/retrieval/zstd-extract.py 写死 'C:/Users/Administrator/.dsh/sessions'
 *      —— 换台机器这条通道永远 not_found，而且是**静默**的：
 *         调用方拿到的是 "no_match"，看起来像"这张卡没有原始对话"。
 *   ③ scripts/smoke-apply.mjs 9 处写死 Temp 路径
 *      —— 别人跑冒烟测的是"路径不存在能不能扛住"，不是"插件能不能加载"。
 *
 * 判据：只查**会被使用者执行到**的位置（lib / scripts / cordis.patch.yml / 根目录套件），
 *       排除注释里作为反面教材引用的字符串（那些是文档，不是代码）。
 *
 * 用法：node scripts/check-hardcodes.mjs [--json]
 * 退出码：0 = 干净；1 = 有硬编码
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const asJson = process.argv.includes('--json');
const REPO = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();

const SCAN = [
  /^lib\/.*\.(js|mjs|cjs|py)$/,
  /^scripts\/.*\.(js|mjs|cjs)$/,
  /^selftest.*\.(js|mjs|cjs)$/,
  /^cordis\.patch\.yml$/,
];

// 会被误伤的合法内容：
//   · 注释里讲"不许这么写"的示例（本文件的判据就靠它传播）
//   · 测试里故意构造的假 token
const ALLOW = [
  /FAKEFORTESTONLY/,
  /process\.env\.USERPROFILE/,
  /本文件之外/,
  // paths.js 的 '~/.dsh' 是"推导全失败时的兜底串"，且有告警注释 —— 有意保留
  /return '~\/\.dsh'/,
  /normalize\(join\(home, '\.dsh'\)\)/,
  // 夹具数据里的字面量 cwd（不参与路径解析，只是被统计的字符串）
  /cwd: '~\/HUB'/,
  // 检查器自身要举的例子
  /C:\/Users\/Administrator/,
];

const HARDCODE = [
  { name: '开发机用户名路径', re: /C:\/Users\/Administrator/ },
  { name: '开发机项目路径', re: /D:\/(dsh-plugins|Phoebe Studio)\/dsh-unified-memory/ },
  { name: '未展开的 ~ 路径', re: /['"]~[\\/]/ },
];

const files = execFileSync('git', ['ls-files'], { encoding: 'utf8', cwd: REPO })
  .split('\n').map((s) => s.trim()).filter(Boolean).filter((f) => SCAN.some((re) => re.test(f)));

const hits = [];
for (const f of files) {
  // 读**工作区**而不是 index：这是发布前自检，要看的是"我现在这份代码"。
  // （git show :f 只看已暂存的内容，修好但没 add 的会被误报成还没修。）
  let raw = '';
  try { raw = readFileSync(join(REPO, f), 'utf8'); } catch { continue; }
  const lines = raw.split('\n');
  lines.forEach((line, i) => {
    if (ALLOW.some((re) => re.test(line))) return;
    // 纯注释行里的路径示例不算（那是文档）
    const trimmed = line.trim();
    if (/^(\/\/|\*|#|--)/.test(trimmed)) return;
    for (const h of HARDCODE) {
      if (h.re.test(line)) hits.push({ file: f, line: i + 1, kind: h.name, text: trimmed.slice(0, 120) });
    }
  });
}

if (asJson) {
  console.log(JSON.stringify({ scanned: files.length, hits }, null, 2));
} else {
  console.log('硬编码扫描: ' + files.length + ' 个会被使用者执行到的文件');
  if (hits.length === 0) {
    console.log('✅ 没有会跟着发布跑的硬编码路径');
  } else {
    console.log('❌ 发现 ' + hits.length + ' 处（在别人的机器上会静默失效）:');
    for (const h of hits) console.log('   ' + h.file + ':' + h.line + '  [' + h.kind + ']  ' + h.text);
  }
}
process.exitCode = hits.length === 0 ? 0 : 1;
