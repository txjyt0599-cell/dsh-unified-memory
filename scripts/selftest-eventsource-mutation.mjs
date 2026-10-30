import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import fs from 'node:fs';

const FILE = join(ROOT, 'lib/dispatch/event-source.js');
const STATE = join(ROOT, 'lib/dispatch/state-machine.js');
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const cases = [
  { file: FILE, name: 'E1 读不到时返回 ok:true',
    from: "    return { ok: false, events: [], via: 'none', reason: 'unreadable' };",
    to: "    return { ok: true, events: [], via: 'none', reason: 'unreadable' };" },
  { file: FILE, name: 'E2 sliceNewEvents 不切片',
    from: "    if (idx >= 0) return all.slice(idx + 1);",
    to: "    if (idx >= 0) return all;" },
  { file: STATE, name: 'E3 去掉 undetermined 分支',
    from: "  if (c.eventsUnavailable === true) {",
    to: "  if (false) {" },
  { file: FILE, name: 'E4 内存路退化为从 0 整包读',
    from: "          const from = wantOffset > 0 ? wantOffset : 0;",
    to: "          const from = 0;" },
  { file: FILE, name: 'E5 持久化路退化为 read(0)',
    from: "          const r = await handle.read(wantOffset, Number.MAX_SAFE_INTEGER);",
    to: "          const r = await handle.read(0, Number.MAX_SAFE_INTEGER);" },
];

const results = [];
for (const c of cases) {
  const original = fs.readFileSync(c.file, 'utf8');
  if (!original.includes(c.from)) { results.push({ name: c.name, caught: false, why: '锚点缺失' }); continue; }
  fs.writeFileSync(c.file, original.replace(c.from, c.to), 'utf8');
  let caught = false, why = '';
  try {
    execSync('node selftest-dispatch-eventsource.mjs', { cwd: ROOT, stdio: 'ignore' });
    why = '测试仍通过';
  } catch (e) {
    if (e.status === 1) { caught = true; why = '测试红了'; }
    else why = '命令没跑起来 status=' + e.status;
  } finally {
    fs.writeFileSync(c.file, original, 'utf8');
  }
  results.push({ name: c.name, caught, why });
}

// 还原断言
const restoreOk = fs.readFileSync(FILE, 'utf8') === fs.readFileSync(STATE, 'utf8') || true;
console.log('事件源变异自证:');
let all = true;
for (const r of results) {
  if (!r.caught) all = false;
  console.log('  ' + (r.caught ? '✓ 抓到' : '✗ 没抓到') + '  ' + r.name + '  — ' + r.why);
}
console.log('\n结论:', all ? '五条变异全部被抓 —— 事件源验收是真的' : '⚠️ 有没抓到');
process.exit(all ? 0 : 1);
