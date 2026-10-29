#!/usr/bin/env node
/**
 * e2e-colloquial-stopwords.mjs —— 口语填充词不能当关键词
 * [2026-10-24 by Assistant · Round 17]
 *
 * 抓到的真问题：问「显存到底多少G」时，alias 抽取把「到底」当成了关键词，
 *   于是 B 路召回一堆含"到底"的无关卡，真关键词「显存」被挤掉。
 *   User的问句里这类填充词极多，不滤掉就会污染检索。
 */
import { STOPWORDS } from '../lib/retrieval/types.js';
import { createRetriever } from '../lib/retrieval/retriever.js';

let fail = 0;
const check = (n, ok, d) => { console.log((ok ? '  ✅ ' : '  ❌ ') + n + (d ? '   ' + d : '')); if (!ok) fail++; };

console.log('[停用词表 ' + STOPWORDS.size + ' 条]\n');

const COLLOQUIAL = ['到底', '究竟', '大概', '大约', '差不多', '来着', '其实', '反正', '好像', '感觉', '似乎', '也许', '咋办', '咋整'];
const missing = COLLOQUIAL.filter((w) => !STOPWORDS.has(w));
check('① 口语填充词已进停用词表', missing.length === 0, missing.length ? '缺: ' + missing.join(',') : '14/14');

// ② 领域词不能被误停（防止加太多把真词吃掉）
const MUST_KEEP = ['显存', '显卡', '记忆', '插件', '日志', '配置', '重启'];
const wrongly = MUST_KEEP.filter((w) => STOPWORDS.has(w));
check('② 领域词没被误加进停用词', wrongly.length === 0, wrongly.join(',') || '无');

// ③ 实际检索：口语问句应能召回到正确答案（9060XT 16G）
const ret = createRetriever({ l0Enabled: true, l0RecentDays: 30 }, null);
await ret.warmup();
const QS = ['显存到底多少G', '显卡显存到底多大'];
let okCnt = 0;
for (const q of QS) {
  const r = await ret.search(q, { k: 8 });
  const hit = (r.hits || []).some((h) => /9060\s*XT|16GB|16G/i.test(String(h.title) + String(h.summary) + String(h.content)));
  if (hit) okCnt++;
  console.log('    · ' + q + ' → ' + (hit ? '★命中' : '未进前8'));
}
check('③ 口语问句能召回正确答案（前 8 内）', okCnt > 0, okCnt + '/' + QS.length);

console.log('\n' + (fail === 0 ? '✅ 全部通过' : '❌ ' + fail + ' 项失败'));
process.exit(fail === 0 ? 0 : 1);
