#!/usr/bin/env node
/**
 * scripts/eval-challenge-graph.mjs —— 期8.4 挑战集：BM25 必漏、只有实体关联能救
 * [2026-10-23 by Assistant · 白队裁决二]
 *
 * 白队的重做标准：
 *   ① 词汇鸿沟：查询用的词，在目标卡里**绝对不能出现**
 *   ② 跨会话实体桥接：查询指向 A，但答案在 B，A/B 共享实体 ⇒ 图一跳才能连
 *
 * 判据设计（关键）：
 *   · 每题先验证「查询词 ∩ 目标卡文本 = ∅」（词汇鸿沟成立）
 *   · 再看 baseline 能否召回目标卡（预期：不能）
 *   · 再看补候选能否召回（预期：能，且 via 含 1hop）
 */
import { createRetriever } from '../lib/retrieval/retriever.js';
import { readFileSync, existsSync } from 'node:fs';

const ROOT = '~/.dsh/unified-memory/ingest';

function loadCards() {
  // [2026-10-23] 原来只读 engrams.jsonl —— 但目标卡多半在 records 里（L1 事实卡）。
  //   改成同时读两处，按 id 去重取最新。
  const byId = new Map();
  const dirs = [
    ROOT + '/engrams.jsonl',
    ROOT + '/records/2026-10-22.jsonl',
    ROOT + '/records/2026-10-23.jsonl',
  ];
  for (const f of dirs) {
    if (!existsSync(f)) continue;
    for (const l of readFileSync(f, 'utf8').split('\n').filter(Boolean)) {
      try {
        const o = JSON.parse(l);
        const k = (o.id || o.engram_id || o.fact_id || '') + '|' + String(o.title || o.scene_name || '').slice(0, 20);
        if (k !== '|') byId.set(k, o);
      } catch {}
    }
  }
  return Array.from(byId.values());
}

// ── 10 道挑战题 ──
// 设计原则：query 用「口语化转述」，target 用「卡片原词」，两者**词面零交集**，
// 但通过共享实体（entities）可一跳桥接。
const CHALLENGES = [
  // ── 白队裁决二标准的正解 ──
  //   ① 词汇鸿沟：seedKw 出现在查询里，target 卡的标题**与 seed 卡零 bigram 重叠**
  //   ② 实体桥接：两卡只靠 bridge（实测度=2 的稀有实体）相连
  //   查询 = 只提 seed 侧的事，答案在 target 侧。
  { q: 'readOwnRecords 那边后来认识到要改什么', seedKw: 'AI 认识到需要在 readOwnRecor', target: 'scene_name处理错误', bridge: 'readownrecords' },
  { q: 'expandOneHop 修好之后实体数量是多少', seedKw: 'AI成功修复图结构', target: '图检索失败根因：卡对象丢失entities', bridge: 'expandonehop' },
  { q: 'consolidate.js 在 lib 目录里是什么状态', seedKw: 'consolidate.js 在 lib/', target: 'sameTopic匹配条件', bridge: 'consolidate.js' },
  { q: 'pnpm install 那次失败到底怎么回事', seedKw: 'pnpm install失败事件', target: 'dsh-whale-widget版本不匹配', bridge: 'install' },
  { q: 'package.json 那个插件目录整理', seedKw: 'dsh-whale-widget 插件目录整', target: 'sharp模块加载失败原因', bridge: 'package.json' },
  { q: '在probeQuotaSummary里埋的那个调试', seedKw: '在probeQuotaSummary中埋了调', target: '汇总量接口缺失Gemini组时', bridge: 'discovered' },
  { q: '测试样本如D6的固定JSON那条', seedKw: '测试样本如D6', target: '生产卡未产出entities字段', bridge: '写入侧' },
  { q: '总验收与攒批机制的那个耦合缺陷', seedKw: '总验收与攒批机制的耦合缺陷', target: 'dualpool 自测脚本路径错位是既有', bridge: 'restart-batch.mjs' },
  { q: '图扩散模块当时为什么选择补候选', seedKw: '图扩散模块采用补候选', target: '生产卡未产出entities字段', bridge: 'design' },
  { q: '代码调试与问题解决那条记录', seedKw: '代码调试与问题解决', target: '当LLM全部返回429时', bridge: '游标' },
];

function tokenize(s) {
  const t = String(s || '').toLowerCase();
  const set = new Set();
  for (let i = 0; i < t.length - 1; i++) {
    const bg = t.slice(i, i + 2);
    if (/[\u4e00-\u9fff]{2}/.test(bg)) set.add(bg);
  }
  for (const w of t.match(/[a-z][a-z0-9_+.-]{2,}/gi) || []) set.add(w);
  return set;
}

async function run(mode, cards) {
  const cfg = { enabled: true, l0Enabled: false };
  if (mode === 'graph') cfg.graphExpandEnabled = true;
  const ret = createRetriever(cfg);
  await ret.warmup();

  const rows = [];
  for (const c of CHALLENGES) {
    const target = cards.find((x) => String(x.title || '').includes(c.target));
    if (!target) { rows.push({ ...c, note: '目标卡不存在', aRank: -1, bRank: -1 }); continue; }

    // ① 词汇鸿沟校验：query 的 bigram 有多少出现在目标卡文本里
    const qt = tokenize(c.q);
    const targetText = String(target.title || '') + ' ' + String(target.summary || '') + ' ' + String(target.content || '');
    const tt = tokenize(targetText);
    let overlap = 0;
    for (const t of qt) if (tt.has(t)) overlap++;

    const find = (hits) => {
      for (let i = 0; i < hits.length; i++) {
        if (String(hits[i].title || '').includes(c.target)) return i + 1;
      }
      return -1;
    };

    const ra = await ret.search.call(Object.assign(Object.create(Object.getPrototypeOf(ret)), ret), c.q, {});
    // 上面的写法太绕，直接用两次独立 retriever 更稳
    rows.push({ ...c, overlap, targetFound: true, _t: target.title });
  }
  return rows;
}

const cards = loadCards();
if (!cards.length) { console.log('❌ 无数据'); process.exitCode = 1; }

// 两个独立 retriever，各自跑一遍
const mk = (graphOn) => {
  const cfg = { enabled: true, l0Enabled: false };
  if (graphOn) cfg.graphExpandEnabled = true;
  return createRetriever(cfg);
};

const ra = mk(false); await ra.warmup();
const rb = mk(true);  await rb.warmup();

console.log('| # | 查询 | 桥接实体 | 种子rank | A·baseline 目标 | B·补候选 目标 | B的via |');
console.log('|---|---|---|---|---|---|---|');
let aHit = 0, bHit = 0, valid = 0, gapOk = 0;
for (let i = 0; i < CHALLENGES.length; i++) {
  const c = CHALLENGES[i];
  const target = cards.find((x) => String(x.title || '').includes(c.target));
  if (!target) { console.log('| ' + (i+1) + ' | ' + c.q + ' | ' + c.target + ' | - | 目标不存在 | - | - |'); continue; }

  const qt = tokenize(c.q);
  const ttext = String(target.title||'') + ' ' + String(target.summary||'') + ' ' + String(target.content||'');
  const tt = tokenize(ttext);
  let overlap = 0, ovWords = [];
  for (const t of qt) if (tt.has(t)) { overlap++; if (ovWords.length < 3) ovWords.push(t); }

  const find = (hits) => {
    for (let k = 0; k < hits.length; k++) if (String(hits[k].title||'').includes(c.target)) return { rank: k+1, via: hits[k].via, graph: Number((hits[k].scoreParts||{}).graph||0) };
    return { rank: -1, via: '', graph: 0 };
  };
  const findSeed = (hits) => {
    for (let k = 0; k < hits.length; k++) if (String(hits[k].title||'').includes(c.seedKw)) return k+1;
    return -1;
  };

  const rA = await ra.search(c.q, {});
  const rB = await rb.search(c.q, {});
  const fA = find(rA.hits || []);
  const fB = find(rB.hits || []);

  valid++;
  if (overlap === 0) gapOk++;
  if (fA.rank > 0) aHit++;
  if (fB.rank > 0) bHit++;

  const seedRank = findSeed(rA.hits || []);
  console.log('| ' + (i+1) + ' | ' + c.q.slice(0, 20) + ' | ' + c.bridge + ' | ' + (seedRank > 0 ? '#' + seedRank : '−') + ' | '
    + (fA.rank > 0 ? '#' + fA.rank : '未召回') + ' | '
    + (fB.rank > 0 ? '#' + fB.rank : '未召回') + ' | '
    + (fB.rank > 0 ? fB.via + ' g=' + fB.graph.toFixed(3) : '-') + ' |');
}

console.log('');
console.log('词汇鸿沟成立（重叠=0）: ' + gapOk + '/' + valid);
console.log('A·baseline 召回: ' + aHit + '/' + valid);
console.log('B·补候选   召回: ' + bHit + '/' + valid);
console.log('');
if (bHit > aHit) console.log('✅ 图**创造性地**多救回 ' + (bHit - aHit) + ' 条 —— 这就是超图的价值。');
else if (bHit === aHit && aHit < valid) console.log('⚠️ 图没能多救回 —— 说明实体桥接还不够强，或目标卡实体重叠不足。');
else console.log('（两路都能召回，题目不够难，需再收紧）');
process.exitCode = 0;
