/**
 * selftest-scene-wiring.mjs —— 场景隔离接线验收（2026-10-28 · v4 最终版）
 *
 * ## User的目标（本套全部围绕它）
 *   **一个Assistant，看全部会话的记忆。**
 *
 * ## 三版演进（每次失败都记下来）
 *   v1 用真实卡库测 ⇒ 真实卡 6818 张里 0 张有 scene ⇒ 该挡的变异挡不到东西 ⇒ 抓不到
 *   v2 用 l0CardsProvider 注入假卡 ⇒ L0 有硬门槛 l0MinScore=25，5 张假卡打不到分 ⇒ 全被挡在候选外
 *   v3 改用源码级断言 + isVisible 判据 ⇒ 抓到 X3，但 X1/X2（开关失效）仍抓不到
 *   v4（本版）加入 cardsProvider 测试接缝 ⇒ 现在能真正测出"开关失效会导致误挡"
 */
import { createRetriever } from './lib/retrieval/retriever.js';
import { isVisible } from './lib/scenes.js';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dataPath } from './lib/paths.js';
const ROOT = fileURLToPath(new URL('./', import.meta.url)).replace(/[\\/]$/, '');

let pass = 0, fail = 0;
const fails = [];
function check(g, name, ok, detail) {
  if (ok) { pass++; console.log('  PASS ' + name + (detail ? '   ' + detail : '')); }
  else { fail++; fails.push(name); console.log('  FAIL ' + name + (detail ? '   ' + detail : '')); }
}

// ── 测试用假卡：2 张标了 video，3 张未标 ──
const TAG = '场景隔离验收探针UNIQ';
const FAKE = [
  { id: 'probe-1', title: TAG + '甲', summary: TAG, content: TAG + ' 内容一 video 场景', createdAt: Date.now(), scene: 'video' },
  { id: 'probe-2', title: TAG + '乙', summary: TAG, content: TAG + ' 内容二 video 场景', createdAt: Date.now(), scene: 'video' },
  { id: 'probe-3', title: TAG + '丙', summary: TAG, content: TAG + ' 内容三 未标记', createdAt: Date.now() },
  { id: 'probe-4', title: TAG + '丁', summary: TAG, content: TAG + ' 内容四 未标记', createdAt: Date.now() },
  { id: 'probe-5', title: TAG + '戊', summary: TAG, content: TAG + ' 内容五 未标记', createdAt: Date.now() },
];

function mk() {
  return createRetriever({
    l0Enabled: false,
    cardsProvider: () => FAKE,
    engramPath: 'C:/nonexistent-scene-probe.jsonl',
    tdaiEnabled: false,
    soulMdEnabled: false,
  }, null);
}

console.log('════ SCENE-WIRING 接线验收 v4 ════');

// ── A · 接线存在性（源码级）──
console.log('\n── A · 接线存在性 ──');
const SRC = readFileSync(join(ROOT, 'lib/retrieval/retriever.js'), 'utf8');
// [2026-10-28] 正则第一次写错：把 `../` 转义成 `\.\.\/` 后与源码不匹配。
//   这类"断言本身写错导致假红"今天出现过多次 ⇒ 改成不看路径、只看 import 语句本身。
check('A', 'A1 import 了 isVisible', /import\s*\{[^}]*\bisVisible\b[^}]*\}\s*from/.test(SRC));
// [2026-10-28 修一个"假断言"]
//   原来用一个全局正则扫整个文件，但**注释里也写着** `o.sceneIsolation === true`
//   （第 1872 行的说明文字）⇒ 把代码变异掉之后，注释还在 ⇒ 断言照样通过 ⇒ 假绿。
//   这正是今天反复出现的「检查本身是假的」。修法：**先剥注释行再匹配**。
const SRC_CODE = SRC.split('\n')
  .filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l))
  .join('\n');
check('A', 'A2 代码里（非注释）有 === true 开关判断', /o\.sceneIsolation === true/.test(SRC_CODE));
check('A', 'A3 判错时放行（return true）', /catch \{ return true; \}/.test(SRC_CODE));
check('A', 'A4 有 scene-filter 日志', /level: 'scene-filter'/.test(SRC_CODE));

// ── B · 假卡源生效 ──
console.log('\n── B · 假卡源生效 ──');
const ret = mk();
await ret.warmup();
const base = await ret.search(TAG, { k: 20 });
const probeN = (base.hits || []).filter(h => String(h.id).startsWith('probe-')).length;
check('B', 'B1 假卡真的进索引了（5 张全在）', probeN === 5, 'hit=' + probeN);
check('B', 'B2 默认 sceneFiltered === 0', base.sceneFiltered === 0, 'filtered=' + base.sceneFiltered);
// [2026-10-28] 补一条：真实卡会混进来（cardsProvider 只替换 engram 源），
//   所以后续断言必须**只看 probe 卡**，不能看总数——否则会被真实卡干扰。
const realLeak = (base.hits || []).filter(h => !String(h.id).startsWith('probe-')).length;
console.log('  （提示：真实卡混入 ' + realLeak + ' 条，后续断言只看 probe 卡）');

// ── C · 默认不挡（User目标）──
console.log('\n── C · 默认一条不挡 ──');
check('C', 'C1 默认下 5 张假卡全在', probeN === 5, 'n=' + probeN);

// ── D · 反例：这些都必须不挡 ──
console.log('\n── D · 反例：必须不挡 ──');
{
  const cases = [
    { name: 'D1 只传 scene 不传开关', opts: { k: 20, scene: 'video' } },
    { name: 'D2 开关开但 scene 空', opts: { k: 20, sceneIsolation: true, scene: '' } },
    { name: 'D3 开关开但 scene 空白', opts: { k: 20, sceneIsolation: true, scene: '   ' } },
    { name: 'D4 sceneIsolation 传 1 不是 true', opts: { k: 20, sceneIsolation: 1, scene: 'video' } },
    { name: 'D5 sceneIsolation 传 "true" 字符串', opts: { k: 20, sceneIsolation: 'true', scene: 'video' } },
  ];
  for (const c of cases) {
    const r = await ret.search(TAG, c.opts);
    check('D', c.name + ' ⇒ 0 条被挡', r.sceneFiltered === 0, 'filtered=' + r.sceneFiltered);
  }
}

// ── E · 显式开启真的挡（证明不是死代码）──
console.log('\n── E · 显式开启 ──');
{
  const r = await ret.search(TAG, { k: 20, sceneIsolation: true, scene: 'memory' });
  // [2026-10-28] sceneFiltered 是**总数**（含真实卡），所以要单独看 probe 卡
  const left = (r.hits || []).filter(h => String(h.id).startsWith('probe-')).map(h => String(h.id));
  check('E', 'E1 probe 卡从 5 张变 3 张（挡掉 2 张 video）', left.length === 3, 'left=' + JSON.stringify(left));
  check('E', 'E2 剩下的正是未标记那 3 张', ['probe-3', 'probe-4', 'probe-5'].every(id => left.includes(id)), JSON.stringify(left));
  check('E', 'E3 被挡的正是 video 那两张', !left.includes('probe-1') && !left.includes('probe-2'));
  check('E', 'E4 sceneFiltered >= 2（含真实卡可能更多）', r.sceneFiltered >= 2, 'filtered=' + r.sceneFiltered);
}

// ── F · 同场景 / crossScene ──
console.log('\n── F · 同场景与放行 ──');
{
  const same = await ret.search(TAG, { k: 20, sceneIsolation: true, scene: 'video' });
  check('F', 'F1 同场景不挡', same.sceneFiltered === 0, 'filtered=' + same.sceneFiltered);
  const cross = await ret.search(TAG, { k: 20, sceneIsolation: true, scene: 'memory', includeCrossScene: true });
  check('F', 'F2 crossScene 放行', cross.sceneFiltered === 0, 'filtered=' + cross.sceneFiltered);
}

// ── G · isVisible 判据 ──
console.log('\n── G · 判据 ──');
check('G', 'G1 未声明 ⇒ 可见', isVisible({ title: 'x' }, 'memory') === true);
check('G', 'G2 当前未声明 ⇒ 可见', isVisible({ scene: 'video' }, null) === true);
check('G', 'G3 两边声明且不同 ⇒ 挡', isVisible({ scene: 'video' }, 'memory') === false);
check('G', 'G4 null 卡不抛', isVisible(null, 'memory') === true);

// ── H · 真实卡库不受影响 ──
console.log('\n── H · 真实卡库（无 scene 字段）──');
// [2026-10-30 · 开源版] H 组要真实卡库才谈得上"真实卡不被误挡"；新装池子空 ⇒ 跳过并说清楚。
if (!existsSync(dataPath('engram-relay/engrams.jsonl'))) {
  console.log('  ⚠️ 跳过 H1/H2：本机还没有卡库（新装即如此），无真实卡可验');
} else {
  const real = createRetriever({ l0Enabled: false }, null);
  await real.warmup();
  const r = await real.search('记忆系统', { k: 30, sceneIsolation: true, scene: 'memory' });
  check('H', 'H1 真实卡全部无 scene ⇒ 一张不挡', r.sceneFiltered === 0, 'filtered=' + r.sceneFiltered);
  check('H', 'H2 结果没被清空', (r.hits || []).length > 0, 'n=' + (r.hits || []).length);
}

console.log('\n════ SUMMARY ════');
console.log('  pass=' + pass + ' fail=' + fail);
if (fail) console.log('  失败项: ' + fails.join(' | '));
process.exit(fail ? 1 : 0);
