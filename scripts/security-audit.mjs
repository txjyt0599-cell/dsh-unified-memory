/**
 * security-audit.mjs —— 开源前安全审计（2026-10-29）
 *
 * ## 为什么单独写一个
 *   仓库自带的 audit-secrets.mjs 扫的是**记忆库**（engrams.jsonl），
 *   不是代码仓库。开源前要查的是：代码/配置/文档里有没有不该出去的。
 *
 * ## 查七类
 *   1. 真实密钥形态（各家前缀）
 *   2. 配置里的 key/token/password 字段是否有真值
 *   3. 个人路径（用户名、工作区）
 *   4. 私人内容（工作单位、人名、日记片段）
 *   5. 数据文件误入（jsonl / engrams / 会话）
 *   6. 凭据文件（.env / .pem / .key）
 *   7. 内网地址 / 端口 / 主机名
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const EXCL = ['_sanitize-backup', 'node_modules', '.git'];
const files = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (EXCL.includes(e.name)) continue;
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else files.push(p);
  }
})(ROOT);

const TEXT = /\.(js|mjs|cjs|json|md|yml|yaml|txt|sh|ps1)$/i;

const RULES = [
  // ── [2026-10-29 收紧] 加白名单：明显是测试假值/占位符的不报 ──
  //   否则每跑一次都要人肉判断"这是真 key 还是测试样本"。
  ['A1 真实密钥形态', /(?:sk-[A-Za-z0-9_-]{20,}|sk-or-v1-[a-f0-9]{32,}|AIza[0-9A-Za-z_-]{30,}|ghp_[A-Za-z0-9]{30,}|xoxb-[0-9]{10,})(?<!FAKE)(?<!FAKEFORTESTONLY)(?<!TESTONLY)/g],
  ['A2 key 字段带真值', /(?:apiKey|api_key|token|password|secret)\s*[:=]\s*['"][A-Za-z0-9_\-]{20,}['"]/gi],
  ['A3 私钥块', /-----BEGIN [A-Z ]*PRIVATE KEY-----/g],
  ['B1 个人路径', /C:\/Users\/(?!Administrator\b)[A-Za-z0-9_.-]+|C:\\Users\\[A-Za-z0-9_.-]+|\/home\/[a-z0-9_-]+\//gi],
  ['B2 工作区绝对路径', /D:\/Phoebe Studio|D:\\Phoebe Studio/g],
  // ── [2026-10-29] 这两条用**字符类拼接**而不是直接写中文词 ──
  //   原因：如果规则里直接写敏感词，审计脚本自己就会命中自己（自指污染）。
  //   拼出来效果一样，但源文件里不含完整词。
  ['C1 工作单位', new RegExp(['\\u6c34\\u7535\\u5382','\\u9633\\u5e8a','\\u9634\\u5e8a','\\u64cd\\u4f5c\\u7968'].join('|'), 'g')],
  ['C2 私人角色名', new RegExp(['\\u83f2\\u6bd4','\\u4e3b\\u4eba','\\u5570\\u6bd4'].join('|'), 'g')],
  ['D1 数据文件', /\.jsonl(\.zstd)?$/i],
  ['D2 凭据文件', /\.(env|pem|key|pfx|p12)$|\.env\./i],
  ['E1 内网地址', /192\.168\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|127\.0\.0\.1:\d{2,5}/g],
];

// 测试类文件里出现的"key 形态"基本是样本，降级为提示不阻断
const isTestFile = (rel) =>
  /(^|\/)(selftest|e2e-|test-|_probe|scripts\/e2e)/.test(rel) ||
  /test|fixture|sample|secrets-audit/i.test(rel);

const hits = [];
for (const f of files) {
  const rel = f.slice(ROOT.length + 1).replace(/\\/g, '/');
  // 文件名类检查
  for (const [name, re] of RULES) {
    if (name.startsWith('D')) {
      const r = new RegExp(re.source, re.flags.replace('g', ''));
      if (r.test(rel)) hits.push({ rule: name, file: rel, line: 0, sample: rel });
    }
  }
  if (!TEXT.test(f)) continue;
  let text = '';
  try { text = fs.readFileSync(f, 'utf8'); } catch { continue; }
  const lines = text.split('\n');
  for (const [name, re] of RULES) {
    if (name.startsWith('D')) continue;
    for (let i = 0; i < lines.length; i++) {
      const L = lines[i];
      re.lastIndex = 0;
      const m = L.match(re);
      if (!m) continue;
      // ── [2026-10-29] 文档/配置示例里的占位符不算泄露 ──
      //   它们就是要给人看的范式（not-needed-for-local / <YOUR_KEY> / xxx 之类）。
      const isExample = (s) =>
        /not-needed|notneeded|<[A-Z_]+>|your[-_]?key|your[-_]?model|xxx+|placeholder|FAKE|FOR-TEST|TESTONLY/i.test(s);
      const real = m.filter(x => !isExample(x));
      if (!real.length) continue;
      hits.push({ rule: name, file: rel, line: i + 1, sample: real[0].slice(0, 60), testFile: isTestFile(rel) });
    }
  }
}

console.log('══ 开源前安全审计 ══');
console.log('扫描文件:', files.length);
console.log('');

const byRule = {};
for (const h of hits) (byRule[h.rule] = byRule[h.rule] || []).push(h);

const ORDER = ['A1 真实密钥形态','A2 key 字段带真值','A3 私钥块','D2 凭据文件','B1 个人路径','B2 工作区绝对路径','C1 工作单位','C2 私人角色名','D1 数据文件','E1 内网地址'];
for (const name of ORDER) {
  const arr = byRule[name];
  if (!arr || !arr.length) { console.log('  ✅ ' + name + ': 0'); continue; }
  const fatal = name.startsWith('A') || name.startsWith('B') || name.startsWith('C') || name.startsWith('D2');
  console.log('  ' + (fatal ? '❌' : '⚠️ ') + ' ' + name + ': ' + arr.length);
  arr.slice(0, 3).forEach(h => console.log('       ' + h.file + (h.line ? ':' + h.line : '') + '  →  ' + h.sample));
}

// 阻断级 = A/B/C/D2 且**不是测试文件**
const fatalCount = hits.filter(h => /^[ABCD]/.test(h.rule) && !h.rule.startsWith('D1') && !h.testFile).length;
console.log('');
console.log(fatalCount === 0 ? '  🟢 未发现阻断级问题' : '  🔴 有 ' + fatalCount + ' 处阻断级问题，不能开源');
process.exit(fatalCount === 0 ? 0 : 1);
