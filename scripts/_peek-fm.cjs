const fs = require('node:fs');
const path = require('node:path');
const raw = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'docs', '_fm-raw.json'), 'utf8'));
console.log('样本 15 条：');
for (const r of raw.slice(0, 15)) console.log(' -', JSON.stringify(r.text.slice(0, 90)));
