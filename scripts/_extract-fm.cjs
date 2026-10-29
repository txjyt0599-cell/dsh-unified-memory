const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const files = [];
function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p); }
    else if (e.name.endsWith('.js')) files.push(p);
  }
}
walk(ROOT + '/lib');

// [2026-10-28 三次修正] 上一版抽了 319 条，混进大量"文件头介绍"。
//   失效模式的本质是：**症状 → 根因 → 修法**，三者至少要出现两个才算。
const SYMPTOM = /症状|现象|实测|实跑|报错|错|失败|不生效|不涨|不动|为零|全灭|抓不到|误判|误杀|硬凑|丢|漏|坏|崩|卡/;
const CAUSE = /根因|原因|为什么|因为|导致|问题在|病灶|缺陷|本质|其实是|原来/;
const FIX = /修法|修复|改成|改为|现在|改成|替换|修正|对策|处理|改为/;

const cards = [];
for (const f of files) {
  const lines = fs.readFileSync(f, 'utf8').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const L = lines[i];
    const dm = L.match(/(\d{4}-\d{2}-\d{2})/);
    if (!dm || !/^\s*(\/\/|\*|\/\*)/.test(L)) continue;
    const block = [];
    let j = i;
    while (j < lines.length && j < i + 28) {
      const cur = lines[j];
      if (!/^\s*(\/\/|\*|\/\*)/.test(cur)) break;
      const t = cur.replace(/^\s*(\/\/|\*|\/\*)+\s*/, '').replace(/\*\/$/, '').trim();
      if (t && !/^[=\-─═]{3,}/.test(t)) block.push(t);
      j++;
    }
    const text = block.join(' ').replace(/\s+/g, ' ').trim();
    if (text.length < 40) continue;
    // 必须至少命中两类（症状/根因/修法）
    const hits = [SYMPTOM, CAUSE, FIX].filter(re => re.test(text)).length;
    if (hits < 2) continue;
    cards.push({ file: f.replace(ROOT + '/', '').replace(/\\/g, '/'), line: i + 1, date: dm[1], text: text.slice(0, 420), hits });
  }
}
fs.writeFileSync(ROOT + '/docs/_fm-raw.json', JSON.stringify(cards, null, 1), 'utf8');
console.log('抽到', cards.length, '条（要求症状/根因/修法至少命中两类）');
const byHits = {}; for (const c of cards) byHits[c.hits] = (byHits[c.hits] || 0) + 1;
console.log('命中类数分布:', JSON.stringify(byHits));
for (const c of cards.slice(0, 3)) console.log(' ---', c.date, c.text.slice(0, 130));
