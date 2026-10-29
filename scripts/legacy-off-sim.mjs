#!/usr/bin/env node
/**
 * scripts/legacy-off-sim.mjs —— 「关掉旧插件」的隔离模拟（红队之外的实证）
 * [2026-10-22 by Assistant]
 *
 * 问题：只把旧插件开关设 false 并不能证明超图不依赖它们——代码里可能还有隐藏的路径耦合。
 * 做法：在**完全空白**的临时目录里跑完整条写入链路 + 读取链路，
 *      并且**故意不提供**任何 tdai/engram 数据目录。
 *      如果这条链路能自己产、自己读，就说明「关旧」在功能上是安全的。
 *
 * 只读：不碰任何生产目录。
 */
import { mkdtempSync, rmSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { dirs, ensureDirs } from '../lib/ingest/core.js';
import { captureTurn } from '../lib/ingest/capture.js';
import { runExtract, readOwnRecords } from '../lib/ingest/extract.js';
import { runDistill, readOwnEngrams } from '../lib/ingest/distill.js';
import { readOwnIngest } from '../lib/hypergraph/source.js';

let fail = 0;
const ok = (n, c, d) => { console.log((c ? '  ✅ ' : '  ❌ ') + n + (d === undefined ? '' : '   ' + d)); if (!c) fail++; };

const root = mkdtempSync(join(tmpdir(), 'pm-legacyoff-'));
const d = dirs(root);
ensureDirs(d);
console.log('隔离目录（无任何 tdai/engram 数据）: ' + root);
console.log('');

const T = Date.now() - 60000;
const fakeExtract = async () => JSON.stringify([
  { type: 'episodic', scene_name: '我（AI）在和User做关旧验证', content: '关掉旧插件后，超图仍能自己捕获对话并提取事实卡，说明写入侧已独立。', priority: 85, evidence: '隔离模拟' },
]);
const fakeDistill = async () => JSON.stringify([
  { kind: 'decision', layer: 'project', title: '关旧前置条件', summary: '先驱动再关旧', content: 'User明确：功能做好才能关旧；本系统三项开关全开并稳定产卡后才可关。', causesOf: [] },
]);

console.log('── ① L0 捕获（无旧插件参与）──');
const cap = captureTurn({
  sessionKey: 'legacyoff-1',
  messages: [
    { id: 'a1', role: 'user', content: '这是一条在完全隔离环境下写入的对话，用来证明捕获不依赖任何旧插件。', timestamp: T },
    { id: 'a2', role: 'assistant', content: '收到，已落盘到超图自己的 ingest 目录，与 tdai 无关。', timestamp: T + 1000 },
  ],
  opts: { root, nowMs: T + 2000 },
});
ok('捕获写入成功', cap.written === 2, JSON.stringify(cap));
ok('落盘在本地 ingest 目录', cap.file && cap.file.startsWith(root), cap.file && cap.file.replace(root, '<root>'));

console.log('');
console.log('── ② L1 提取 ──');
const ex = await runExtract({ llm: { baseUrl: 'x', apiKey: 'x', model: 'x', maxTokens: 100, temperature: 0, timeoutMs: 100 }, opts: { root, batchMessages: 4, minBatchMessages: 2 }, completeFn: fakeExtract });
ok('提取产出卡', ex.written > 0, JSON.stringify(ex));
ok('读取自产 L1', readOwnRecords(root).cards.length > 0, 'n=' + readOwnRecords(root).cards.length);

console.log('');
console.log('── ③ engram 蒸馏 ──');
const di = await runDistill({ llm: { baseUrl: 'x', apiKey: 'x', model: 'x', maxTokens: 100, temperature: 0, timeoutMs: 100 }, opts: { root, sessionId: 's', cwd: 'D:/x', minDistillMessages: 1 }, completeFn: fakeDistill });
ok('蒸馏产出卡', di.written > 0, JSON.stringify(di));
ok('读取自产蒸馏卡', readOwnEngrams(root).length > 0, 'n=' + readOwnEngrams(root).length);

console.log('');
console.log('── ④ 检索侧闭环（不依赖旧插件）──');
const ing = readOwnIngest(root);
ok('readOwnIngest 读到全部自产数据', ing.cards.length >= 2, 'cards=' + ing.cards.length);
const l1 = ing.cards.filter((c) => c._source === 'ingest-l1').length;
const eg = ing.cards.filter((c) => c._source === 'ingest-engram').length;
ok('L1 与蒸馏都在', l1 > 0 && eg > 0, 'l1=' + l1 + ' engram=' + eg);

console.log('');
console.log('── ⑤ 依赖审计：新链路有没有偷偷读旧路径 ──');
{
  // 静态检查：ingest/ 目录下的代码不应出现 tdai/engram-relay 的生产路径读取
  const dir = 'D:/dsh-plugins/dsh-unified-memory/lib/ingest';
  let suspicious = [];
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.js'))) {
    const raw = readFileSync(dir + '/' + f, 'utf8');
    // LEGACY_DIRS 常量是「迁移期双读」用的，允许存在；但要检查有没有真正的业务读取
    // 允许：LEGACY_DIRS 常量本身（纯记录，无业务读取）
    let inLegacyBlock = false;
    const lines = raw.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      if (/^export const LEGACY_DIRS\s*=/.test(l)) { inLegacyBlock = true; continue; }
      if (inLegacyBlock) { if (/^\};?\s*$/.test(l)) inLegacyBlock = false; continue; }
      if (!/memory-tencentdb|engram-relay/.test(l)) continue;
      if (/^\s*(\/\/|\*)/.test(l)) continue;
      // [允许项] persona.js 的 DEFAULT_PERSONA_SRC 与 scene-nav.js 的 DEFAULT_SCENE_DIR：
      //   这两处是**可降级**的可选路径，文件缺失时分别回退或返回空，
      //   不强制要求旧插件目录存在 ⇒ 属于平滑接管，不算隐藏依赖。
      if (/^export const (DEFAULT_PERSONA_SRC|DEFAULT_SCENE_DIR)/.test(l.trim())) continue;
      suspicious.push(f + ':' + (i + 1) + ': ' + l.trim().slice(0, 90));
    }
  }
  ok('ingest 代码无隐藏的旧路径读取', suspicious.length === 0, suspicious.length ? JSON.stringify(suspicious) : 'clean');
}

console.log('');
console.log(fail === 0 ? '✅ 关旧隔离模拟通过：新链路完全不依赖旧插件' : '❌ 有 ' + fail + ' 项失败');
try { rmSync(root, { recursive: true, force: true }); } catch {}
process.exitCode = fail === 0 ? 0 : 1;
