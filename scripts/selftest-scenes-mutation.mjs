/**
 * 场景隔离变异自证：把隔离逻辑故意改错，看 selftest-scenes 会不会红。
 *
 * ## 要抓的三个方向
 *   S1 把"未声明场景的卡"也挡掉 → 历史卡集体消失（最危险）
 *   S2 当前场景未声明时也隔离 → 一换会话就断片
 *   S3 从标题猜场景 → 张冠李戴
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import fs from 'node:fs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const F = ROOT + '/lib/scenes.js';
const TEST = 'selftest-scenes.mjs';

const cases = [
  { name: 'S1 未声明的卡也挡（历史卡集体消失）',
    from: '  if (!cs) return true;',
    to: '  if (!cs) return false;' },
  { name: 'S2 当前场景未声明时也隔离',
    from: '  if (!currentScene) return true;',
    to: '  if (!currentScene) return false;' },
  { name: 'S3 允许从标题猜场景（张冠李戴）',
    from: "  if (c.cwd) return sceneOfCwd(c.cwd);",
    to: "  if (c.cwd) return sceneOfCwd(c.cwd);\n  if (/桌宠/.test(String(c.title || ''))) return 'desktop-pet';" },
];

const results = [];
for (const c of cases) {
  const original = fs.readFileSync(F, 'utf8');
  if (!original.includes(c.from)) { results.push({ name: c.name, caught: false, why: '锚点缺失' }); continue; }
  fs.writeFileSync(F, original.replace(c.from, c.to), 'utf8');
  let caught = false, why = '';
  try {
    execSync('node ' + TEST, { cwd: ROOT, stdio: 'ignore' });
    why = '测试仍通过';
  } catch (e) {
    if (e.status === 1) { caught = true; why = '测试红了'; }
    else why = '命令没跑起来 status=' + e.status;
  } finally {
    fs.writeFileSync(F, original, 'utf8');
  }
  results.push({ name: c.name, caught, why });
}

// 还原断言
const restoredFiles = fs.readFileSync(F, 'utf8');
console.log('场景隔离变异自证:');
let all = true;
for (const r of results) {
  if (!r.caught) all = false;
  console.log('  ' + (r.caught ? '✓ 抓到' : '✗ 没抓到') + '  ' + r.name + '  — ' + r.why);
}
console.log('\n结论:', all ? '三条变异全部被抓 —— 隔离验收是真的（不会误挡历史卡）' : '⚠️ 有漏');
process.exit(all ? 0 : 1);
