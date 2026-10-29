/**
 * selftest-title-clean.mjs —— 标题清洗自测
 * [2026-10-24 by Assistant · 实跑抓到的脏标题回归测试]
 */
import { cleanTitle, isDirtyTitle, cutAtWord } from './lib/ingest/title-clean.js';
import { readCards } from './lib/hypergraph/source.js';

let pass = 0, fail = 0;
const T = (n, fn) => { try { fn(); pass++; console.log('  ✓', n); } catch (e) { fail++; console.log('  ✗', n, '—', e && e.message); } };
const eq = (a, b, m) => { if (a !== b) throw new Error((m || '') + ' 期望 ' + JSON.stringify(b) + ' 实际 ' + JSON.stringify(a)); };
const ok = (v, m) => { if (!v) throw new Error(m || '期望为真'); };

console.log('\n[title-clean selftest]');

T('A1 闭合标签被剥（剩下 ✓ 是符号 ⇒ 退兜底正文，符合预期）', () => eq(cleanTitle('</style> ✓', '正文。'), '正文。'));
T('A2 表格碎片被剥', () => eq(cleanTitle('<tr><td>R1', '正文。'), 'R1'));
T('A3 代码块被剥', () => eq(cleanTitle('<pre><code', '这是一段真正的正文。'), '这是一段真正的正文'));
T('A4 纯符号 → 兜底正文', () => ok(cleanTitle('===---===', '兜底句。').length > 0));
T('A5 截断开标签被剥', () => eq(cleanTitle('本轮文档（ x ） <s', '正文。'), '本轮文档（ x ）'));
T('A6 属性残留被剥', () => eq(cleanTitle('标题 <div class="phoe', '正文。'), '标题'));
T('A7 制表符/框线被剥', () => ok(!/[\u2500-\u257F]/.test(cleanTitle('▼ ▼ ┌──────', '正文句。'))));
T('A8 markdown 标题符被剥', () => eq(cleanTitle('### 记忆改造', ''), '记忆改造'));
T('A9 正常标题一字不改', () => eq(cleanTitle('圆桌插件v0.2.2装配', ''), '圆桌插件v0.2.2装配'));
T('A10 全脏且无兜底 → 无标题', () => eq(cleanTitle('</style>', ''), '（无标题）'));
T('A11 幂等：清洗两次结果相同', () => {
  const once = cleanTitle('标题 <div class="x', '正文。');
  eq(cleanTitle(once, '正文。'), once);
});
T('A13 冒号结尾的引导语 → 取冒号后的实质内容', () => {
  // [Round 27 实测] 397 张卡标题是「这样：」「麻烦你回一句：」这种引导语
  const r1 = cleanTitle('麻烦你回一句：', '麻烦你回一句：这个我需要你确认一下要不要改');
  ok(!/[：:]$/.test(r1), '不能仍以冒号结尾：' + r1);
  ok(r1.length >= 6, '要有实质内容：' + r1);
  const r2 = cleanTitle('这样：', '这样：- 闭嘴时：嘴皮物理隐身，脸上只有纯正、干净的小倒V嘴角线');
  ok(!/[：:]$/.test(r2), '不能仍以冒号结尾：' + r2);
  ok(!/^这样/.test(r2), '引导语应被替换掉：' + r2);
});
T('A14 生产卡库：0 张以冒号结尾的标题', async () => {
  // 这条由 B 组统查（见下），此处只断函数自洽
  const r = cleanTitle('修法**已发令：', '修法（已发令）：把分档改成利落的双档');
  ok(!/[：:]$/.test(r), '不能以冒号结尾：' + r);
});
T('A15 按词边界截断，不切英文残词', () => {
  // [Round 28] 实测 132 张残词：「Cubism预乘Alph」（缺 a）、「canvas勿用inse」（缺 r）
  const r1 = cutAtWord('canvas勿用insertBefore否则重排', 16);
  ok(!/^canvas勿用insertBe$/.test(r1), '不能切成半词 insertBe：' + r1);
  ok(r1 === 'canvas勿用' || r1.includes('insertBefore'), '应是完整词或整词回退：' + r1);
  const r2 = cutAtWord('Cubism预乘Alpha后边缘发黑', 15);
  ok(!/Alph$/.test(r2), '不能切成 Alph：' + r2);
  // 中文照切（无词边界问题）
  const r3 = cutAtWord('这是一个纯中文的标题不需要断词', 8);
  eq(r3, '这是一个纯中文的');
  // 不超长时原样返回
  eq(cutAtWord('短标题', 16), '短标题');
});
T('A12 isDirtyTitle 判得准', () => {
  ok(isDirtyTitle('</style>') === true);
  ok(isDirtyTitle('n class="c') === true);
  ok(isDirtyTitle('圆桌插件装配') === false);
});

T('B1 生产卡库：0 张脏标题', () => {
  const r = readCards();
  const bad = r.alive.filter((c) => {
    const t = String(c.title || '');
    return /<\/?[a-zA-Z]/.test(t) || /\b[a-zA-Z-]+\s*=\s*["']/.test(t) || /[\u2500-\u257F]/.test(t) || t.trim().length < 2;
  });
  ok(bad.length === 0, '仍有 ' + bad.length + ' 张：' + bad.slice(0, 3).map((c) => String(c.title)).join(' / '));
});
T('B2 生产卡库：0 张「以冒号结尾的半句话」标题', () => {
  const r = readCards();
  const bad = r.alive.filter((c) => /[：:]\s*$/.test(String(c.title || '')));
  ok(bad.length === 0, '仍有 ' + bad.length + ' 张半句标题');
});

console.log('\n  ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
