import fs from 'node:fs';
import path from 'node:path';

import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXCL = ['_sanitize-backup', 'node_modules', '.git', 'normify-phoebe-memory'];
const files = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (EXCL.includes(e.name)) continue;
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p); else files.push(p);
  }
})(ROOT);

// 真实数据指纹：我们的卡片 ID 形态、会话 ID、时间戳量级
const DATA_RULES = [
  ['卡片ID(pmi_)', /\bpmi[:_][a-z0-9_]{8,}/g],
  ['卡片ID(pm_179)', /\bpm_179\d{10,}/g],
  ['tdai 卡片ID', /\btdai:m_\d{13}_[a-f0-9]+/g],
  ['会话ID(session-)', /\bsession-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/g],
  ['派单ID(T2026)', /\bT202\d{5}-\d{6}-[a-z0-9]{4}/g],
  ['团队消息ID', /\bteam-message-[0-9a-f]{8}/g],
  ['真实时间戳(1793d{9})', /\b1793\d{9}\b/g],
];

const hits = [];
let scanned = 0;
for (const f of files) {
  const rel = f.slice(ROOT.length + 1).replace(/\\/g, '/');
  if (!/\.(js|mjs|cjs|json|md|yml|txt)$/i.test(f)) continue;
  let t = '';
  try { t = fs.readFileSync(f, 'utf8'); } catch { continue; }
  scanned++;
  const lines = t.split('\n');
  for (const [name, re] of DATA_RULES) {
    for (let i = 0; i < lines.length; i++) {
      re.lastIndex = 0;
      const m = lines[i].match(re);
      if (!m) continue;
      // ── [2026-10-29 收紧] 逐条过滤占位符/测试构造值 ──
      //   教训：第一版把 session-00000000-0000-0000（我们自己换的占位符）
      //        和 pmi_test_problem_01（测试造的数据）也报成泄露 ⇒ 27 处误报。
      const isPh = (s) =>
        /00000000-0000-0000/.test(s) ||
        s === '<card-id>' ||
        // 测试里常把时间戳写成整数递增（1793300000000/1793400000000…），
        // 真卡时间戳末 6 位是随机毫秒，这种整千整百的是构造值。
        // 形如 1793000000000 / 1793100000000 的整千万级构造值（真卡不会这么整）
        (/^\d{13}$/.test(s) && /^179\d{2}[0-9]0{6,}$/.test(s)) ||
        /_test_|test-problem|_fixture_|_sample_/.test(s) ||
        /^pmi:(pmi_)?(dup|done|bad|good|a|b)[_a-z0-9]*$/.test(s) ||
        /^pmi_(dup|done|bad|good)_/.test(s) ||
        /^team-message-(11111111|00000000)/.test(s);
      const real = m.filter(x => !isPh(x));
      if (!real.length) continue;
      hits.push({ rule: name, file: rel, line: i + 1, sample: real[0].slice(0, 40) });
    }
  }
}

console.log('══ 数据泄露终检 ══');
console.log('扫描文本文件:', scanned);
console.log('');
const by = {};
for (const h of hits) (by[h.rule] = by[h.rule] || []).push(h);
const KEYS = ['卡片ID(pmi_)','卡片ID(pm_179)','tdai 卡片ID','会话ID(session-)','派单ID(T2026)','团队消息ID','真实时间戳(1793\d{9})'];
let bad = 0;
for (const k of Object.keys(by)) {
  const arr = by[k];
  bad += arr.length;
  console.log('  ❌ ' + k + ': ' + arr.length);
  arr.slice(0, 3).forEach(h => console.log('       ' + h.file + ':' + h.line + '  →  ' + h.sample));
}
if (!bad) console.log('  🟢 未发现任何真实数据指纹');
console.log('');
console.log(bad ? '  🔴 有 ' + bad + ' 处真实数据痕迹' : '  🟢 干净');
process.exit(bad ? 1 : 0);
