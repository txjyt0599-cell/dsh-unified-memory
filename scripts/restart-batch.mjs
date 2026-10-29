#!/usr/bin/env node
/**
 * restart-batch.mjs —— 「攒批重启」闸门
 * [2026-10-22 by Assistant]
 *
 * 为什么有这个：
 *   每次重启 DSH = **system prompt 全量重算**（实测 40~70 万 token 全价）。
 *   一次重启 ≈ 1000~1700 次正常轮次的 input 成本。
 *   而缓存缓存的是「前缀」，重启后进程内缓存全丢，必须从零重建。
 *
 *   今晚（2026-10-22 00:38~01:22）因为「改一处就重启一次」，浪费了 16 次全价重算
 *   ≈ 800 万 token。这个脚本就是为了不再犯。
 *
 * 用法：
 *   node scripts/restart-batch.mjs add "改了 section.js：注入改消息尾" [文件...]
 *   node scripts/restart-batch.mjs status      # 看待重启清单 + 能否重启
 *   node scripts/restart-batch.mjs verify      # 跑六套测试（必须全绿）
 *   node scripts/restart-batch.mjs clear       # 重启成功后再清（会记一笔历史）
 *   node scripts/restart-batch.mjs history     # 看重启浪费账
 *
 * 铁律：
 *   - 有 pending 项时，**不许**请User重启（除非 verify 全绿）
 *   - 每完成一项改动立刻 add，别攒到最后忘
 *   - 重启成功后立刻 clear，别让旧记录污染下一批
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, readdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { tmpdir as osTmpdir } from 'node:os';

const ROOT = 'D:/dsh-plugins/dsh-unified-memory';
const STATE = join(ROOT, '.restart-batch.json');
const HISTORY = join(ROOT, '.restart-batch-history.jsonl');

const SUITES = [
  'selftest.mjs',
  'selftest-p2.mjs',
  'selftest-p3.mjs',
  'selftest-p4.mjs',
  'selftest-bridge.mjs',
  // [2026-10-28 by Assistant · P0 注入落盘真伪]
  //   他山之石：淋雨家自审「插件标 runtime-context ⇒ 正文被静默丢弃，日志照写 inject 成功」。
  //   本套验回捞钩子的判据，并**钉死一个我第一版真写错的地方**：
  //   只替换字面 \\n 会漏掉真换行 ⇒ 跨行指纹永远匹配不上 ⇒ 把成功误报成丢注入。
  'selftest-inject-verify.mjs',
  // [2026-10-28 by Assistant · P1 体温交接]
  //   抓到的真问题：写盘塞在 runDistill 里，而 llm:off 时第 429 行就 return
  //   ⇒ 本机 llm:off 期间 ongoing-thread.json 结构性永不更新（实测停在 11:04）。
  //   本套验"无 LLM 也能写"+ 脏数据清洗 + 反例。
  'selftest-ongoing-thread.mjs',
  // [2026-10-28 by Assistant · 老红项] 读侧标题闸门
  //   根因不是判据错，是判据没被执行（cleanTitle 只去脏不判合格），
  //   且 cleanTitle 把"提不出"写死成「（无标题）」⇒ 脏数据伪装成合法标题。
  'selftest-title-gate.mjs',
  // [2026-10-28 by Assistant · 派单回执状态机 v1]
  //   七条反例：A 死投 / B 假唤醒 / C 真完成回执丢 / D 假完成不销账 /
  //   E 前缀污染 / F 多标签 / G 投递丢失；H 组单钉「inactive 不许判死」。
  //   ⛔ 判据全部来自实读源码行号，已废除 turnCount（不存在）/ mtime（整包重写）。
  'selftest-dispatch-machine.mjs',
  // [2026-10-28 by Assistant · 派单接线] 三手柄 + Write-Ahead 台账
  //   A10 是关键的**时序**断言：投递发生那一刻台账里必须已有 pending。
  //   （第一版没这条，导致"先投递后落盘"的变异抓不到 —— 又是反例不够细）
  'selftest-dispatch-wiring.mjs',
  // [2026-10-28 by Assistant · 真实派单抓到的第四个 bug]
  //   agentTeams.sendMessage(caller, request) 是**两个参数**，我原来只传一个。
  //   旧测试全用假函数，假函数不校验参数个数 ⇒ 测试全绿但上线就崩。
  //   本套用"严格两参"假函数 + 源码断言 + 两条变异，把签名钉死。
  'selftest-dispatch-signature.mjs',
  // [2026-10-28 by Assistant · 第六次真实派单抓到的**误报**]
  //   派单成功、回执也回来了，dispatch_scan 却判 dead_target。
  //   根因：getAgents 调了不存在的方法名 listAgents（正确是 listMembers）⇒ 名册恒空。
  //   本套钉死：名册读失败 ⇒ undetermined（不知道）；空名册 ⇒ 才允许 dead_target。
  'selftest-dispatch-roster.mjs',
  // [2026-10-28 by Assistant · 热重载第一步·只读探针]
  //   只回答"能不能"：loader 可达 / 找得到自己 / 有 fiber。
  //   ⛔ 不改任何状态（P6 组专门验证了这点）。
  'selftest-hotreload-probe.mjs',
  // [2026-10-28 by Assistant · 热重载第二步·保险]
  //   核心是**顺序**不是功能：保险必须先于 dispose 挂上（G-ORDER1 专门验这个）。
  //   三条变异对应三种"会真丢插件"的写法，含最致命的"先拆后挂"。
  'selftest-hotreload-guard.mjs',
  // [2026-10-28 by Assistant · User指出的真 bug]
  //   ongoing-thread 的"问"和"答"各自找"最后一条"⇒ 不保证是同一对。
  //   实测 L0：user 20:32:01 → asst 13 → 19 → 26 → 34
  //   旧逻辑会把"过程里最后一句"当答案。P2 反例专钉"提问后无回答时不许回退拿旧答"。
  'selftest-ongoing-thread-pairing.mjs',
  // [2026-10-28 by Assistant · 热重载第三步·两个工具]
  //   今天最丢脸的 bug：join 里的转义换行被写成**真换行** ⇒
  //   node --check 报 OK、84 文件语法扫描全过，但运行时 import 直接 Invalid token。
  //   本套加 H2a「字符串字面量跨行」扫描 + H1「ESM 真解析」，
  //   且**先扫源码再加载模块**（否则源码坏了在 import 阶段就崩）。
  'selftest-hotreload-tools.mjs',
  // [2026-10-28 by Assistant · 真执行 · 一次真实翻车的教训]
  //   19:43 真跑 hotreload_apply 后插件**永久消失**（工具全没、日志无 rescue）。
  //   三个死因：① 用已 dispose 的 p.ctx 重新 apply ② catch 静默 ③ 保险同死因。
  //   ⇒ 本套钉死：没有可靠外部重装器时必须**拒绝自拆**，绝不再拆了自己装不回来。
  'selftest-hotreload-exec.mjs',
  // [2026-10-28 by Assistant · 事件源接入]
  //   N1 是关键反例：两条读取路都失败时必须判 undetermined，
  //   ⛔ 绝不能用空数组冒充"没有新增"（那会让 classify 判 busy，让人催一个没问题的目标）。
  'selftest-dispatch-eventsource.mjs',
  // [2026-10-28 by Assistant · 补一套真事故的守门测试]
  //   线上三个 dispatch 工具**全部注册失败**（缺 output { schema, render }），
  //   而 probe 仍打出 dispatch-tools-registered n=3 —— 今天第三次"日志说成功≠真成功"。
  //   本套验工具声明完整性（name/description/parameters/output.schema/render/execute），
  //   并有配套变异证明"删掉 output 会被抓到"。
  'selftest-tool-schema.mjs',
  // [2026-10-28 by Assistant · 补一套更根本的守门测试]
  //   cordis 铁律：没声明进 inject 的服务，读 ctx.xxx 会被直接拦下。
  //   今天**两次**踩同一个坑：tools（10-24）、agentTeams+sessions+sessionPersistence（10-28）。
  //   本套做静态对账：代码里读了哪些 ctx.xxx vs inject 声明了哪些，不一致就红。
  'selftest-inject-declarations.mjs',
  // [2026-10-28 by Assistant · 场景隔离]
  //   反例全是「必须可见」：未声明的卡 / 当前场景未声明 / includeCrossScene。
  //   因为隔离做错的后果是**历史卡集体消失**——比不隔离更糟。
  'selftest-scenes.mjs',
  // [2026-10-28 by Assistant · 场景隔离接线]
  //   User目标：**一个Assistant，看全部会话的记忆**。所以本套最重要的不是"隔离能生效"，
  //   而是"默认一条都不挡"。A 组是源码级断言（先剥注释再匹配，防"注释让断言假绿"）。
  'selftest-scene-wiring.mjs',
  // [2026-10-28 by Assistant · 结构重构] L0 归一化抽成纯函数模块
  //   判据是**逐位等价性**：新模块输出必须与旧内联实现逐字节相同（含 toFixed(4) 尾数）。
  'selftest-l0-normalize.mjs',
  'selftest-crosssource.mjs',
  'selftest-vector.mjs',
  // [2026-10-26 by Assistant · 回应审核 P1「备路零测试覆盖」]
  //   selftest-vector 只测 breaker 纯函数，测不到 retriever 集成；
  //   P0（主路熔断后整条向量路被跳过）正是这样漏过去的。此套专测备路。
  'selftest-fallback.mjs',
  'selftest-hotreload.mjs',
  'selftest-p23.mjs',
  'selftest-l0detail.mjs',
  // [2026-10-23 by Assistant · 期8.3] 路径修正：这个文件从来就在 scripts/ 下，
  //   SUITES 里写的是根目录路径 ⇒ `node <文件>` 直接 MODULE_NOT_FOUND ⇒
  //   execSync 抛异常 ⇒ 被 catch 当成「测试失败」。
  //   也就是说这个套件**从来没有被 verify 真正跑过**（却一直被当成 15 套之一）。
  'scripts/selftest-stage1-dualpool.mjs',
  // [2026-10-22 by Assistant · 期7] 写入侧（L0/L1/蒸馏）自测
  'selftest-ingest.mjs',
  // [2026-10-22 by Assistant · 坑6] 索引自动保鲜（源变才重建、幽灵卡清除）
  'selftest-autorefresh.mjs',
  // [2026-10-23 by Assistant · 期8.1] 认知信用协议 + 会话冷却期（白队钦定 Case 1/2/3）
  //   白队要求：「跑完拿 Trace 日志来，我们看数据说话」⇒ 必须每次 verify 都跑
  'scripts/bench-p8.mjs',
  // [2026-10-23 by Assistant · 期8.3] 图扩散**接线**自测（bench-p8 只测纯函数，不测接线）
  'scripts/selftest-graph-wiring.mjs',
  // [2026-10-22 by Assistant] 启动冒烟：apply() 本身（以前从没测过）
  //   注意 cwd 是插件根，所以路径相对根写（不是相对 scripts/）
  'scripts/smoke-apply.mjs',
  // ── [2026-10-24 by Assistant · Round 37] 完整链路总演练 ──
  //   前 36 轮都是分项验证，但从没把「真实 9533 张卡 + 真实查询」
  //   从检索→门控→四股力→装配→采纳→写盘→冷宫 串起来跑过。
  //   这条是**唯一一条端到端**的：它挂了说明接缝断了，比单测更有诊断价值。
  'scripts/e2e-full-chain.mjs',
  // [Round 36] 采纳四路分流（主库/自产/L1/tdai 各写各的文件）
  'scripts/e2e-adoption-routing-v2.mjs',
  // [Round 33] 三个数据源的 importance 都必须有，且要有区分度
  'scripts/e2e-importance-coverage.mjs',
  // [Round 31] 记忆的实用价值：库内给得出答案、库外不硬凑
  'scripts/e2e-memory-value.mjs',
  // [Round 39] 多会话并发与隔离：不串、幂等、20 并发无竞态
  'scripts/e2e-concurrency.mjs',
  // [Round 40] 索引重建时机：只改 hits 不该重建、加新卡必须重建
  //   这条直接关系到检索延迟（错误的重建策略 = 每轮白烧 1.5 秒）
  'scripts/e2e-index-rebuild.mjs',
  // [Round 41] 三个数据源的签名都要对 hits 免疫（主库已修，L1/tdai 是同类第二三处）
  'scripts/e2e-index-rebuild-sources.mjs',
  // [Round 43] 纠错机制：被推翻的卡要被降权（排序分不出两个基石谁对谁错）
  'scripts/e2e-refute-mechanism.mjs',
  // [Round 44] 终局验收：对照User最初提的 7 条诉求
  //   这条是全项目的「北极星」—— 前面的单测再多，这条挂了就说明方向错了
  'scripts/acceptance-final.mjs',
  // [Round 46] 交叉验证的边界：锁住「不按提及次数加权」的决定，
  //   防止以后（包括未来的Assistant）一拍脑袋把泛词频次加进排序
  'scripts/e2e-corroboration-boundary.mjs',
  // [Round 47-52 红白终裁] 对话层主动记忆三手柄：memory_search / memory_get / memory_refute
  'scripts/e2e-dialogue-memory-tools.mjs',
  // [2026-10-26 by Assistant · 问题生命周期根因治理]
  //   入口列表重排（问题卡优先）+ 解决识别 + 证据判定（防 AI 自嗨）+ 状态落盘。
  'scripts/e2e-resolution-lifecycle.mjs',
  // [2026-10-26 by Assistant · 白队 P0] 蒸馏**并发归属隔离**：
  //   readRecentL0 曾经跨会话混采、写卡统一盖当前 sessionId ⇒ 张冠李戴。
  //   这条锁死「只取自己会话 + 无 sessionKey 一律不收 + 无身份不写卡」。
  'scripts/e2e-distill-isolation.mjs',
];

// 一次重启的平均全价成本（实测：40~70 万 token，取 50 万）
const AVG_RESTART_TOKENS = 500000;
// 一次正常轮次的 input（实测 ~400 token）
const AVG_TURN_TOKENS = 400;

function load() {
  if (!existsSync(STATE)) return { batchId: null, openedAt: null, items: [], lastVerify: null };
  try {
    return JSON.parse(readFileSync(STATE, 'utf8'));
  } catch (e) {
    // [P3/E5] 损坏不再静默吞：把坏文件改名存档（下一次 save 就不会覆盖它），再返回空状态
    try {
      const bad = STATE + '.corrupt-' + Date.now();
      renameSync(STATE, bad);
      console.error('⚠️ 状态文件损坏，已移到 ' + bad + '，本次按空状态处理');
    } catch {}
    return { batchId: null, openedAt: null, items: [], lastVerify: null };
  }
}
/**
 * [2026-10-22 by Assistant · 工程红队 P3/E5] 状态文件原子写。
 * 红队指出：原来是直接 writeFileSync 覆盖，磁盘满/权限/占用会**截断状态**，
 * 而 load() 解析损坏时静默返回空状态 ⇒ 待重启清单和 verify 结果直接丢。
 * 改法：写 .tmp → rename（同盘 rename 在 Windows 上是原子的）。
 */
function save(s) {
  const tmp = STATE + '.tmp';
  writeFileSync(tmp, JSON.stringify(s, null, 2), 'utf8');
  renameSync(tmp, STATE);
}
function nowISO() { return new Date().toISOString(); }

function cmdAdd(args) {
  const note = args[0];
  if (!note) { console.error('用法: add "说明" [文件...]'); process.exit(2); }
  const s = load();
  if (!s.batchId) { s.batchId = 'b' + Date.now(); s.openedAt = nowISO(); s.items = []; }
  s.items.push({ at: nowISO(), note, files: args.slice(1) });
  s.lastVerify = null;   // 新改动 ⇒ 上次的绿作废
  save(s);
  console.log('✅ 已记入本批（' + s.items.length + ' 项待重启）');
  console.log('   batch=' + s.batchId);
  console.log('   ⚠️ 继续改，别急着重启；改完跑 verify');
}

function cmdStatus() {
  const s = load();
  if (!s.batchId) {
    console.log('📭 没有待重启的改动。');
    return;
  }
  console.log('📦 待重启批次: ' + s.batchId);
  console.log('   开启于: ' + s.openedAt);
  console.log('   改动 ' + s.items.length + ' 项:');
  s.items.forEach((it, i) => {
    console.log('     ' + (i + 1) + ') [' + it.at.slice(11, 19) + '] ' + it.note);
    if (it.files && it.files.length) console.log('        文件: ' + it.files.join(', '));
  });
  console.log('');
  if (!s.lastVerify) {
    console.log('🚦 还没跑过 verify —— **不许请User重启**');
    console.log('   跑: node scripts/restart-batch.mjs verify');
  } else {
    const ok = s.lastVerify.allGreen;
    console.log('🚦 最近一次 verify: ' + s.lastVerify.at.slice(11, 19) + '  ' + (ok ? '✅ 全绿，可以请User重启' : '❌ 有失败，先修'));
    if (!ok) console.log('   失败项: ' + (s.lastVerify.failed || []).join(', '));
  }
  const saved = (s.items.length - 1) * AVG_RESTART_TOKENS;
  if (s.items.length > 1) {
    console.log('');
    console.log('💰 本批已避免 ' + (s.items.length - 1) + ' 次额外重启 ≈ ' + Math.round(saved / AVG_TURN_TOKENS) + ' 次正常轮次的成本');
  }
}

function cmdVerify() {
  const s = load();
  if (!s.batchId) { console.log('📭 没有待验证的改动。'); return; }
  console.log('🧪 跑六套测试（' + SUITES.length + ' 套）...');
  const results = [];
  let allGreen = true;
  for (const suite of SUITES) {
    const t0 = Date.now();
    let ok = false, tail = '';
    try {
      const out = execSync('node ' + suite, { cwd: ROOT, encoding: 'utf8', timeout: 600000, stdio: ['ignore', 'pipe', 'pipe'] });
      ok = true;
      tail = out.trim().split('\n').slice(-2).join(' ').slice(0, 100);
    } catch (e) {
      ok = false;
      const o = (e && e.stdout) || '';
      const err = (e && e.stderr) || '';
      tail = (o + err).trim().split('\n').slice(-3).join(' ').slice(0, 140);
    }
    const ms = Date.now() - t0;
    results.push({ suite, ok, ms, tail });
    if (!ok) allGreen = false;
    console.log('  ' + (ok ? '✅' : '❌') + ' ' + suite.padEnd(24) + String(ms).padStart(6) + 'ms  ' + tail);
  }
  s.lastVerify = {
    at: nowISO(),
    allGreen,
    failed: results.filter(r => !r.ok).map(r => r.suite),
    results,
  };
  save(s);
  console.log('');
  if (allGreen) {
    console.log('✅ 全绿 —— **可以请User重启了**（本批 ' + s.items.length + ' 项改动一次生效）');
    // ── [2026-10-24 by Assistant · Round 20] 重启前强制提醒打代码快照 ──
    //   这个插件不是 git 仓库，重启后若 apply 抛错会很难回退。
    //   之前从没备份过**代码**（只备份数据），这次补上并把提醒接在闸门上。
    try {
      const snapRoot = join(osTmpdir(), 'code-snapshots');
      let snaps = [];
      try { snaps = readdirSync(snapRoot).filter((n) => !n.startsWith('pre-restore-')); } catch {}
      // [Round 20] files 是**数组**（[{at,note,files:[...]}]），不是字符串
      const codeTouched = s.items.some((x) => {
        const arr = Array.isArray(x.files) ? x.files : (x.files ? [String(x.files)] : []);
        return arr.some((f) => /^lib[\/\\]/.test(String(f)));
      });
      if (codeTouched) {
        const newest = snaps.sort().slice(-1)[0];
        console.log('💾 代码已改动 —— 重启前建议打快照：');
        if (newest) console.log('   已有: ' + newest + '（若不是本批打的，请重打）');
        console.log('   命令: node scripts/snapshot-code.mjs');
      }
    } catch {}
  } else {
    console.log('❌ 有失败 —— 修完再 verify，别重启');
    process.exit(1);
  }
}

function cmdClear() {
  const s = load();
  if (!s.batchId) { console.log('📭 没有待清空的批次。'); return; }
  const rec = {
    at: nowISO(),
    batchId: s.batchId,
    openedAt: s.openedAt,
    items: s.items.length,
    verified: !!(s.lastVerify && s.lastVerify.allGreen),
    avoidedRestarts: Math.max(0, s.items.length - 1),
    savedTokensEstimate: Math.max(0, s.items.length - 1) * AVG_RESTART_TOKENS,
  };
  try { writeFileSync(HISTORY, JSON.stringify(rec) + '\n', { encoding: 'utf8', flag: 'a' }); } catch {}
  writeFileSync(STATE, JSON.stringify({ batchId: null, openedAt: null, items: [], lastVerify: null }, null, 2), 'utf8');
  console.log('🧹 批次已结清: ' + s.batchId + '（' + s.items.length + ' 项改动）');
  if (rec.avoidedRestarts > 0) {
    console.log('💰 本批避免了 ' + rec.avoidedRestarts + ' 次重启 ≈ ' + Math.round(rec.savedTokensEstimate / AVG_TURN_TOKENS) + ' 次正常轮次的成本');
  }
}

function cmdHistory() {
  if (!existsSync(HISTORY)) { console.log('📭 还没有历史记录。'); return; }
  const rows = readFileSync(HISTORY, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  console.log('📊 攒批历史（' + rows.length + ' 批）');
  let totalAvoided = 0, totalTokens = 0;
  rows.slice(-15).forEach(r => {
    totalAvoided += r.avoidedRestarts || 0;
    totalTokens += r.savedTokensEstimate || 0;
    console.log('  ' + r.at.slice(0, 19).replace('T', ' ') + '  ' + String(r.items).padStart(2) + ' 项  避免 ' + (r.avoidedRestarts || 0) + ' 次重启  ' + (r.verified ? '✅已验证' : '⚠️未验证'));
  });
  console.log('');
  console.log('  累计避免重启: ' + totalAvoided + ' 次');
  console.log('  累计省下: ' + (totalTokens / 1e6).toFixed(2) + ' M token ≈ ' + Math.round(totalTokens / AVG_TURN_TOKENS) + ' 次正常轮次');
}

// ── dispatch ──
const [cmd, ...rest] = process.argv.slice(2);
switch (cmd) {
  case 'add': cmdAdd(rest); break;
  case 'status': cmdStatus(); break;
  case 'verify': cmdVerify(); break;
  case 'clear': cmdClear(); break;
  case 'history': cmdHistory(); break;
  default:
    console.log('用法:');
    console.log('  node scripts/restart-batch.mjs add "说明" [文件...]');
    console.log('  node scripts/restart-batch.mjs status');
    console.log('  node scripts/restart-batch.mjs verify');
    console.log('  node scripts/restart-batch.mjs clear');
    console.log('  node scripts/restart-batch.mjs history');
    process.exit(cmd ? 2 : 0);
}
