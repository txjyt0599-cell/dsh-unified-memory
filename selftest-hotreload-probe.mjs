/**
 * selftest-hotreload-probe.mjs —— 只读探针验收（2026-10-28）
 *
 * 探针本身必须"判得准"：该绿绿、该红红。
 * 反例：
 *   P1 loader 取不到 ⇒ ok=false，不许假装能重载
 *   P2 entries 里没有自己 ⇒ ok=false（说明 id 猜错或路径不同）
 *   P3 找到自己但没有 fiber ⇒ ok=false（不能 dispose）
 *   P4 全齐 ⇒ ok=true
 */
import { createHotReloadProbe } from './lib/dispatch/hotreload-probe.js';

let pass = 0, fail = 0;
const fails = [];
function check(g, name, ok, detail) {
  if (ok) { pass++; console.log('  PASS ' + name + (detail ? '   ' + detail : '')); }
  else { fail++; fails.push(name); console.log('  FAIL ' + name + (detail ? '   ' + detail : '')); }
}

console.log('════ HOTRELOAD-PROBE 只读探针验收 ════');
const probe = createHotReloadProbe({ logger: null }).probe;

// ── P1 · loader 取不到 ──
console.log('\n── P1 · loader 不可达 ──');
{
  const r = probe(() => null, 'unified-memory');
  check('P1', 'P1a ok=false（不许假装能重载）', r.ok === false, 'ok=' + r.ok);
  check('P1', 'P1b loaderReachable=false', r.loaderReachable === false);
  check('P1', 'P1c 有说明原因', r.notes.length > 0, r.notes[0]);
}

// ── P2 · 找不到自己 ──
console.log('\n── P2 · entries 里没有自己 ──');
{
  const fakeLoader = { entries: () => [{ options: { id: 'other-plugin' } }] };
  const r = probe(() => fakeLoader, 'unified-memory');
  check('P2', 'P2a ok=false', r.ok === false, 'ok=' + r.ok);
  check('P2', 'P2b selfFound=false', r.selfFound === false);
  check('P2', 'P2c 列出了看到的 id（便于排查）', r.sampleEntryIds.includes('other-plugin'), JSON.stringify(r.sampleEntryIds));
}

// ── P3 · 找到自己但没有 fiber ──
console.log('\n── P3 · 有 entry 无 fiber ──');
{
  const fakeLoader = { entries: () => [{ options: { id: 'unified-memory' } }] };  // 没有 fiber
  const r = probe(() => fakeLoader, 'unified-memory');
  check('P3', 'P3a selfFound=true', r.selfFound === true);
  check('P3', 'P3b selfHasFiber=false', r.selfHasFiber === false);
  check('P3', 'P3c ok=false（不能 dispose 就不算可行）', r.ok === false, 'ok=' + r.ok);
}

// ── P4 · 全齐 ──
console.log('\n── P4 · 全部条件满足 ──');
{
  const fakeLoader = { entries: () => [{ options: { id: 'unified-memory' }, fiber: { dispose() {} } }] };
  const r = probe(() => fakeLoader, 'unified-memory');
  check('P4', 'P4a ok=true', r.ok === true);
  check('P4', 'P4b loaderReachable=true', r.loaderReachable === true);
  check('P4', 'P4c selfFound=true', r.selfFound === true);
  check('P4', 'P4d selfHasFiber=true', r.selfHasFiber === true);
}

// ── P5 · 反例：entries 抛错 ──
console.log('\n── P5 · entries 抛错 ──');
{
  const badLoader = { entries: () => { throw new Error('boom'); } };
  let threw = false, r;
  try { r = probe(() => badLoader, 'unified-memory'); } catch { threw = true; }
  check('P5', 'P5a 探针自己不许抛错', threw === false);
  check('P5', 'P5b ok=false', r && r.ok === false);
}

// ── P6 · 安全性：探针不许改状态 ──
console.log('\n── P6 · 只读性 ──');
{
  let disposeCalled = 0, updateCalled = 0, removeCalled = 0;
  const trapLoader = {
    entries: () => [{
      options: { id: 'unified-memory' },
      fiber: { dispose() { disposeCalled++; } },
      update() { updateCalled++; },
    }],
    remove() { removeCalled++; },
    update() { updateCalled++; },
  };
  probe(() => trapLoader, 'unified-memory');
  check('P6', 'P6a 没调用 fiber.dispose()', disposeCalled === 0, 'calls=' + disposeCalled);
  check('P6', 'P6b 没调用 entry.update()', updateCalled === 0, 'calls=' + updateCalled);
  check('P6', 'P6c 没调用 loader.remove()', removeCalled === 0, 'calls=' + removeCalled);
}

console.log('\n════ SUMMARY ════');
console.log('  pass=' + pass + ' fail=' + fail);
if (fail) console.log('  失败项: ' + fails.join(' | '));
process.exit(fail ? 1 : 0);
