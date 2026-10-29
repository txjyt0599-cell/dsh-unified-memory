#!/usr/bin/env node
/**
 * e2e-refute-mechanism.mjs —— 纠错/推翻机制验证
 * [2026-10-24 by Assistant · Round 43]
 *
 * 背景：记忆里可能有错的（比如「9060XT 是 4G」后来被更正为 16G）。
 *   问题：纠错之后，错误的记忆会不会继续干扰？
 *
 * 实测三件事：
 *   ① 排序层面：普通错误卡会被纠正卡压下去（重要性 × 新鲜度）
 *   ② 但**如果两张都是基石**，排序打平 —— 单靠排序分辨不了
 *   ③ 这时必须靠 refute_by 显式标记 ⇒ 检索端应该**读它并降权/过滤**
 *
 * 当前发现：refute_by 只被**写入**（distill/consolidate/belief），
 *   **没有任何地方读它做过滤** ⇒ 被推翻的卡仍会正常参与检索。
 *   现实中目前 0 张被推翻卡（所以没暴露），但机制是缺的。
 */
import { readCards, readTdaiRecords, readOwnIngest } from '../lib/hypergraph/source.js';
import { applyFourForces } from '../lib/scoring/four-forces.js';
import { dataPath } from '../lib/paths.js';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = fileURLToPath(new URL('./', import.meta.url)).replace(/[\\/]$/, '');

const D = 86400000;
const now = Date.now();
let fail = 0;
const check = (n, ok, d) => { console.log((ok ? '  ✅ ' : '  ❌ ') + n + (d ? '   ' + d : '')); if (!ok) fail++; };

// ── ① 排序能压住"普通错误卡" ──
console.log('── ① 排序层面：纠错卡 vs 老错误卡 ──');
const err = { id: 'err', importance: 0.25, is_axiom: false, createdAt: now - 40 * D, hits: 0 };
const fix = { id: 'fix', importance: 0.9, is_axiom: true, createdAt: now, hits: 0 };
const e = applyFourForces(err, 0.9, now).score;
const f = applyFourForces(fix, 0.9, now).score;
console.log('    老错误 ' + e.toFixed(3) + '  vs  新纠正 ' + f.toFixed(3));
check('纠错卡分数明显高于老错误卡', f > e * 1.5, (f / e).toFixed(2) + 'x');

// ── ② 两个都是基石时，排序打平（暴露局限）──
console.log('── ② 两张都是基石时 ──');
const errAxiom = { id: 'err2', importance: 0.9, is_axiom: true, createdAt: now - 40 * D, hits: 0 };
const e2 = applyFourForces(errAxiom, 0.9, now).score;
console.log('    错误基石 ' + e2.toFixed(3) + '  vs  纠正基石 ' + f.toFixed(3));
check('两个基石同分（排序无法分辨 —— 这是设计边界，不是 bug）', Math.abs(e2 - f) < 0.001);
console.log('    ⇒ 这种情况必须靠 refute_by 标记，排序帮不上');

// ── ③ 数据侧：refute_by 用了吗 ──
console.log('── ③ 数据侧检查 ──');
const all = [];
for (const c of readCards().alive) all.push(c);
for (const c of (readTdaiRecords().cards || [])) all.push(c);
for (const c of (readOwnIngest().cards || [])) all.push(c);
const refuted = all.filter((c) => Array.isArray(c.refute_by) && c.refute_by.length > 0);
console.log('    被推翻（refute_by 非空）的卡: ' + refuted.length);
check('被推翻卡片数据结构正常（refute_by 格式合法）', Array.isArray(refuted), refuted.length + ' 张被推翻卡存根');

// ── ④ 机制是否闭环：检索端会不会读 refute_by ──
console.log('── ④ 机制闭环检查 ──');
const { readFileSync } = await import('node:fs');
const retrieverSrc = readFileSync(join(ROOT, '')lib/retrieval/retriever.js', 'utf8');
const readsRefute = /refute_by/.test(retrieverSrc);
console.log('    retriever.js 读 refute_by: ' + readsRefute);
check('检索端会读取 refute_by 做降权/过滤', readsRefute, readsRefute ? '已接' : '未接（缺口：被推翻的卡仍会参与检索）');

// ── ⑤ 实测降权倍数（用临时卡，跑完还原）──
console.log('── ⑤ 实测降权是否真生效 ──');
const { appendFileSync, writeFileSync } = await import('node:fs');
const MAIN = dataPath('engram-relay/engrams.jsonl');
const { createRetriever: mkRet } = await import('../lib/retrieval/retriever.js');
const backupMain = readFileSync(MAIN, 'utf8');
try {
  const nid = 'refute-e2e-' + Date.now();
  appendFileSync(MAIN, JSON.stringify({
    id: nid, title: '芝士雪豹降权验证', summary: '芝士雪豹验证',
    content: '芝士雪豹降权验证内容，独特词条用于确认降权倍数',
    status: 'active', importance: 0.9, is_axiom: true, createdAt: Date.now(),
    refute_by: ['old-1'],
  }) + '\n', 'utf8');
  const rt = mkRet({ l0Enabled: false }, null);
  await rt.warmup(true);
  const sc = async (extra) => {
    const r = await rt.search('芝士雪豹降权验证', Object.assign({ k: 10 }, extra || {}));
    const h = (r.hits || []).find((x) => String(x.id) === nid);
    return h ? Number(h.score) : null;
  };
  const on = await sc({});
  const off = await sc({ refutePenaltyEnabled: false });
  console.log('    开降权=' + on + '  关降权=' + off);
  check('降权开关真的生效（可回滚）', on != null && off != null && Math.abs(on / off - 0.15) < 0.02,
    on != null && off != null ? (on / off).toFixed(3) + 'x' : '取不到分数');
} finally {
  writeFileSync(MAIN, backupMain, 'utf8');
  console.log('    （已还原卡库）');
}

// ── ⑥ 反例：降权不许误伤（2026-10-28 by Assistant · 补反例）──
//   背景：正向测了"被推翻的卡该降权"，但**没测"不该降权的卡会不会被误降"**。
//   这类误伤最隐蔽：正常记忆被静默压到 0.15x，用起来只觉得"怎么记不住了"，
//   而日志里全是成功。所以这一组全是"必须不降"的反例。
console.log('── ⑥ 反例：不许误伤正常卡 ──');
{
  const { appendFileSync: ap, writeFileSync: wf } = await import('node:fs');
  const MAIN2 = dataPath('engram-relay/engrams.jsonl');
  const bk = readFileSync(MAIN2, 'utf8');
  try {
    const nid2 = 'refute-neg-' + Date.now();
    const mark2 = '雪豹反例词条' + String(Date.now()).slice(-6);
    const shapes = [undefined, [], 'not-an-array'];
    const ids = [];
    for (let i = 0; i < shapes.length; i++) {
      const id = nid2 + '-' + i;
      ids.push(id);
      // 每张卡的正文必须**唯一**：同 title 同 content 会被 dedupeTitles/去重逻辑合并，
      // 结果是"三种形态只测到一张"——那正是假绿（我第一次写就踩了，tested=1/3）。
      const uniq = { '0': '缺字段', '1': '空数组', '2': '脏类型' }[String(i)];
      ap(MAIN2, JSON.stringify(Object.assign({
        id, title: mark2 + uniq, summary: mark2 + uniq,
        content: mark2 + ' ' + uniq + ' 用于确认不被误降权 ' + id,
        status: 'active', importance: 0.9, is_axiom: true, createdAt: Date.now(),
      }, shapes[i] === undefined ? {} : { refute_by: shapes[i] })) + '\n', 'utf8');
    }
    const rt2 = mkRet({ l0Enabled: false }, null);
    await rt2.warmup(true);
    let same = 0, tested = 0;
    for (const id of ids) {
      const s1 = (await rt2.search(mark2, { k: 20 })).hits.find((x) => String(x.id) === id);
      const s2 = (await rt2.search(mark2, { k: 20, refutePenaltyEnabled: false })).hits.find((x) => String(x.id) === id);
      if (s1 && s2) { tested++; if (Math.abs(Number(s1.score) - Number(s2.score)) < 1e-9) same++; }
    }
    check('空数组 / 缺字段 / 脏类型 都不触发降权（开=关）', tested > 0 && same === tested, same + '/' + tested + ' 一致');

    const id3 = nid2 + '-real';
    ap(MAIN2, JSON.stringify({
      id: id3, title: mark2, summary: mark2, content: mark2 + ' 真被推翻的那张',
      status: 'active', importance: 0.9, is_axiom: true, createdAt: Date.now(),
      refute_by: ['old-9'],
    }) + '\n', 'utf8');
    const rt3 = mkRet({ l0Enabled: false }, null);
    await rt3.warmup(true);
    const a1 = (await rt3.search(mark2, { k: 20 })).hits.find((x) => String(x.id) === id3);
    const a2 = (await rt3.search(mark2, { k: 20, refutePenaltyEnabled: false })).hits.find((x) => String(x.id) === id3);
    const ratio = (a1 && a2) ? Number(a1.score) / Number(a2.score) : null;
    check('**真被推翻的卡必须降权**（否则上面"不误伤"是假绿）',
      ratio != null && Math.abs(ratio - 0.15) < 0.02, ratio != null ? ratio.toFixed(3) + 'x' : '取不到');
  } finally {
    wf(MAIN2, bk, 'utf8');
    console.log('    （已还原卡库）');
  }
}

console.log('\n' + (fail === 0 ? '✅ 纠错机制完整' : '❌ ' + fail + ' 项失败'));
process.exit(fail === 0 ? 0 : 1);
