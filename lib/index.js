import {
  mkdirSync as _mkdir,
  appendFileSync as _append,
  statSync as _statSync,
  unlinkSync as _unlinkSync,
  renameSync as _renameSync,
  // [2026-10-26] scene-nav 新鲜度戳需要列目录（ESM 里不能用 require）
  readdirSync as _readdirSync,
  // [2026-10-28 P0 注入回捞] 读会话落盘（zstd 压缩的 jsonl）
  readFileSync as _readFileSync,
} from 'node:fs';
import { zstdDecompressSync as _zstdDecompress } from 'node:zlib';
import { createSectionRenderer } from './section.js';
import { createOrchestrator } from './orchestrator.js';
import { createJournalBackend } from './backends/journal.js';
import { createEngramBackend } from './backends/engram.js';
import { createScorer } from './scorer/baseline.js';
import { createLogger } from './observe/log.js';
import { createHypergraphBackend } from './hypergraph/backend.js';
import { createHash } from 'node:crypto';
import { createRetriever } from './retrieval/retriever.js';
import { inheritFromProfile } from './embedding/client.js';
import { resolveEndpoint } from './embedding/client.js';
// [2026-10-26 by Assistant · 向量自动增量] 与 scripts/build-embeddings.mjs 共用同一份实现
import { buildMissing } from './embedding/auto-build.js';
import { createPrefetcher } from './prefetch.js';
// [2026-10-23 · 白队补充2 消费者：对话里「撤销公理：xxx」的自然语言入口]
import { revokeAxiom } from './ingest/axioms.js';
import { createWorkingMemory } from './working-memory/index.js';
import { buildL0Index } from './hypergraph/source.js';
import { readCards, readTdaiRecords, readOwnIngest } from './hypergraph/source.js';
// [2026-10-22 by Assistant · 期7] 写入侧总装（L0 捕获 / L1 提取 / engram 蒸馏）
import { createIngest } from './ingest/index.js';
// [2026-10-22 期7-D] 接管 persona 注入（关旧 tdai 后画像不丢）
import { readPersona, DEFAULT_PERSONA_SRC } from './ingest/persona.js';
import { generateSceneNavigation } from './ingest/scene-nav.js';
// [2026-10-22 by Assistant · 坑6 根治] 索引自动保鲜：只在源数据真变了时才重建
import { createAutoRefresh } from './hypergraph/auto-refresh.js';
// [2026-10-24 by Assistant · 日记本] 一位Assistant、多副身体：任意会话都能写
import { createDiaryTools } from './diary/tool.js';
// [2026-10-25 by Assistant · 红白双队终裁指令] 注册对话层主动记忆三手柄
import { createMemoryTools } from './retrieval/tools.js';
import { maybeNudge, maybeAssemble, diaryHealth } from './diary/scheduler.js';
// [2026-10-28 by Assistant · 派单回执状态机] 台账 + 三手柄（dispatch_send / _scan / _close）
import { createLedger } from './dispatch/ledger.js';
import { createDispatchTools } from './dispatch/tool.js';
import { createEventSource } from './dispatch/event-source.js';
// [2026-10-28 by Assistant · 热重载第一步] 只读探针：不做任何重载动作，只回答"能不能"
import { createHotReloadProbe } from './dispatch/hotreload-probe.js';
import { createHotReloadTools } from './dispatch/hotreload-tools.js';
// [2026-10-28 by Assistant · P0 注入真伪] 线上落盘回捞：日志说注入了，落盘里必须真有
import { recordFault } from './faults.js';
// [2026-10-24 Step 3] 回合后「真采纳」核验 → 补 hits（异步、绝不阻塞）
import { commitAdoptions } from './scoring/adoption.js';
import { loadLiveConfig } from './ingest/config.js';
// [2026-10-24 Step 4] 冷宫归档（只搬不删；默认只统计不搬）
import { runColdArchive } from './scoring/cold-archive.mjs';
import { dataPath, dshHome, normalize, sessionsRoot } from './paths.js';

// [2026-10-22 by Assistant · L0详情 P0 修复]
//   复核（l0-bridge）抓到：l0IndexProvider 引用了这个常量但**从未声明**，
//   ReferenceError 被外层 catch 吞掉 ⇒ l0Detail:true 时静默无原话（看起来像"没效果"）。
//   注意：之前的插入逻辑用 includes 判断，而被第 165 行的**引用**骗过去了，所以没真正插上。
/**
 * [2026-10-27 by Assistant · 第一优先：双目录活水]
 * 实测断链：memory-tdai/conversations 最后一份是 2026-10-22（tdai 旧链路已停写）；
 *   capture.js 从 10-23 起写的是 ingest/conversations（最新 10-27）。
 *   只读前者 ⇒ 近 5 天对话原话从未进入 L0 索引，问「这几天做了什么」只能捞出旧提问。
 * 现在改为**双目录**：旧的 64 天历史 + 新的 5 天活水，合并去重读取
 *   （l0-rounds.js 内按消息 id 去重，实测 10-22 重叠 471 条不会重复计数）。
 *
 * 注意：仍接受字符串（向后兼容）；buildL0Index / buildL0RoundCards 均已支持数组。
 */
// ══════════════════════════════════════════════════════════════════
// [2026-10-27 by Assistant · 路径权威表 —— **改路径前必读**]
//
// 事故背景（真实发生，别重演）：
//   有会话看到 D:/MemoryBackup/ 下有 unified-memory/ 目录，
//   就断定「数据迁移到 D 盘了、C 盘那份是旧的」，于是按 D 盘路径排查，
//   得出「数据根不见了/live 层被去掉」这类错误结论，白折腾半天。
//
// 【唯一权威】**插件读写的主目录永远是 C 盘这份**：
//   ~/.dsh/unified-memory/
//     ├─ ingest/          ← L0 捕获 + L1 记录 + 蒸馏产卡（capture.js 在写）
//     ├─ hypergraph/      ← 超图索引
//     ├─ embeddings/      ← 向量索引 index.json + vectors.bin
//     ├─ working/         ← 工作记忆
//     ├─ engram-relay/    ← engram 存储
//     └─ probe/           ← 探针日志
//
// 【D 盘那份不是工作目录】
//   D:/MemoryBackup/  ← **只是备份落地位置**，插件从不往这里写。
//   它下面可能同时存在 backup-*（备份脚本产出）与一份 unified-memory/（镜像），
//   两者都**不是**运行时数据源。看到它不代表「迁移了」。
//
// 【历史名词 live/】
//   曾短暂出现过 D:/MemoryBackup/**live**/unified-memory/ 这种写法，
//   现已废弃。全仓真实代码（lib/ scripts/）已零引用 —— 若你搜到，
//   那一定是 _tmp/ 里我留的临时探针（已归档到
//   ~/archive/tmp-probes-20261027/），**不要采信**。
//
// 判据（一行）：插件 cwd 数据根 = ~/.dsh/unified-memory/
// ══════════════════════════════════════════════════════════════════
const DEFAULT_CONVERSATIONS_DIR = [
  dataPath('memory-tencentdb/memory-tdai/conversations'),
  dataPath('ingest/conversations'),
];

export const name = 'dsh-unified-memory';
// [2026-10-24 by Assistant · 日记本] 加 'tools'：diary_write / diary_config 要注册到工具表。
//   cordis 铁律：没声明进 inject 的服务，读 ctx.tools 会被直接拦下
//   （重启后实跑抓到的）：cannot get property "tools" without inject。
//
// [2026-10-28 by Assistant · 派单状态机 · 又一次同类事故]
//   第一次真实派单就失败：cannot get property "agentTeams" without inject
//   —— 和上面 'tools' 那次是**同一个铁律**，Assistant明明写过注释提醒自己，还是漏了。
//   ⇒ 补 'agents' 与 'agentTeams'（参照 dsh-experimental-tool-agent-team/lib/index.js:9-14 的声明）。
//   ⚠️ 副作用：声明 inject 意味着这两个服务缺失时本插件不会加载。
//      但它们由 agent-team 插件提供，本机已装；若将来卸载，需同步移除这两个声明。
// [2026-10-28 by Assistant · 热重载只读探针] 补 'loader'
//   —— 又一次踩同一个铁律：读了 ctx.loader 就必须声明进 inject。
//   这次是守门测试（selftest-inject-declarations）在 verify 阶段抓到的，
//   不是等到重启后线上报错才发现的 —— 说明那套对账测试真的有用。
// [2026-10-31 · GitHub issue 修复] agentTeams 是**软依赖**，不能写进 inject。
//
//   病灶（issue superman007-glitch 报告，我核实成立）：
//     agentTeams 由 @deepseek-ai/dsh-experimental-agent-team 提供。
//     宿主没装那个实验插件时该服务不存在 ⇒ cordis 的 fiber._refresh() 里
//       for (const name of Object.keys(this.inject)) {
//         const impl = this._store[name];
//         if (!impl) { epoch = INACTIVE; break; }     ← 任一缺失
//       }
//     会把 epoch 设成 INACTIVE 并 _unload() ⇒ **整个插件永不激活**。
//     结果就是：默认 profile 上装完毫无反应，连 section 都不注册。
//
//   ⇒ 派单三件套（dispatch_send/scan/close）只是可选功能，
//     不该因为它缺少宿主服务就让整个记忆插件不加载。
//     改为软依赖：inject 只要宿主核心服务；agentTeams 运行时按需取，
//     取不到就明确报错（三处已有 if (!teams) 防御，保持）。
export const inject = ['systemPrompt', 'tools', 'agents', 'sessions', 'sessionPersistence', 'loader'];

const SECTION_NAME = 'unified-memory:digest';

// [2026-10-22 by Assistant · 实跑抓到的真 bug：apply 被调 421 次，最后一次拿空 config]
//
//   探针证据：`section-register.jsonl` 里 04:54:16 起连续三条 ingest-enabled 都是
//   `{master:false, capture:false, extract:false, distill:false}`，
//   而 04:54:15 之前的三条都是全 true。
//
//   根因：DSH 在热装配 / 子系统重建时会**再次调用 apply**，某些轮次传进来的 config 是空对象。
//   旧代码 `const c = config || {}` ⇒ 空对象照单全收 ⇒ 所有子能力按"未配置"处理 ⇒
//   后一次 apply 覆盖前一次，把已经在跑的能力全关掉（定时器也被新的空实例顶替）。
//
//   修法：**记住上一份非空的有效配置**，空配置时沿用它。
//   这是幂等性要求——apply(ctx) 不该因为参数缺失就把已生效的能力清空。
let __lastGoodConfig = null;

// [2026-10-22 by Assistant · 第二次实跑抓到的同类 bug（更隐蔽）]
//
// 上一版只处理「config 是空对象」。但探针抓到的真实形态是：
//   {"l0Effective":true,"hasRetrieval":true}
//   {"l0Effective":false,"hasRetrieval":false}  ← 后面 5 次都这样
// config **不是空的**（有 enabled/budgetTokens），只是**缺了 retrieval 这一段**。
// 旧逻辑判定「非空 ⇒ 有效配置」，于是 l0Enabled 变 false，完整实例建的 L0 索引被顶掉
// ⇒ 生产里 health().l0 === null。
//
// 修法：**按段合并**而不是整份替换。缺的段从上一份补，显式给的键以新的为准。
function mergeConfig(prev, next) {
  if (!prev) return next;
  if (!next) return prev;
  const out = Object.assign({}, prev, next);
  for (const k of Object.keys(prev)) {
    const pv = prev[k];
    const nv = next[k];
    if (pv && nv && typeof pv === 'object' && typeof nv === 'object' && !Array.isArray(pv) && !Array.isArray(nv)) {
      out[k] = Object.assign({}, pv, nv);
    }
  }
  return out;
}

export function apply(ctx, config) {
  const raw = config || {};
  // [2026-10-28] 记下本次 config，供热重载时"用同一份配置重新 apply"
  try { __lastApplyConfig = raw; } catch {}
  // [2026-10-22 by Assistant · 测试隔离]
  //   __lastGoodConfig 是**模块级**累积状态，跨 apply 继承。
  //   生产只有一个插件实例，这是对的；但自测里会连续 apply 多组不同配置，
  //   上一组的 retrieval 会串到下一组（bridge 的 I1~I3 就是这么挂的）。
  //   ⇒ 调用方可用 config.__resetMerge: true 显式要求「本次为全新基准」。
  if (raw && raw.__resetMerge === true) {
    __lastGoodConfig = null;
  }
  const cfgRaw = raw && raw.__resetMerge === true ? Object.assign({}, raw, { __resetMerge: undefined }) : raw;
  const isWholeEmpty = typeof cfgRaw === 'object' && Object.keys(cfgRaw).length === 0;
  let c;
  if (isWholeEmpty && __lastGoodConfig) {
    c = __lastGoodConfig;
  } else if (__lastGoodConfig) {
    c = mergeConfig(__lastGoodConfig, cfgRaw);
  } else {
    c = cfgRaw;
  }
  __lastGoodConfig = c;
  if (c.enabled === false) return;

  // [2026-10-22 by Assistant · 注入诊断] 取证函数必须在最前面定义（否则 TDZ）
  const PROBE_DIR2 = dataPath('probe');
  /**
   * [2026-10-22 by Assistant · 安全红队 M2] 探针文件轮转。
   *
   * 红队指出：assemble.jsonl 是裸 appendFileSync，**无 maxBytes/rotate/保留份数**，
   * 会无限增长（wake/miss 日志有轮转，但探针不走那个 logger）。
   * 这里加：单文件超 8MB 就改名成 `.1`（只保留一份历史），再继续追加。
   * 8MB ≈ 8000 条 assemble 记录，够排查用。
   * 失败一律吞掉（探针不能拖累主流程）。
   */
  const PROBE_MAX_BYTES = 8 * 1024 * 1024;
  function appendProbe(file, line) {
    try {
      const st = _statSync(file);
      if (st.size > PROBE_MAX_BYTES) {
        const bak = file + '.1';
        try { _unlinkSync(bak); } catch {}
        try { _renameSync(file, bak); } catch {}
      }
    } catch {}
    _append(file, line);
  }
  // [2026-10-22] section 内容指纹（判断重启后 system prompt 是否逐字节相同）
  function sha1_16(text) {
    try { return createHash('sha1').update(String(text || ''), 'utf8').digest('hex').slice(0, 16); }
    catch { return 'nohash'; }
  }
  /**
   * [2026-10-22 by Assistant · 探针噪音误判的根治]
   *
   * 真实教训：`section-register.jsonl` 里混着**生产进程**和**测试脚本**两种写入。
   * 我据此得出"DSH 用空 config 重复 apply 把能力关掉了"的错误结论，
   * ——因为那 40 条 `master:false` 全是我自己跑 smoke-apply 时写的。
   *
   * 根治：每条探针记录**带来源标记**，让任何人在读时间线时能一眼分开：
   *   · src:'dsh'  —— 生产进程（DSH 真的 apply 了我）
   *   · src:'test' —— 测试脚本（smoke-apply / selftest 用假 ctx）
   * 判据：假 ctx 没有真实的 systemPrompt 服务？不准。改用**显式开关**：
   *   测试脚本可以在环境变量里设 PM_PROBE_SRC=test，探针就标成 test。
   *   默认看 **argv[1] 是不是 DSH 的入口**（@deepseek-ai/dsh 或 dsh/lib/bin.js）⇒ 'dsh'，否则 'cli'。
   */
  // [2026-10-22 二次修正] 光靠环境变量不够 —— 我用 node 直接跑脚本时也没设，
  //   结果那些记录仍被标成 'dsh'，还是分不清「DSH 主进程」和「我跑的测试」。
  //   现在三层判据：① 环境变量强制 > ② 是否被 shell 启动 > ③ 默认 dsh。
  const PROBE_SRC = (() => {
    try {
      const forced = String(process.env.PM_PROBE_SRC || '').trim();
      if (forced) return forced.slice(0, 16);
      // [2026-10-22 三次修正] COMSPEC 判据**不可靠**：DSH 自己也是从 shell 起的，
      //   实测 DSH 主进程（PID 15448）也被标成了 'cli'。
      //   改用**进程链**判据：DSH 主进程的 argv[1] 里含 '@deepseek-ai/dsh' 或 'dsh/bin'；
      //   我 `node xxx.mjs` 跑脚本时 argv[1] 是那个 .mjs 路径。
      const argv1 = String((process.argv && process.argv[1]) || '');
      if (/@deepseek-ai[\\/]dsh|dsh[\\/]lib[\\/]bin\.js|cordis/i.test(argv1)) return 'dsh';
      // 兜底：脚本名以 .mjs/.js 结尾且不在 dsh 安装树里 ⇒ cli
      return argv1 ? 'cli' : 'dsh';
    } catch { return 'dsh'; }
  })();
  const probeLog = (o) => {
    try {
      _mkdir(PROBE_DIR2, { recursive: true });
      appendProbe(PROBE_DIR2 + '/section-register.jsonl', JSON.stringify({ at: new Date().toISOString(), src: PROBE_SRC, pid: process.pid, ...o }) + '\n');
    } catch {}
  };

  const logger = createLogger(c.logs);
  const journal = createJournalBackend(c.journal);
  const engram = createEngramBackend(c.engram);

  // ── 期2：超图后端（默认只读、不建图；需显式 enable）──
  const hypergraph = createHypergraphBackend(c.hypergraph, logger);

  // ── 期3：三级检索（enabled:false 时 createRetriever 返回 null ⇒ R0 回滚档）──
  //    暖启动**不 await**：355~400ms 的建索引不能卡首字（DESIGN §5 坑 7）
  // [2026-10-22 by Assistant · 向量路] embedding 配置两种写法都认：
  //   ① 顶层 c.embedding（与 tdai-memory 的写法一致，User最可能这么配）
  //   ② 嵌套 c.retrieval.embedding（保持与前几期配置风格一致）
  //   **没有 apiKey ⇒ resolveEndpoint 返回 null ⇒ 检索保持纯 BM25。**
  // [2026-10-22 by Assistant · key 不过手] 如果配置里没给 apiKey，就从 profile 的
  //   tdai-memory 段继承（那里已经有 baseUrl/model/dimensions/key）。
  //   ⇒ User不需要把 key 复述给Assistant，key 只在本机文件之间流动。
  //   继承失败 ⇒ 维持 null ⇒ 检索走纯 BM25（功能不退化）。
  let embeddingCfg = (c.retrieval && c.retrieval.embedding) || c.embedding || null;
  if (!embeddingCfg || !embeddingCfg.apiKey) {
    const profilePath = c.profilePath || normalize(dshHome() + '/profiles/web/cordis.patch.yml');
    const inherited = inheritFromProfile(profilePath);
    if (inherited) {
      embeddingCfg = Object.assign({}, inherited, embeddingCfg || {});
      if (!embeddingCfg.apiKey) embeddingCfg.apiKey = inherited.apiKey;
    }
  }
  const vectorOverrides = {
    l0Enabled: (c.retrieval && c.retrieval.l0Enabled === true) || c.l0Enabled === true,
 l0RecentDays: (c.retrieval && c.retrieval.l0RecentDays) || c.l0RecentDays ||30,
 conversationsDir: c.conversationsDir || DEFAULT_CONVERSATIONS_DIR,
 embedding: embeddingCfg,
    // [2026-10-26 by Assistant · 向量备路] 主路失败时的下级端点。
    //   不配 ⇒ undefined ⇒ resolveEndpoint 返回 null ⇒ 备路完全不参与（行为与接入前相同）。
    //   **只用于查询**：该端点绝不参与 build，不会改 index.json 的 model。
    embeddingFallback: (c.retrieval && c.retrieval.embeddingFallback) || c.embeddingFallback || undefined,
    embeddingDir: (c.retrieval && c.retrieval.embeddingDir) || c.embeddingDir || undefined,
    vectorTopK: (c.retrieval && c.retrieval.vectorTopK) !== undefined ? c.retrieval.vectorTopK : c.vectorTopK,
    vectorMinScore: (c.retrieval && c.retrieval.vectorMinScore) !== undefined ? c.retrieval.vectorMinScore : c.vectorMinScore,
    vectorScale: (c.retrieval && c.retrieval.vectorScale) !== undefined ? c.retrieval.vectorScale : c.vectorScale,
    wVector: (c.retrieval && c.retrieval.wVector) !== undefined ? c.retrieval.wVector : c.wVector,
    // ── [2026-10-27 by Assistant · 第1步 soul-md 第四源] ──
    //   踩坑实录：配置里写了 soulMdEnabled: true，但生产 docs 仍是 9929（没生效）。
    //   根因：createRetriever(Object.assign({}, c.retrieval, vectorOverrides))
    //         —— vectorOverrides 是一份"白名单展开"，没列进来的字段虽然会被 c.retrieval 带进来，
    //         但这里显式展开的字段才保证优先级；而 soulMdEnabled 既没在白名单、
    //         又因为 c.retrieval 里确实有……实测仍失效，说明必须显式透传。
    //   修法：显式列为白名单字段（与 l0Enabled 同等待遇）。
    soulMdEnabled: (c.retrieval && c.retrieval.soulMdEnabled === true) || c.soulMdEnabled === true,
    soulMdRoot: (c.retrieval && c.retrieval.soulMdRoot) || c.soulMdRoot,
  };
  // [2026-10-22 by Assistant · L0 排查探针]
  //   症状：profile 里明明写了 retrieval.l0Enabled: true，但生产实例 health().l0 === null。
  //   必须留下「apply 到底收到了什么」的客观记录，否则只能靠猜。
  try {
    probeLog({
      phase: 'retrieval-config',
      hasRetrieval: !!c.retrieval,
      retrievalKeys: c.retrieval ? Object.keys(c.retrieval) : [],
      l0FromNested: c.retrieval ? c.retrieval.l0Enabled : undefined,
      l0FromTop: c.l0Enabled,
      l0Effective: vectorOverrides.l0Enabled,
      conversationsDir: vectorOverrides.conversationsDir,
      soulMdEnabled: vectorOverrides.soulMdEnabled,
    });
  } catch {}

  const retriever = createRetriever(Object.assign({}, c.retrieval, vectorOverrides), logger);
  if (retriever) {
    void retriever.warmup().then((w) => {
      // 暖启动完成后立刻记录 l0 是否真的建起来了（这是最终判据）
      try { probeLog({ phase: 'retrieval-health', l0: retriever.health().l0, warm: w }); } catch {}
    }).catch(() => {});
  }

  const scorer = createScorer(c.scorer);

  const orchestrator = createOrchestrator({
    backends: [hypergraph, engram, journal],
    scorer,
    logger,
    budgetTokens: c.budgetTokens ?? 450,
    retriever,                       // 期3：可为 null（未启用/未就绪）
  });

  // 源卡表惰性单例（prefetcher 与 workingMemory 共用，避免重复读 23MB）
  //
  // [2026-10-22 by Assistant · 跨源渲染修复] 必须**同时**包含 tdai 卡。
  //   否则 workingMemory.cardHeader() 查不到 tdai 卡 ⇒ 兜底成
  //   `[[tdai:m_xxx]][global]: `（标题是 id、摘要是空、层是默认 global），
  //   注入里全是这种不可读的行。
  let _cardMap = null;
  const cardMap = () => {
    if (_cardMap !== null) return _cardMap;
    const m = new Map();
    try {
      const r = readCards();
      for (const card of r.alive) m.set(String(card.id), card);
    } catch {}
    try {
      if (c.tdaiEnabled !== false) {
        const td = readTdaiRecords(c.tdaiDir || undefined, { since: c.tdaiSince || null });
        if (td && td.cards) for (const tc of td.cards) if (!m.has(tc.id)) m.set(tc.id, tc);
      }
    } catch {}
    // ── [2026-10-24 by Assistant · 重大缺口修复] ──
    //   症状：问「我们刚才在做什么」时，命中里第一条标题是 "text"、
    //         而且**所有卡都没有 ageDays（时间维度全失效）**。
    //   根因：cardMap 只装了 engram 源 + tdai 源，**漏了 readOwnIngest**。
    //         而检索器（buildIndex）是把「engram + tdai + 自产 ingest」三处并进同一个 BM25 的
    //         ⇒ 自产卡（pm:/pmi: 前缀）能被检索出来，但这里查不到它
    //         ⇒ cardHeader() 返回 null ⇒ 标题兜成 id、createdAt=0
    //         ⇒ recencyOf() 返回 {recency:0, ageDays:Infinity}
    //         ⇒ **"越近越详细"（按 recency 分 full/summary/title 档）实际上从未生效**。
    //   这是"检索有、渲染没有"的经典不对称 —— 和上次 entities 漏透传是同一类坑。
    try {
      const own = readOwnIngest(c.ingest && c.ingest.root ? c.ingest.root : undefined);
      if (own && own.cards) {
        for (const oc of own.cards) {
          if (!m.has(String(oc.id))) m.set(String(oc.id), oc);
        }
        probeLog({ phase: 'cardMap-own-ingest', n: own.cards.length, total: m.size });
      }
    } catch (e) {
      probeLog({ phase: 'cardMap-own-ingest-FAILED', err: String(e && e.message || e) });
    }
    _cardMap = m;
    return m;
  };

  // ── P0 接线：pre-step 异步预取 → section 同步读缓存 ──
  //    cardsProvider 惰性加载（首次 pre-step 才读 23MB 源卡），失败也不影响主流程
  // ── 期4 分层工作记忆（可选；开启后接管渲染，期3 只提供候选）──
  //   默认**开启**：User 2026-10-21 要求期4 接管这条链。
  //   回滚：配置 workingMemoryEnabled: false（立刻退回期3 平铺渲染，无需改代码）
  //   另有二次回滚：wm.assemble 抛错时 prefetch 会自动退回平铺（不空窗）
  const wmEnabled = c.workingMemoryEnabled !== false;
  // [2026-10-21 by Assistant · 期4 扩散接线] graph 必须**惰性**给：
  //   retriever.warmup() 是异步且不 await（不能卡首字），建 workingMemory 时 ctx 还没就绪。
  //   所以传一个 getter，真正用时（assemble）再取。
  // [2026-10-24 Round 25] 删死变量 wmInstance —— 声明了从未赋值/使用
  const graphProvider = () => {
    try {
      return retriever && typeof retriever.getGraph === 'function' ? retriever.getGraph() : null;
    } catch { return null; }
  };
  const workingMemory = wmEnabled ? createWorkingMemory({
    enabled: true,
    // [2026-10-22 by Assistant · 路径统一] 默认指向 live，与 profile 配置同源；
    //   C: 那段只留诊断探针（probe/log），不留任何"记忆数据"。
    dir: c.workingMemoryDir || dataPath('working'),
    logger,
    graphProvider,
    // [L1→L0 详情] L0 反查索引：懒建，只有开了 l0Detail 才会真正读盘
    l0IndexProvider: () => {
      try {
        if (c.l0Detail !== true && !(c.retrieval && c.retrieval.l0Detail === true)) return null;
        return buildL0Index(c.conversationsDir || DEFAULT_CONVERSATIONS_DIR);
      } catch (e) { return null; }
    },
    l0Detail: (c.l0Detail === true || (c.retrieval && c.retrieval.l0Detail === true)) ? true : false,
    l0DetailChars: (c.l0DetailChars !== undefined ? c.l0DetailChars
      : (c.retrieval && c.retrieval.l0DetailChars !== undefined ? c.retrieval.l0DetailChars : undefined)),
    // 卡片适配器：L0 渲染需要 title/summary
    cards: {
      header: (id) => {
        const c2 = cardMap().get(String(id)) || (retriever && typeof retriever.getCard === 'function' ? retriever.getCard(id) : null);
        if (!c2) return null;
        // [2026-10-22 by Assistant · 架构修复] 这里原本只给 title/summary/layer，
        //   **把 createdAt 丢了** ⇒ 整条装配链路（候选 → finalScore → 渲染档位）
        //   都没有时间维度，"越近越详细" 无法实现。
        //   另外 layer 的兜底原本是假的 'L3'（把工作记忆档位当成存储层），改成 'global'。
        return {
          id: String(id),
          title: c2.title || '',
          summary: c2.summary || '',
          layer: c2.layer || 'global',
          createdAt: Number(c2.createdAt) || 0,
        };
      },
      get: (id) => {
 const base = cardMap().get(String(id));
 if (base) return base;
 return retriever && typeof retriever.getCard === 'function' ? retriever.getCard(id) : null;
 },
 content: (id) => {
        const c2 = cardMap().get(String(id)) || (retriever && typeof retriever.getCard === 'function' ? retriever.getCard(id) : null);
        return c2 && typeof c2.content === 'string' ? c2.content : null;
      },
    },
  }) : null;

  const prefetcher = createPrefetcher({
    orchestrator,
    workingMemory,
    logger,
    maxChars: c.injectMaxChars ?? 8000,
    enabled: c.prefetchEnabled !== false,
    cardsProvider: cardMap,
    // [2026-10-26 by Assistant · 跨会话脉搏] 传 retriever 以便直读卡片池（不走查询词）
    retriever,
    pulseEnabled: c.crossSessionPulseEnabled !== false,
    pulseWindowMs: c.crossSessionPulseWindowMs,
    pulseLimit: c.crossSessionPulseLimit,
  });

  // agent/pre-step 是异步瀑布：能拿到 messages，是唯一能在 assembly 之前做异步检索的时机。
  //
  // [2026-10-22 by Assistant · 缓存修复] 注入位置从 **system prompt 段** 改为 **消息尾**。
  //   原因：systemPrompt.section 每轮内容不同（检索结果不同）⇒ system 前缀每轮失效
  //        ⇒ prefix cache 全废，缓存命中率一路掉。
  //   engram-relay 早就踩过这个坑（其源码注释：「固定文本，零动态：system 稳定 → 前缀缓存保持命中；
  //   动态召回内容走消息尾注入」），我们把同样的教训再犯了一遍。
  //   修法：pre-step 里 await next() 拿到 decision，把记忆作为一条 durable user message 追加到末尾。
  // [2026-10-24 by Assistant · 日记本] 记住最近一次活跃会话 id，供 diary_write 打标（判重用）
  let __currentSessionId = '';
  // [2026-10-28 by Assistant · P0 注入真伪] 待核验的注入登记（环形，最多 8 条）
  const pendingInjects = [];
  // ── [2026-10-28 · 派单接线] sendMessage 需要真实 caller（Agent 对象）──
  //   官方工具从 exec.agent 拿；插件侧拿不到 exec，只能在 pre-step 里
  //   把 payload.agent 存下来（那是同一次对话里最近的 agent 对象）。
  //   ⛔ 绝不伪造一个 caller —— 拿不到就让调用方明确失败。
  let __lastAgent = null;
  // ── [2026-10-28 by Assistant · 修正 caller 取法] ──
  //   第七次派单暴露的问题：dispatch_send 成功（caller 拿到了），
  //   但随后 dispatch_scan 报 roster-unreadable —— 说明 scan 时拿不到 caller。
  //   根因：scan 和 send 是**两次独立的工具调用**，中间只要有一次 pre-step 换了 agent，
  //        __lastAgent 就不再是"发单那个 Lead"；更糟的是某些情况下它可能是空的。
  //   ⇒ 两条兜底：① 记住"最近一次成功派单用过的 caller"（scan 优先用它）
  //              ② 都没有才用 __lastAgent
  // [2026-10-28 by Assistant · 热重载只读探针结果] 供日后工具化读取（不参与业务判断）
  let __hotReloadReport = null;
  // [2026-10-28 by Assistant · 热重载真执行需要]
  //   __lastApplyConfig: 最近一次 apply 收到的 config（重新 apply 时要用同一个）
  //   __selfModuleUrl  : 本模块的 file:// URL（重新 import 时要用，带查询串绕缓存）
  let __lastApplyConfig = null;
  const __selfModuleUrl = import.meta.url;
  // [2026-10-28 by Assistant · 派单兜底] 从磁盘反查"哪个会话包含这个标记"
  //   背景：重启后目标 agent 可能不在内存（已归档），agents.get() 返回 undefined。
  //   但会话文件还在磁盘上，且 taskId 是唯一标记 ⇒ 扫目录能找到。
  //   ⚠️ 这是兜底，不是主路径；代价是一次目录扫描（会话少时可接受）。
  function __findSessionByTaskId(marker) {
    try {
      // ESM 里不能用 require ⇒ 用文件顶部已有的静态导入（_readFileSync / _readdirSync 等）
      const root = sessionsRoot();
      const hit = String(marker || '');
      if (!hit) return '';
      let wss = [];
      try { wss = _readdirSync(root, { withFileTypes: true }); } catch { return ''; }
      for (const ws of wss) {
        if (!ws.isDirectory()) continue;
        const wsPath = root + '/' + ws.name;
        let subs = [];
        try { subs = _readdirSync(wsPath, { withFileTypes: true }); } catch { continue; }
        for (const sd of subs) {
          if (!sd.isDirectory()) continue;
          const f = wsPath + '/' + sd.name + '/session.v4.jsonl.zstd';
          try {
            const raw = _zstdDecompress(_readFileSync(f)).toString('utf8');
            if (raw.includes(hit)) return sd.name;
          } catch { /* 单个文件坏了/不存在，跳过 */ }
        }
      }
    } catch { /* 整体失败就返回空 */ }
    return '';
  }
  let __lastSendCaller = null;
  function __lastAgentForSend() { return __lastSendCaller || __lastAgent; }
  function __rememberSendCaller(c) { if (c) __lastSendCaller = c; }
  /**
   * 判断会话落盘里是否含某段注入正文指纹。
   *
   * [2026-10-28 by Assistant · 修一个自己写的 bug]
   *   第一版写成 raw.replace(/\\n/g,' ') —— 只把**字面反斜杠+n**换掉，
   *   而会话 JSON 里的换行是**真换行**（\n），于是任何跨行指纹都匹配不上，
   *   会把"注入成功"误判成"注入被吞"。实测抓到的：真指纹在文件里，
   *   归一化后 includes=true，原版却 false ⇒ 误报的注入丢失。
   *
   *   正确做法：先解 JSON 取每条 message 的真实文本，再比对；
   *   解不出时才退化为"剥空白后子串匹配"（仍比字面替换可靠）。
   */
  function containsFingerprint(rawText, fp) {
    if (!fp) return false;
    const want = String(fp).replace(/\s+/g, '');
    if (!want) return false;
    // ① 精确法：逐行解 JSON，只比 message 正文（最干净，不受转义影响）
    try {
      for (const line of rawText.split('\n')) {
        if (line.indexOf('unified-memory') < 0) continue;
        let j; try { j = JSON.parse(line); } catch { continue; }
        if (j.type !== 'user/message') continue;
        const m = (j.data && j.data.message) || j.data;
        if (!m || !m.source || String(m.source.kind || '') !== 'plugin:unified-memory') continue;
        const txt = (m.content || []).map(function (x) { return (x && x.text) || ''; }).join(' ');
        if (String(txt).replace(/\s+/g, '').includes(want)) return true;
      }
    } catch { /* 落到退化路径 */ }
    // ② 退化法：去掉全部空白后子串匹配（真换行、字面 \n 都会被抹掉）
    try { return String(rawText).replace(/\s+/g, '').replace(/\\n/g, '').includes(want); }
    catch { return false; }
  }

  /** 读一个 zstd 会话文件并返回解压后的文本；失败返回空串（调用方按"不可判定"处理）。 */
  function _readFileSyncZstd(p) {
    try {
      const buf = _readFileSync(p);
      try { return _zstdDecompress(buf).toString('utf8'); }
      catch { return buf.toString('utf8'); }   // 未压缩的会话也能读
    } catch { return ''; }
  }
  const disposePreStep = ctx.on('agent/pre-step', async (payload, next) => {
    try {
      const __sid = payload && payload.agent && payload.agent.session && payload.agent.session.id;
      if (__sid) __currentSessionId = String(__sid);
      // [2026-10-28] 存下 agent 对象供 dispatch_send 当 caller（sendMessage 需要它）
      if (payload && payload.agent) __lastAgent = payload.agent;
    } catch {}
    let decision;
    try {
      decision = await next();
    } catch (e) {
      throw e;   // next 失败要原样抛，不吞
    }
    try {
      // ── [2026-10-23 · 白队补充2：撤销公理的自然语言入口] ──
      //   User说「撤销公理：9060XT」⇒ 从待审池标记 revoked。
      //   注意：这只影响**下次冷启动**的合入，当前会话的 system prompt 一个字节不动
      //   （前缀缓存铁律），所以需要重启/新会话才真正从上下文里消失。
      if (c.axiomStagingEnabled === true) {
        try {
          const lastUser = (function () {
            const msgs = (payload && payload.messages) || [];
            for (let i = msgs.length - 1; i >= 0; i--) {
              if (msgs[i] && msgs[i].role === 'user') {
                const ct = msgs[i].content;
                if (typeof ct === 'string') return ct;
                if (Array.isArray(ct)) return ct.map(function (x) { return String(x && (x.text || '') || ''); }).join(' ');
                return '';
              }
            }
            return '';
          })();
          const m = /撤销公理[:：]\s*([^\n，。；]{1,40})/.exec(String(lastUser || ''));
          if (m) {
            const rv = revokeAxiom(c.axiomsPendingPath || null, m[1].trim());
            logger?.info?.('[unified-memory] axiom revoked: target=%s count=%s', m[1].trim(), rv && rv.revoked);
          }
        } catch (e) { /* 撤销失败不影响主流程 */ }
      }

      // [2026-10-24 by Assistant · 日记本] 两条注入合到一次返回里：
      //   旧写法记忆段命中就 `return`，轻推永远轮不到 —— 这是"零接线"的经典形态。
      let extraText = '';
      const entry = await prefetcher.prefetchFor(payload);
      if (entry && typeof entry.text === 'string' && entry.text.length > 0) {
        const msgs = decision && decision.messages;
        if (Array.isArray(msgs)) {
          // 去重：最近 3 条里已有同款记忆段就不再追加（避免多步/重试时重复）
          const tail = msgs.slice(-3).map(function (m) {
            try { return JSON.stringify(m && m.content); } catch { return ''; }
          }).join('');
          const fingerprint = entry.text.slice(0, 80);
          if (!tail.includes(fingerprint)) {
            try { logger?.wake?.({ level: 'inject-tail', chars: entry.text.length, n: entry.n }); } catch {}
            extraText += entry.text;
          } else {
            try { logger?.wake?.({ level: 'inject-skip', reason: 'already-present' }); } catch {}
          }
        }
      }

      // [2026-10-24 by Assistant · 日记本轻推]
      //   今天这个会话还没写过本子 ⇒ 这轮消息尾加一句小提示，每天每会话一次。
      //   只追加到消息尾，不动 system prompt（保前缀缓存）。
      try {
        // 回滚档：prefetchEnabled:false 表示「注入全关」，轻推也一起停（R0 语义）
        const nudge = (c.prefetchEnabled === false) ? null : maybeNudge({ sessionKey: __currentSessionId });
        if (nudge) {
          try { logger?.wake?.({ level: 'diary-nudge', session: __currentSessionId }); } catch {}
          extraText += (extraText ? '\n\n' : '') + nudge;
        }
      } catch {}

      if (extraText) {
        const msgs3 = decision && decision.messages;
        if (Array.isArray(msgs3)) {
          // 去重：消息尾已经有这一段就不再追加（pre-step 每步都会跑）
          const tail3 = msgs3.slice(-4).map(function (m) {
            try { return JSON.stringify(m && m.content); } catch { return ''; }
          }).join('');
          if (extraText.includes('<diary-nudge>') && tail3.includes('<diary-nudge>')) {
            extraText = extraText.replace(/<diary-nudge>[\s\S]*?<\/diary-nudge>/g, '').trim();
            if (!extraText) return decision;
          }
          if (extraText.includes('<unified-memory>') && tail3.includes('<unified-memory>')) {
            extraText = extraText.replace(/<unified-memory>[\s\S]*?<\/unified-memory>/g, '').trim();
            if (!extraText) return decision;
          }
          const injected = {
            id: 'unified-memory-' + Date.now() + '-' + Math.floor(Math.random() * 1e6),
            role: 'user',
            source: { kind: 'plugin:unified-memory', plugin: 'unified-memory' },
            content: [{ type: 'text', text: extraText }],
          };
          // ── [2026-10-28 by Assistant · P0 注入真伪] 落到"待核验"名单 ──
          //   他山之石（淋雨家自审 P0）：插件把消息标成引擎保留 kind `runtime-context`，
          //   引擎只对"非 runtime-context"落盘 ⇒ 正文被静默丢弃，日志却照写 inject 成功。
          //   我们的 kind 是自有 `plugin:unified-memory`，走 else 分支，理论上安全；
          //   但"理论安全"不算证据 —— 这里登记一笔，回合结束后回捞会话落盘核对。
          try {
            const sidNow = (payload && payload.agent && payload.agent.session && payload.agent.session.id) || '';
            pendingInjects.push({
              sessionId: String(sidNow),
              at: Date.now(),
              chars: extraText.length,
              // 用注入正文里最独特的一小段当指纹（标签头不是唯一判据，正文才算）
              fingerprint: extraText.replace(/\s+/g, ' ').slice(120, 200) || extraText.slice(0, 80),
            });
            while (pendingInjects.length > 8) pendingInjects.shift();
          } catch { /* 登记失败不影响注入本身 */ }
          return { ...decision, messages: [...msgs3, injected] };
        }
      }
    } catch (e) {
      // prefetchFor 内部已 catch；这层是最后一道保险，绝不让记忆拖垮整轮
      try { logger?.miss?.({ level: 'pre-step-inject', reason: String(e && e.message || e) }); } catch {}
    }
    return decision;
  });

  // ── [2026-10-28 by Assistant · P0 注入落盘回捞] ────────────────────────
  //   他山之石：淋雨家自审发现「插件标了引擎保留 kind runtime-context ⇒ 正文被
  //   静默丢弃，日志照写 inject 成功」。那种假成功只能靠"回捞落盘"证伪。
  //
  //   本钩子做的就一件事：回合结束时，把刚才登记的那笔注入拿去会话落盘里找。
  //     找到   ⇒ 记 inject-verified（真的进了历史，模型一定看得见）
  //     找不到 ⇒ 记 recordFault('inject','miss') + 日志 inject-miss（这是 P0 级事故）
  //
  //   判据用**正文指纹**而不是标签头：标签头谁都能写，正文才是内容本身。
  //   读盘失败一律当作"无法判定"，记 skip —— 绝不把环境问题误报成注入故障。
  let disposeInjectVerify = null;
  try {
    if (typeof ctx.on === 'function') {
      disposeInjectVerify = ctx.on('agent/turn-stopping', (payload) => {
        try {
          if (!pendingInjects.length) return;
          const sid = String((payload && payload.agent && payload.agent.session && payload.agent.session.id) || '');
          const target = pendingInjects.find((x) => !sid || !x.sessionId || x.sessionId === sid) || pendingInjects[pendingInjects.length - 1];
          if (!target) return;
          // 落盘是异步的：给写入让路，延迟核验（不阻塞回合）
          setTimeout(() => {
            try {
              let found = false, readable = false;
              const roots = [sessionsRoot()];
              const files = [];
              const walk = (dir, depth) => {
                if (depth > 3) return;
                let ents = [];
                try { ents = _readdirSync(dir, { withFileTypes: true }); } catch { return; }
                for (const e of ents) {
                  const p = dir + '/' + e.name;
                  if (e.isDirectory && e.isDirectory()) walk(p, depth + 1);
                  else if (/\.zstd$/.test(e.name)) files.push(p);
                }
              };
              for (const root of roots) walk(root, 0);
              files.sort();
              // 只挑最近改动的几个（每次全扫 900MB 不现实）
              const cand = [];
              for (const f of files) {
                try { cand.push({ f, m: _statSync(f).mtimeMs }); } catch {}
              }
              cand.sort((a, b) => b.m - a.m);
              for (const c1 of cand.slice(0, 3)) {
                if (found) break;
                try {
                  const raw = _readFileSyncZstd(c1.f);
                  if (!raw) continue;
                  readable = true;
                  found = containsFingerprint(raw, target.fingerprint);
                } catch {}
              }
              if (!readable) {
                try { logger?.wake?.({ level: 'inject-verify-skip', reason: 'session-unreadable', chars: target.chars }); } catch {}
                return;
              }
              if (found) {
                try { logger?.wake?.({ level: 'inject-verified', chars: target.chars, session: sid.slice(0, 18) }); } catch {}
                const i = pendingInjects.indexOf(target);
                if (i >= 0) pendingInjects.splice(i, 1);
              } else {
                try { logger?.miss?.({ level: 'inject-miss', chars: target.chars, session: sid.slice(0, 18) }); } catch {}
                recordFault('inject', 'miss', '日志报注入 ' + target.chars + ' 字，但会话落盘里找不到注入正文指纹');
              }
            } catch (e) {
              try { logger?.wake?.({ level: 'inject-verify-skip', reason: String(e && e.message || e).slice(0, 80) }); } catch {}
            }
          }, 3000);
        } catch { /* 核验失败绝不能拖垮回合 */ }
      });
    }
  } catch { /* 钩子注册失败不影响主流程 */ }

  // 回合收尾：把 L0 写回激活（EWMA）+ 落盘，供下次/重启恢复 L1
  let disposeTurn = null;
  if (wmEnabled) {
    // [2026-10-21 by Assistant · bug 修复] agent/turn-stopping 是 @mode serial，**没有 next()**！
    //   原代码写成 waterfall 样式的 `return next()` ⇒ next 为 undefined，调用即 TypeError，
    //   生产环境从未提交成功（日志只在 selftest 里出现过 wm-commit，那里我手传了 next）。
    //   serial 模式：直接做事，return 值被忽略。
    disposeTurn = ctx.on('agent/turn-stopping', (payload) => {
      try {
        const sid = payload && payload.agent && payload.agent.session && payload.agent.session.id;
        prefetcher.commitTurn(sid);
      } catch (e) {
        try { logger?.miss?.({ level: 'turn-stopping-error', reason: String(e && e.message || e) }); } catch {}
      }
      // ── [2026-10-24 Step 3] 采纳核验补 hits ──
      //   红队铁律：召回 ≠ 被使用。只有最终回复真引用了卡片（实体命中 / ≥2 个非常见 bigram）
      //   才 +1，否则陪跑卡会把 hits 刷成铜墙铁壁（马太死锁）。
      //   全程异步 + try-catch：绝不影响主对话。
      try {
        const fourOn = (function () {
          try {
            if (c.fourForcesEnabled === true) return true;
            if (c.fourForcesEnabled === false) return false;
            return loadLiveConfig().fourForcesEnabled === true;
          } catch { return false; }
        })();
        if (fourOn) {
          const sid = payload && payload.agent && payload.agent.session && payload.agent.session.id;
          const ids = (prefetcher && typeof prefetcher.lastInjectedIds === 'function') ? prefetcher.lastInjectedIds(sid) : [];
          if (ids && ids.length) {
            let reply = '';
            try {
              const msgs = payload && payload.agent && payload.agent.session && typeof payload.agent.session.deriveMessages === 'function'
                ? (payload.agent.session.deriveMessages() || []) : [];
              for (let i = msgs.length - 1; i >= 0; i -= 1) {
                const m = msgs[i];
                if (m && m.role === 'assistant') {
                  const ct = m.content;
                  if (typeof ct === 'string') reply = ct;
                  else if (Array.isArray(ct)) reply = ct.map(function (x) { return String((x && x.text) || ''); }).join(' ');
                  break;
                }
              }
            } catch {}
            if (reply) {
              const cards = ids.map(function (id) {
                try { return cardMap().get(String(id)) || null; } catch { return null; }
              }).filter(Boolean);
              if (cards.length) {
                setTimeout(function () {
                  try {
                    // ── [2026-10-24 by Assistant · Round 9 抓到的真 bug] ──
                    //   原来**所有**采纳都写到 ingest/engrams.jsonl。
                    //   但卡片的真实归属有三处：
                    //     · engram-relay/engrams.jsonl    ← 主库（5735 张，25MB）
                    //     · unified-memory/ingest/engrams.jsonl ← 自产蒸馏卡（239 张）
                    //     · unified-memory/ingest/records/*.jsonl ← L1 卡（每天一个文件）
                    //   给主库的卡把 hits 写进自产库 = 主库 hits 永远不涨（等于没做）。
                    //   现在按 id 前缀分流：
                    //     pmi: → 自产 engrams；pm: → 当天 records；其余(tdai:/em...) → 主库
                    const OWN_ENG = dataPath('ingest/engrams.jsonl');
                    const MAIN_ENG = dataPath('engram-relay/engrams.jsonl');
                    const own = [], main = [], l1 = [], tdai = [];
                    for (const cd of cards) {
                      const id = String(cd && cd.id || '');
                      if (id.startsWith('pmi:')) own.push(cd);
                      else if (id.startsWith('pm:')) l1.push(cd);
                      // ── [2026-10-24 by Assistant · Round 36 抓到的归属错位] ──
                      //   tdai 卡的**原始数据在按天文件里**（memory-tdai/records/YYYY-MM-DD.jsonl），
                      //   不在主库。原来把它归进 main ⇒ 往主库文件追加 tdai 行
                      //   ⇒ 主库里出现 28 行"孤儿"（原 tdai 源根本不认这些行，
                      //     下次读 tdai 仍是老值 ⇒ hits 永远不涨，还污染主库）。
                      //   正确做法：tdai 卡写回它**自己的按天文件**。
                      else if (id.startsWith('tdai:')) tdai.push(cd);
                      else main.push(cd);
                    }
                    const results = [];
                    if (main.length) results.push({ tag: 'main', r: commitAdoptions({ cards: main, reply, file: MAIN_ENG }) });
                    if (own.length) results.push({ tag: 'own', r: commitAdoptions({ cards: own, reply, file: OWN_ENG }) });
                    if (tdai.length) {
                      // tdai 按天分文件：按 createdAt 找到对应那天
                      const TDAI_REC = dataPath('memory-tencentdb/memory-tdai/records');
                      const byFile2 = new Map();
                      for (const cd of tdai) {
                        const d = Number(cd && cd.createdAt) || Date.now();
                        const dt = new Date(d);
                        const p3 = dt.getFullYear() + '-' + String(dt.getMonth() + 1).padStart(2, '0') + '-' + String(dt.getDate()).padStart(2, '0');
                        const f2 = TDAI_REC + '/' + p3 + '.jsonl';
                        if (!byFile2.has(f2)) byFile2.set(f2, []);
                        byFile2.get(f2).push(cd);
                      }
                      for (const [f2, list] of byFile2) {
                        results.push({ tag: 'tdai:' + f2.slice(-16), r: commitAdoptions({ cards: list, reply, file: f2 }) });
                      }
                    }
                    if (l1.length) {
                      // L1 卡按 createdAt 落到当天文件；跨天就用今天的
                      const byFile = new Map();
                      for (const cd of l1) {
                        const d = Number(cd && cd.createdAt) || Date.now();
                        const dt = new Date(d);
                        const p2 = dt.getFullYear() + '-' + String(dt.getMonth() + 1).padStart(2, '0') + '-' + String(dt.getDate()).padStart(2, '0');
                        const f = dataPath('ingest/records/') + p2 + '.jsonl';
                        if (!byFile.has(f)) byFile.set(f, []);
                        byFile.get(f).push(cd);
                      }
                      for (const [f, list] of byFile) results.push({ tag: 'l1:' + f.slice(-16), r: commitAdoptions({ cards: list, reply, file: f }) });
                    }
                    const total = results.reduce((a, x) => a + (x.r && x.r.bumped || 0), 0);
                    try { logger?.wake?.({ level: 'adoption', bumped: total, groups: results.map((x) => x.tag + ':' + (x.r && x.r.bumped || 0)) }); } catch {}
                  } catch (e) {
                    try { logger?.miss?.({ level: 'adoption-error', reason: String(e && e.message || e) }); } catch {}
                  }
                }, 30);
              }
            }
          }
        }
      } catch (e) {
        try { logger?.miss?.({ level: 'adoption-wire-error', reason: String(e && e.message || e) }); } catch {}
      }
    });
  }

  // [2026-10-22 by Assistant · 注入诊断最终取证]
  //   注册 system-prompt/assemble 的 waterfall 监听：**不改 assembly**，只把最终结果写盘。
  //   这是唯一能证明「我的 section 到底在不在最终 prompt 里」的客观手段。
  let disposeAssembleProbe = null;
  // [2026-10-22 期7-D] persona 注入的会话级快照（同会话逐字节稳定）
  const personaCtxSnapshots = new Map();
  // [2026-10-22 期7-D] scene-navigation 注入的会话级快照
  const sceneNavSnapshots = new Map();
  try {
    if (typeof ctx.on === 'function') {
      disposeAssembleProbe = ctx.on('system-prompt/assemble', async (assembly, context, next) => {
        let result = assembly;
        try { result = (typeof next === 'function') ? await next() : assembly; } catch (e) { result = assembly; }

        // [2026-10-22 by Assistant · 期7-D 关旧前置 —— persona 注入接管]
        //
        //   追踪结论：tdai 的 user-persona 不是写在 system 里，
        //   而是往 assembly.contexts 追加一条 {name:'tdai:profile', order:1001}。
        //   这是独立的 context 通道 => 不破 system 前缀缓存。
        //
        //   关掉 tdai 后，超图用同一个通道接管，位置一致、行为一致。
        //   开关 personaInject（默认关），内容按会话快照固化（逐字节稳定）。
        try {
          if (c.personaInject === true) {
            const sid = String(
              (assembly && assembly.agent && (assembly.agent.sessionId || (assembly.agent.session && assembly.agent.session.id)))
              || 'anon'
            );
            if (!personaCtxSnapshots.has(sid)) {
              personaCtxSnapshots.set(sid, null);
              const p = readPersona(
                c.personaSrc || DEFAULT_PERSONA_SRC,
                c.personaNotesPath || null
              );
              if (p && p.text) {
                const budget = Number(c.personaMaxChars) || 3000;
                const body = '<user-persona>' + String.fromCharCode(10) + p.text.slice(0, budget) + String.fromCharCode(10) + '</user-persona>';
                personaCtxSnapshots.set(sid, body);
                probeLog({ phase: 'persona-injected', src: p.source, chars: body.length, degraded: !!p.degraded });
              }
            }
            const personaText = personaCtxSnapshots.get(sid);
            if (personaText) {
              const ctxs = Array.isArray(result.contexts) ? result.contexts.slice() : [];
              if (!ctxs.some((x) => String(x && x.name) === 'Assistant:persona')) {
                ctxs.push({ name: 'Assistant:persona', order: 1001, text: personaText });
              }
              result = Object.assign({}, result, { contexts: ctxs });
            }
          }

          // ── scene-navigation 接管（期7-D 前置）──
          //   数据源：tdai 的 scene_blocks META 段（10 个场景、11099 字摘要，
          //   是跨会话累积的真实主题叙事）。**不用超图 topics 生成** ——
          //   实测 439 个 content topic 全只有 1 成员，是单条标签不是聚类。
          //   开关 sceneNavInject（默认关），按会话快照固化。
          if (c.sceneNavInject === true) {
            const sid2 = String(
              (assembly && assembly.agent && (assembly.agent.sessionId || (assembly.agent.session && assembly.agent.session.id)))
              || 'anon'
            );
            if (!sceneNavSnapshots.has(sid2)) {
              sceneNavSnapshots.set(sid2, null);
              const nav = generateSceneNavigation(c.sceneNavDir, {
                maxScenes: Number(c.sceneNavMaxScenes) || 10,
                maxTotalChars: Number(c.sceneNavMaxChars) || 4000,
              });
              if (nav && nav.text) {
                // [2026-10-26 by Assistant · 跨会话同步修复] **必须标数据生成日期**。
                //
                // 事故：2026-10-22 期7-D 把 tdai-memory 关停（它是 scene_blocks 的唯一生产者），
                //   但 unified-memory 仍在读那几个 md ⇒ 注入里的「跨会话全景」整整 4 天
                //   都是 10-21 的化石，而且**没有任何日期标注**，模型把它当成"现在"，
                //   于是出现「现在还是 10 月 21 日」的时空错乱（另一会话因此连时间基准都算错了）。
                //
                // 修法：不删内容（里面有用户偏好/职业/项目全景，今天仍然有效），
                //   而是把真实生成日期写进注入，并提示最新动态看消息尾的 cross-session-pulse。
                let stamp = '';
                try {
                  const dir = String(c.sceneNavDir || dataPath('memory-tencentdb/memory-tdai/scene_blocks'));
                  let newest = 0;
                  for (const f of _readdirSync(dir)) {
                    if (!f.endsWith('.md')) continue;
                    const st2 = _statSync(dir + '/' + f);
                    if (st2.mtimeMs > newest) newest = st2.mtimeMs;
                  }
                  if (newest > 0) {
                    const d = new Date(newest);
                    const ageDays2 = Math.floor((Date.now() - newest) / 86400000);
                    stamp = '（本段为**静态背景**，数据生成于 ' + d.getFullYear() + '-' +
                      String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0') +
                      '，已 ' + ageDays2 + ' 天未更新；最新跨窗口动态请看消息尾部的 cross-session-pulse）\n';
                    if (ageDays2 > 7) {
                      try { probeLog({ phase: 'scene-nav-STALE', ageDays: ageDays2, oldestSource: d.toISOString() }); } catch {}
                    }
                  }
                } catch (e2) {}
                sceneNavSnapshots.set(sid2, stamp + nav.text);
                probeLog({ phase: 'scene-nav-injected', scenes: nav.scenes, chars: nav.totalChars, stamped: !!stamp });
              }
            }
            const navText = sceneNavSnapshots.get(sid2);
            if (navText) {
              const ctxs2 = Array.isArray(result.contexts) ? result.contexts.slice() : [];
              if (!ctxs2.some((x) => String(x && x.name) === 'Assistant:scene-nav')) {
                ctxs2.push({ name: 'Assistant:scene-nav', order: 1002, text: navText });
              }
              result = Object.assign({}, result, { contexts: ctxs2 });
            }
          }
        } catch (e) {
          try { probeLog({ phase: 'persona-inject-FAILED', err: String(e && e.message || e) }); } catch {}
        }

        try {
          const dir = dataPath('probe');
          _mkdir(dir, { recursive: true });
          appendProbe(dir + '/assemble.jsonl', JSON.stringify({
            at: new Date().toISOString(),
            inSections: (assembly.sections || []).map((s) => s.name),
            // [2026-10-22 by Assistant · 缓存指纹] 长度相同 ≠ 内容相同。
        //   上游 prefix cache 是按 **token 序列** 比对的，所以必须记 hash 才能判断
        //   「重启后 system prompt 是否逐字节相同」。sha1 前缀 16 位够用且不泄内容。
        outSections: (result.sections || []).map((s) => {
          const t = String(s.text || '');
          return { name: s.name, len: t.length, h: sha1_16(t), order: Number(s.order) || 0 };
        }),
        outHash: sha1_16((result.sections || []).map((s) => String(s.text || '')).join('\u0000')),
        outChars: (result.sections || []).reduce((a, s) => a + String(s.text || '').length, 0),
            outContexts: (result.contexts || []).map((s) => s.name),
          }) + '\n');
        } catch {}
        return result;
      });
      probeLog({ phase: 'assemble-probe-registered' });
    }
  } catch (e) {
    probeLog({ phase: 'assemble-probe-FAILED', err: String(e && e.message || e) });
  }

  // ── 期7：写入侧（默认关闭；ingest.enabled: true 才挂）──
  //   与检索侧完全解耦：即使写侧全关，读侧照常工作（回滚只需删一个开关）。
  let ingest = null;
  try {
    ingest = createIngest(ctx, c.ingest, logger);
    if (ingest) probeLog({ phase: 'ingest-enabled', dir: ingest.dirs.root, llm: ingest.llm, enabled: ingest.enabled });
  } catch (e) {
    probeLog({ phase: 'ingest-FAILED', err: String(e && e.message || e) });
    ingest = null;
  }

  // ── 超图索引自动保鲜（坑6）──
  //   症状：manifest.builtAt 比 engrams.jsonl 旧好几小时，ghostCards 出现，
  //         新卡要等重启才看得见。根因是"没有任何机制让索引跟上源数据"。
  //   这里挂一个按需重建器：算源签名 → 变了才 rebuild（内部增量、只写脏片）。
  //   回滚：config.hypergraphAutoRefresh === false（默认开启）
  let autoRefresh = null;
  try {
    const hgCfg = c.hypergraph || {};
    autoRefresh = createAutoRefresh({
      indexRoot: hgCfg.indexRoot || dataPath('hypergraph'),
      source: hgCfg.source || dataPath('engram-relay/engrams.jsonl'),
      tdaiDir: c.tdaiDir || dataPath('memory-tencentdb/memory-tdai/records'),
      intervalMs: hgCfg.autoRefreshIntervalMs,
      enabled: c.hypergraphAutoRefresh !== false,
      logger,
    });
    autoRefresh.start();
    probeLog({ phase: 'auto-refresh-started', status: autoRefresh.status() });
  } catch (e) {
    probeLog({ phase: 'auto-refresh-FAILED', err: String(e && e.message || e) });
    autoRefresh = null;
  }

  // ── 日记本（2026-10-24 by Assistant · User批「开工」）──
  //   一位Assistant、多副身体：任意会话都能写，两本分开，不进检索。
  //   回滚：diary.enabled=false（活配置，改文件即生效，无需重启）。
  let diaryDisposers = [];
  try {
    const dCfg = c.diary || {};
    if (dCfg.enabled !== false) {
      const diaryTools = createDiaryTools({
        logger,
        getSessionKey: () => __currentSessionId || '',
      });
      // [2026-10-24 修 · 重启后实跑抓到的真 bug]
      //   探针写着：diary-tool-FAILED / cannot get property tools without inject
      //   根因：inject 只声明了 systemPrompt。修法：文件顶部 inject 补 'tools'。
      //   这里仍然兜一层 try —— 测试桩 / 老版本 DSH 没有 tools 服务时不能把整插件带崩。
      for (const t of (Array.isArray(diaryTools) ? diaryTools : [diaryTools])) {
        try {
          const off = ctx.tools.register(t);
          diaryDisposers.push(off);
        } catch (e) {
          probeLog({ phase: 'diary-tool-FAILED', name: t && t.name, err: String(e && e.message || e) });
        }
      }
      probeLog({ phase: 'diary-tools-registered', n: diaryDisposers.length });

      // ── [2026-10-25 by Assistant · 红白双队终裁指令] ──
      //   注册对话层主动记忆三手柄：memory_search / memory_get / memory_refute
      try {
        const memTools = createMemoryTools({
          retriever,
          cardMap,
          prefetcher,
          getSessionId: () => __currentSessionId || '',
          logger,
        });
        for (const t of (Array.isArray(memTools) ? memTools : [memTools])) {
          try {
            const off = ctx.tools.register(t);
            diaryDisposers.push(off);
          } catch (e) {
            probeLog({ phase: 'memory-tool-FAILED', name: t && t.name, err: String(e && e.message || e) });
          }
        }
        probeLog({ phase: 'memory-tools-registered', n: memTools.length });
      } catch (e) {
        probeLog({ phase: 'memory-tools-init-FAILED', err: String(e && e.message || e) });
      }

      // ── [2026-10-28 by Assistant · 热重载可行性 · 第一步只读探针] ──
      //   ⛔ 只读：不 dispose、不 update、不 remove、不改配置。
      //   目的只有一件事：把"能不能拿到 loader / 找不找得到自己 / 有没有 fiber"
      //   这三件事如实记进日志，供后续决定要不要做第二步。
      //   结果不参与任何业务判断 —— 它红了也不影响插件正常工作。
      try {
        const hrp = createHotReloadProbe({ logger });
        const rep = hrp.probeAndLog(() => ctx.loader, 'unified-memory');
        // [2026-10-28 修一个小 bug] 原来写的是 `state.hotReloadReport = rep`，
        //   但本作用域里**根本没有 state 变量** ⇒ ReferenceError。
        //   探针结果在抛错前已经写进日志了（所以三问数据是真的），
        //   但这个异常会让 "hotreload-probe-FAILED" 看起来像探针自己坏了。
        //   ⇒ 改成本地变量 + 挂到闭包外可读的位置。
        __hotReloadReport = rep;
      } catch (e) {
        probeLog({ phase: 'hotreload-probe-FAILED', err: String(e && e.message || e) });
      }

      // ── [2026-10-28 by Assistant · 热重载第三步：两个工具] ──
      //   hotreload_probe  = 纯只读（随时可调，永远安全）
      //   hotreload_dryrun = 预检 + 报告计划（零风险，不动手）
      //   ⛔ 真执行（dispose + reload）的工具**暂不注册** ——
      //      第三步只走到"看计划"，真动手要User明确点头。
      try {
        const hrTools = createHotReloadTools({
          logger,
          getLoader: () => ctx.loader,
          selfId: 'unified-memory',
          // ── [2026-10-28 by Assistant · 真执行 —— 已实测失败，改为诚实拒绝] ──
          //   19:43 真跑了一次 hotreload_apply{confirm:true}，结果：
          //     steps: precheck ok → armed rescue → scheduled reload → disposed self
          //     然后 **插件再也没回来**（工具全消失，日志无 rescue）。
          //   根因（三个真缺陷）：
          //     ① 重装回调用了已被 dispose 的 p.ctx ⇒ apply 抛错；
          //     ② catch 静默 ⇒ 失败无痕，看起来"安排了"其实什么都没发生；
          //     ③ 保险和被保对象用同一个死掉的 ctx ⇒ 保险等于没有。
          //   ⇒ 结论：**进程内自愈做不到**（除非宿主提供外部重装器）。
          //   ⇒ 本版改为：没有可靠外部重装器就**拒绝自拆**，绝不再拆了自己装不回来。
          rotate: async () => {
            const { rotateSelf } = await import('./dispatch/hotreload-exec.js');
            return rotateSelf({
              getLoader: () => ctx.loader,
              selfId: 'unified-memory',
              ctx,
              config: __lastApplyConfig || {},
              moduleUrl: __selfModuleUrl,
              rescueDelayMs: 5000,
              // ⛔ 故意不提供 externalReload ⇒ rotateSelf 会拒绝执行。
              //   将来若找到可靠的宿主重装入口，在这里注入即可。
            });
          },
        });
        let hrOk = 0;
        const hrFailed = [];
        for (const t of (Array.isArray(hrTools) ? hrTools : [hrTools])) {
          try { ctx.tools.register(t); hrOk++; } catch (e) {
            hrFailed.push(String((t && t.name) || '?'));
            probeLog({ phase: 'hotreload-tool-FAILED', name: t && t.name, err: String(e && e.message || e) });
          }
        }
        probeLog({ phase: hrFailed.length ? 'hotreload-tools-PARTIAL' : 'hotreload-tools-registered', ok: hrOk, failed: hrFailed.length });
      } catch (e) {
        probeLog({ phase: 'hotreload-tools-init-FAILED', err: String(e && e.message || e) });
      }

      // ── [2026-10-28 by Assistant · 派单回执状态机 v1] ──
      //   三手柄：dispatch_send（发单+Write-Ahead）/ dispatch_scan（对账）/ dispatch_close（销账）
      //   判据来源见 lib/dispatch/state-machine.js 头部行号表。
      //   ⛔ 已废除：turnCount（不存在）/ mtime（整包重写）/ inactive 当死（健康空闲）
      try {
        const dispatchLedger = createLedger({ logger });
        const dispatchTools = createDispatchTools({
          ledger: dispatchLedger,
          logger,
          // ── [2026-10-28 by Assistant · 修正真实签名] ──
          //   第一次真实派单报错：Cannot read properties of undefined (reading 'signal')
          //   根因：`sendMessage(caller, request)` 是**两个参数**，
          //        caller 必须是"当前调用工具的那个 Agent 对象"，
          //        request 形如 { target, content:[{type:'text',text}], signal }。
          //        我原来只传了一个 { target, message } ⇒ request 变成 undefined。
          //   caller 从哪来：官方工具用 exec.agent（工具执行上下文里的 agent）。
          //        我们拿不到 exec，退一步用 payload.agent 存的最近活跃 agent；
          //        两者都没有就明确报错（绝不猜一个假的 caller）。
          sendMessage: async (callerIn, request) => {
            // [2026-10-31 · 软依赖] agentTeams 不在 inject 里（它来自实验插件）。
            //   用 ctx.get() 读：注释原文是 "Read a service from the store without
            //   the inject requirement" ⇒ 服务没提供时返回 undefined，不会让插件不激活。
            const teams = ctx.get('agentTeams');
            if (!teams || typeof teams.sendMessage !== 'function') {
              throw new Error('agentTeams.sendMessage unavailable: 该服务未注入或团队功能未启用');
            }
            // caller 优先用 tool.js 传进来的（未来可接 exec.agent），退用 pre-step 存的 agent
            const caller = callerIn || __lastAgentForSend();
            if (!caller) {
              throw new Error('sendMessage 需要 caller（当前 Agent），但本插件拿不到 exec.agent；请在工具上下文内调用');
            }
            // ── [2026-10-28 by Assistant · 第五次修正] ──
            //   mailbox.send 内部做 AbortSignal.any([request.signal, lifecycle.signal])，
            //   request.signal **必须是真正的 AbortSignal**，缺了会报
            //   "signals[0] is not of type AbortSignal"。
            //   ⇒ 从 tool.js 一路传下来的 request.signal 必须有；没有就明确报错（不猜、不伪造）。
            const sig = request && request.signal;
            if (!sig || typeof sig.aborted !== 'boolean') {
              throw new Error('sendMessage 需要 AbortSignal（execute 的 exec.signal 没传下来）');
            }
            const out = await teams.sendMessage(caller, {
              target: String((request && request.target) || ''),
              content: Array.isArray(request && request.content) ? request.content : [{ type: 'text', text: '' }],
              signal: sig,
            });
            // 记住这个 caller：后续 dispatch_scan 需要同一个 agent 才能查名册
            __rememberSendCaller(caller);
            return out;
          },
          // ── [2026-10-28 by Assistant · 第六次真实派单抓到的误报根因] ──
          //   现象：派单明明成功、回执也回来了，dispatch_scan 却判 dead_target。
          //   根因：正确方法名是 **listMembers(caller)**，
          //        我写成了 listAgents()（拼错）⇒ 名册恒为空 ⇒ 每个在途目标都"查不到"
          //        ⇒ exists:false ⇒ 判 member-object-missing ⇒ **误报死目标**。
          //   这是今天最该记住的一类：**查询接口名写错，静默返回空**，
          //        而空数组在状态机眼里就是"人不在了"。
          //   ⇒ 修：用 listMembers(caller)；取不到就返回 null（区分"空名册"和"读失败"）。
          getAgents: () => {
            // [2026-10-28 诊断] 每条返回 null 的路径都记日志，避免"静默返回空"再坑一次
            try {
              const teams = ctx.get('agentTeams');   // [2026-10-31] 软依赖，见上
              if (!teams || typeof teams.listMembers !== 'function') {
                try { logger && logger.miss && logger.miss({ level: 'dispatch-getAgents-null', reason: 'no-teams-service' }); } catch {}
                return null;
              }
              const caller = __lastAgentForSend();
              if (!caller) {
                try { logger && logger.miss && logger.miss({ level: 'dispatch-getAgents-null', reason: 'no-caller' }); } catch {}
                return null;
              }
              const list = teams.listMembers(caller);
              if (!Array.isArray(list)) {
                try { logger && logger.miss && logger.miss({ level: 'dispatch-getAgents-null', reason: 'bad-return', type: typeof list }); } catch {}
                return null;
              }
              try { logger && logger.wake && logger.wake({ level: 'dispatch-getAgents-ok', n: list.length, names: list.map(function (m) { return String(m && m.name || ''); }).join(',') }); } catch {}
              return list;
            } catch (e) {
              try { logger && logger.miss && logger.miss({ level: 'dispatch-getAgents-failed', reason: String(e && e.message || e || '') }); } catch {}
              return null;   // null = 读不到（上层要判 undetermined，不能当"没人"）
            }
          },
          // ── [2026-10-28 by Assistant · 自动解析目标会话 id] ──
          //   为什么需要：dispatch_send 时若没传 targetSessionId，台账 dstSessionId 为空，
          //   事件源就永远读不到 ⇒ 恒判 undetermined（虽然"不误报"，但也"永远不知道"）。
          //   名册成员的 id 就是 agent id ⇒ ctx.agents.get(id).session.id 即会话 id。
          //   ⛔ 取不到就返回空串（下游保持 undetermined），不许瞎猜。
          getAgentSessionId: (agentIdOrName) => {
            try {
              const key = String(agentIdOrName || '');
              if (!key) return '';
              const agents = ctx.agents;
              if (!agents || typeof agents.get !== 'function') return '';
              // 先按 id 直接取；取不到再按名字在名册里找 id
              let agent = agents.get(key);
              if (!agent) {
                const teams = ctx.get('agentTeams');   // [2026-10-31] 软依赖，见上
                const caller = __lastAgentForSend();
                if (teams && typeof teams.listMembers === 'function' && caller) {
                  const list = teams.listMembers(caller) || [];
                  const hit = list.find(function (m) { return String(m && m.name || '') === key; });
                  if (hit && hit.id) agent = agents.get(hit.id);
                }
              }
              let sid = agent && agent.session && agent.session.id;

              // ── [2026-10-28 by Assistant · 兜底：从磁盘反查] ──
              //   线上实测（19:27 日志）：重启后 agents.get(sid) 返回 undefined
              //   （hasAgent:false / hasSession:false），因为目标 agent 不在内存。
              //   ⇒ 加一条磁盘兜底：扫 sessions 目录里哪个会话**包含该 taskId**。
              //      这不是瞎猜——taskId 是我们自己写的、唯一的标记，命中即证据。
              if (!sid && key) {
                try {
                  const found = __findSessionByTaskId(key);
                  if (found) sid = found;
                } catch { /* 兜底失败就保持空 */ }
              }
              // [2026-10-28 诊断] 解析链每一环都记一笔，便于定位"卡在哪一步"
              try {
                logger && logger.wake && logger.wake({
                  level: 'dispatch-resolve-sid',
                  key,
                  hasAgentsService: !!(agents && typeof agents.get === 'function'),
                  hasAgent: !!agent,
                  hasSession: !!(agent && agent.session),
                  sid: sid ? String(sid) : '',
                });
              } catch {}
              return sid ? String(sid) : '';
            } catch (e) {
              try { logger && logger.miss && logger.miss({ level: 'dispatch-resolve-sid-throw', reason: String(e && e.message || e) }); } catch {}
              return '';
            }
          },
          // getSessionEvents：真读目标会话的新增事件（2026-10-28 接入）。
          //   两条路：① ctx.sessions.get(id).snapshotEvents()（内存，实时）
          //          ② ctx.sessionPersistence.open(id,'read')（会话不在内存时兜底）
          //   ⛔ 两条都失败 ⇒ 返回 {ok:false}，让 classify 判 undetermined，
          //      绝不用空数组冒充"没有新增"（那会误判成 busy，催一个没问题的目标）。
          getSessionEvents: async (rec) => {
            try {
              const targetSid = String((rec && rec.dstSessionId) || '');
              if (!targetSid) return { ok: false, events: [], via: 'none', reason: 'no-dst-session-id' };
              const src = createEventSource({
                logger,
                getSessions: () => ctx.sessions,
                getPersistence: () => ctx.sessionPersistence,
              });
              return await src.newEventsSince(targetSid, {
                eventCountBefore: rec.eventCountBefore,
                messageId: rec.messageId,
              });
            } catch (e) {
              return { ok: false, events: [], via: 'none', reason: String(e && e.message || e).slice(0, 120) };
            }
          },
        });
        // ── [2026-10-28 by Assistant · 修"注册数骗人"] ──
        //   原来这里打 `n: dispatchTools.length` —— 那个数是"循环遍历了几个"，
        //   不是"成功注册了几个"。所以三个工具**全部注册失败**时，
        //   日志照样写 dispatch-tools-registered n=3，看起来一切正常。
        //   ⇒ 改成只统计**成功数**，并把失败的名字单独列出来。
        let okCount = 0;
        const failedNames = [];
        for (const t of (Array.isArray(dispatchTools) ? dispatchTools : [dispatchTools])) {
          try {
            const off = ctx.tools.register(t);
            diaryDisposers.push(off);
            okCount++;
          } catch (e) {
            failedNames.push(String((t && t.name) || '?'));
            probeLog({ phase: 'dispatch-tool-FAILED', name: t && t.name, err: String(e && e.message || e) });
          }
        }
        probeLog({
          phase: failedNames.length ? 'dispatch-tools-PARTIAL' : 'dispatch-tools-registered',
          ok: okCount,
          failed: failedNames.length,
          failedNames: failedNames.join(',') || undefined,
        });
      } catch (e) {
        probeLog({ phase: 'dispatch-tools-init-FAILED', err: String(e && e.message || e) });
      }

      // 零点汇编：每 10 分钟看一次「昨天那页该不该收成合订」。
      // 不用精确 0 点 —— DSH 进程常被 Windows 降频，惰性检查比准点更可靠；
      // 幂等键是 state['assembled:<日期>']，重复跑不会重复收。
      const diaryTimer = setInterval(() => {
        try { maybeAssemble(); } catch {}
      }, 10 * 60 * 1000);
      if (diaryTimer && typeof diaryTimer.unref === 'function') diaryTimer.unref();
      // 启动即补一次（跨夜关机的常见情形）
      try { setTimeout(() => { try { maybeAssemble(); } catch {} }, 45 * 1000).unref?.(); } catch {}
      diaryDisposers.push(() => { try { clearInterval(diaryTimer); } catch {} });
      probeLog({ phase: 'diary-scheduler-started', health: diaryHealth() });

      // ── [2026-10-24 Step 4] 冷宫归档定时器 ──
      //   默认「只统计不搬」（autoApply=false）：先把数字摸清，人点头再开自动搬。
      //   理由：搬卡是不可逆的物理动作，自动化风险比排序调参高一个量级。
      let coldTimer = null;
      try {
        const runColdTick = () => {
          try {
            const L = loadLiveConfig();
            if (L.coldArchiveEnabled !== true) return;
            // [2026-10-24 Round 9] 三个库都要管，不能只盯主库：
            //   主库 / 自产蒸馏库 / L1 每日 records —— 后两个也会随天数膨胀。
            //   各自独立跑、独立冷宫文件（主库冷宫路径不同，自产库共用同一个冷宫后缀）。
            const targets = [
              { tag: 'main', file: dataPath('engram-relay/engrams.jsonl'), cold: dataPath('engram-relay/cold_archive.jsonl') },
              { tag: 'own', file: dataPath('ingest/engrams.jsonl'), cold: dataPath('ingest/cold_archive.jsonl') },
            ];
            const out = [];
            for (const t of targets) {
              try {
                const r = runColdArchive({
                  file: t.file,
                  coldFile: t.cold,
                  apply: L.coldArchiveAutoApply === true,
                  ageDays: Number(L.coldArchiveAgeDays) || 60,
                  impMax: Number(L.coldArchiveImpMax) || 0.4,
                });
                if (!r || r.ok === false) continue;
                out.push({ tag: t.tag, total: r.total, move: r.move, stay: r.stay, reasons: r.reasons });
              } catch (e) {
                out.push({ tag: t.tag, error: String(e && e.message || e).slice(0, 120) });
              }
            }
            try {
              logger?.wake?.({
                level: 'cold-archive',
                mode: L.coldArchiveAutoApply === true ? 'apply' : 'dry',
                groups: out,
              });
            } catch {}
            probeLog({ phase: 'cold-archive-tick', groups: out });
          } catch (e) {
            probeLog({ phase: 'cold-archive-FAILED', err: String(e && e.message || e) });
          }
        };
        coldTimer = setInterval(runColdTick, Number(loadLiveConfig().coldArchiveIntervalMs) || 21600000);
        if (coldTimer && typeof coldTimer.unref === 'function') coldTimer.unref();
        diaryDisposers.push(() => { try { clearInterval(coldTimer); } catch {} });
        probeLog({ phase: 'cold-archive-scheduler-started', mode: loadLiveConfig().coldArchiveAutoApply === true ? 'apply' : 'dry' });
      } catch (e) {
        probeLog({ phase: 'cold-archive-scheduler-FAILED', err: String(e && e.message || e) });
      }
    }
  } catch (e) {
    probeLog({ phase: 'diary-FAILED', err: String(e && e.message || e) });
  }

  // ── [2026-10-26 by Assistant · 向量自动增量（计划 P0 方案甲）] ──
  //
  //   症状：索引最后构建于 2026-10-21，此后新产 1372 张卡（13.6%）没有任何向量。
  //   根因不是上游停服，是**从来没有自动化** —— build-embeddings.mjs 只能手动跑。
  //
  //   为什么选方案甲（后台定时）而不是方案乙（落盘即补）：
  //     甲不碰写入路径、不改 distill.js，风险最低；代价是新卡有最长一轮的空窗。
  //     稳定后再评估乙。
  //
  //   三条护栏：
  //     ① 单飞锁（running 标志）—— 上一轮没跑完绝不重入，避免叠加请求打爆端点
  //     ② 端点为空/索引不兼容 ⇒ 只报告，**绝不重建**（废掉 8701 条是灾难）
  //     ③ 补完立刻 refreshVectorIndex() 热替换内存索引（B2），否则检索看不见
  let vectorTimer = null;
  let vectorFirstTimer = null;
  let vecBuilding = false;
  try {
    const vecEp = resolveEndpoint(embeddingCfg);
    const runVectorBuild = async () => {
      if (vecBuilding) return;                       // ① 单飞锁
      const L = loadLiveConfig();
      if (L.vectorAutoBuildEnabled !== true) return;
      vecBuilding = true;
      const t0 = Date.now();
      try {
        const r = await buildMissing(vecEp, { limit: Number(L.vectorAutoBuildLimit) || 0 });
        if (r.ok && !r.skipped) {
          // ③ 热替换：补完的向量要立刻可见，否则要等下一次源变更才碰巧重载
          let refreshed = null;
          try { if (retriever && typeof retriever.refreshVectorIndex === 'function') refreshed = retriever.refreshVectorIndex(); } catch (e) { refreshed = { ok: false, reason: String(e && e.message || e) }; }
          probeLog({ phase: 'vector-auto-build', ...r, refreshed });
          try { logger && logger.wake && logger.wake({ level: 'vector-auto-build', ...r, refreshed }); } catch {}
        } else if (r.ok && r.skipped) {
          probeLog({ phase: 'vector-auto-build', skipped: true, count: r.count });
        } else {
          // ② 不兼容/无端点：只报告，绝不重建
          probeLog({ phase: 'vector-auto-build-SKIPPED', reason: r.reason, wantModel: r.wantModel, indexModel: r.indexModel });
        }
      } catch (e) {
        probeLog({ phase: 'vector-auto-build-FAILED', err: String(e && e.message || e), ms: Date.now() - t0 });
      } finally {
        vecBuilding = false;
      }
    };

    if (vecEp) {
      const intervalMs = Number(loadLiveConfig().vectorAutoBuildIntervalMs) || 1800000;
      const firstDelayMs = Number(loadLiveConfig().vectorAutoBuildFirstDelayMs) || 120000;
      vectorTimer = setInterval(() => { void runVectorBuild(); }, intervalMs);
      if (vectorTimer && typeof vectorTimer.unref === 'function') vectorTimer.unref();
      // 启动即补一轮（跨夜关机的常见情形），但延后，别跟暖启动抢资源
      vectorFirstTimer = setTimeout(() => { void runVectorBuild(); }, firstDelayMs);
      if (vectorFirstTimer && typeof vectorFirstTimer.unref === 'function') vectorFirstTimer.unref();
      diaryDisposers.push(() => {
        try { if (vectorTimer) clearInterval(vectorTimer); } catch {}
        try { if (vectorFirstTimer) clearTimeout(vectorFirstTimer); } catch {}
      });
      probeLog({ phase: 'vector-timer-started', intervalMs, firstDelayMs, endpoint: resolveEndpoint(embeddingCfg) ? 'ok' : 'off' });
    } else {
      probeLog({ phase: 'vector-timer-started', endpoint: 'off', reason: 'no-endpoint' });
    }
  } catch (e) {
    probeLog({ phase: 'vector-timer-FAILED', err: String(e && e.message || e) });
  }


  const renderDigest = createSectionRenderer({ orchestrator, prefetcher, config: c, logger });

  // 唯一接缝：order 0.6（soul-md persona=0 / memory=0.5 之后）
  let dispose;
  try {
    dispose = ctx.systemPrompt.section({
      name: SECTION_NAME,
      order: c.order ?? 0.6,
      text: renderDigest,
    });
    probeLog({ phase: 'registered', name: SECTION_NAME, order: c.order ?? 0.6, disposeType: typeof dispose });
  } catch (e) {
    probeLog({ phase: 'register-FAILED', name: SECTION_NAME, err: String(e && e.message || e) });
    throw e;
  }

  ctx.logger?.info?.('[unified-memory] section registered: %s (prefetch=%s)', SECTION_NAME, prefetcher.stats().enabled);
  return () => {
    try { for (const off of diaryDisposers) { if (typeof off === 'function') off(); } } catch {}
    diaryDisposers = [];
    try { if (autoRefresh && typeof autoRefresh.stop === 'function') autoRefresh.stop(); } catch {}
    try { if (ingest && typeof ingest.dispose === 'function') ingest.dispose(); } catch {}
    try { dispose(); } catch {}
    try { if (typeof disposePreStep === 'function') disposePreStep(); } catch {}
    try { if (typeof disposeTurn === 'function') disposeTurn(); } catch {}
    try { if (typeof disposeAssembleProbe === 'function') disposeAssembleProbe(); } catch {}
  };
}
