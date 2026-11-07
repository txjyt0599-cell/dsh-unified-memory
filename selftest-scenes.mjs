/**
 * selftest-scenes.mjs —— 场景隔离验收（2026-10-28）
 *
 * ## 最危险的失效模式（本套主要防它）
 * 隔离做错 → **历史卡集体消失**。这比"不隔离"更糟：
 *   不隔离只是吵，隔离错了是"记忆没了"，而且用户只会觉得"怎么记不住了"。
 * ⇒ 所以本套的反例全是"**必须可见**"：
 *     ① 未声明场景的卡，在任何场景下都必须可见
 *     ② 当前场景未声明时，一律不隔离
 *     ③ 显式 includeCrossScene 时，跨场景也可见
 *   只有"两边都声明且不同"这一种情况才允许挡。
 */
import { sceneOfCwd, sceneOfCard, isVisible, summarize, SCENE_ROOTS, makeSceneRoots } from './lib/scenes.js';

let pass = 0, fail = 0;
const fails = [];
function check(g, name, ok, detail) {
  if (ok) { pass++; console.log('  PASS ' + name + (detail ? '   ' + detail : '')); }
  else { fail++; fails.push(name); console.log('  FAIL ' + name + (detail ? '   ' + detail : '')); }
}

console.log('════ SCENES 场景隔离验收 ════');

// [2026-11-07 · 去个人化] 场景根表现在默认是空的（不再内置作者的项目目录），
//   所以这套测试改为**自带夹具**：用通用目录名演示，同时验证 makeSceneRoots 可用。
const ROOTS = makeSceneRoots({
  'project-a': ['/opt/project-a'],
  'project-a-sub': ['/opt/project-a/sub'],
  'project-b': ['/opt/project-b'],
});

// ── A · 从 cwd 推断场景 ──
console.log('\n── A · cwd → 场景 ──');
check('A', 'A1 项目 A 目录', sceneOfCwd('/opt/project-a/src', ROOTS) === 'project-a');
check('A', 'A2 项目 B 目录', sceneOfCwd('/opt/project-b', ROOTS) === 'project-b');
check('A', 'A3 反斜杠也能认', sceneOfCwd('\\opt\\project-b\\src', ROOTS) === 'project-b');
check('A', 'A4 未知路径返回 null（不瞎猜）', sceneOfCwd('/usr/bin', ROOTS) === null);
check('A', 'A5 空值返回 null', sceneOfCwd('', ROOTS) === null && sceneOfCwd(null, ROOTS) === null);
check('A', 'A6 最长前缀优先（子目录不被父目录抢）',
  sceneOfCwd('/opt/project-a/sub/specs', ROOTS) === 'project-a-sub', String(sceneOfCwd('/opt/project-a/sub/specs', ROOTS)));

// ── B · 卡片场景归属 ──
console.log('\n── B · 卡片 → 场景 ──');
check('B', 'B1 显式 scene 字段优先', sceneOfCard({ scene: 'video' }) === 'video');
check('B', 'B2 无 scene 但有 cwd ⇒ 推断', sceneOfCard({ cwd: '/opt/project-a/src' }, ROOTS) === 'project-a');
check('B', 'B3 都没有 ⇒ null', sceneOfCard({}) === null);
check('B', 'B4 **绝不从标题猜**（title 里有场景名也不算）',
  sceneOfCard({ title: 'project-a 里那个功能怎么做' }, ROOTS) === null, String(sceneOfCard({ title: 'project-a 里那个功能怎么做' }, ROOTS)));

// ── C · 反例：必须可见的情况（最危险）──
console.log('\n── C · 反例：这些必须可见 ──');
check('C', 'C1 当前场景未声明 ⇒ 全部可见（不隔离）',
  isVisible({ scene: 'video' }, null) === true);
check('C', 'C2 卡未声明场景 ⇒ 可见（历史卡不该消失）',
  isVisible({}, 'unified-memory') === true);
check('C', 'C3 两边都未声明 ⇒ 可见',
  isVisible({}, null) === true);
check('C', 'C4 同场景 ⇒ 可见',
  isVisible({ scene: 'video' }, 'video') === true);
check('C', 'C5 includeCrossScene ⇒ 跨场景也可见',
  isVisible({ scene: 'video' }, 'unified-memory', { includeCrossScene: true }) === true);

// ── D · 唯一允许挡的情况 ──
console.log('\n── D · 唯一允许隔离的情况 ──');
check('D', 'D1 两边都声明且不同 ⇒ 隔离',
  isVisible({ scene: 'video' }, 'unified-memory') === false);
check('D', 'D2 反过来同样隔离',
  isVisible({ scene: 'unified-memory' }, 'video') === false);

// ── E · 统计对照 ──
console.log('\n── E · 统计 ──');
{
  // [2026-11-07 · 去个人化] 夹具改用通用场景名 + 自带 roots（默认表已清空）
  const E_ROOTS = makeSceneRoots({
    'project-a': ['/opt/project-a'],
    'project-b': ['/opt/project-b'],
  });
  const cards = [
    { scene: 'project-b' }, { scene: 'project-b' }, { scene: 'project-a' }, {}, { cwd: '/opt/project-b/src' },
  ];
  const s = summarize(cards, 'project-a', { roots: E_ROOTS });
  check('E', 'E1 总数对', s.total === 5, 'total=' + s.total);
  // 第 5 条 {cwd:'/opt/project-b/src'} 会被正确推断成 'project-b' ⇒ 已声明且不同 ⇒ 该挡。
  // 所以 hidden = 2 条显式 project-b + 1 条推断 project-b = 3，未声明的那条不挡。
  check('E', 'E2 隐藏数 = 3（2 条显式 + 1 条由 cwd 推断，未声明的不挡）', s.hidden === 3, 'hidden=' + s.hidden);
  check('E', 'E3 分场景统计含未声明', s.byScene['(未声明)'] === 1, JSON.stringify(s.byScene));
}

// ── F · 反例：隔离率不许 100%（防"全挡"）──
console.log('\n── F · 防"全挡" ──');
{
  const many = [
    { scene: 'video' }, { scene: 'desk' }, {}, { cwd: 'C:/unknown' }, { title: '没有场景信息的历史卡' },
  ];
  const s = summarize(many, 'unified-memory');
  check('F', 'F1 未声明的卡一条都没被挡（5 条里只挡 2 条）', s.hidden === 2, 'hidden=' + s.hidden + '/' + s.total);
  check('F', 'F2 可见数 > 0（绝不允许全挡）', s.total - s.hidden > 0, 'visible=' + (s.total - s.hidden));
}

// ── G · 幂等与健壮 ──
console.log('\n── G · 健壮 ──');
check('G', 'G1 null 卡不抛', isVisible(null, 'video') === true);
check('G', 'G2 summarize(null) 不抛', summarize(null, 'video').total === 0);
check('G', 'G3 同一输入重复调用结果一致',
  isVisible({ scene: 'video' }, 'unified-memory') === isVisible({ scene: 'video' }, 'unified-memory'));

console.log('\n════ SUMMARY ════');
console.log('  pass=' + pass + ' fail=' + fail);
if (fail) console.log('  失败项: ' + fails.join(' | '));
process.exit(fail ? 1 : 0);
