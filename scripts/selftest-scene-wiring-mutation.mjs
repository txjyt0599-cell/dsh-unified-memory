/**
 * 场景隔离接线变异自证（2026-10-28）
 *
 * ## 守的是什么
 *   User的目标是「一个Assistant看全部记忆」。所以最危险的退化是：
 *   **有人把默认改成了"开"** —— 那会让记忆悄悄变少，而且不报错。
 * 三个变异方向：
 *   X1 去掉 sceneIsolation 开关判断（变成"传了 scene 就开"）
 *   X2 从 cwd 自动推断场景（在哪个目录开就只看那类）
 *   X3 过滤时对判错的卡"挡掉"而不是"放行"（误挡）
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import fs from 'node:fs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const F = ROOT + '/lib/retrieval/retriever.js';
const TEST = 'selftest-scene-wiring.mjs';

const cases = [
  { name: 'X1 去掉 sceneIsolation 开关（传 scene 就开）',
    from: "const sceneWanted = (o.sceneIsolation === true) ? String(o.scene || '').trim() : '';",
    to: "const sceneWanted = String(o.scene || '').trim();" },
  { name: 'X2 从 cwd 自动推断场景',
    from: "const sceneWanted = (o.sceneIsolation === true) ? String(o.scene || '').trim() : '';",
    to: "const sceneWanted = (o.sceneIsolation === true) ? (String(o.scene || '').trim() || 'unified-memory') : '';" },
  { name: 'X3 判错的卡挡掉而不是放行（误挡）',
    from: "            } catch { return true; }   // 单条判错 ⇒ 放行（宁可见多，不可误挡）",
    to: "            } catch { return false; }" },
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

console.log('场景隔离接线变异自证:');
let all = true;
for (const r of results) {
  if (!r.caught) all = false;
  console.log('  ' + (r.caught ? '✓ 抓到' : '✗ 没抓到') + '  ' + r.name + '  — ' + r.why);
}
console.log('\n结论:', all ? '三条变异全部被抓 —— "默认不隔离"守得住' : '⚠️ 有漏');
process.exit(all ? 0 : 1);
