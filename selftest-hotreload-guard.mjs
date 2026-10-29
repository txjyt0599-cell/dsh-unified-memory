/**
 * selftest-hotreload-guard.mjs —— 热重载保险验收（2026-10-28）
 *
 * ## 这套测试的核心是**顺序**，不是功能
 * 唯一会真正丢插件的路径是「先 dispose，再挂保险」——
 * 那中间只要崩一次，插件就永久消失，只能重启救。
 * 所以本套最重要的断言是 G-ORDER：**保险必须先挂**。
 *
 * ## 反例（必须被挡住）
 *   G1 没有保险函数 ⇒ 拒绝执行（不许裸拆）
 *   G2 预检不过 ⇒ 什么都不做
 *   G3 reload 抛错 ⇒ 保险**不能**被撤销（必须让它到点执行）
 *   G4 dryRun ⇒ 绝不 dispose
 */
import { createHotReloadGuard } from './lib/dispatch/hotreload-guard.js';

let pass = 0, fail = 0;
const fails = [];
function check(g, name, ok, detail) {
  if (ok) { pass++; console.log('  PASS ' + name + (detail ? '   ' + detail : '')); }
  else { fail++; fails.push(name); console.log('  FAIL ' + name + (detail ? '   ' + detail : '')); }
}

console.log('════ HOTRELOAD-GUARD 保险验收 ════');

/** 造一个带 fiber 的假 loader，记录所有动作的**顺序** */
function makeFakeLoader(id) {
  const events = [];
  const entry = {
    options: { id },
    fiber: { dispose() { events.push('dispose'); } },
  };
  const loader = {
    entries: () => {
      events.push('entries');
      return [entry];
    },
  };
  return { loader, entry, events };
}

// ── G0 · 预检 ──
console.log('\n── G0 · 预检 ──');
{
  const g = createHotReloadGuard({});
  check('G0', 'G0a loader 没有 ⇒ ok=false', g.precheck(() => null, 'x').ok === false);
  check('G0', 'G0b 找不到自己 ⇒ ok=false', (() => {
    const { loader } = makeFakeLoader('other');
    return g.precheck(() => loader, 'unified-memory').ok === false;
  })());
  {
    const { loader } = makeFakeLoader('unified-memory');
    const r = g.precheck(() => loader, 'unified-memory');
    check('G0', 'G0c 全齐 ⇒ ok=true 且有 fiber', r.ok === true && !!r.fiber);
  }
  check('G0', 'G0d 没有 fiber ⇒ ok=false', (() => {
    const loader = { entries: () => [{ options: { id: 'unified-memory' } }] };
    return g.precheck(() => loader, 'unified-memory').ok === false;
  })());
}

// ── G1 · 没有保险函数 ⇒ 拒绝执行 ──
console.log('\n── G1 · 没有保险不裸拆 ──');
{
  const g = createHotReloadGuard({});
  const { loader, events } = makeFakeLoader('unified-memory');
  const r = await g.reloadWithGuard({
    getLoader: () => loader,
    selfId: 'unified-memory',
    reload: async () => {},
    // 故意不给 rescue
  });
  check('G1', 'G1a 返回 ok=false', r.ok === false, r.reason);
  check('G1', 'G1b 原因是没保险', /no-rescue-fn/.test(String(r.reason)), r.reason);
  check('G1', 'G1c **没有** dispose（裸拆被挡住）', !events.includes('dispose'), JSON.stringify(events));
}

// ── G2 · dryRun 不动手 ──
console.log('\n── G2 · dryRun ──');
{
  const g = createHotReloadGuard({});
  const { loader, events } = makeFakeLoader('unified-memory');
  const r = await g.reloadWithGuard({
    getLoader: () => loader, selfId: 'unified-memory',
    reload: async () => { events.push('reload'); },
    rescue: async () => { events.push('rescue'); },
    dryRun: true,
  });
  check('G2', 'G2a ok=true 且标记 dryRun', r.ok === true && r.dryRun === true);
  check('G2', 'G2b **没有** dispose', !events.includes('dispose'), JSON.stringify(events));
  check('G2', 'G2c **没有** reload', !events.includes('reload'), JSON.stringify(events));
}

// ── G-ORDER · 关键：保险必须先于 dispose 存在 ──
//   [2026-10-28 修正] 上一版只验"dispose 在 reload 之前"，
//   **根本测不出"保险是不是先挂的"** —— 所以 K1 变异（先拆后挂）抓不到。
//   真正该验的是：**fiber.dispose() 被调用的那一刻，保险定时器是否已经存在**。
//   办法：在 dispose 的瞬间，往事件表里打一条"armed?"记录 —— 由 armRescue 侧标记。
console.log('\n── G-ORDER · 顺序（保险必须先挂）──');
{
  const g = createHotReloadGuard({});
  const events = [];
  let armedBeforeDispose = null;
  const entry = {
    options: { id: 'unified-memory' },
    fiber: {
      dispose() {
        // 此刻读"保险是否已挂"——这是唯一能证明顺序的时点
        armedBeforeDispose = (g.__debugArmedCount ? g.__debugArmedCount() : null);
        events.push('dispose');
      },
    },
  };
  const loader = { entries: () => [entry] };
  // [2026-10-28 修"测试自己崩了还报绿" · 今天第三次]
  //   变异成"先拆后挂"时，guard 变量不存在 ⇒ reloadWithGuard 抛 ReferenceError
  //   ⇒ 整个测试进程崩溃 ⇒ process.exit 跑不到 ⇒ 退出码 0 ⇒ 变异脚本以为"没抓到"。
  //   ⇒ 用 try/catch 包住：**抛错本身就算这项断言失败**，绝不让测试崩掉。
  let r = null;
  let thrown = null;
  try {
    r = await g.reloadWithGuard({
      getLoader: () => loader, selfId: 'unified-memory',
      reload: async () => { events.push('reload'); },
      rescue: async () => { events.push('rescue'); },
      rescueDelayMs: 5000,
    });
  } catch (e) { thrown = String(e && e.message || e); }
  check('G-ORDER', 'G-ORDER0 reloadWithGuard 不许抛错', thrown === null, thrown ? 'threw: ' + thrown : 'ok');
  // 判据：dispose 那一刻，保险计数必须 >= 1；否则就是"先拆后挂"
  check('G-ORDER', 'G-ORDER1 **dispose 时保险已挂**（顺序正确）',
    thrown === null && armedBeforeDispose !== null && armedBeforeDispose >= 1,
    'armedAtDispose=' + armedBeforeDispose);
  check('G-ORDER', 'G-ORDER2 dispose 在 reload 之前', events.indexOf('dispose') < events.indexOf('reload'),
    JSON.stringify(events));
  check('G-ORDER', 'G-ORDER3 成功路径不触发 rescue', !events.includes('rescue'), JSON.stringify(events));
  // [2026-10-28] r 可能为 null（上面抛错时）——直接 r.ok 会崩掉整个测试
  check('G-ORDER', 'G-ORDER4 返回 ok=true', r !== null && r.ok === true,
    r === null ? 'r=null' : JSON.stringify(r.steps));
}

// ── G3 · reload 抛错 ⇒ 保险必须留着 ──
console.log('\n── G3 · reload 抛错 ──');
{
  const g = createHotReloadGuard({});
  const { loader, events } = makeFakeLoader('unified-memory');
  let rescueFired = false;
  const r = await g.reloadWithGuard({
    getLoader: () => loader, selfId: 'unified-memory',
    reload: async () => { throw new Error('boom'); },
    rescue: async () => { rescueFired = true; events.push('rescue'); },
    rescueDelayMs: 1000,   // 1 秒保险，等它到点
  });
  check('G3', 'G3a 返回 ok=false', r.ok === false, r.reason);
  check('G3', 'G3b 步骤里写明"保险会接手"', /保险会接手/.test(String(r.steps.join(' '))));
  // 等保险到点
  await new Promise(res => setTimeout(res, 1600));
  check('G3', 'G3c 保险真的执行了（没被误撤销）', rescueFired === true, 'fired=' + rescueFired);
}

// ── G4 · 成功路径必须撤掉保险（避免二次装载）──
console.log('\n── G4 · 成功后撤保险 ──');
{
  const g = createHotReloadGuard({});
  const { loader } = makeFakeLoader('unified-memory');
  let rescueFired = false;
  // [2026-10-28] 包 try/catch：变异后这里可能抛错，不许让测试崩掉（今天第 N 次）
  let r = null, thrown4 = null;
  try {
    r = await g.reloadWithGuard({
      getLoader: () => loader, selfId: 'unified-memory',
      reload: async () => {},
      rescue: async () => { rescueFired = true; },
      rescueDelayMs: 1000,
    });
  } catch (e) { thrown4 = String(e && e.message || e); }
  await new Promise(res => setTimeout(res, 1600));
  check('G4', 'G4a 成功路径 ok=true', thrown4 === null && r !== null && r.ok === true, thrown4 || '');
  check('G4', 'G4b 保险被撤销（1.6 秒后没触发）', rescueFired === false, 'fired=' + rescueFired);
}

// ── G5 · dispose 抛错 ⇒ 保险要撤（因为没拆成功，不该再装）──
console.log('\n── G5 · dispose 抛错 ──');
{
  const g = createHotReloadGuard({});
  const entry = { options: { id: 'unified-memory' }, fiber: { dispose() { throw new Error('d-boom'); } } };
  const loader = { entries: () => [entry] };
  let rescueFired = false;
  let r5 = null, thrown5 = null;
  try {
    r5 = await g.reloadWithGuard({
      getLoader: () => loader, selfId: 'unified-memory',
      reload: async () => {},
      rescue: async () => { rescueFired = true; },
      rescueDelayMs: 1000,
    });
  } catch (e) { thrown5 = String(e && e.message || e); }
  check('G5', 'G5a 返回 ok=false', thrown5 === null && r5 !== null && r5.ok === false, thrown5 || String(r5 && r5.reason));
  await new Promise(res => setTimeout(res, 1400));
  check('G5', 'G5b dispose 没成功 ⇒ 保险已撤（不应再装）', rescueFired === false, 'fired=' + rescueFired);
}

console.log('\n════ SUMMARY ════');
console.log('  pass=' + pass + ' fail=' + fail);
if (fail) console.log('  失败项: ' + fails.join(' | '));
process.exit(fail ? 1 : 0);
