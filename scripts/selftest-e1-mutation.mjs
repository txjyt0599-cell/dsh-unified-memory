/**
 * E1 断言变异自证：让检索结果大幅变动，看 Jaccard 断言会不会红。
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';

const ROOT = 'D:/dsh-plugins/dsh-unified-memory';
const F = ROOT + '/selftest-bridge.mjs';
const original = fs.readFileSync(F, 'utf8');

// 变异：把 jaccard 门槛提到 2.0（不可能达到）⇒ 断言必须红
const FROM = 'jaccard >= 0.6 && core1.length > 0 && core2.length > 0';
const TO = 'jaccard >= 2.0 && core1.length > 0 && core2.length > 0';

if (!original.includes(FROM)) {
  console.log('✗ 锚点缺失');
  process.exit(1);
}
fs.writeFileSync(F, original.replace(FROM, TO), 'utf8');

let caught = false, why = '';
try {
  execSync('node selftest-bridge.mjs', { cwd: ROOT, stdio: 'pipe', encoding: 'utf8' });
  why = '测试仍通过';
} catch (e) {
  if (e.status === 1) { caught = true; why = '测试红了（status=1）'; }
  else why = '命令没跑起来 status=' + e.status;
}
fs.writeFileSync(F, original, 'utf8');

console.log('E1 断言变异自证:', caught ? '✓ 抓到' : '✗ 没抓到', '—', why);
console.log('还原:', fs.readFileSync(F, 'utf8') === original ? '✓' : '✗');
process.exit(caught ? 0 : 1);
