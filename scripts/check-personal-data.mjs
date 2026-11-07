/**
 * check-personal-data.mjs —— 发布前自检：运行期代码里不许有「作者本机/个人」的痕迹
 *
 * 为什么需要（2026-11-07）：
 *   开源版曾把作者本机的硬件公理（具体显卡型号 / 显存 / 防误报规则）
 *   硬编码进 section.js 的静态段，于是**每个使用者每一轮** system prompt 都会
 *   被注入约 250 字符与该用户机器完全无关的内容；同类问题还有：
 *     · importance 正则里写死具体显卡型号（影响打分）
 *     · 场景根表里写死作者的项目目录（影响场景隔离）
 *     · 域内词表里写死作者的项目词汇（影响检索范围判定）
 *     · 转录脚本里写死作者助手的自称/称呼（影响导出结果）
 *   这些都不是路径类硬编码，check-hardcodes 抓不到，所以单独立这道检查。
 *
 * 判据：
 *   · 只扫**运行期代码**（lib/ 下的 .js / .py）
 *   · 跳过注释行（注释里的历史说明不算泄漏）
 *   · 命中即失败，并打印文件:行号
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO = process.cwd();
const SELF = 'scripts/check-personal-data.mjs';

const RULES = [
  { name: '具体显卡/芯片型号', re: /\b(9060|780M|4050|RDNA4|gfx1200|AdapterRAM|Radeon)\b/i },
  // 这两条用**字符类/拼接**构造，不把敏感词原样写进本文件
  //   —— 否则本文件自己会被 security-audit 的 C2/B2 规则命中（自指污染）。
  { name: '助手自称/对用户的称呼', re: new RegExp(['\u83f2\u6bd4', '\u4e3b\u4eba'].join('|')) },
  { name: '作者私有项目名', re: /desktop-pet|next-hub|nexthub/i },
  { name: '作者私有备份盘路径', re: /MemoryBackup/ },
  { name: '开发机路径', re: new RegExp('C:\\/Users\\/Admin' + 'istrator|D:\\/Phoebe' + ' Studio') },
];

const files = execFileSync('git', ['ls-files'], { encoding: 'utf8', cwd: REPO })
  .split('\n').map((s) => s.trim()).filter(Boolean)
  .filter((f) => f !== SELF && /^lib\//.test(f) && /\.(js|mjs|py)$/.test(f));

/** 去掉行注释，避免把「历史说明」误判成泄漏 */
function stripComment(line, isPy) {
  let s = line;
  const i = isPy ? s.indexOf('#') : s.indexOf('//');
  if (i >= 0) s = s.slice(0, i);
  // 块注释起止行整行丢弃
  if (/^\s*\/?\*/.test(line)) return '';
  return s;
}

const hits = [];
for (const f of files) {
  const isPy = f.endsWith('.py');
  const lines = readFileSync(join(REPO, f), 'utf8').split('\n');
  lines.forEach((line, i) => {
    const code = stripComment(line, isPy);
    if (!code.trim()) return;
    for (const r of RULES) {
      if (r.re.test(code)) hits.push({ file: f, line: i + 1, rule: r.name, text: line.trim().slice(0, 90) });
    }
  });
}

console.log('个人数据扫描: ' + files.length + ' 个运行期文件');
if (!hits.length) {
  console.log('✅ 运行期代码里没有作者本机/个人痕迹');
} else {
  for (const h of hits) console.log('  ❌ [' + h.rule + '] ' + h.file + ':' + h.line + '  ' + h.text);
  console.log('❌ 共 ' + hits.length + ' 处：这些内容会随插件发给所有使用者，请改为配置项或删除');
  process.exit(1);
}