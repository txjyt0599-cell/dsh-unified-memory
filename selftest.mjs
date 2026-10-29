#!/usr/bin/env node
/**
 * 期1 验收自测（六组）。**独立进程运行，不依赖 DSH 加载**。
 * 用法: node selftest.mjs
 * 退出码: 0 全绿 / 1 有 FAIL
 */
import { compact } from './lib/observe/rotate.js';
import { createLogger } from './lib/observe/log.js';
import { createJournalBackend } from './lib/backends/journal.js';
import { createEngramBackend } from './lib/backends/engram.js';
import { createScorer } from './lib/scorer/baseline.js';
import { createOrchestrator, DEGRADE_LEVELS, FIXED_TEXT } from './lib/orchestrator.js';
import { createSectionRenderer } from './lib/section.js';
import { readFileSync, existsSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const results = [];
const ok = (g, n, pass, detail = '') => results.push({ g, n, pass, detail });
const TMP = '~/_team-v2/p1/_selftest-logs';

// ---------- A 组：日志轮转纯函数 ----------
{
  const small = 'abc';
  ok('A', 'A1 未超限原样返回', compact(small, 100, 25) === small);

  const big = 'x'.repeat(1000);
  const out = compact(big, 200, 50);
  ok('A', 'A2 超限被裁剪', Buffer.byteLength(out, 'utf8') <= 200, '实际 ' + Buffer.byteLength(out, 'utf8') + 'B');
  ok('A', 'A3 裁剪后带省略标记', out.startsWith('…') || out.includes('轮转'));

  const cjk = ''.repeat(300);
  const out2 = compact(cjk, 300, 80);
  ok('A', 'A4 中文不被切碎（无替换字符）', !out2.includes('\uFFFD') && Buffer.byteLength(out2,'utf8') <= 300);
}

// ---------- B 组：日志器（采样/上限/原子） ----------
{
  if (existsSync(TMP)) rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
  const lg = createLogger({ dir: TMP, maxBytes: 2048, keepRotations: 1, missSampleRate: 1 });
  for (let i = 0; i < 60; i++) lg.wake({ level: 'test', n: i, pad: 'y'.repeat(50) });
  const wakePath = join(TMP, 'wake.log');
  ok('B', 'B1 wake.log 已生成', existsSync(wakePath));
  const size = existsSync(wakePath) ? readFileSync(wakePath).length : 0;
  ok('B', 'B2 轮转后不超上限', size <= 2048 * 1.1, '实际 ' + size + 'B');

  for (let i = 0; i < 5; i++) lg.miss({ q: 'q' + i });
  ok('B', 'B3 miss.log 采样为 1 时不丢', existsSync(join(TMP, 'miss.log')));

  const bad = createLogger({ dir: 'Z:/不存在的盘/xx', maxBytes: 100 });
  let threw = false;
  try { bad.wake({ a: 1 }); } catch { threw = true; }
  ok('B', 'B4 写不进去也不抛（永不阻断）', !threw);
}

// ---------- C 组：只读后端 ----------
{
  const j = createJournalBackend();
  const h = j.health();
  ok('C', 'C1 日记后端能定位文件', h.ok === true, JSON.stringify(h).slice(0, 120));
  ok('C', 'C2 日记 readRaw 能读到内容', j.readRaw({ maxChars: 100 }).ok === true);
  let recallThrew = false;
  try { j.recall('x'); } catch { recallThrew = true; }
  ok('C', 'C3 日记拒绝检索（设计如此）', recallThrew);

  const e = createEngramBackend();
  const eh = e.health();
  ok('C', 'C4 engram 健康检查通过', eh.ok === true, 'lines=' + eh.lines);
  let eThrew = false;
  try { e.recall('x'); } catch { eThrew = true; }
  ok('C', 'C5 engram recall 期1 未实现（会触发降级）', eThrew);
}

// ---------- D 组：打分器 ----------
{
  const s = createScorer();
  const cands = [
    { id: 'a', title: '记忆系统改动年表', summary: '记忆 注入 freeze', importance: 0.9, createdAt: Date.now() },
    { id: 'b', title: '无关的卡', summary: 'vrm 显存', importance: 0.3, createdAt: Date.now() - 90 * 86400000 },
  ];
  const m = s.score('记忆系统 注入', cands);
  ok('D', 'D1 返回 Map 且覆盖全部候选', m instanceof Map && m.size === 2);
  ok('D', 'D2 相关卡得分高于无关卡', m.get('a') > m.get('b'), 'a=' + m.get('a').toFixed(3) + ' b=' + m.get('b').toFixed(3));
  ok('D', 'D3 分数落在 [0,1]', [...m.values()].every(v => v >= 0 && v <= 1));
  ok('D', 'D4 空查询不死', s.score('', cands) instanceof Map);
}

// ---------- E 组：降级链 ----------
{
  const logger = createLogger({ dir: TMP, missSampleRate: 1 });
  const engram = createEngramBackend();
  const journal = createJournalBackend();
  const o = createOrchestrator({ backends: [engram, journal], logger });
  const avail = o.levelAvailability();
  ok('E', 'E1 四级降级表齐全', DEGRADE_LEVELS.join(',') === 'hypergraph,engram,grep,fixed');
  ok('E', 'E2 engram 不可用（期1 预期）', avail.engram === false);
  const r = await o.recall('测试查询');
  ok('E', 'E3 自动降到 fixed 而不是抛错', r.level === 'fixed', 'level=' + r.level);
  ok('E', 'E4 fixed 带固定文案', r.text === FIXED_TEXT);
  const r2 = await o.recall('x'.repeat(5000));
  ok('E', 'E5 超长查询不死', !!r2 && typeof r2.level === 'string');
}

// ---------- F 组：section 渲染（唯一接缝） ----------
{
  const logger = createLogger({ dir: TMP, missSampleRate: 1 });
  const o = createOrchestrator({ backends: [createEngramBackend(), createJournalBackend()], logger });
  const render = createSectionRenderer({ orchestrator: o, config: { injectMaxChars: 8000, freezePerSession: true }, logger });
  const a1 = render({ agent: { session: { id: 's1' } } });
  ok('F', 'F1 渲染出非空段', typeof a1 === 'string' && a1.length > 0);
  ok('F', 'F2 带 <unified-memory> 标记', a1.includes('<unified-memory>'));
  const a2 = render({ agent: { session: { id: 's1' } } });
  ok('F', 'F3 同会话冻结（逐字节一致，护前缀缓存）', a1 === a2);
  const b1 = render({ agent: { session: { id: 's2' } } });
  ok('F', 'F4 不同会话可独立渲染', typeof b1 === 'string' && b1.length > 0);
  ok('F', 'F5 不含日记内容（日记不注入）', !a1.includes('Assistant的日记'));
  const boom = createSectionRenderer({ orchestrator: { levelAvailability() { throw new Error('boom'); } }, config: {}, logger });
  let threw = false; let out = '';
  try { out = boom({ agent: { session: { id: 's3' } } }); } catch { threw = true; }
  // [2026-10-22 by Assistant] section 已改为**固定文本**（动态记忆走消息尾），
  //   不再调用 orchestrator ⇒ 「抛错返回空串」这个旧判据失效。
  //   新判据：不管 orchestrator 怎么坏，section 都必须稳定返回非空固定串，绝不崩轮。
  ok('F', 'F6 orchestrator 抛错也不崩（section 固定，不依赖检索）', !threw && typeof out === 'string' && out.length > 0 && out.includes('<unified-memory>'));
}

// ---------- 汇总 ----------
const pass = results.filter(r => r.pass).length;
const fail = results.length - pass;
console.log('');
for (const g of ['A','B','C','D','E','F']) {
  const rows = results.filter(r => r.g === g);
  const p = rows.filter(r => r.pass).length;
  console.log(`[${g}] ${p}/${rows.length}`);
  for (const r of rows) if (!r.pass) console.log('   ✗ ' + r.n + '  ' + (r.detail || ''));
}
console.log('');
console.log(`合计 ${pass}/${results.length} 通过，${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
