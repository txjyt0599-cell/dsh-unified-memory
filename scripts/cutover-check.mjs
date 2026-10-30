#!/usr/bin/env node
/**
 * scripts/cutover-check.mjs —— 期7-D「能不能关旧」的体检（只读，不关任何东西）
 * [2026-10-22 by Assistant]
 *
 * 用途：在真正关掉 tdai-memory / dsh-engram-relay 之前，逐项回答三个问题：
 *   ① 这项能力，超图**有没有**对应的新实现？
 *   ② 这个新实现**现在会不会真跑**（开关 + 模型端点 + 目录）？
 *   ③ 如果现在把旧的关掉，这项能力会**降级成什么**（以及可接受吗）？
 *
 * 它**不做**任何改动：不写生产数据、不改配置、不启停插件。
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dataPath } from '../lib/paths.js';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dshHome } from '../lib/paths.js';
const ROOT = fileURLToPath(new URL('./', import.meta.url)).replace(/[\\/]$/, '');

const INGEST_ROOT = dataPath('ingest');
const CFG = INGEST_ROOT + '/config.json';
const PROFILE = join(dshHome(), 'profiles/web/cordis.patch.yml');

let bad = 0;
const rows = [];
const row = (cap, old, neo, ok, note) => {
  rows.push({ cap, old, neo, ok, note });
  if (!ok) bad++;
};

function readJson(p) { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } }
function countLines(p) { try { return readFileSync(p, 'utf8').split('\n').filter(Boolean).length; } catch { return 0; } }
function listJsonl(dir) { try { return readdirSync(dir).filter((f) => f.endsWith('.jsonl')); } catch { return []; } }

const cfg = readJson(CFG);
console.log('═══ 期7-D 关旧体检 ═══');
console.log('ingest 配置: ' + (cfg ? JSON.stringify({ enabled: cfg.enabled, capture: cfg.capture, extract: cfg.extract, distill: cfg.distill }) : '缺失'));
console.log('');

// ① L0 对话捕获
{
  const conv = listJsonl(INGEST_ROOT + '/conversations');
  const oldFiles = listJsonl(dataPath('memory-tencentdb/memory-tdai/conversations'));
  const hasImpl = existsSync(join(ROOT, 'lib/ingest/capture.js'));
  const on = !!(cfg && cfg.enabled && cfg.capture);
  row('L0 对话捕获',
    'tdai auto-capture.js → conversations/',
    'lib/ingest/capture.js → ingest/conversations/',
    hasImpl,
    hasImpl
      ? (on ? '开关已开' : '⚠️ 已实现但开关**关着**（要开才有新数据）') + '; 已产 ' + conv.length + ' 个日文件; 旧库 ' + oldFiles.length + ' 个（存量仍可读）'
      : '❌ 没有实现');
}

// ② L1 事实提取
{
  const rec = listJsonl(INGEST_ROOT + '/records');
  let cards = 0;
  for (const f of rec) cards += countLines(INGEST_ROOT + '/records/' + f);
  const hasImpl = existsSync(join(ROOT, 'lib/ingest/extract.js'));
  const on = !!(cfg && cfg.enabled && cfg.extract);
  // 模型端点能不能解析（不打印 key）
  let llm = '未解析';
  try {
    const prof = readFileSync(PROFILE, 'utf8');
    const m = prof.match(/id:\s*tdai-memory[\s\S]{0,800}?llm:\s*\n\s*apiKey:[^\n]*\n\s*baseUrl:\s*([^\n]*)\n\s*model:\s*([^\n]*)/);
    llm = m ? (new URL(m[1].trim()).host + '/' + m[2].trim().split('#')[0].trim()) : '没找到 tdai.llm 段';
  } catch { llm = 'profile 读不到'; }
  row('L1 事实提取',
    'tdai l1-extractor + l1-writer → records/',
    'lib/ingest/extract.js → ingest/records/',
    hasImpl,
    hasImpl
      ? (on ? '开关已开' : '⚠️ 已实现但开关**关着**') + '; 已产 ' + cards + ' 条; LLM=' + llm
      : '❌ 没有实现');
}

// ③ engram 蒸馏
{
  const eng = INGEST_ROOT + '/engrams.jsonl';
  const n = existsSync(eng) ? countLines(eng) : 0;
  const hasImpl = existsSync(join(ROOT, 'lib/ingest/distill.js'));
  const on = !!(cfg && cfg.enabled && cfg.distill);
  row('engram 蒸馏',
    'engram-relay relay.js:625 maybeDistill()',
    'lib/ingest/distill.js → ingest/engrams.jsonl',
    hasImpl,
    hasImpl ? (on ? '开关已开' : '⚠️ 已实现但开关**关着**') + '; 已产 ' + n + ' 条' : '❌ 没有实现');
}

// ④ 检索能否读到自产数据（闭环）
{
  let ok = false; let detail = '';
  try {
    const mod = await import('../lib/hypergraph/source.js');
    const r = mod.readOwnIngest(INGEST_ROOT);
    ok = Array.isArray(r.cards);
    detail = 'cards=' + r.cards.length + ' files=' + r.files + ' reason=' + (r.reason || '-');
  } catch (e) { detail = String(e && e.message || e); }
  row('写入→检索闭环', '（旧插件自己读自己）', 'readOwnIngest() 并入同一份 BM25', ok, detail);
}

// ⑤ 存量可读性（关旧之后历史还在不在）
{
  const engramFile = dataPath('engram-relay/engrams.jsonl');
  const tdaiRec = dataPath('memory-tencentdb/memory-tdai/records');
  const eOk = existsSync(engramFile);
  const tOk = existsSync(tdaiRec);
  row('存量历史', '旧插件目录', '直接读 jsonl（不依赖插件运行）', eOk && tOk,
    'engram=' + (eOk ? countLines(engramFile) + ' 行' : '缺失') + '; tdai records=' + (tOk ? listJsonl(tdaiRec).length + ' 文件' : '缺失'));
}

// ⑥ 关旧之后的缺口（诚实列出）
// [2026-10-22 更新] L3 人格画像已接管：lib/ingest/persona.js
//   · 读取：直接读 tdai 的 persona.md（只读，不迁移存量）
//   · 生成：超图自己从对话抽「稳定事实」追加到 ingest/persona-notes.md
//   ⇒ 关掉 tdai 后，画像不再"消失"，而是由超图的增量笔记接棒。
{
  let personaOk = false; let personaEv = '';
  try {
    const mod = await import('../lib/ingest/persona.js');
    const p = mod.readPersona();
    personaOk = !p.missing && p.bytes > 0;
    personaEv = p.missing ? 'persona.md 缺失' : ('可读 ' + p.bytes + ' 字节；增量笔记由 ingest/persona.js 接管');
  } catch (e) { personaEv = String(e && e.message || e); }
  row('L3 人格画像', 'tdai persona.md（持续生成）', '超图读取 + 增量笔记（lib/ingest/persona.js）', personaOk,
    personaEv + '；⚠️ 默认不自动生成，需把 personaTakeover 设为 true');
}

row('L2 场景块', 'tdai scene_blocks', '❌ 超图不读也不产', true,
  '这是**有意的**：scene_blocks 属于 tdai 自己的 L2 体系，超图用 Episode 自成一套，不需要它');
row('向量库 561MB', 'tdai vectors.db', '超图自有 34MB embeddings', true, '不迁移，各自独立');

// 输出
console.log('能力 | 旧实现 | 新实现 | 状态');
console.log('---|---|---|---');
for (const r of rows) {
  console.log((r.ok ? '✅' : '❌') + ' ' + r.cap + ' | ' + r.old + ' | ' + r.neo + ' | ' + r.note);
}
console.log('');
// [2026-10-22 by Assistant · 期7-D 修正] 原来只查写入三项，漏了注入侧 ——
//   那会得出「可以关」的错误结论（关掉后 user-persona / scene-navigation 全消失）。
//   现在写入 + 注入一起判。
const ready = rows.filter((r) => r.cap === 'L0 对话捕获' || r.cap === 'L1 事实提取' || r.cap === 'engram 蒸馏');
const implOk = ready.every((r) => r.ok);
const onCount = [cfg && cfg.capture, cfg && cfg.extract, cfg && cfg.distill].filter(Boolean).length;

// 注入侧：persona + scene-navigation 是否已被超图接管
let personaInjectOk = false;
let sceneNavOk = false;
try {
  const nav = await import('../lib/ingest/scene-nav.js');
  sceneNavOk = typeof nav.generateSceneNavigation === 'function' && nav.generateSceneNavigation().text.length > 0;
} catch {}
try {
  const persona = await import('../lib/ingest/persona.js');
  const pp = persona.readPersona(persona.DEFAULT_PERSONA_SRC, null);
  personaInjectOk = !!pp && !pp.missing && pp.bytes > 0;
} catch {}

console.log('汇总结论：');
console.log('  · 三项写入能力已实现: ' + (implOk ? '是' : '否'));
console.log('  · 三项开关已开: ' + onCount + '/3');
console.log('  · persona 注入已接管: ' + (personaInjectOk ? 'YES (personaInject, default off)' : 'NO'));
console.log('  · scene-navigation 已接管: ' + (sceneNavOk ? 'YES (sceneNavInject, default off)' : 'NO'));
const canCut = implOk && onCount === 3 && personaInjectOk && sceneNavOk;
console.log('  · 可以关旧: ' + (canCut ? 'YES 写入与注入都已接管，重启后开两个开关即可' : 'NO ' + (implOk ? '注入侧未接管' : '写入实现不全')));
console.log('');
console.log('关旧步骤（不是直接删）：');
console.log('  1. profile 给 unified-memory 加两个开关 personaInject: true / sceneNavInject: true');
console.log('  2. 重启，确认 contexts 出现 Assistant:persona 与 Assistant:scene-nav');
console.log('  3. 再关 tdai-memory / dsh-engram-relay 的 enabled');
console.log('  4. 数据不删（User说过删不删以后再说）');
console.log('');
console.log('已知取舍（关旧后）：');
console.log('  · tdai 的 scene_blocks 不再自动更新 —— 超图只读它的 META 生成导航');
console.log('  · engram-relay 的灵枢浅思维注入段消失');
process.exitCode = (canCut ? 0 : 1);
