#!/usr/bin/env node
/**
 * e2e-title-dedupe.mjs —— 标题去重回归
 * [2026-10-24 by Assistant · Round 21]
 *
 * 抓到的真问题：481 个标题被多张卡共用，最多 26 张。
 *   查下去发现**不是真冗余**（content 各异，真冗余只有 0.3%），
 *   而是**标题太粗承载不了细节** —— 检索时只看到「修复粒子视效」×26，
 *   分不清哪条是「混合模式改 NormalBlending」、哪条是「bloom 不生效」。
 *
 * 修法：同标题的卡，把 content 里**剥掉共同前缀后的差异片段**拼进标题。
 */
import { dedupeTitles } from '../lib/hypergraph/dedupe-titles.mjs';
import { readTdaiRecords } from '../lib/hypergraph/source.js';

let fail = 0;
const check = (n, ok, d) => { console.log((ok ? '  ✅ ' : '  ❌ ') + n + (d ? '   ' + d : '')); if (!ok) fail++; };

console.log('── ① 函数行为 ──');
// 同标题、内容差异在中间
const a = dedupeTitles([
  { id: '1', title: '修复粒子视效', content: '主粒子层混合模式从 AdditiveBlending 改为 NormalBlending' },
  { id: '2', title: '修复粒子视效', content: 'bloom 溢光层开关不生效，实际没渲染' },
]);
check('同标题的卡被加了差异补语', a[0].title !== a[1].title);
check('补语来自 content', a[0].title.includes('：') && a[1].title.includes('：'));
console.log('     ' + a[0].title);
console.log('     ' + a[1].title);

// 同前缀、差异在句尾（Round 21 踩的坑）
const b = dedupeTitles([
  { id: '3', title: '用户希望在 NextHubKVM 项目中', content: '用户希望在 NextHubKVM 项目中实现画面增强功能，开启超分时自动降一档分辨率采集' },
  { id: '4', title: '用户希望在 NextHubKVM 项目中', content: '用户希望在 NextHubKVM 项目中实现采集卡帧率锁定到 60fps' },
]);
check('同前缀时仍能提取出差异（不重复）', b[0].title !== b[1].title);
console.log('     ' + b[0].title);
console.log('     ' + b[1].title);

// 占位标题不动
const c = dedupeTitles([
  { id: '5', title: '（无标题）', content: 'aaa' },
  { id: '6', title: '（无标题）', content: 'bbb' },
]);
check('占位标题不补后缀', c[0].title === '（无标题）' && c[1].title === '（无标题）');

// 唯一标题不动
const d = dedupeTitles([{ id: '7', title: '示例设备A再生示例单据', content: 'x' }]);
check('唯一标题保持原样', d[0].title === '示例设备A再生示例单据');

// 幂等
const e1 = dedupeTitles(a);
const e2 = dedupeTitles(e1);
check('幂等：再跑一次不变', JSON.stringify(e1.map(x => x.title)) === JSON.stringify(e2.map(x => x.title)));

console.log('── ② 生产数据效果 ──');
const cards = readTdaiRecords().cards || [];
const m = new Map();
for (const x of cards) { const k = String(x.title || '').replace(/\s+/g, ''); m.set(k, (m.get(k) || 0) + 1); }
const dup = [...m.values()].filter((n) => n > 1).reduce((a2, n) => a2 + n, 0);
const rate = dup / Math.max(1, cards.length);
console.log('    tdai 重复标题: ' + dup + '/' + cards.length + ' (' + (rate * 100).toFixed(1) + '%)');
check('② 重复标题率降到 15% 以下', rate < 0.15, (rate * 100).toFixed(1) + '%');

console.log('\n' + (fail === 0 ? '✅ 全部通过' : '❌ ' + fail + ' 项失败'));
process.exit(fail === 0 ? 0 : 1);
