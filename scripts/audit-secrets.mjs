#!/usr/bin/env node
/**
 * audit-secrets.mjs —— 记忆库敏感信息审计
 * [2026-10-24 by Assistant · Round 22]
 *
 * 为什么要有：
 *   记忆卡会**原样注入**到对话里。如果库里存过 API key / 密码 / 私钥，
 *   那么每次检索命中它，都会把密钥重新送进上下文 —— 这是持久化的泄露。
 *   之前从没系统性查过。User的铁律是「圣物永不出借」，这里是它的技术落地。
 *
 * 只读审计：不改任何数据，只报告。
 * 用法：node scripts/audit-secrets.mjs [--verbose]
 */
import { readCards, readTdaiRecords, readOwnIngest } from '../lib/hypergraph/source.js';
import { readFileSync, readdirSync, existsSync } from 'node:fs';

const VERBOSE = process.argv.includes('--verbose');

const PATTERNS = [
  ['OpenAI/Anthropic 风格 key', /\b(sk-[A-Za-z0-9_-]{16,}|sk-ant-[A-Za-z0-9_-]{16,})\b/g],
  ['GitHub token', /\b(ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g],
  ['AWS Access Key', /\bAKIA[0-9A-Z]{16}\b/g],
  ['Google API key', /\bAIza[0-9A-Za-z_-]{30,}\b/g],
  ['Bearer token', /Bearer\s+([A-Za-z0-9._-]{20,})/gi],
  ['密码赋值', /(password|passwd|pwd|密码)\s*[=:：]\s*([^\s,，。；]{4,40})/gi],
  ['私钥块', /-----BEGIN [A-Z ]*PRIVATE KEY-----/g],
  // [Round 22 修正] 原写法把 "base64/ctypes/hmac/http/json/..." 这种**斜杠分隔的模块名列表**
  //   误判成长 base64（实测 2 张误报）。真正的 base64 不含斜杠，且必须混合大小写+数字。
  ['长串 base64（>80）', /(?=[A-Za-z0-9+]{80,})(?=[^\/\s]*[A-Z])(?=[^\/\s]*[a-z])(?=[^\/\s]*[0-9])[A-Za-z0-9+]{80,}={0,2}/g],
];

function scan(text) {
  const hits = [];
  for (const [name, re] of PATTERNS) {
    re.lastIndex = 0;
    const m = re.exec(text);
    if (m) hits.push({ name, sample: String(m[0]).slice(0, 50) });
  }
  return hits;
}

console.log('══ 记忆库敏感信息审计 ══\n');

// 收集三源
const sources = [];
try { for (const c of readCards().alive) sources.push({ src: 'engram', c }); } catch {}
try { for (const c of (readTdaiRecords().cards || [])) sources.push({ src: 'tdai', c }); } catch {}
try { for (const c of (readOwnIngest().cards || [])) sources.push({ src: 'own', c }); } catch {}
console.log('扫描卡片总数: ' + sources.length);
console.log('  来源分布: ' + JSON.stringify(sources.reduce((a, x) => { a[x.src] = (a[x.src] || 0) + 1; return a; }, {})) + '\n');

const byPattern = new Map();
const offenders = [];
for (const { src, c } of sources) {
  const text = [c.title, c.summary, c.content].map((x) => String(x || '')).join('\n');
  if (!text.trim()) continue;
  const hits = scan(text);
  if (!hits.length) continue;
  offenders.push({ src, id: String(c.id), title: String(c.title || '').slice(0, 36), hits });
  for (const h of hits) byPattern.set(h.name, (byPattern.get(h.name) || 0) + 1);
}

console.log('── 结果 ──');
if (!offenders.length) {
  console.log('  ✅ 未发现敏感信息');
} else {
  console.log('  ⚠ 命中 ' + offenders.length + ' 张卡');
  for (const [k, v] of [...byPattern.entries()].sort((a, b) => b[1] - a[1])) {
    console.log('     ' + k.padEnd(24) + v + ' 处');
  }
  const show = VERBOSE ? offenders : offenders.slice(0, 8);
  console.log('\n  涉及卡片' + (VERBOSE ? '' : '（前 8 张，--verbose 看全部）') + ':');
  for (const o of show) {
    console.log('   · [' + o.src + '] ' + o.id.slice(0, 18) + '  ' + o.title);
    for (const h of o.hits) console.log('        ' + h.name + ': ' + h.sample);
  }
}

// ── 顺带扫 live 配置文件（不该含明文密钥）──
console.log('\n── 活配置扫一遍 ──');
const CFG = '~/.dsh/unified-memory/ingest/config.json';
if (existsSync(CFG)) {
  const hits = scan(readFileSync(CFG, 'utf8'));
  if (hits.length) {
    console.log('  ⚠ config.json 命中: ' + hits.map((h) => h.name).join(', '));
  } else {
    console.log('  ✅ config.json 无敏感信息');
  }
} else {
  console.log('  （找不到 config.json）');
}

console.log('\n' + (offenders.length === 0 ? '✅ 审计通过' : '⚠ 需人工核查上述卡片'));
process.exit(0);
