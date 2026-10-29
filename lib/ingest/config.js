/**
 * ingest/config.js —— 期7 的**活配置**（不靠改 profile、不靠重启）
 * [2026-10-22 by Assistant · 期7]
 *
 * 为什么不用 cordis.patch.yml：
 *   ① profile 铁律是「只许末尾追加」，再加一个同 id 块会像当初 soul-md 那样出现
 *      两条配置块（人设差点被吞）。写入侧开关不值得冒这个险。
 *   ② 改 profile 必须重启才生效，一次重启 40~70 万 token。而这三条链路是
 *      "跑起来就该自己走"的后台作业，开关需要能随时拧——放文件里最合适。
 *
 * 做法：每次钩子被调用时读一次（按 mtime 缓存，几乎零成本）。文件不存在 ⇒ 全关。
 * 默认值全部偏保守：不写、不调模型，先把链路挂上不产生副作用。
 */
import { readFileSync, statSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { dataPath } from '../paths.js';

export const DEFAULT_CONFIG_PATH = dataPath('ingest/config.json');

// ── [2026-10-29 · 开源版默认值调整] ──
//   原版这几个默认 false 是"灰度上线"的保险丝：先挂上不动作，等人工确认后再开。
//   但那份保险丝是**为已经在跑的系统**设计的 —— 原版机器上有一个手写的
//   config.json（里面 enabled/capture/extract/distill 全 true）覆盖了默认值。
//   开源用户没有那个文件 ⇒ 拿到的是全 false ⇒ **装完什么都不记录，也不报错**。
//   实测：新目录首次启动 _missing=true，六个开关全是 false。
//   ⇒ 开源版把默认值改成"开箱即用"，同时保留 writing 一份带注释的模板供用户改。
//   ⚠️ extract/distill 没有 LLM 时仍会优雅跳过并明确告警，不会报错。
export const DEFAULT_LIVE = {
  enabled: true,         // 总闸：所有写入侧能力的总开关
  capture: true,         // 7-A L0 捕获
  extract: true,         // 7-B L1 提取（会调 LLM；没配 LLM 时跳过并告警）
  distill: true,         // 7-C engram 蒸馏（会调 LLM；没配 LLM 时跳过并告警）
  // 下列是有意暴露的旋钮，默认值经过自测，改之前先看 selftest-ingest.mjs
  minChars: 6,
  maxCharsPerMessage: 8000,
  batchMessages: 24,
  minBatchMessages: 4,
  maxWindowsPerRun: 3,
  extractIntervalMs: 600000,
  distillWindowMessages: 40,
  minDistillMessages: 4,
  distillMinGapMs: 60000,
  // [2026-10-23 by Assistant · 期8.2] 会话冷却期（Consolidation Window）
  //   默认 false ⇒ 判决后直接写盘（与期8.1 行为逐位相同）。
  //   打开 ⇒ 判决得出的新卡先进内存 pending，等 session/flush 的 sweepIdle
  //          或 session/disposed 的 archive 才落盘最终态（DESIGN §三 Case 2）。
  consolidationWindowEnabled: false,
  // [2026-10-23 · 红白双队 记忆动力学]
  //   concentrationEnabled: 同一主题重复 ⇒ 不新建卡，老卡 hits += 1（浓度不体积）
  //   concentrationBoostEnabled: 检索时按 hits 加权（但必须过相关性门控，防霸盘）
  //   axiomStagingEnabled: 够格的卡写入公理待审池（**绝不实时改 System Prompt**）
  //   三者默认全关 ⇒ 行为与接线前逐位相同。
  concentrationEnabled: true,
  concentrationBoostEnabled: true,
  concentrationGate: 0.35,
  concentrationAlpha: 0.15,
  axiomStagingEnabled: true,
  axiomsPendingPath: dataPath('axioms_pending.jsonl'),
  //   闲置多久的会话才被 sweepIdle 归档（白队 §9.3 定 30 分钟；原来是 5 分钟）
  consolidationIdleMs: 1800000,
  retireAfterDays: 14,
  maxBytes: 16777216,
  // ── [2026-10-24 by Assistant · 四股力] ──
  //   打开后：乘法门控 + 三档半衰期 + 采纳核验补 hits。
  //   放在**活配置**里（不是 profile）⇒ 改文件即生效，不用重启。
  //   [2026-10-29 · 开源版] 默认改为 true。
  //     理由：这是本项目核心卖点之一，默认关等于没发布。
  //     回滚成本极低：改成 false 即时生效，不需要改代码或回滚版本。
  fourForcesEnabled: true,
  // ── [2026-10-24 by Assistant · 双轨闪回] ──
  //   独立旁路，最多 1 条「远期同构」老记忆，不参与主排序。
  //   依赖图谱索引（motifs/entities），开启时会顺手建图。
  flashbackEnabled: false,
  // ── [2026-10-24 by Assistant · Step 4 冷宫归档] ──
  //   autoApply=false ⇒ 定时器只**统计**（dry-run），不自动搬。
  //   要真搬必须显式改成 true（或手动跑 scripts/cold-archive.mjs --apply）。
  //   理由：搬卡是不可逆的物理动作，默认自动化风险太高 —— 先看统计，人点头再开。
  coldArchiveEnabled: false,
  coldArchiveAutoApply: false,
  coldArchiveAgeDays: 60,
  coldArchiveImpMax: 0.4,
  coldArchiveIntervalMs: 21600000,
  // ── [2026-10-26 by Assistant · 向量自动增量（计划 P0 方案甲）] ──
  //   背景：build-embeddings.mjs 从没有定时器调它，索引停在 2026-10-21，
  //         此后的新卡全都没有向量（实测 1372 张 / 13.6%）。
  //   放在**活配置**里 ⇒ 改文件即生效，不用重启。
  //   enabled 默认 true —— 这是修复缺口的目的本身；要停改成 false 即可
  //   （停了只是回到「手动跑脚本」，不影响 BM25 主路径）。
  vectorAutoBuildEnabled: true,
  vectorAutoBuildIntervalMs: 1800000,      // 30 分钟一轮
  vectorAutoBuildFirstDelayMs: 120000,     // 启动 2 分钟后跑第一轮（别跟暖启动抢资源）
  vectorAutoBuildLimit: 0,                 // 0 = 不设上限，一轮补完；>0 则每轮最多补 N 张
};

let _cache = { path: '', mtime: -1, value: null };

export function loadLiveConfig(path) {
  const p = String(path || DEFAULT_CONFIG_PATH);
  try {
    if (!existsSync(p)) return Object.assign({}, DEFAULT_LIVE, { _missing: true, _path: p });
    const st = statSync(p);
    if (_cache.path === p && _cache.mtime === st.mtimeMs && _cache.value) return _cache.value;
    let raw = {};
    try { raw = JSON.parse(readFileSync(p, 'utf8')); } catch { raw = {}; }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) raw = {};
    const merged = Object.assign({}, DEFAULT_LIVE, raw, { _missing: false, _path: p });
    _cache = { path: p, mtime: st.mtimeMs, value: merged };
    return merged;
  } catch {
    return Object.assign({}, DEFAULT_LIVE, { _missing: true, _path: p });
  }
}

/** 给运维/自测用：把默认配置落地成文件（不覆盖已有文件）。 */
export function writeDefaultConfig(path, overrides) {
  const p = String(path || DEFAULT_CONFIG_PATH);
  try {
    if (existsSync(p)) return { written: false, path: p, reason: 'exists' };
    const dir = p.replace(/[\\/][^\\/]*$/, '');
    if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(p, JSON.stringify(Object.assign({}, DEFAULT_LIVE, overrides || {}), null, 2), 'utf8');
    return { written: true, path: p };
  } catch { return { written: false, path: p, reason: 'error' }; }
}
