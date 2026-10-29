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
import { sceneOfCwd, sceneOfCard, isVisible, summarize, SCENE_ROOTS } from './lib/scenes.js';

let pass = 0, fail = 0;
const fails = [];
function check(g, name, ok, detail) {
  if (ok) { pass++; console.log('  PASS ' + name + (detail ? '   ' + detail : '')); }
  else { fail++; fails.push(name); console.log('  FAIL ' + name + (detail ? '   ' + detail : '')); }
}

console.log('════ SCENES 场景隔离验收 ════');

// ── A · 从 cwd 推断场景 ──
console.log('\n── A · cwd → 场景 ──');
check('A', 'A1 记忆系统目录', sceneOfCwd('D:/dsh-plugins/dsh-unified-memory') === 'unified-memory');
check('A', 'A2 桌宠目录', sceneOfCwd('~/Assistant-live2d-pet') === 'desktop-pet');
check('A', 'A3 反斜杠也能认', sceneOfCwd('D:\\Assistant Studio\\Assistant-live2d-pet\\src') === 'desktop-pet');
check('A', 'A4 未知路径返回 null（不瞎猜）', sceneOfCwd('C:/Windows/System32') === null);
check('A', 'A5 空值返回 null', sceneOfCwd('') === null && sceneOfCwd(null) === null);
check('A', 'A6 最长前缀优先（hub 不被 Assistant studio 抢）',
  sceneOfCwd('~/HUB/specs') === 'hub', String(sceneOfCwd('~/HUB/specs')));

// ── B · 卡片场景归属 ──
console.log('\n── B · 卡片 → 场景 ──');
check('B', 'B1 显式 scene 字段优先', sceneOfCard({ scene: 'video' }) === 'video');
check('B', 'B2 无 scene 但有 cwd ⇒ 推断', sceneOfCard({ cwd: 'D:/dsh-plugins/dsh-unified-memory' }) === 'unified-memory');
check('B', 'B3 都没有 ⇒ null', sceneOfCard({}) === null);
check('B', 'B4 **绝不从标题猜**（title 里有"桌宠"也不算）',
  sceneOfCard({ title: 'Assistant桌宠的立绘怎么做' }) === null, String(sceneOfCard({ title: 'Assistant桌宠的立绘怎么做' })));

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
  const cards = [
    { scene: 'video' }, { scene: 'video' }, { scene: 'unified-memory' }, {}, { cwd: '~/HUB' },
  ];
  const s = summarize(cards, 'unified-memory');
  check('E', 'E1 总数对', s.total === 5, 'total=' + s.total);
  // [2026-10-28 修正] 我最初期望 hidden=2 是错的：
  //   第 5 条 {cwd:'~/HUB'} 会被正确推断成 'hub'，
  //   所以它也是"已声明且不同" ⇒ 该挡。hidden 应为 3。
  //   ⚠️ 这里必须改测试而不是改代码 —— 代码是对的（cwd 推断本来就该生效）。
  check('E', 'E2 隐藏数 = 3（2 条 video + 1 条 hub，未声明的 1 条不挡）', s.hidden === 3, 'hidden=' + s.hidden);
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
