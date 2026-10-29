import { execSync } from 'node:child_process';
import fs from 'node:fs';
const ROOT = 'D:/dsh-plugins/dsh-unified-memory';
const TF = ROOT + '/lib/dispatch/hotreload-tools.js';
const TEST = 'selftest-hotreload-tools.mjs';
const original = fs.readFileSync(TF, 'utf8');
// 直接用真实片段（从文件里读到的形态）
const GOOD = "]." + "join(" + String.fromCharCode(39) + String.fromCharCode(92) + "n" + String.fromCharCode(39) + ")";
const BAD  = "]." + "join(" + String.fromCharCode(39) + "\n" + String.fromCharCode(39) + ")";
console.log('GOOD:', JSON.stringify(GOOD));
console.log('包含 GOOD:', original.includes(GOOD));
if (!original.includes(GOOD)) { console.log('锚点缺失'); process.exit(1); }
fs.writeFileSync(TF, original.split(GOOD).join(BAD), 'utf8');
let caught = false, why = '';
try { execSync('node ' + TEST, { cwd: ROOT, stdio: 'pipe', encoding: 'utf8' }); why = '仍通过'; }
catch (e) { caught = e.status === 1; why = caught ? '红了' : '未跑起来 ' + e.status; }
fs.writeFileSync(TF, original, 'utf8');
console.log('变异自证:', caught ? '✓ 抓到' : '✗ 没抓到', '—', why);
console.log('还原:', fs.readFileSync(TF, 'utf8') === original ? '✓' : '✗');
process.exit(caught ? 0 : 1);