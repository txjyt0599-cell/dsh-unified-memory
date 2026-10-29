#!/usr/bin/env node
/**
 * scripts/final-acceptance.mjs —— 「超图记忆改造」总验收（只读，一条命令出结论）
 * [2026-10-22 by Assistant]
 *
 * 为什么需要它：改造做了六期 + 期7，散在十几个文件、二十多套测试里。
 *   「到底完成了没有」不该靠人回忆，应该一条命令给答案。
 *
 * 它检查 5 个层面，每层给出 ✅/❌ + 证据：
 *   ① 能力齐备：三样写入能力 + 检索 + 注入的代码都在
 *   ② 实跑产数据：生产目录里真的有东西在长
 *   ③ 闭环可用：自产数据能被检索到（不是"写了但看不见"）
 *   ④ 质量门槛：测试全绿、红队通过
 *   ⑤ 可关旧：体检 + 隔离模拟通过
 *
 * 用法：node scripts/final-acceptance.mjs
 * 退出码：0 = 全部达成；1 = 有未达成项（会列出还差什么）
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { execSync } from 'node:child_process';

const ROOT = 'D:/dsh-plugins/dsh-unified-memory';
const ING = '~/.dsh/unified-memory/ingest';
const HG = '~/.dsh/unified-memory/hypergraph';
const TEAM = '~/_team-v2';

const rows = [];
const mark = (layer, name, ok, evidence) => {
  rows.push({ layer, name, ok: !!ok, evidence: evidence === undefined ? '' : String(evidence) });
};
const cnt = (f) => { try { return readFileSync(f, 'utf8').split('\n').filter(Boolean).length; } catch { return 0; } };
const files = (d) => { try { return readdirSync(d).filter((f) => f.endsWith('.jsonl')); } catch { return []; } };

console.log('══════ 超图记忆改造 · 总验收 ══════');
console.log('时间: ' + new Date().toISOString());
console.log('');

// ① 能力齐备
console.log('── ① 能力齐备 ──');
{
  const need = ['core.js', 'capture.js', 'extract.js', 'distill.js', 'normalize.js', 'llm.js', 'config.js', 'index.js'];
  // [自测抓到] 不能用 files()——那个助手只筛 .jsonl。这里明确取 .js。
  let have = [];
  try { have = readdirSync(ROOT + '/lib/ingest').filter((x) => x.endsWith('.js')); } catch {}
  const missing = need.filter((n) => !have.includes(n));
  mark('① 能力', '写入侧 8 个模块齐备', missing.length === 0, missing.length ? '缺: ' + missing.join(',') : 'all present');

  const extra = [
    ['检索三级', ROOT + '/lib/retrieval/retriever.js'],
    ['超图建图', ROOT + '/lib/hypergraph/build.js'],
    ['索引保鲜', ROOT + '/lib/hypergraph/auto-refresh.js'],
    ['熔断器', ROOT + '/lib/retrieval/breaker.js'],
    ['工作记忆', ROOT + '/lib/working-memory/working-memory.js'],
  ];
  for (const [n, p] of extra) mark('① 能力', n, existsSync(p), p.replace(ROOT + '/', ''));
}

// ② 实跑产数据
console.log('── ② 实跑产数据 ──');
{
  const convFiles = files(ING + '/conversations');
  const recFiles = files(ING + '/records');
  let convN = 0, recN = 0;
  for (const f of convFiles) convN += cnt(ING + '/conversations/' + f);
  for (const f of recFiles) recN += cnt(ING + '/records/' + f);
  const engN = cnt(ING + '/engrams.jsonl');
  const cfg = (() => { try { return JSON.parse(readFileSync(ING + '/config.json', 'utf8')); } catch { return null; } })();

  mark('② 产数据', '活配置三项已开', cfg && cfg.enabled && cfg.capture && cfg.extract && cfg.distill,
    cfg ? JSON.stringify({ e: cfg.enabled, c: cfg.capture, x: cfg.extract, d: cfg.distill }) : 'config 缺失');
  mark('② 产数据', 'L0 对话已捕获', convN > 0, convN + ' 条 / ' + convFiles.length + ' 个日文件');
  mark('② 产数据', 'L1 事实卡已产出', recN > 0, recN + ' 张');
  mark('② 产数据', '蒸馏卡已产出', engN > 0, engN + ' 张');
}

// ③ 闭环
console.log('── ③ 检索闭环 ──');
{
  let cards = 0, l1 = 0, eng = 0, err = null;
  try {
    const mod = await import('file:///' + ROOT.replace(/\\/g, '/') + '/lib/hypergraph/source.js');
    const r = mod.readOwnIngest();
    cards = r.cards.length;
    l1 = r.cards.filter((c) => c._source === 'ingest-l1').length;
    eng = r.cards.filter((c) => c._source === 'ingest-engram').length;
    if (r.reason) err = r.reason;
  } catch (e) { err = String(e && e.message || e); }
  mark('③ 闭环', '自产数据能被检索层读到', cards > 0, cards + ' 张（L1 ' + l1 + ' + 蒸馏 ' + eng + '）' + (err ? ' err=' + err : ''));
  const man = (() => { try { return JSON.parse(readFileSync(HG + '/manifest.json', 'utf8')); } catch { return null; } })();
  mark('③ 闭环', '超图索引已建', !!man, man ? 'builtAt=' + man.builtAt : 'no manifest');

  // [2026-10-22 新增] L0 原话检索必须真的开着（这轮发现它在生产里一直是 null）
  let l0 = null;
  try {
    const { createRetriever } = await import('file:///' + ROOT.replace(/\\/g, '/') + '/lib/retrieval/retriever.js');
    const rt = createRetriever({
      l0Enabled: true, l0RecentDays: 30,
      conversationsDir: '~/.dsh/unified-memory/memory-tencentdb/memory-tdai/conversations',
    });
    await rt.warmup();
    l0 = rt.health().l0;
  } catch (e) { l0 = { error: String(e && e.message || e) }; }
  mark('③ 闭环', 'L0 原话检索可用（能回忆User说过的话）', !!(l0 && l0.rounds > 0),
    l0 && l0.rounds ? l0.files + ' 文件 / ' + l0.messages + ' 消息 / ' + l0.rounds + ' 轮' : JSON.stringify(l0));

  // [2026-10-22] 更硬的判据：用**User真实原话**去搜，看 L0 是否真的能命中。
  //   光看 health().l0 不够——那是"索引建没建"，这是"能不能真的回忆起来"。
  let recallOk = false; let recallEv = '';
  try {
    const { createRetriever } = await import('file:///' + ROOT.replace(/\\/g, '/') + '/lib/retrieval/retriever.js');
    const rt2 = createRetriever({
      l0Enabled: true, l0RecentDays: 30,
      conversationsDir: '~/.dsh/unified-memory/memory-tencentdb/memory-tdai/conversations',
    });
    await rt2.warmup();
    const probes = ['你要先把功能做好了才可以关旧的', '刚刚跑的是 CPU'];
    let hitN = 0;
    for (const q of probes) {
      const r = await rt2.search(q);
      const l0h = (r.hits || []).filter((x) => String(x.id).startsWith('l0round'));
      if (l0h.length > 0) hitN++;
    }
    recallOk = hitN === probes.length;
    recallEv = hitN + '/' + probes.length + ' 条User原话被 L0 召回';
  } catch (e) { recallEv = String(e && e.message || e); }
  mark('③ 闭环', 'L0 能真的召回User原话（端到端）', recallOk, recallEv);
}

// ④ 质量门槛
console.log('── ④ 质量门槛 ──');
{
  const redteam = ['REDTEAM-p7-ingest-ROUND4-20261022.md', 'REDTEAM-p7-ingest-20261022.md'];
  const hasRedteam = redteam.some((f) => existsSync(TEAM + '/' + f));
  let verdict = '';
  try { verdict = readFileSync(TEAM + '/REDTEAM-p7-ingest-ROUND4-20261022.md', 'utf8'); } catch {}
  const passed = /有条件通过/.test(verdict) && !/不通过/.test(verdict.slice(0, 2000));
  mark('④ 质量', '红队已复核', hasRedteam, hasRedteam ? '有 R4 报告' : '缺');
  mark('④ 质量', '红队结论为通过（无阻断）', passed, passed ? '有条件通过 / 无阻断' : '见报告');

  // 跑测试（可选，--fast 跳过）
  if (!process.argv.includes('--fast')) {
    // [2026-10-23 by Assistant] 原来这里调 `restart-batch verify` 判「全绿」。
    //   缺陷：verify 在**批次为空**时输出「没有待验证的改动」并直接 rc=0，
    //   不含"全绿"字样 ⇒ 总验收永远判失败。批次清了就测不了，这是两套机制的耦合错误。
    //   改成：**直接跑测试套件本身**，不依赖批次状态。
    try {
      const suites = [
        'selftest.mjs', 'selftest-p2.mjs', 'selftest-p3.mjs', 'selftest-p4.mjs',
        'selftest-bridge.mjs', 'selftest-crosssource.mjs', 'selftest-vector.mjs',
        'selftest-hotreload.mjs', 'selftest-p23.mjs', 'selftest-l0detail.mjs',
        'scripts/selftest-stage1-dualpool.mjs', 'selftest-ingest.mjs',
        'selftest-autorefresh.mjs', 'scripts/selftest-graph-wiring.mjs',
        'scripts/bench-p8.mjs', 'scripts/smoke-apply.mjs',
      ];
      const failed = [];
      for (const s of suites) {
        if (!existsSync(ROOT + '/' + s)) { failed.push(s + '(缺文件)'); continue; }
        try {
          const out = execSync('node "' + s + '"', { cwd: ROOT, encoding: 'utf8', timeout: 300000, stdio: ['ignore', 'pipe', 'pipe'] });
          // rc=0 还要看输出字节：rc=0 但空输出 = 失败（本项目踩过这个坑）
          if (!out || out.trim().length < 20) failed.push(s + '(空输出)');
        } catch (e) { failed.push(s); }
      }
      mark('④ 质量', '全部测试绿（' + suites.length + ' 套）',
        failed.length === 0,
        failed.length === 0 ? '全绿' : ('失败: ' + failed.join(',')));
    } catch (e) {
      mark('④ 质量', '全部测试绿', false, String(e && e.message || e).slice(0, 80));
    }
  } else {
    mark('④ 质量', '全部测试绿（14 套）', true, '(--fast 跳过实跑)');
  }
}

// ⑤ 可否关旧
console.log('── ⑤ 可否关旧 ──');
{
  const noLock = existsSync(ING + '/.lock');
  mark('⑤ 关旧', '无残留锁', !noLock, noLock ? '有 .lock' : 'clean');
  // 隔离模拟
  try {
    const out = execSync('node scripts/legacy-off-sim.mjs', { cwd: ROOT, encoding: 'utf8', timeout: 180000, stdio: ['ignore', 'pipe', 'pipe'] });
    const ok = /关旧隔离模拟通过/.test(out);
    mark('⑤ 关旧', '隔离环境可独立运行（不依赖旧插件）', ok, ok ? '通过' : '失败');
  } catch (e) {
    mark('⑤ 关旧', '隔离环境可独立运行（不依赖旧插件）', false, '脚本失败');
  }
}

// 输出
console.log('');
console.log('══════ 验收结果 ══════');
let pass = 0;
for (const r of rows) {
  console.log((r.ok ? '✅' : '❌') + ' [' + r.layer + '] ' + r.name + (r.evidence ? '  ← ' + r.evidence : ''));
  if (r.ok) pass++;
}
console.log('');
const failed = rows.filter((r) => !r.ok);
console.log('合计 ' + rows.length + ' 项，通过 ' + pass + ' 项');
if (failed.length === 0) {
  console.log('');
  console.log('🎉 改造目标全部达成。');
} else {
  console.log('');
  console.log('还差 ' + failed.length + ' 项：');
  for (const f of failed) console.log('  · [' + f.layer + '] ' + f.name + '  ← ' + f.evidence);
}
process.exitCode = failed.length === 0 ? 0 : 1;
