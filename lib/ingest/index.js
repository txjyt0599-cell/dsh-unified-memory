/**
 * ingest/index.js —— 期7 写入侧总装（把 A/B/C 三样挂到 DSH 接缝上）
 * [2026-10-22 by Assistant · 期7]
 *
 * 三条链路各自独立、各自可关、各自有游标：
 *   7-A capture : session/flush（每次请求边界，awaitable）→ conversations/
 *   7-B extract : 定时器（每 N 分钟）→ records/
 *   7-C distill : agent/turn-stopping（回合关闭边界，节流）→ engrams.jsonl
 *
 * **开关读活配置**（ingest/config.json），不靠重启：
 *   迁移期先在旁路把链路挂上、文件里全 false ⇒ 零副作用；
 *   验收通过后把对应项改 true 就立即生效（按 mtime 缓存，每钩子读一次几乎零成本）。
 *
 * 铁律（与既有 prefetch 一致）：
 *   1. 任何异常一律吞掉 + 留痕，绝不让写入侧拖垮回合。
 *   2. 三个开关分开：capture / extract / distill。
 *   3. enabled=false（总闸）时三条链路都不动作，连定期器都不跑。
 */
import { dirs, ensureDirs } from './core.js';
import { captureTurn, isRealUser, extractText } from './capture.js';
import { runExtract } from './extract.js';
// [2026-10-28 by Assistant · P1] 体温交接不依赖 LLM：回合收尾直接调这几个确定性函数
import { runDistill, writeOngoingThread, readRecentL0ForSession, resolveDistillSession } from './distill.js';
import { resolveLlm, llmLabel } from './llm.js';
import { loadLiveConfig, DEFAULT_CONFIG_PATH } from './config.js';
import { dshHome, normalize } from '../paths.js';

/** 从 session 派生「本轮新增的真实 user/assistant 消息」。 */
export function deriveTurnMessages(session) {
  try {
    if (!session || typeof session.deriveMessages !== 'function') return [];
    const all = session.deriveMessages() || [];
    let start = -1;
    for (let i = all.length - 1; i >= 0; i--) {
      if (isRealUser(all[i])) { start = i; break; }
    }
    if (start < 0) return [];
    const out = [];
    for (let i = start; i < all.length; i++) {
      const m = all[i];
      if (!m) continue;
      if (m.role !== 'assistant' && !isRealUser(m)) continue;   // 丢掉插件注入的伪 user
      const text = extractText(m.content);
      if (!text) continue;
      out.push({
        id: m.id || ('m_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7)),
        role: m.role === 'assistant' ? 'assistant' : 'user',
        content: text,
        timestamp: Number(m.timestamp) || Date.now(),
      });
    }
    return out;
  } catch { return []; }
}

export function createIngest(ctx, config, logger) {
  const c = config || {};
  if (c.disabled === true) return null;
  const cfgPath = c.configPath || DEFAULT_CONFIG_PATH;

  const live = () => loadLiveConfig(cfgPath);

  // ── [2026-10-29 · 开源补丁] 启动自检：一眼看出"关键配置没填" ──
  //   背景：纯净环境装上后，一切看起来正常，但产卡全被静默跳过。
  //   用户唯一的线索应该是这里 —— 启动时就把话说清楚，别让人去猜。
  try {
    const L0 = live();
    const ep = (() => { try { return getLlm0(); } catch { return null; } })();
    function getLlm0() {
      return resolveLlm({
        baseUrl: c.llm && c.llm.baseUrl,
        apiKey: c.llm && c.llm.apiKey,
        model: c.llm && c.llm.model,
        maxTokens: c.llm && c.llm.maxTokens,
        profilePath: c.profilePath || normalize(dshHome() + '/profiles/web/cordis.patch.yml'),
      });
    }
    if (!ep) {
      logger && logger.wake && logger.wake({
        level: 'ingest-llm-missing-at-startup',
        severity: 'warn',
        hint: [
          '⚠️ 本插件已加载，但没有 LLM 配置 —— 记忆卡不会生成，只有原始对话会被记录。',
          '请在 cordis.patch.yml 的 config.llm 里填：baseUrl / apiKey / model。',
          '或者设 config.profilePath 指向已有 llm: 段的 DSH profile。',
          '文档：README → Configuration → Models',
        ].join(' '),
      });
    }
  } catch { /* 自检失败不影响启动 */ }

  const optsOf = (L) => ({
    root: c.root,
    minChars: L.minChars,
    maxCharsPerMessage: L.maxCharsPerMessage,
    batchMessages: L.batchMessages,
    minBatchMessages: L.minBatchMessages,
    maxWindowsPerRun: L.maxWindowsPerRun,
    distillWindowMessages: L.distillWindowMessages,
    minDistillMessages: L.minDistillMessages,
    retireAfterDays: L.retireAfterDays,
    maxBytes: L.maxBytes,
    // ── [2026-10-23 by Assistant · 零接线第 4 例] ──
    //   配置里写了 concentrationEnabled: true，但 optsOf 不透传 ⇒ distill 永远收不到
    //   ⇒ 浓度引擎白接。这里补齐三个开关的透传（关闭时逐位等同旧行为）。
    concentrationEnabled: L.concentrationEnabled === true,
    concentrationBoostEnabled: L.concentrationBoostEnabled === true,
    axiomStagingEnabled: L.axiomStagingEnabled === true,
    concentrationGate: L.concentrationGate,
    concentrationAlpha: L.concentrationAlpha,
    axiomsPendingPath: L.axiomsPendingPath,
  });

  const d = dirs(c.root);
  ensureDirs(d);

  // LLM 惰性解析：配置里没给就从 profile 的 tdai-memory 段继承（key 不过手）
  let _llm;
  let _llmTried = false;
  const getLlm = () => {
    if (_llmTried) return _llm;
    _llmTried = true;
    try {
      _llm = resolveLlm({
        baseUrl: c.llm && c.llm.baseUrl,
        apiKey: c.llm && c.llm.apiKey,
        model: c.llm && c.llm.model,
        maxTokens: c.llm && c.llm.maxTokens,
        profilePath: c.profilePath || normalize(dshHome() + '/profiles/web/cordis.patch.yml'),
      });
    } catch { _llm = null; }
    return _llm;
  };

  const state = {
    lastCapture: null, lastExtract: null, lastDistill: null,
    captureRuns: 0, extractRuns: 0, distillRuns: 0,
    captureWritten: 0, extractWritten: 0, distillWritten: 0,
    lastError: null, startedAt: new Date().toISOString(),
  };
  const swallow = (tag, e) => {
    state.lastError = tag + ': ' + String(e && e.message || e);
    try { logger && logger.miss && logger.miss({ level: 'ingest-' + tag, reason: state.lastError }); } catch {}
  };

  const disposers = [];

  // ============================================================
  // 【必须在所有钩子之前声明】—— 这两个是延迟赋值的占位函数：
  //   钩子/定时器在注册时就捕获它们，真正实现稍后才赋上。
  //   教训：本轮把 let catchUpTick 写在钩子后面 ⇒ 钩子里调用触发 TDZ
  //         ReferenceError ⇒ 整个 capture 挂掉。凡钩子要调的，声明必须前置。
  // ============================================================
  let catchUpTick = () => {};
let distillTickFn0 = () => {};

// ══════════════════════════════════════════════════════════════════
// [2026-10-23 by Assistant · 期8.2 缺口 b：冷却期接线]
//
//   之前的状态：consolidate.js 写好了、测试绿了，但**没人调它**（零接线）。
//   现在接在 session/flush 上：
//     · 闲置 ≥30 分钟的会话 ⇒ sweepIdle() 收敛（只落最终态一条）
//     · 会话卸载           ⇒ archive(sessionId)
//
//   开关 consolidationWindowEnabled **默认 false**：关闭时本模块完全不创建，
//   行为与接线前逐位相同（这是能不能安全上主路的底线）。
// ══════════════════════════════════════════════════════════════════
let consolidation = null;
function ensureConsolidation() {
  try {
    const L = live();
    if (L.consolidationWindowEnabled !== true) return null;
    if (consolidation) return consolidation;
    consolidation = createConsolidation({
      idleMs: Number.isFinite(Number(L.consolidationIdleMs)) ? Number(L.consolidationIdleMs) : IDLE_CONSOLIDATE_MS,
      // onCommit：真正落盘（append-only），并给被推翻的旧卡写 refuted 版本行
      onCommit: (engram) => {
        try {
          const line = JSON.stringify(engram);
          appendLines(d.engrams, [line], optsOf(L).maxBytes);
          for (const oldId of (engram.refutedOldIds || [])) {
            try {
              const old = readOwnEngrams(optsOf(L).root).find((x) => String(x.id) === String(oldId));
              if (old) {
                appendLines(d.engrams, [JSON.stringify(Object.assign({}, old, {
                  status: 'refuted', refutedAt: new Date().toISOString(), refutedBy: engram.id,
                }))], optsOf(L).maxBytes);
              }
            } catch {}
          }
          state.consolidationCommitted = (state.consolidationCommitted || 0) + 1;
        } catch (e) { swallow('consolidate-commit', e); }
      },
    });
    return consolidation;
  } catch (e) { swallow('consolidate-create', e); return null; }
}
  let distillTickFn = () => {};

  // ── 7-A：捕获 ──
  try {
    disposers.push(ctx.on('session/flush', async (session) => {
      try {
        const L = live();
        if (!L.enabled || !L.capture) return;
        const sid = session && session.id;
        // 记住最近一次活跃会话，供蒸馏定时兜底用（回合不结束时也有归属）
        if (sid) state._lastSessionId = sid;
        const cwd0 = session && session.header && session.header.cwd;
        if (typeof cwd0 === 'string' && cwd0) state._lastCwd = cwd0;
        const msgs = deriveTurnMessages(session);
        if (!msgs.length) return;
        const r = captureTurn({ sessionKey: sid, sessionId: sid, messages: msgs, opts: optsOf(L) });
        state.captureRuns++;
        state.captureWritten += r.written;
        state.lastCapture = { at: new Date().toISOString(), written: r.written, skipped: r.skipped };
        if (r.written > 0) { try { logger && logger.wake && logger.wake({ level: 'ingest-capture', n: r.written }); } catch {} }
        // [2026-10-22] 事件驱动补跑：借对话发生这个高频事件，把积压的 extract/distill 推一下
        try { catchUpTick(); } catch (e) { swallow('catchup', e); }

        // ── 期8.2 冷却期：借同一个 session/flush 机会做两件事 ──
        //   ① 闲置 ≥30 分钟的会话 ⇒ 收敛落盘（只写最终态一条 + trace）
        //   ② 本次会话若已结束 ⇒ 归档
        //   开关关闭时 ensureConsolidation() 返回 null，这里一行都不执行。
        try {
          const cons = ensureConsolidation();
          if (cons) {
            const swept = cons.sweepIdle();
            if (swept && swept.archived > 0) {
              try { logger && logger.wake && logger.wake({ level: 'consolidate-sweep', archived: swept.archived }); } catch {}
            }
            // 会话对象显式标记结束（或 flush 时已被判定 idle）⇒ 归档
            const ended = session && (session.ended === true || session.closed === true || session.disposed === true);
            if (ended && sid) {
              const r2 = cons.archive(sid, { existing: readOwnEngrams(optsOf(L).root), reason: 'session-ended' });
              if (r2 && r2.committed > 0) {
                try { logger && logger.wake && logger.wake({ level: 'consolidate-archive', n: r2.committed }); } catch {}
              }
            }
          }
        } catch (e) { swallow('consolidate-flush', e); }
      } catch (e) { swallow('capture', e); }
    }));
  } catch (e) { swallow('capture-register', e); }



  // ── 7-B：提取（定时器；只有活配置里开了才真跑）──
  let timer = null;
  {
    // 用固定的短轮询（60s）检查一次开关；真正跑不跑由活配置 + interval 决定
    const tick = () => {
      const L = live();
      if (!L.enabled || !L.extract) return;
      const ep = getLlm();
      if (!ep) {
        // ── [2026-10-29 · 开源补丁] 静默跳过是最大的坑 ──
        //   实测：纯净环境装上插件，用户聊半天发现"什么都记不住"，
        //   查日志一片安静 —— 因为这里直接 return，什么都不说。
        //   ⇒ 改成：每 10 分钟最多告警一次，明确告诉他缺什么、填哪。
        const now = Date.now();
        state._lastNoLlmWarnAt = state._lastNoLlmWarnAt || 0;
        if (now - state._lastNoLlmWarnAt > 600000) {
          state._lastNoLlmWarnAt = now;
          try {
            swallow('llm-unavailable', {
              level: 'ingest-llm-unavailable',
              hint: '产卡已跳过：没有可用的 LLM 配置。请在 cordis.patch.yml 的 config.llm 填 baseUrl / apiKey / model（或设 profilePath 从 DSH profile 继承）。在此之前只会记录对话，不会生成记忆卡。',
            });
          } catch { /* 告警失败不影响主流程 */ }
        }
        return;
      }
      const now = Date.now();
      if (state._extractBusy) return;                    // 防重入：上一轮还没跑完
      if (state._lastExtractAt && now - state._lastExtractAt < (Number(L.extractIntervalMs) || 600000)) return;
      state._lastExtractAt = now;
      state._extractBusy = true;
      runExtract({ llm: ep, opts: optsOf(L) })
        .then((r) => {
          state.extractRuns++;
          state.extractWritten += r.written || 0;
          state.lastExtract = Object.assign({ at: new Date().toISOString() }, r);
          // [2026-10-22 by Assistant · 自审] 失败不该白等一整个间隔：
          //   429 限流 / 锁被占 / 追加失败 —— 这些都是**瞬时**的，
          //   旧写法把 _lastExtractAt 设成 now 就再等 15 分钟 ⇒ 一次限流损失一整个窗口。
          //   失败时把时间戳回拨到「间隔的 3/4 处」，等于 3~4 分钟后重试。
          const interval = Number(L.extractIntervalMs) || 600000;
          if (r && ((r.failed || 0) > 0 || r.reason)) {
            state._lastExtractAt = Date.now() - Math.floor(interval * 0.75);
          }
        })
        .catch((e) => {
          swallow('extract', e);
          state._lastExtractAt = Date.now() - Math.floor((Number(L.extractIntervalMs) || 600000) * 0.75);
        })
        .finally(() => { state._extractBusy = false; });
    };
    // [2026-10-22 by Assistant · 实跑抓到的真 bug（第二个）]
    //   distillTick 是 const 声明在**后面**（第 ~228 行），这里在 164 行就引用它
    //   ⇒ 第一次 tick 抛 ReferenceError（TDZ）⇒ 被 `catch {}` 静默吞掉
    //   ⇒ **tick 里的 extract 也一起死了**（因为 tick() 在同一个 try 之前，
    //     实际上 tick() 先执行没问题，但整个回调抛错后 setInterval 仍会继续……
    //     真正的问题是 distillTick 永远 undefined ⇒ ReferenceError 每 60s 抛一次）。
    //   表现：extract 12:35 之后不再产出、distill 从未自动触发。
    //   修法：用**函数提升**（function 声明）或在引用前定义。这里改成延迟查找：
    // [2026-10-22 by Assistant · 实跑抓到「定时器静默停摆」]
    //   症状：capture（钩子驱动）一直在跑，但 extract/distill（定时器驱动）
    //         在 14:07 之后整整 4 小时没有任何活动。
    //   没有报错、没有日志——**完全静默**。
    //   必须先能"看见"timer 到底跳没跳，否则永远只能猜。
    // ============================================================
    // [2026-10-22 by Assistant · 实跑抓到「定时器静默停摆」——根因已定位]
    //
    //   症状：capture（钩子驱动）一直在跑，但 extract/distill（定时器驱动）
    //         14:07 之后整整 3 小时 40 分没有任何活动，日志空白。
    //
    //   根因：DSH 进程 PriorityClass = Idle（实测 Get-Process 确认，所有 node 都是 Idle）。
    //         Windows 对 Idle 优先级进程会大幅降低定时器精度/合并唤醒，
    //         setInterval(60s) 可能长期不触发。
    //
    //   为什么不动优先级：那是User环境层面的决定，插件没资格自行提权。
    //
    //   正确修法：不依赖 Timer 准时性 —— 事件驱动 + 惰性补跑。
    //     ① 保留 setInterval（尽力而为）
    //     ② 在 capture 钩子里顺手检查「该跑没跑」，超时立即补跑
    //     => 只要有对话活动，积压的 extract/distill 就会立刻补上。
    // ============================================================
    state._tickCount = 0;
    state._lastTickAt = 0;
    catchUpTick = () => {
      try { tick(); } catch (e) { swallow('extract-catchup', e); }
      try { distillTickFn(); } catch (e) { swallow('distill-catchup', e); }
    };
    timer = setInterval(() => {
      state._tickCount++;
      state._lastTickAt = Date.now();
      try { tick(); } catch (e) { swallow('extract-tick', e); }
      try { distillTickFn(); } catch (e) { swallow('distill-tick', e); }
      // 每 10 跳记一次心跳（不刷屏，但足以判断 timer 是否活着）
      if (state._tickCount % 10 === 0) {
        try {
          logger && logger.wake && logger.wake({
            level: 'ingest-tick',
            n: state._tickCount,
            lastExtractAt: state._lastExtractAt || 0,
            lastDistillAt: state._lastDistillAt || 0,
            busy: !!state._extractBusy,
          });
        } catch {}
      }
    }, 60000);
    if (timer && typeof timer.unref === 'function') timer.unref();
  }

  // ── 7-C：蒸馏 ──
  //
  // [2026-10-22 by Assistant · 实跑抓到的真问题]
  //   原来**只**挂 agent/turn-stopping（回合关闭边界）。实测：重启后 8 分钟里
  //   capture 写了 12 条、extract 产了 4 张卡，但 **distill 一次都没跑**（engrams.jsonl 不存在）。
  //   原因不是 bug，而是"回合还没结束"——长任务里一个回合能跑几小时，
  //   蒸馏就被饿死几小时；而且 instrument 一旦进程被杀，这一轮的对话就永远没被蒸馏。
  //
  //   所以改成**双触发**：
  //     ① 回合收尾（turn-stopping）：最贴近原始设计，语义最准
  //     ② 定时兜底（和 extract 同一个 tick）：即使回合一直不结束，也按 minGap 推进
  //   两条路共用同一个 chain 串行，不会并发写卡库。
  let chain = Promise.resolve();
  let distillBusy = false;
  const kickDistill = (sid, cwd) => {
    try {
      const L = live();
      if (!L.enabled || !L.distill) return;
      const ep = getLlm();
      if (!ep) {
        // [开源补丁] 同 extract：静默跳过会让人完全查不出问题，给一条明确告警。
        const now = Date.now();
        state._lastNoLlmWarnAt = state._lastNoLlmWarnAt || 0;
        if (now - state._lastNoLlmWarnAt > 600000) {
          state._lastNoLlmWarnAt = now;
          try {
            swallow('llm-unavailable', {
              level: 'ingest-llm-unavailable',
              hint: '蒸馏已跳过：没有可用的 LLM 配置。请在 cordis.patch.yml 的 config.llm 填 baseUrl / apiKey / model。',
            });
          } catch { /* 忽略 */ }
        }
        return;
      }
      if (distillBusy) return;                          // 防重入
      const now = Date.now();
      const gap = Number(L.distillMinGapMs) || 300000;
      if (state._lastDistillAt && now - state._lastDistillAt < gap) return;
      state._lastDistillAt = now;
      distillBusy = true;
      chain = chain
        .then(() => runDistill({ llm: ep, opts: Object.assign({}, optsOf(live()), { sessionId: sid, cwd }) }))
        .then((r) => {
          state.distillRuns++;
          state.distillWritten += r.written || 0;
          state.lastDistill = Object.assign({ at: new Date().toISOString() }, r);
          // 失败（含 reason）不该白等一个节流周期 ⇒ 回拨到 3/4 处，几分钟后重试
          if (r && ((r.failed || 0) > 0 || r.reason)) {
            state._lastDistillAt = Date.now() - Math.floor(gap * 0.75);
          }
          // 没料可蒸（not-enough-new）也缩短等待：下一批对话来了就能再试
          if (r && r.reason === 'not-enough-new') {
            state._lastDistillAt = Date.now() - Math.floor(gap * 0.5);
          }
        })
        .catch((e) => {
          swallow('distill', e);
          state._lastDistillAt = Date.now() - Math.floor(gap * 0.75);
        })
        .finally(() => { distillBusy = false; });
    } catch (e) { swallow('distill-trigger', e); }
  };

  // ① 回合收尾
  try {
    disposers.push(ctx.on('agent/turn-stopping', (payload) => {
      const agent = payload && payload.agent;
      const sid = agent && agent.session && agent.session.id;
      const cwd = (agent && agent.session && agent.session.header && agent.session.header.cwd) || undefined;
      // ── [2026-10-28 by Assistant · P1] 体温交接必须先写，且**不依赖 LLM** ──
      //   原实现只把它塞在 runDistill 里；而 kickDistill 在无 LLM 通道时直接 return
      //   ⇒ 本机 llm:off 期间 ongoing-thread.json 永不更新（结构性问题，不是偶发）。
      //   现在：回合收尾先无条件写一次体温（纯确定性、0 成本），再考虑蒸馏。
      try {
        const L0 = readRecentL0ForSession(d, 40, sid || resolveDistillSession(d));
        const w = writeOngoingThread({
          root: d.root, fresh: L0, sessionId: sid,
          eventTs: Date.now(), nowIso: new Date().toISOString(),
        });
        if (w && w.ok) swallow('ongoing-thread', { chars: w.chars });
      } catch (e) { swallow('ongoing-thread', e); }
      kickDistill(sid, cwd);
    }));
  } catch (e) { swallow('distill-register', e); }

  // ② 定时兜底（与 extract 共用一个 60s tick，避免多开定时器）
  // 到这里 kickDistill 已定义，把真正的兜底函数接上（tick 每 60s 调它）
  distillTickFn = () => { kickDistill(state._lastSessionId, state._lastCwd); };

  // ── 7-D 前置：L3 人格画像接管 ──
  //
  //   tdai 的 persona.md（32KB，User画像）关掉旧插件后不再更新。
  //   这里让超图自己也能积累画像要点：从 L0 对话里抽「稳定事实」句子，
  //   追加到 ingest/persona-notes.md（**只增不改、不动 tdai 原件**）。
  //   注入侧仍以 tdai 的 persona.md 为权威主档；关旧后这条增量笔记接棒。
  let personaTimer = null;
  if (c.personaTakeover === true) {
    const everyMs = Math.max(300000, Number(c.personaIntervalMs) || 1800000);
    personaTimer = setInterval(() => {
      try {
        if (state._personaBusy) return;
        state._personaBusy = true;
        Promise.resolve()
          .then(async () => {
            const persona = await import('./persona.js');
            const dm = await import('./distill.js');
            const recent = dm.readRecentL0(d, 60);          // d 是本模块已解析的目录对象
            const text = recent.map((m) => String(m.content || '')).join('\n');
            const facts = persona.extractPersonaFacts(text, { maxItems: 6 });
            if (facts.length > 0) {
              const r = persona.appendPersonaFacts(d.root, facts);
              state.personaAppended = (state.personaAppended || 0) + (r.appended || 0);
              state.lastPersona = { at: new Date().toISOString(), appended: r.appended, reason: r.reason };
            }
          })
          .catch((e) => swallow('persona', e))
          .finally(() => { state._personaBusy = false; });
      } catch {}
    }, everyMs);
    if (personaTimer && typeof personaTimer.unref === 'function') personaTimer.unref();
  }

  return {
    dirs: d,
    configPath: cfgPath,
    get llm() { return llmLabel(getLlm()); },
    /** 当前生效的开关（读活配置） */
    get enabled() {
      const L = live();
      return { master: !!L.enabled, capture: !!(L.enabled && L.capture), extract: !!(L.enabled && L.extract), distill: !!(L.enabled && L.distill) };
    },
    /** 手动触发（测试 / 运维；忽略开关，直接用传入或解析出的模型） */
    async runExtractNow(extra) {
      const L = live();
      return runExtract({ llm: getLlm(), opts: Object.assign({}, optsOf(L), extra || {}) });
    },
    async runDistillNow(extra) {
      const L = live();
      return runDistill({ llm: getLlm(), opts: Object.assign({}, optsOf(L), extra || {}) });
    },
    captureNow(p) { return captureTurn(Object.assign({ opts: optsOf(live()) }, p || {})); },
    status() {
      return Object.assign({ dir: d.root, configPath: cfgPath, llm: llmLabel(getLlm()) }, state, { enabled: this.enabled });
      // 注：state 里已含 _tickCount / _lastTickAt，可直接判断 timer 是否活着
    },
    dispose() {
      try { if (timer) clearInterval(timer); } catch {}
      try { if (personaTimer) clearInterval(personaTimer); } catch {}
      for (const fn of disposers) { try { if (typeof fn === 'function') fn(); } catch {} }
      disposers.length = 0;
    },
  };
}
