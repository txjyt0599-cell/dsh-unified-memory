#!/usr/bin/env node
/**
 * scripts/eval-flashback-rate.mjs —— 闪回触发率实测（红队标准：20 条里 2~4 次）
 */
import { createRetriever } from '../lib/retrieval/retriever.js';

const QS = [
  '想要在qq部署ai bot小Assistant可以帮我吗','提前设置的选项还有美化和之前设置的Assistant圣域同步','帮我打包 注册表命令会导致dsh重启吗',
  '我不是装了生图插件吗 你查询一下','你没办法查现在端口走到局域网哪里被拦截了吗','我要解决的是我以后装其他模型的路子',
  '你之前 不是说评论区推荐66吗','这眼睛怎么还带下脸蛋的 我才发现','怎么多了一层嘴 原来的嘴跟个胡子一样在前面',
  '为什么人物脸上还是感觉有个圈 放大又没有','你现在是打算用这个接收器给zako信号吗','publish_now 为什么我看修改日期是9.16',
  '那实际用起来需要跑任务前先让会话进行一次升级吗','改完你先试试看 这个插件的功能是否正常','你可以帮我把low降权这部分功能直接永久关闭吗',
  '-b512之前不是在我们机械上被证有问题要用1024吗','有什么可以优化到我们融合版本上的吗','你先把可以优化的清单整好',
  '两个号轮流切 都这样子是上游炸了吗','这是每周的不是刚刚我发在吗掉的',
];

const ret = createRetriever({ l0Enabled: false, flashbackEnabled: true }, null);
await ret.warmup();
let fired = 0;
const rows = [];
for (const q of QS) {
  let r; try { r = await ret.search(q, {}); } catch { r = { hits: [] }; }
  const fb = r.flashback || null;
  if (fb) fired++;
  rows.push({ q: q.slice(0, 16), fired: !!fb, title: fb ? String(fb.title || '').slice(0, 24) : '', score: fb ? Number(fb.score || 0).toFixed(3) + ' age=' + (fb.ageDays === null ? '?' : fb.ageDays + 'd') : '' });
}
console.log('| # | 查询 | 触发 | 闪回卡 | 分 |');
console.log('|---|---|---|---|---|');
rows.forEach((r, i) => console.log('| ' + (i + 1) + ' | ' + r.q + ' | ' + (r.fired ? '✅' : '-') + ' | ' + r.title + ' | ' + r.score + ' |'));
console.log('\n触发 ' + fired + '/' + QS.length + ' 次');
const ok = fired >= 1 && fired <= 8;
console.log((ok ? '✅' : '❌') + ' 触发率落在「安静为主、偶尔惊艳」区间（目标 2~4，容忍 1~8）');
process.exit(0);