#!/usr/bin/env node
/**
 * e2e-secrets-audit.mjs —— 敏感信息审计的"有效性"测试
 * [2026-10-24 by Assistant · Round 22]
 *
 * 「扫描通过」和「扫描有效」是两件事。
 * 如果正则写错了，库里真藏着 key 也报"通过" —— 那比不扫更危险（虚假的安心）。
 * 所以这个测试用**构造的假密钥**做阳性对照：必须报红，否则说明审计是摆设。
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = fileURLToPath(new URL('./', import.meta.url)).replace(/[\\/]$/, '');

let fail = 0;
const check = (n, ok, d) => { console.log((ok ? '  ✅ ' : '  ❌ ') + n + (d ? '   ' + d : '')); if (!ok) fail++; };

// 从脚本里把 PATTERNS 抠出来做单测（不依赖真实数据）
const SRC = join(ROOT, '')scripts/audit-secrets.mjs';
const code = readFileSync(SRC, 'utf8');
const m = /const PATTERNS = \[([\s\S]*?)\n\];/.exec(code);
check('能提取到 PATTERNS 定义', !!m);
if (!m) { console.log('\n❌ 无法测试'); process.exit(1); }

// 构造正则（用 eval 在受控字符串上）
const PATTERNS = eval('[' + m[1] + ']');
const scan = (text) => {
  const hits = [];
  for (const [name, re] of PATTERNS) {
    re.lastIndex = 0;
    const mm = re.exec(text);
    if (mm) hits.push({ name, sample: String(mm[0]).slice(0, 40) });
  }
  return hits;
};

console.log('── ① 阳性对照：必须报红 ──');
const MUST_CATCH = [
  ['OpenAI key', 'my key is sk-FAKE-FOR-TEST-ONLY-0000', /key/],
  ['GitHub token', 'token ghp_FAKEFORTESTONLY0000000000000000', /GitHub/],
  ['AWS key', 'AKIAIOSFODNN7EXAMPLE', /AWS/],
  ['私钥块', '-----BEGIN FAKE KEY', /私钥/],
  ['密码', 'password: hunter2xyz', /密码/],
];
let caught = 0;
for (const [label, text, want] of MUST_CATCH) {
  const h = scan(text);
  const ok = h.some((x) => want.test(x.name));
  if (ok) caught++;
  console.log('    ' + (ok ? '✓' : '✗') + ' ' + label + (ok ? '' : '  ← 漏报！'));
}
check('所有构造密钥都能被抓到（审计有效）', caught === MUST_CATCH.length, caught + '/' + MUST_CATCH.length);

console.log('── ② 阴性对照：不该误报 ──');
const MUST_PASS = [
  ['模块名列表', 'base64/ctypes/hmac/http/json/os/re/secrets/shutil/ssl/subprocess/sys'],
  ['正常技术讨论', '我们讨论了 API key 应该怎么安全存放，不要写进配置文件'],
  ['URL', 'https://example.com/api/v1/memory/search?query=test'],
  ['普通代码', 'const x = require("fs").readFileSync(p, "utf8");'],
];
let falsePos = 0;
for (const [label, text] of MUST_PASS) {
  const h = scan(text);
  if (h.length) { falsePos++; console.log('    ✗ 误报 ' + label + ': ' + h[0].name); }
  else console.log('    ✓ ' + label);
}
check('正常文本不误报', falsePos === 0, falsePos + ' 误报');

console.log('── ③ 真实库跑一遍 ──');
const out = execFileSync(process.execPath, [SRC], { encoding: 'utf8' });
check('真实库审计通过', /未发现敏感信息|审计通过/.test(out), out.includes('未发现') ? '干净' : '有命中');

console.log('\n' + (fail === 0 ? '✅ 审计有效（能抓真的、不误伤假的）' : '❌ ' + fail + ' 项失败'));
process.exit(fail === 0 ? 0 : 1);
