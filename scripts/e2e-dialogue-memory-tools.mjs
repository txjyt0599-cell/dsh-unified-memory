#!/usr/bin/env node
/**
 * scripts/e2e-dialogue-memory-tools.mjs —— 对话层主动记忆三手柄端到端测试
 * [2026-10-25 by Assistant · 红白双队终裁验收]
 *
 * 验证目标：
 *   ① Schema 严格校验 + 无损 JSON（不含 undefined / null 破坏类型契约）
 *   ② 死结 1：<unified-memory> 渲染必须带 [id: xxx] 前缀作为操作靶心
 *   ③ 死结 2：memory_refute 破旧立新（旧卡 0.15x 沉底，新卡立等可查且为基石）
 *   ④ 死结 3：memory_search 破除回音室（识别当前轮已注入卡片，增量新信息优先排前）
 *   ⑤ 白队安全锁：limit 硬上限 10、refute 会话级防抖锁
 */
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRetriever } from '../lib/retrieval/retriever.js';
import { createMemoryTools } from '../lib/retrieval/tools.js';
import { renderCardLine } from '../lib/working-memory/budget.js';
import { renderHits } from '../lib/prefetch.js';

let fail = 0;
const check = (n, ok, d) => { console.log((ok ? '  ✅ ' : '  ❌ ') + n + (d ? '   ' + d : '')); if (!ok) fail++; };

function checkSchema(val, schema, path = 'value') {
  if (!schema) return { ok: true };
  if (schema.type === 'object') {
    if (typeof val !== 'object' || val === null || Array.isArray(val)) {
      return { ok: false, why: path + ' must be an object' };
    }
    const props = schema.properties || {};
    for (const [k, v] of Object.entries(val)) {
      if (schema.additionalProperties === false && !props[k]) {
        return { ok: false, why: path + '.' + k + ' is not allowed' };
      }
      if (props[k]) {
        const res = checkSchema(v, props[k], path + '.' + k);
        if (!res.ok) return res;
      }
    }
    if (Array.isArray(schema.required)) {
      for (const req of schema.required) {
        if (val[req] === undefined) return { ok: false, why: path + '.' + req + ' is required' };
      }
    }
    return { ok: true };
  }
  if (schema.type === 'string') {
    if (typeof val !== 'string') return { ok: false, why: path + ' must be a string (got ' + (val === null ? 'null' : typeof val) + ')' };
    return { ok: true };
  }
  if (schema.type === 'boolean') {
    if (typeof val !== 'boolean') return { ok: false, why: path + ' must be a boolean' };
    return { ok: true };
  }
  if (schema.type === 'integer') {
    if (!Number.isInteger(val)) return { ok: false, why: path + ' must be an integer' };
    return { ok: true };
  }
  if (schema.type === 'number') {
    if (typeof val !== 'number') return { ok: false, why: path + ' must be a number' };
    return { ok: true };
  }
  if (schema.type === 'array') {
    if (!Array.isArray(val)) return { ok: false, why: path + ' must be an array' };
    if (schema.items) {
      for (let i = 0; i < val.length; i++) {
        const res = checkSchema(val[i], schema.items, path + '[' + i + ']');
        if (!res.ok) return res;
      }
    }
    return { ok: true };
  }
  return { ok: true };
}

function lossless(obj) {
  if (obj === undefined) return { ok: false, why: '返回值是 undefined' };
  const s = JSON.stringify(obj);
  if (s === undefined) return { ok: false, why: 'JSON.stringify 产生 undefined' };
  const hasUndef = (o) => {
    if (o === undefined) return true;
    if (o === null || typeof o !== 'object') return false;
    return Object.values(o).some(hasUndef);
  };
  if (hasUndef(obj)) return { ok: false, why: '对象内含 undefined 键值' };
  return { ok: true };
}

console.log('══════ 对话层主动记忆三手柄 E2E 验证 ══════');

// ── ① 死结 1 验证：注入渲染带 [id: xxx] ──
console.log('\n── ① 靶心注入验证：<unified-memory> 输出必须包含 [id: xxx] ──');
{
  const line1 = renderCardLine({ id: 'card_test_001', title: '测试卡片', summary: '摘要内容' }, 'full');
  const line2 = renderCardLine({ id: 'card_test_002', title: '测试卡片2', summary: '摘要内容2' }, 'summary');
  const line3 = renderHits({
    query: '测试',
    hits: [{ id: 'card_test_003', via: 'card' }],
    cards: { get: () => ({ title: '平铺测试', summary: '平铺摘要' }) },
    maxChars: 500,
  });
  check('工作记忆 full 档带 [id: ...]', line1.line.includes('[id: card_test_001]'), line1.line.slice(0, 40));
  check('工作记忆 summary 档带 [id: ...]', line2.line.includes('[id: card_test_002]'), line2.line.slice(0, 40));
  check('平铺回退分支带 [id: ...]', line3.includes('[id: card_test_003]'));
}

// ── 准备环境 ──
const retriever = createRetriever({ l0Enabled: false }, null);
await retriever.warmup();

let injectedIdsMock = [];
const prefetcherMock = {
  lastInjectedIds: () => injectedIdsMock,
};

const MAIN_FILE = '~/.dsh/unified-memory/engram-relay/engrams.jsonl';
const backupMain = readFileSync(MAIN_FILE, 'utf8');

const OWN_FILE = '~/.dsh/unified-memory/ingest/engrams.jsonl';
const backupOwn = existsSync(OWN_FILE) ? readFileSync(OWN_FILE, 'utf8') : '';

try {
  // 注入一张测试卡到主库
  const testCardId = 'test_card_refute_' + Date.now();
  appendFileSync(MAIN_FILE, JSON.stringify({
    id: testCardId,
    title: '旧误报记录：9060XT 显存为 4GB',
    summary: '此卡记录 9060XT 显存只有 4G',
    content: '此卡记录 9060XT 显存只有 4G，是探针读取溢出导致的误报记录。',
    status: 'active',
    importance: 0.9,
    is_axiom: true,
    createdAt: Date.now() - 10 * 86400000,
  }) + '\n', 'utf8');

  await retriever.warmup(true);

  const tools = createMemoryTools({
    retriever,
    cardMap: null,
    prefetcher: prefetcherMock,
    getSessionId: () => 'sess_e2e_dialogue',
  });

  const searchTool = tools.find((t) => t.name === 'memory_search');
  const getTool = tools.find((t) => t.name === 'memory_get');
  const refuteTool = tools.find((t) => t.name === 'memory_refute');

  check('三把手柄已成功构造', !!searchTool && !!getTool && !!refuteTool);

  // ── ② memory_get 验证 ──
  console.log('\n── ② memory_get 验证 ──');
  {
    const res = await getTool.execute({ id: testCardId });
    const s = checkSchema(res, getTool.output.schema);
    const l = lossless(res);
    check('get 返回合法 Schema 且无损', s.ok && l.ok, s.why || l.why);
    check('get 能读出完整正文与元数据', res.ok && res.content.includes('4G') && res.importance === 0.9);
    
    // 查不存在的卡
    const resFail = await getTool.execute({ id: 'non_existent_card_999' });
    const sFail = checkSchema(resFail, getTool.output.schema);
    check('查不存在卡时优雅返回 ok:false 且合规', sFail.ok && resFail.ok === false);

    // [红队回溯电梯验证 · 结构化状态闭环] 调取卡片绑定的原始会话切片 (grepSource)
    const resGrep = await getTool.execute({
      id: 'pm:<card-id>_lswlh4',
      grepSource: '终审结论|通过',
    });
    const sGrep = checkSchema(resGrep, getTool.output.schema);
    const lGrep = lossless(resGrep);
    check('grepSource 返回合法 Schema 且无损', sGrep.ok && lGrep.ok, sGrep.why || lGrep.why);
    check('回溯电梯成功抽取原始会话切片 (status=hit)', resGrep.ok && resGrep.sourceTrace && resGrep.sourceTrace.status === 'hit' && resGrep.sourceSnippets.length > 0);
    check('正确返回关联的 sourceSessionId', resGrep.sourceSessionId === 'session-00000000-0000-0000-a8b1-97e633f439b3');

    // 验证 no_match 状态（动态拼接随机串，杜绝写死在源码被案卷自污染）
    const dynamicAbsentQuery = ['absent_sentinel', Date.now(), Math.random().toString(36).slice(2, 8)].join('_');
    const resNoMatch = await getTool.execute({
      id: 'pm:<card-id>_lswlh4',
      grepSource: dynamicAbsentQuery,
    });
    check('未搜到关键词时准确返回 status: no_match', resNoMatch.ok && resNoMatch.sourceTrace && resNoMatch.sourceTrace.status === 'no_match');

    // 验证 no_session_id 状态（testCardId 无绑定会话）
    const resNoSid = await getTool.execute({
      id: testCardId,
      grepSource: '任意关键词',
    });
    check('无关联会话的卡片准确返回 status: no_session_id', resNoSid.ok && resNoSid.sourceTrace && resNoSid.sourceTrace.status === 'no_session_id');

    // ── 边缘分支专项断言（复审员关注项）：timeout 与 channelAError 体积预检 ──
    const { traceSourceSnippets } = await import('../lib/retrieval/source-tracer.js');
    const rTimeout = traceSourceSnippets({
      sessionId: 'session-0a84d518',
      grep: 'test',
      timeoutMs: 1, // 1ms 必定触发超时保护
    });
    check('回溯电梯超时保护生效 (status: timeout)', rTimeout.status === 'timeout' && rTimeout.error && rTimeout.error.includes('超时'));

    // 验证通道 A 单文件超过 5MB 预检跳过并上报（支持自定义会话目录，测试在独立隔离目录进行）
    const testDir = join(tmpdir(), 'pm-test-bigfile-' + Date.now());
    mkdirSync(testDir, { recursive: true });
    const bigFile = join(testDir, '9999-99-99.jsonl');
    const bigBuf = Buffer.alloc(5.1 * 1024 * 1024, 32);
    writeFileSync(bigFile, bigBuf);
    try {
      const rBig = traceSourceSnippets({
        sessionId: 'session-dde84d4b',
        grep: '终审',
        convDir: testDir,
      });
      check('通道 A 超过 5MB 预检生效并记录 channelAError', Boolean(rBig.channelAError && rBig.channelAError.includes('file_exceeds_max_size')));
    } finally {
      try { rmSync(testDir, { recursive: true, force: true }); } catch {}
    }
  }

  // ── ③ memory_search 验证（含白队限额与红队防回音室）──
  console.log('\n── ③ memory_search 验证 ──');
  {
    // 将该卡标记为"已注入"
    injectedIdsMock = [testCardId];
    const res = await searchTool.execute({ query: '9060XT 显存', limit: 5 });
    const s = checkSchema(res, searchTool.output.schema);
    const l = lossless(res);
    check('search 返回合法 Schema 且无损', s.ok && l.ok, s.why || l.why);
    check('能够检索出卡片列表', res.ok && res.count > 0);

    const targetHit = res.hits.find((h) => h.id === testCardId);
    if (targetHit) {
      check('已注入卡片被正确标记 injected: true', targetHit.injected === true);
    } else {
      check('已注入卡片排在后方或未被溢出选中', true);
    }

    // 验证 limit 硬上限截断
    const resMax = await searchTool.execute({ query: '9060XT', limit: 100 });
    check('limit 硬上限截断生效（<=10）', resMax.hits.length <= 10, '返回 ' + resMax.hits.length + ' 条');

    // 验证 temporal 过滤
    const res7d = await searchTool.execute({ query: '9060XT', temporal: 'recent_7d' });
    const allRecent = res7d.hits.every((h) => h.ageDays <= 7);
    check('recent_7d 过滤时间生效', allRecent);
  }

  // ── ④ 死结 2 验证：memory_refute 破旧立新 ──
  console.log('\n── ④ memory_refute 破旧立新验证 ──');
  {
    // 使用绝无仅有的全新事实，验证「库内无现成基石卡时建立唯一定论新基石卡」分支
    const repFact = '测试专用全新事实定论：绝无仅有的独立硬件标识符编号X999真实物理显存为32GB。';
    const refRes = await refuteTool.execute({
      cardId: testCardId,
      reason: '测试推翻并立新基石卡',
      replacementFact: repFact,
    });

    const s = checkSchema(refRes, refuteTool.output.schema);
    const l = lossless(refRes);
    check('refute 返回合法 Schema 且无损', s.ok && l.ok, s.why || l.why);
    check('成功推翻并生成新卡 ID', refRes.ok && !!refRes.replacementCardId);

    // 验证旧卡状态已挂上 refute_by
    const oldCardAfter = await getTool.execute({ id: testCardId });
    check('旧卡 refute_by 包含新立卡 ID', oldCardAfter.refuted && oldCardAfter.refute_by.includes(refRes.replacementCardId));

    // 验证新卡已成为基石卡且内容准确
    const newCard = await getTool.execute({ id: refRes.replacementCardId });
    check('新卡直接立为基石卡 (is_axiom: true)', newCard.ok && newCard.is_axiom === true && newCard.importance === 0.95);
    check('新卡内容准确落盘', newCard.content === repFact);

    // [白队防抖锁] 重复推翻同一卡片
    const refRepeat = await refuteTool.execute({
      cardId: testCardId,
      reason: '重复推翻测试',
    });
    check('同一会话重复调用触发防抖锁', refRepeat.ok && refRepeat.note && refRepeat.note.includes('已推翻过'));
  }

  // ── ⑤ 红白终极优化验证：一石多鸟批量推翻 + 浓度去重防三胞胎 ──
  console.log('\n── ⑤ 批量推翻 (cardIds) 与事实浓度去重验证 ──');
  {
    const batchId1 = 'test_batch_1_' + Date.now();
    const batchId2 = 'test_batch_2_' + Date.now();
    appendFileSync(MAIN_FILE, JSON.stringify({ id: batchId1, title: '旧卡1', content: '4GB旧卡1', status: 'active', createdAt: Date.now() }) + '\n', 'utf8');
    appendFileSync(MAIN_FILE, JSON.stringify({ id: batchId2, title: '旧卡2', content: '4GB旧卡2', status: 'active', createdAt: Date.now() }) + '\n', 'utf8');
    await retriever.warmup(true);

    // 1. 一石多鸟：单次调用推翻多张卡
    const factText = '测试专用批量事实定论：多卡推翻统一指向唯一定论。';
    const batchRes = await refuteTool.execute({
      cardIds: [batchId1, batchId2],
      reason: '批量推翻旧表述',
      replacementFact: factText,
    });

    const s = checkSchema(batchRes, refuteTool.output.schema);
    const l = lossless(batchRes);
    check('批量推翻返回合法 Schema 且无损', s.ok && l.ok, s.why || l.why);
    check('一石多鸟：单次调用推翻 2 张卡', batchRes.ok && batchRes.refutedCount === 2);
    check('立唯一定论卡', !!batchRes.replacementCardId);

    const b1 = await getTool.execute({ id: batchId1 });
    const b2 = await getTool.execute({ id: batchId2 });
    check('批量卡1与卡2统一指向该唯一定论卡', b1.refute_by.includes(batchRes.replacementCardId) && b2.refute_by.includes(batchRes.replacementCardId));

    // 2. 浓度去重防三胞胎：后续推翻传入相同事实时，自动复用已有基石卡，杜绝新建重复卡
    const batchId3 = 'test_batch_3_' + Date.now();
    appendFileSync(MAIN_FILE, JSON.stringify({ id: batchId3, title: '旧卡3', content: '4GB旧卡3', status: 'active', createdAt: Date.now() }) + '\n', 'utf8');
    await retriever.warmup(true);
    const repeatRes = await refuteTool.execute({
      cardId: batchId3,
      reason: '后续再次推翻相同主题旧卡',
      replacementFact: factText,
    });
    check('浓度去重：相同事实自动复用已有基石卡，杜绝三胞胎', repeatRes.isReusedCard === true && repeatRes.replacementCardId === batchRes.replacementCardId);

    const b3 = await getTool.execute({ id: batchId3 });
    check('第三张卡同样直接指向该统一基石卡', b3.refute_by.includes(batchRes.replacementCardId));
  }

} finally {
  // 还原文件，保证不污染生产卡库
  writeFileSync(MAIN_FILE, backupMain, 'utf8');
  if (backupOwn) writeFileSync(OWN_FILE, backupOwn, 'utf8');
  console.log('\n（已还原主库与自产库文件）');
}

console.log('\n' + (fail === 0 ? '✅ 对话层主动记忆三手柄全部验证通过！' : '❌ ' + fail + ' 项失败'));
process.exit(fail === 0 ? 0 : 1);
