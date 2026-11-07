/**
 * ingest/extract.js —— 期7-B：L1 事实提取（超图自产）
 * [2026-10-22 by Phoebe · 期7-B]
 *
 * 旧实现的两个真问题（这次要治本，不是照搬）：
 *   ① 缓冲区在内存里（everyNConversations=5 / l1IdleTimeout=600 两路触发）
 *      ⇒ 进程一重启 buffer 全丢 ⇒ 覆盖率实测只有 2.9%。
 *      根治：**落盘游标 + 已处理消息键去重**，重启后从断点继续，不丢不重。
 *   ② 提取结果只写 tdai 的 records/，超图被绑定在别人的目录结构上。
 *      根治：写进**超图自己的** records/，同时保持 tdai 兼容字段（type/priority/
 *      scene_name/source_message_ids），这样 migration 期两个源可以并存，
 *      但删掉 tdai 后本链路仍然完整可用。
 *
 * 输入：本插件自己捕获的 conversations/（7-A 的产出）
 * 输出：records/YYYY-MM-DD.jsonl
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import {
  dirs, ensureDirs, appendLines, localDate, loadCursor, saveCursor, messageKey, sha1_16, acquireLock,
} from './core.js';
import { complete, parseJsonArray } from './llm.js';
// [2026-11-05 by Phoebe · 兜底三档] 故障记账（核心路径不许静默吞异常）
//   ⚠️ 之前这个文件没有 import recordFault，Assistant加了调用却没加 import
//      ⇒ ReferenceError 被 selftest-ingest 抓到（H 段正常路径也会走到兜底分支）。
import { recordFault } from '../faults.js';
import { normalizeL1, sanitizeTitle } from './normalize.js';
// [2026-10-23 by Phoebe · 期8.3.1] 写入侧实体抽取：
//   L1 事实卡落盘即带 entities，超图二部图才有真实体可用（不必走 graph.js 的
//   deriveEntities 退化路径 —— 那条路径从标题滑窗抽词元，产出「在和」这类噪声）。
//   规则法，零 LLM 额外开销（提取已经花过一次钱了）。
import { extractEntities } from './entities.js';
// [2026-10-24 Round 11] L1 写入侧必须带 importance（之前只有蒸馏侧带）
import { scoreImportance } from '../scoring/importance.js';
// [2026-10-29 by Phoebe · 工单第一件事] SIGNAL 漏采池：只旁路采集，不改判据。
//   ⛔ 默认不注入 ⇒ 一次 IO 都不做（36 套测试/离线干跑全绿，返回值逐字节不变）。
//   为什么把 buildContext 引到这里：上下文必须取**未过滤**的完整句序列，
//   而被丢掉的常常正是那句短句 —— 拿过滤后的序列拼上下文等于没有语境。
import { buildContext, createMissPool, collectLlmMisses } from './signal-miss.js';

/**
 * [2026-11-06 by Phoebe · 红队 P1-1] 统一消息时间戳解析。
 * 病灶：L0 的 timestamp 是 epoch 毫秒**数字**，旧代码 Date.parse(String(数字)) → NaN
 *   ⇒ 回退 nowIso，但 eventTsSource 仍写 'activity_start'，把提取时刻伪装成活动开始时间。
 * 修法：数字 / 纯数字字符串直接当 epoch；其余才 Date.parse；都失败返回 NaN（调用方自行回退）。
 */
export function epochMsOf(v) {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v;
  const s = String(v === undefined || v === null ? '' : v).trim();
  if (/^\d+$/.test(s)) { const n = Number(s); if (Number.isFinite(n) && n > 0) return n; }
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : NaN;
}

/**
 * 提取提示 —— [2026-10-22 第12轮质量审计后的根本重写]
 *
 * 前一版的病根：它让模型「总结我做了什么事」，产出全是过程流水账：
 *   「我（AI）在和系统做超图记忆改造」「系统存在三个关键问题：1)…2)…」
 * 拿「定时器为什么停摆」去搜，一张都搜不到 —— 因为卡里根本没写「定时器」。
 *
 * 根本改法：把目标从「发生了什么」改成「学到了什么」。
 */
export const EXTRACT_SYSTEM_PROMPT = `你是记忆提取器。目标不是"记录我做了什么"，而是"沉淀可复用的事实"。

## 判断标准（最重要）
问自己：**这句话，三个月后拿来回答一个技术问题，还有用吗？**

✅ 要提取（可复用的事实）：
- 某个东西的**行为/状态**：「DSH 进程是 Idle 优先级，导致 setInterval 长期不触发」
- 某个问题的**根因**：「planWindows 要求窗口以 user 开头，真实会话 1:46 ⇒ 永远 0 窗口」
- 某个**决定/约定**：「记忆写入必须用落盘游标，不许用内存缓冲」
- 某个**参数/阈值**：「L0 门槛取 25：真命中 36~142 分，无关 12~16 分」
- 用户的**稳定偏好/底线**（persona）

❌ 不要提取（过程流水账）：
- 「我（AI）在和系统做超图记忆改造」← 场景，不是事实
- 「这让我必须重新审视」「现在去查」← 心理活动
- 「系统存在三个关键问题：1)…2)…3)…」← 会议纪要
   （应拆成 3 条独立事实，每条讲一个具体问题）

## 输出格式
每条一个 JSON 对象，最多 4 条：

- type: "persona" | "episodic" | "instruction"
- title: 名词性结论，**必须含具体名词**（进程/配置/函数/参数/文件名等），不超过 24 字
  ✅ 「Idle优先级导致定时器不跳」  ✅ 「L0注入无条件占满24个位置」
  ❌ 「我（AI）在和系统调试」      ❌ 「这让我重新审视」
- content: 一条可独立成立的事实，不超过 200 字。
  建议结构：<主体> + <行为/状态> + <原因或后果>
  例：「extract 定时器依赖 setInterval，而 DSH 进程是 Idle 优先级，
       Windows 会合并唤醒 ⇒ 定时器可能数小时不触发，改为 capture 钩子事件驱动补跑。」
- scene_name: 可选，仅作线索，不超过 40 字
- priority: 0-100（instruction 负命令 -1；persona 80-100 健康/禁忌、50-70 偏好；episodic 80-100 重要、60-70 一般）
- evidence: 支撑这条的原文片段，不超过 40 字

## 硬性要求
1. title 和 content 都必须出现具体名词（不能全是"这/那/它/我"）。
2. 宁缺毋滥：抽不出合格的，返回 [] 比产出流水账更好。
3. 只输出 JSON 数组，不要任何解释。`;

/**
 * [红队 P0] 提交 extract 游标 —— 单一出口，避免「失败也推进」的旧 bug 再犯。
 *
 * processedKeys 保留 20000 个 + prunedBelow 水位：
 *   键被淘汰后，靠水位挡住「明显更早」的消息，避免它们被当成新消息重新提取。
 */
function saveExtractCursor(d, processed, all, cur) {
  const keep = 20000;
  const arr = Array.from(processed);
  // [红队 R2 P1] 与 capture 同理：**不用时间戳水位**（会误杀回拨的真新消息）。
  //   被淘汰的键挪进 retiredKeys 精确记住（上限 40000），宁可多记不可误杀。
  const retired = new Set(Array.isArray(cur && cur.retiredKeys) ? cur.retiredKeys : []);
  let kept = arr;
  if (arr.length > keep) {
    const drop = arr.slice(0, arr.length - keep);
    kept = arr.slice(-keep);
    for (const k of drop) retired.add(k);
  }
  return saveCursor(d, 'extract', null, {
    processedKeys: kept,
    retiredKeys: Array.from(retired).slice(-40000),
    lastDay: all && all.length ? all[all.length - 1].day : (cur && cur.lastDay) || null,
    lastRunAt: new Date().toISOString(),
  });
}

/**
 * [2026-10-22 by Phoebe · 限流兜底] 离线启发式提取。
 *
 * 为什么需要：实测 glm-4.6v-flash 会长时间 429（code 1305「访问量过大」）。
 *   LLM 一挂，extract 就完全不产卡——但**对话本身是有价值的**，不能因为模型限流就全丢。
 *
 * 做什么：不调模型，用纯规则从窗口里抽出「确定性的事实/决策」：
 *   · 以「我做了/改成/修复/新增/发现」开头的助理句 → episodic（进展）
 *   · 以「User要求/User明确/以后都/不要/必须」开头 → instruction（规则）
 *   · 含「喜欢/偏好/讨厌/习惯」且主语是用户 → persona
 * 质量不如 LLM，但**保住下限**：限流期间记忆仍在生长，恢复后 LLM 会继续补充。
 */
/**
 * [2026-10-29 · 工单] SIGNAL 判据 —— **从 heuristicExtract 内联处原样上提**。
 *
 * 为什么要提：漏采池需要知道"哪些句子已判据收下"，否则会把收下的句子也当漏采写进池子。
 * 判据必须**唯一出处**，不能在采集器里抄一份（抄了就会漂）。
 *
 * ⛔ 内容与本文件 2026-10-22 第12轮审计后的版本**逐字相同**，未增删任何词。
 *    工单要求今晚不动 SIGNAL 词表；上提只是可见性变化，语义零变化。
 */
const SIGNAL_RE = /(完成|修复|根治|改成|新增|发现|确认|实现|上线|落地|通过|无阻断|恢复|解决|是因为|因为|导致|造成|原因|根因|问题在|根源|由于|所以|因此|从而|机制|原理|本质|关键在于|前提是|依赖|不触发|失效|停摆|崩溃|报错|失败|异常|阻塞|泄漏|改为|调整为|设置为|取值|阈值|门槛|参数|配置|优先级|定时器|进程|索引|游标|缓存|注入|检索|提取|蒸馏)/;

export function heuristicExtract(win, opts) {
  const o = opts || {};
  const max = Number(o.maxItems) || 3;
  const out = [];
  const seen = new Set();
  // [2026-10-22 by Phoebe · 实跑抓到的质量事故]
  //   旧版直接 slice 原文，产出带 markdown 残留（\*\*、\`）和过场话的卡：
  //     "[兜底] episodic | Assistant这就查上游仓库有没有修复(呆毛一竖)"
  //     "[兜底] episodic | 关键发现:\`ingest-capture\` 在持续写入日志..."
  //   现在统一清洗 + 黑名单 + 只认句首结论。
  // [2026-10-22] 口语化句首前缀：作为正文可以，但做标题要剥掉
  const stripLead = (s) => String(s || "")
    .replace(/^\s*(查到了|查到|发现|确认了|确认|知道了|原来是|原来|其实|是因为|因为|所以|结果|然后|而且|并且)\s*[:：,\s]*/i, "")
    .replace(/^\s*(是|有)\s*/, "")
    .trim();

  const clean = (s) => {
    let t = String(s || '');
    // [2026-10-22 补] 表格行/分隔线：'| HANDOFF | 主交接 |' 这种不是记忆
    if (/^\s*\|/.test(t) || /^\s*[-:]{3,}\s*\|/.test(t)) return '';
    t = t
      // 剥 markdown：粗体/斜体/行内代码/标题符号/引用符
      .replace(/\*\*|__|\`|\*|(^|\s)#{1,6}\s/g, ' ')
      // 表格管线符：把 '| a | b |' 摊平成 'a b'
      .replace(/\s*\|\s*/g, ' ')
      .replace(/^[\s>•·\-]+/, '')
      .replace(/\s+/g, ' ')
      .trim();
    // 摊平后如果只剩表头/噪声词，丢掉
    if (/^(HANDOFF|README|文件名|文档|章节|标题)$/i.test(t)) return '';
    return t;
  };

  // 过场话/口头禅：这些不是记忆
  const NOISE = /^(Assistant这就|Assistant拿到|好的|明白|收到|继续|下面|接下来|那么|其实|所以|但是|不过|然后|现在|让我|我来|我先|备份完成|等等|稍等|马上)/;

  // ══════════════════════════════════════════════════════════════════
  // [2026-10-22 by Phoebe · 实跑抓到「自产卡质量差」的真根因]
  //
  //   实测自产卡的标题长这样：
  //     「这让我必须重新审视:」
  //     「这没问题」
  //     「它用的是「这是关于期」
  //     「Assistant差点被「5/5 全命中」骗过去」
  //
  //   问题不是措辞脏，而是**类型错了**：
  //   这些是「我（AI）做事的过程叙述」，不是「发生了什么事/得出了什么结论」。
  //
  //   对长期记忆真正有用的是**名词性的结论**：
  //     ✅ 「planWindows 强制 user 开头导致 extract 饿死」
  //     ✅ 「DSH 进程是 Idle 优先级，定时器长期不跳」
  //     ❌ 「这让我必须重新审视…」（第一人称思考过程）
  //     ❌ 「先验证定时器是否真的停止」（下一步计划）
  //
  //   加两道过滤：
  //     ① **过程叙述黑名单**：以"这/那/它/我/先/接下来/然后"起头的句子
  //     ② **必须含具体主语**：起码有一个技术名词/具体对象，不能全是虚词
  // ══════════════════════════════════════════════════════════════════
  const PROCESS_NOISE = /^(这让我|这没问题|这说明我|这就是|那我|那我先|先验证|先看|先查|接下来|然后我|现在我|我一直在|我不该|我得|我要|它用的是|它其实|Assistant差点|Assistant这|让我先|等我想|确认一下)/;

  // 至少要有"具体对象"：技术栈名词、文件、参数、时间、或明确的中文主体词
  const CONCRETE = /([a-zA-Z]{3,}|[0-9]+|窗口|游标|索引|配置|进程|定时器|优先级|接口|函数|模块|参数|阈值|测试|日志|卡片|记忆|蒸馏|提取|捕获|检索|注入|向量|缓存|门禁|熔断|队列|字段|路径|文件|目录|端口|版本|红队|报告|审计|验收|画像|开关|批次|重启|部署|构建|编译|超时|限流|异常|错误|崩溃|泄漏|阻塞|并发|锁|降级|回退|迁移|替换|注入)/;

  const push = (type, content, priority) => {
    let c = clean(content);
    if (c.length < 14 || c.length > 280) return;
    if (NOISE.test(c)) return;
    // [2026-10-22] 过程叙述不收：那是"我在做事"，不是"发生了什么"
    if (PROCESS_NOISE.test(c)) return;
    // [2026-10-22] 必须有具体对象（技术名词/数字/文件等），纯感慨不收。
    //   例外：instruction / persona 类**不适用**——「User讨厌很酸的水果」是有效画像，
    //   它没有技术名词但确实值得记。（实跑教训：这条误杀了 K2 的偏好样本）
    if (type !== 'instruction' && type !== 'persona' && !CONCRETE.test(c)) return;
    // 必须至少有一个中文字符（挡纯符号/纯英文碎片）
    if (!/[\u4e00-\u9fff]/.test(c)) return;
    const fp = sha1_16(type + '\u0000' + c);
    if (seen.has(fp)) return;
    seen.add(fp);
    // scene_name 会作为标题展示 ⇒ 剥掉「查到了:」这类口语前缀
    const head = stripLead(c);
    // [2026-10-23 by Phoebe · 期8.3.2] 这条**启发式兜底路径连 normalizeL1 都不走**，
    //   原来直接 content.slice(0,36) 当 scene_name —— 短句就切出「对抗审查」这种 4 字碎片。
    //   闸门装在 normalizeL1 的 title 上对这里**完全无效**（这就是 29 张坏卡的来源之一）。
    //   ⇒ 必须过统一的 sanitizeTitle；返回 null ⇒ 宁缺毋滥，丢弃该卡。
    const t = sanitizeTitle(head || c, c);
    if (!t) return;
    out.push({ type, scene_name: t, content: c, priority: priority || 65, evidence: '' });
  };

  // [2026-10-29 by Phoebe · 工单第一件事] 漏采池 sink（可为 null ⇒ 零 IO）
  //   ⛔ 只读不写：本变量**绝不**参与 out.push / return，主链路返回值一行不改。
  const missSink = (o.missSink && typeof o.missSink.record === 'function') ? o.missSink : null;

  for (const m of win.messages) {
    const raw = String(m.content || '');
    // 先按句切，逐句找「像结论」的那句（而不是只取第一句——
    //   真实对话里第一句常是"好的，我来…"，结论在后面）
    //
    // [2026-10-29 · 工单] 切一次、留两份：
    //   rawSentences 不设长度门槛 —— 漏采池用。工单明确禁止按字数切：
    //     <4 字 过滤会系统性丢掉「我赢了」「认输」「难受」，三个字恰恰是生活事件核心。
    //   sentences（>=14）保持原样 —— 主链路判据，一个字都不许动。
    const rawSentences = raw.split(/[。！？\n]/).map((x) => x.trim()).filter((x) => x.length > 0);
    const sentences = raw.split(/[。！？\n]/).map((x) => x.trim()).filter((x) => x.length >= 14);

    // ── 旁路采集：这一整条消息里**没被任何判据收下**的句子 ──
    //   放在循环顶部而不是分散在两个分支里：user 侧（"今天真下了一盘五子棋"）与
    //   assistant 侧（"Assistant认输"）都会被丢。只钩 assistant 的 SIGNAL 会漏掉触发本工单的那盘棋。
    //   ⛔ 任何异常都在这里吞掉：采集器绝不能把主链路带崩。
    if (missSink) {
      try {
        const taken = new Set();
        for (const s of sentences) {
          const head = s.slice(0, 60);
          if (m.role === 'user') {
            if (/(以后都|从现在开始|必须|不要再|记住|要求|希望)/.test(head)) { taken.add(s); }
            else if (/(喜欢|偏好|讨厌|习惯|我需要|我想要)/.test(head)) { taken.add(s); }
          } else if (SIGNAL_RE.test(s)) {
            taken.add(s);
          }
        }
        for (let si = 0; si < rawSentences.length; si++) {
          const s = rawSentences[si];
          if (taken.has(s)) continue;
          missSink.record({
            sessionId: win.sessionKey,
            messageId: String(m.id || messageKey(m)),
            role: String(m.role || ''),
            text: s,
            context: buildContext(rawSentences, si),
            now: Number(m.timestamp) || Date.now(),
          });
        }
      } catch { /* 采集失败一律不影响主链路 */ }
    }

    if (m.role === 'user') {
      for (const s of sentences) {
        const head = s.slice(0, 60);
        if (/(以后都|从现在开始|必须|不要再|记住|要求|希望)/.test(head)) { push('instruction', s, 85); break; }
        if (/(喜欢|偏好|讨厌|习惯|我需要|我想要)/.test(head)) { push('persona', s, 70); break; }
      }
    } else {
      // 助理：挑「可复用事实」——不仅认「完成/修复」，更要认根因/机制/因果。
      //
      // [2026-10-22 第12轮审计后的补强]
      //   旧词表只有「完成/修复/根治/发现」，把最关键的根因句全漏了：
      //     「DSH 进程被系统设成 Idle 优先级…」← 没有上面的词，被丢
      //     「因为 L0 候选无条件占满…」      ← 含「因为」但被丢
      //   根因比动作更有记忆价值。
      //   另一个 bug：原来 sentences.find() 只取第一条命中，
      //   一条消息里有多个事实时只留一个 ⇒ 改成全扫。
      // [2026-10-29 · 工单] 正则**原样**上提到模块作用域（SIGNAL_RE），
      //   只为让旁路采集器能复用同一张表（同一条消息里"已收下"的句子集合）。
      //   ⛔ 一个字符都没改、没加、没删 —— 工单明确：今晚不动 SIGNAL 词表。
      const SIGNAL = SIGNAL_RE;
      const hits = sentences.filter((s) => SIGNAL.test(s) && !NOISE.test(clean(s)));
      for (const h of hits) { push('episodic', h, 70); if (out.length >= max) break; }
    }
    if (out.length >= max) break;
  }
  return out;
}

/** 读某天（或全部未处理）的 L0 消息，按 session 聚合。 */
export function readL0Messages(d, opts) {
  const o = opts || {};
  if (!existsSync(d.conversations)) return [];
  let names = [];
  try { names = readdirSync(d.conversations).filter((f) => f.endsWith('.jsonl')).sort(); } catch { return []; }
  const sinceDay = o.sinceDay ? String(o.sinceDay) : null;
  const out = [];
  for (const name of names) {
    const day = name.slice(0, 10);
    if (sinceDay && day < sinceDay) continue;
    let raw = '';
    try { raw = readFileSync(d.conversations + '/' + name, 'utf8'); } catch { continue; }
    for (const line of raw.split('\n')) {
      if (!line) continue;
      let m; try { m = JSON.parse(line); } catch { continue; }
      if (!m || !m.role || typeof m.content !== 'string') continue;
      const ts = Number(m.timestamp);
      if (!Number.isFinite(ts)) continue;
      out.push({
        day, sessionKey: String(m.sessionKey || m.sessionId || 'unknown'),
        id: String(m.id || ''), role: m.role, content: m.content, timestamp: ts,
      });
    }
  }
  out.sort((a, b) => a.timestamp - b.timestamp);
  return out;
}

/** 把消息按 session + 连续块切成「待提取窗口」，跳过已经处理过的消息键。 */
export function planWindows(messages, cursor, opts) {
  const o = opts || {};
  const batch = Number.isFinite(Number(o.batchMessages)) ? Number(o.batchMessages) : 24;
  const minBatch = Number.isFinite(Number(o.minBatchMessages)) ? Number(o.minBatchMessages) : 4;
  const done = new Set(Array.isArray(cursor.processedKeys) ? cursor.processedKeys : []);
  for (const k of (Array.isArray(cursor.retiredKeys) ? cursor.retiredKeys : [])) done.add(k);
  const bySession = new Map();
  for (const m of messages) {
    const k = messageKey(m);
    if (done.has(k)) continue;
    let a = bySession.get(m.sessionKey);
    if (!a) bySession.set(m.sessionKey, a = []);
    a.push(Object.assign({}, m, { _key: k }));
  }
  // ══════════════════════════════════════════════════════════════════
  // [2026-10-22 by Phoebe · 第17轮] 窗口要**优先挑信息量大的**，不是按顺序切。
  //
  //   实测：待处理 8 条全是我的过程叙述（"这是最后一个 bug""补测试并做最终验证"），
  //   而 L0 里其实有 65 条含技术事实（"根因找到了：distillTick 在第 228 行声明…"）。
  //   按顺序切 ⇒ 最新的过程话先被处理，真正有价值的事实排在后面等着。
  //
  //   修法：给每条消息打**信息量分**，窗口按分数从高到低取；
  //   同一窗口内仍按时间排序（保证上下文连贯）。
  // ══════════════════════════════════════════════════════════════════
  const scoreOf = (m) => {
    const c = String(m.content || '');
    let s = 0;
    // 强信号：根因/机制/参数/结论
    if (/(根因|原因|导致|因为|所以|说明|证明|确认了|找到了|机制|原理|本质)/.test(c)) s += 5;
    if (/[0-9]+\s*(ms|秒|分钟|小时|轮|条|张|个|分)/.test(c)) s += 2;
    if (/(修复|改成|改为|新增|实现|落地|通过|阈值|门槛|参数|配置)/.test(c)) s += 3;
    // 具体技术名词
    if (/(定时器|进程|优先级|索引|游标|缓存|注入|检索|蒸馏|提取|接口|函数|模块|字段|路径)/.test(c)) s += 2;
    if (/[a-zA-Z]{4,}/.test(c)) s += 1;
    // 过程叙述扣分
    if (/(这让我|这没问题|现在去查|接下来|补测试|做最终验证|收尾|先看|先验证)/.test(c)) s -= 4;
    // user 的话更有价值（那是需求/决定）
    if (m.role === 'user') s += 3;
    return s;
  };

  const windows = [];
  for (const [sessionKey, arr] of bySession) {
    arr.sort((a, b) => a.timestamp - b.timestamp);
    // 按信息量排序，分高的优先成窗
    const ranked = arr.slice().sort((a, b) => scoreOf(b) - scoreOf(a));
    for (let i = 0; i < ranked.length; i += batch) {
      const slice = ranked.slice(i, i + batch);
      if (slice.length < minBatch) continue;
      // 窗口内按时间排回去（保持上下文连贯）
      slice.sort((a, b) => a.timestamp - b.timestamp);
      // [2026-10-22 by Phoebe · 实跑抓到的设计缺陷 —— 这条把 extract 饿死了]
      //
      //   旧逻辑：「窗口必须以 user 开头，否则助手回答脱离提问」——听起来对，
      //   但真实数据是 47 条里 1 条 user、46 条 assistant：
      //     · 用户发一句 → 我调几十次工具 → 期间 assistant 消息一条条被捕获
      //     · capture 每次从「最后一条真实 user」往后切 ⇒ 只有第一条含 user
      //     · planWindows 一看窗口里没 user 就 continue ⇒ 永远 0 窗口 ⇒ extract 空转
      //   实测：extract cursor 停在 12:35，之后 35 条未处理消息**全是 assistant**。
      //
      //   修法：不再强制以 user 开头。对话是连续的，assistant 段落本身就是
      //   「这一轮做了什么 / 得出了什么」，对长期记忆同样有信息量（甚至更有——那是结论）。
      //   只保留一个下限：窗口里至少有 1 条 user，或至少 minBatch 条 assistant。
      const hasUser = slice.some((m) => m.role === 'user');
      const assistantN = slice.filter((m) => m.role === 'assistant').length;
      if (!hasUser && assistantN < minBatch) continue;
      windows.push({ sessionKey, messages: slice });
    }
  }
  // [2026-10-22 修正] 不能在最后按时间重排 —— 会把"高信息量窗口"重新压到后面，
  //   前面那个打分排序就白做了。改为保留打分顺序（谁信息量大谁先被提取）。
  return windows;
}

function renderWindow(win) {
  const head = '会话：' + win.sessionKey;
  const body = win.messages.map((m) => {
    const t = new Date(m.timestamp).toISOString();
    return '[' + t + '] ' + (m.role === 'user' ? '用户' : 'AI') + '：' + m.content;
  }).join('\n');
  return head + '\n\n' + body.slice(0, 6000);
}

/**
 * 跑一轮提取。
 * @returns {Promise<{windows:number, extracted:number, written:number, skipped:number, llm:string}>}
 */
export async function runExtract(p) {
  const params = p || {};
  const opts = params.opts || {};
  const ep = params.llm || null;
  if (!ep) return { windows: 0, extracted: 0, written: 0, skipped: 0, llm: 'off', reason: 'no-llm' };
  // 可注入的补全函数（测试塞假模型用；生产不传就走真 LLM）
  const completeFn = typeof params.completeFn === 'function' ? params.completeFn : complete;
  const d = dirs(opts.root);
  ensureDirs(d);
  const maxWindows = Number.isFinite(Number(opts.maxWindowsPerRun)) ? Number(opts.maxWindowsPerRun) : 3;
  // [红队 P0] 并发保护：拿不到锁就本轮不跑（下一轮再来），绝不做无锁的 read-modify-write。
  const lock = opts.disableLock ? { release() {} } : acquireLock(d, 'extract', opts.lockTtlMs);
  if (!lock) return { windows: 0, committed: 0, extracted: 0, written: 0, failed: 0, reason: 'locked' };

  // ── [2026-10-29 by Phoebe · 工单第一件事] 漏采池（只采集，不改判据） ──
  //   为什么在这里建而不是模块顶层：顶层会在**每次 import** 就建，36 套测试一进来
  //   就往真实数据集灌假数据（一周后没法标注）。这里只在 runExtract 真跑时建。
  //   ── 开关为什么是「默认关、生产显式开」而不是「默认开」──
  //   2026-10-29 17:50 真实事故：跑 selftest-ingest 时，9 条**测试假句子**被写进
  //   真实数据集 logs/signal-miss.jsonl（"时钟回拨了…"是测试造的风控样本）。
  //   一周后拿这份池子去标注，样本里混着假数据，判据就是从垃圾里提的。
  //   ⇒ 库层默认 off；只在 lib/ingest/index.js 的生产调用点显式传 missPool:true。
  //      测试/干跑/影子跑一律不传 ⇒ 一次 IO 都不做。
  //   ⛔ 建池失败 ⇒ 降级成 null，绝不拖垮提取主流程。
  let missPool = null;
  if (opts.missPool === true || (typeof opts.missPoolPath === 'string' && opts.missPoolPath)) {
    try {
      missPool = createMissPool({
        path: opts.missPoolPath || undefined,
        maxAgeDays: opts.missPoolMaxAgeDays,
        maxEntries: opts.missPoolMaxEntries,
        logger: opts.logger || null,
      });
    } catch (e) {
      missPool = null;
      try { const lg = opts.logger; lg && lg.miss && lg.miss({ level: 'signal-miss-init', reason: String(e && e.message || e) }); } catch {}
    }
  }
  let result;
  try {
  const cur = loadCursor(d, 'extract', null, { processedKeys: [], retiredKeys: [], lastDay: null, updatedAt: null });
  const all = readL0Messages(d, opts);
  const wins = planWindows(all, cur, opts).slice(0, maxWindows);
  const processed = new Set(Array.isArray(cur.processedKeys) ? cur.processedKeys : []);
  for (const k of (Array.isArray(cur.retiredKeys) ? cur.retiredKeys : [])) processed.add(k);
  let extracted = 0;
  let written = 0;
  let failed = 0;

  let committed = 0;   // 真正成功提交的窗口数（游标只推进这些）
  let state_fallback = 0;   // 走了离线启发式兜底的窗口数（限流时）
  // [2026-11-05 by Phoebe · User裁定「先关掉启发式兜底」后的观测计数器]
  let state_fallback_llm = 0;       // 备用 LLM 成功救回的窗口数（预留通道被真正用上）
  let state_fallback_skipped = 0;   // LLM 挂了且不允许兜底 ⇒ 主动放弃的窗口数（不推进游标）
  const hb = setInterval(() => { try { lock.touch && lock.touch(); } catch {} }, 30000);
  if (hb && typeof hb.unref === 'function') hb.unref();
  try {
  for (const win of wins) {
    const text = await completeFn(ep, EXTRACT_SYSTEM_PROMPT, renderWindow(win));
    // [红队 P0] LLM 失败（null / 非法输出 / 归一化后为空）时**绝不能推进窗口游标**，
    //   否则这段对话永久不能重试 ⇒ 静默丢记忆（旧实现正是这么丢的，覆盖率 2.9%）。
    //   这里改成「失败即中止本轮」：剩下的窗口下一轮再说，已成功的照常提交。
    // [2026-10-22 by Phoebe · 限流兜底] LLM 挂掉（限流/超时/坏输出）时**不空手而归**：
    //   改用离线启发式抽「确定性的事实/决策」。质量不如模型，但保住下限——
    //   限流期间记忆仍在生长，恢复后 LLM 会继续补充。
    //   注意：兜底成功也算"提交"，游标照常推进（这些消息确实被处理过了）。
    let usedFallback = false;
    let arr = null;
    if (text === null || text === undefined) {
      usedFallback = true;
    } else {
      arr = parseJsonArray(text);
      if (!arr) usedFallback = true;
    }
    if (usedFallback) {
      state_fallback++;
      // ══════════════════════════════════════════════════════════════
      // [2026-11-05 by Phoebe · User裁定：先关掉启发式兜底]
      //
      // User原话：
      //   「先要保证路径B不要再产出重复低质量的卡片影响，卡片后续重做。
      //    顶多作为 LLM 保底，甚至保底换成其他 LLM 或本地小 LLM，
      //    都比继续开启路径B污染好。」
      //
      // 实测依据（2026-11-05）：
      //   · heuristic-fallback 共产 24 张 / 3090 张 = **0.8%**（数量不大）
      //   · 但这 24 张里只有 3 张有 title，其余只能靠 scene_name 硬凑
      //   · 它是「正则抠句子」，没有 LLM 的语义提炼 ⇒ 天生低质量
      //
      // 三档模式（opts.fallbackMode，默认 'off' —— User要求先关掉）：
      //   · 'off'       → **不产卡**，记 fault 等下一轮 LLM 恢复（默认）
      //   · 'llm'       → 用备用 LLM（opts.fallbackLlm）重试一次，仍失败则不产卡
      //   · 'heuristic' → 旧的启发式兜底（保留代码，需显式开启）
      //
      // ⚠️ 关掉兜底的代价：LLM 限流期间「记忆断流」。
      //    这是User明确接受的取舍 —— 宁可不产，也不产污染卡。
      // ══════════════════════════════════════════════════════════════
      const fbMode = String(opts && opts.fallbackMode || 'off');

      // ── 档位 'llm'：备用 LLM 预留通道 ──
      //   [为将来接本地小模型预留] User：「我会让其他会话准备一些本地模型到时候测试」
      //   · opts.fallbackLlm 形如 { provider, model } 或直接一个 endpoint 对象
      //   · 复用同一个 EXTRACT_SYSTEM_PROMPT 与 renderWindow（口径与主路径完全一致）
      //   · 失败一律降级为「不产卡」，绝不回落到启发式（除非显式 heuristic 档）
      if (fbMode === 'llm' && opts && opts.fallbackLlm) {
        try {
          const t2 = await completeFn(opts.fallbackLlm, EXTRACT_SYSTEM_PROMPT, renderWindow(win));
          const arr2 = t2 === null || t2 === undefined ? null : parseJsonArray(t2);
          if (Array.isArray(arr2) && arr2.length) {
            // 备用 LLM 成功 ⇒ 走与主路径完全相同的落盘逻辑（下面主循环复用）
            arr = arr2;
            usedFallback = false;
            state_fallback_llm++;
          }
        } catch (fbErr) {
          recordFault('ingest', 'fallback-llm', fbErr);
        }
      }

      // ── 档位 'off'（默认）/ 'llm' 失败：不产卡，等下一轮 ──
      //   关键：**不推进游标**（break），这段对话下一轮还会重试 ⇒ 不丢记忆。
      //   ⚠️ 只有 'off'/'llm' 两档才 break；'heuristic' 档要往下走（由下面那段接管）。
      //      [2026-11-05 实测抓到] 第一版这里写成无条件 if (usedFallback) break，
      //      导致下面的 heuristic 分支永远走不到 ⇒ 显式开 heuristic 也不产卡（AC13.4 挂）。
      if (usedFallback && fbMode !== 'heuristic') {
        state_fallback_skipped++;
        recordFault('ingest', 'fallback-skipped', new Error('llm-failed mode=' + fbMode + ' win=' + String(win && win.messages && win.messages.length || 0)));
        failed++;
        break;
      }
    }

    // ── 启发式兜底（仅在显式 fallbackMode='heuristic' 时才会走到）──
    if (usedFallback && String(opts && opts.fallbackMode || 'off') === 'heuristic') {
      // [2026-10-29 by Phoebe · 工单第一件事] 兜底路径是 SIGNAL 闸门真正生效的地方
      //   （主路径由 LLM 判断，不走正则），所以漏采池挂在这里。
      //   ⛔ 只在**兜底**时采集是刻意的：主路径被 LLM 丢掉的内容另一套机制管，
      //      混进来会让"一周后标注样本"里同时有两种丢法的句子，判据反而更糊。
      const heur = heuristicExtract(win, { maxItems: 3, missSink: missPool });
      if (heur.length === 0) { failed++; break; }   // 真的没内容可提 ⇒ 不推进游标
      const nowIsoF = new Date().toISOString();
      const linesF = [];
      for (const it of heur) {
        const fp = it._fp || sha1_16(it.type + '\u0000' + it.content);
        if (processed.has('fp:' + fp)) continue;
        // [2026-10-23 · 期8.3.2 第三次补漏] 这条**离线兜底路径**是同类事故的第三处：
        //   前两轮分别修了 :200（启发式产卡）与 :465（LLM 主路径），唯独这条
        //   「LLM 挂掉 → heuristicExtract 兜底 → 直接落盘」的路线上没有闸门，
        //   `it.scene_name || it.content.slice(0,30)` 原样落盘 ⇒ session id 当标题。
        //   ⇒ 与其他两条路径**同口径**：过 sanitizeTitle，提不出就丢卡。
        // [2026-11-06 by Phoebe · 与主路径同口径] 真标题优先，scene 兜底。
        //   heuristicExtract 产的对象**不带 title**（它只给 scene_name），
        //   但为防御未来加字段，这里也走 it.title 优先。
        const llmTitleF = sanitizeTitle(String(it.title || '').trim(), it.content);
        const sceneF = sanitizeTitle(String(it.scene_name || '').trim() || String(it.content || '').slice(0, 30), it.content);
        const finalTitleF = llmTitleF || sceneF;
        if (!sceneF && !finalTitleF) continue;   // 宁缺毋滥，与其他两条路径同口径
        extracted++;
        // [2026-10-24 Round 11] 第二条写卡路径（启发式兜底）同样要带 importance。
        //   这个文件里有**三处**产卡：:200 启发式产卡 / :465 LLM 主路径 / 这里兜底路径。
        //   历史上"只修一处漏两处"出过三次事故，所以三处必须同口径。
        const impF = scoreImportance({ title: finalTitleF, summary: String(it.content || '').slice(0, 100), content: it.content, role: 'user' });
        linesF.push(JSON.stringify({
          id: 'pm_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
          content: it.content, type: it.type,
          priority: it.priority || 65,
          // [2026-11-06 by Phoebe] 与主路径同口径：真标题优先
          title: finalTitleF,
          scene_name: sceneF,
          importance: impF.importance,
          is_axiom: impF.is_axiom,
          importance_signals: impF.signals,
          // ── [2026-11-05 by Phoebe · C4 指针改全窗] ──
          //   【病灶】原来是 slice(0, 8) —— 窗口 24 条只记前 8 条（33%），
          //     实测 67.6% 的卡顶格 8 条、平均 7.09 条，后 16 条**从没说出去**。
          //   ⇒ 溯源时只能回查窗口前三分之一，后面的事实无法定位。
          //   【为什么改成全窗】窗口 = 24 条，全记下来才是「忠实指针」。
          //   【风险已排查】① 不进任何指纹/缓存键（grep lib/ 15 处确认）
          //               ② source-tracer 只透传不做匹配，多带 id 只会增召回不减精度
          //   【体积】约 +16 id/卡，3136 张卡估 +300~600KB，可接受。
          source_message_ids: win.messages.map((m) => String(m.id || messageKey(m))),
          metadata: { evidence: 'heuristic-fallback', activity_start_time: new Date(win.messages[0].timestamp).toISOString(), activity_end_time: new Date(win.messages[win.messages.length - 1].timestamp).toISOString() },
          timestamps: [nowIsoF], createdAt: nowIsoF, updatedAt: nowIsoF,
          // ── [2026-11-05 by Phoebe · 补 eventTs（User批「都补」）] ──
          //   【病灶】extract.js 从上线起**从未写过 eventTs**（grep 0 处）。
          //     pm: 卡占检索池 30.6%（4272/13978）却全都没有真实事件时间
          //     ⇒ 时间窗口过滤只能退化到 createdAt（索引时间，不是事发时间）。
          //   【数据现成】metadata.activity_start_time 就是这扇窗第一句话的时间，
          //     即「这件事什么时候发生」——正是 eventTs 的定义。
          //   ⚠️ 两处产卡点（启发式兜底 / LLM 主路径）**必须同口径**，
          //      历史上"只修一处漏两处"出过三次事故。
          //   【口径】eventTs = 这扇窗第一句话的时间（= 事什么时候发生）
          //     fallback 到 nowIsoF（写入时刻），保证不产生 NaN。
          eventTs: (function () {
            const t0 = epochMsOf(win.messages[0].timestamp);
            return Number.isFinite(t0) && t0 > 0 ? t0 : Date.parse(String(nowIsoF));
          })(),
          // [红队 P1-1] 只有真的用到了消息时间才标 activity_start；回退提取时刻要如实标 extracted_at
          eventTsSource: (function () {
            const t0 = epochMsOf(win.messages[0].timestamp);
            return Number.isFinite(t0) && t0 > 0 ? 'activity_start' : 'extracted_at';
          })(),
          sessionKey: win.sessionKey, sessionId: win.sessionKey, source_session_id: win.sessionKey, schema: 'phoebe-memory.l1.v1',
          // 期8.3.1：事实卡自带实体（content + scene_name 是 L1 的全部文本面）
          // [第三次补漏] 用**净化后**的 sceneF，别再用原始 it.scene_name（否则实体里又是 session id）
          entities: extractEntities({ content: it.content, scene_name: sceneF }),
        }));
        processed.add('fp:' + fp);
      }
      if (linesF.length > 0) {
        const fileF = d.records + '/' + localDate(win.messages[win.messages.length - 1].timestamp) + '.jsonl';
        const nF = appendLines(fileF, linesF, opts.maxBytes);
        if (nF === 0) { failed++; break; }
        written += nF;
      }
      for (const m of win.messages) processed.add(m._key || messageKey(m));
      const okF = saveExtractCursor(d, processed, all, cur);
      if (okF !== true) { failed++; break; }
      committed++;
      continue;
    }
    // [2026-10-22 by Phoebe · 旁路实跑抓到] 不能把「机器可解析」寄希望于小模型听话：
    //   glm-4.6v-flash 会自造字段名（{"阶段":..,"事件":..}），严格 schema 校验会整批丢弃 ⇒ 提取率 0。
    //   先做三层归一化（别名映射 / 按内容推断 / 兜底），再走后续逻辑。
    const norm = normalizeL1(arr, { maxItems: 4 });
    // 归一化后为空：这是「模型认为本段无长期价值」的合法结果（空数组），
    //   也可能是解析彻底失败。二者靠 text 是否含 '[' 粗分：有数组却没内容 ⇒ 视为成功（跳窗）；否则视为失败（不推进）。
    if (norm.length === 0) {
      if (typeof text === 'string' && text.indexOf('[') >= 0) {
        // ── [2026-10-29 by Phoebe · 最关键的一个采集点] ──
        //   这个分支 = "LLM 正常返回了，但它认为**整段都没价值**（返回 []）"。
        //   实测那盘五子棋走的正是这里：LLM 一句都没提，全部丢弃，且**没有任何痕迹**。
        //   原来采集器完全不覆盖这里 —— 等于"丢得最干净的那类，一条都采不到"。
        //   ⇒ 整个窗口的句子都是"被 LLM 判空"的，全采。
        //   ⛔ 纯旁路：不改变 committed / 游标 / 返回值。
        if (missPool) {
          try { collectLlmMisses(missPool, win, []); } catch { /* 采集失败不影响主链路 */ }
        }
        // [红队 R2 P1] 空窗口也要**立即**提交游标，不能等循环结束（中途崩溃会重跑）
        for (const m of win.messages) processed.add(m._key || messageKey(m));
        const ok0 = saveExtractCursor(d, processed, all, cur);
        if (ok0 !== true) { failed++; break; }
        committed++;
        continue;
      }
      failed++; break;
    }
    const nowIso = new Date().toISOString();
    const lines = [];
    for (const it of norm) {
      const type = it.type;
      const content = it.content;
      if (!['persona', 'episodic', 'instruction'].includes(type)) continue;
      if (content.length < 8) continue;
      // 去重：内容指纹已存在就跳过（同一段对话反复提取不堆积）
      const fp = it._fp || sha1_16(type + '\u0000' + content);
      if (processed.has('fp:' + fp)) continue;
      extracted++;
      // [2026-10-23 by Phoebe · 期8.3.2] 主路径同样要过闸门。
      //   L1 卡落盘对象里**根本没有 title 字段**（只有 scene_name），所以
      //   normalizeL1 里那套「改 title」的判据在这里完全碰不到 —— 29 张坏卡
      //   正是从这里原样落盘的（UUID / 英文叙述 / 4 字泛称）。
      //   ⇒ 用同一个 sanitizeTitle 净化 scene_name；null ⇒ 丢弃该卡。
      // ══ [2026-11-06 by Phoebe · User追问「老卡标题都是错的」后重查] ══
      //   【上一轮修错了】11-05 只加了 `title: scene` —— 而 scene 本身就是
      //     content.slice(0,30) 截断出来的脏值 ⇒ 等于把脏值复制给 title，
      //     字段非空但内容还是假标题。实测：341 张有 title 的卡里 57% 是正文前缀。
      //   【真病根】这一行**从来没读过 it.title**：
      //     LLM 按 prompt（L71「title: 名词性结论，必须含具体名词，≤24字」）
      //     明明产了 title，落盘时被完全忽略，只用 scene_name 顶。
      //   【本改】title 优先取 LLM 产的真标题，scene_name 保持原语义：
      //     · it.title 过同一个 sanitizeTitle 闸门（不合格→退回 scene）
      //     · 两个都没有 → 退回 content 截断（兜底不变）
      //   【为什么不重做老卡】老卡磁盘上没有真 title（当年就没存），
      //     补也只能补 scene 那个脏值 ⇒ 补是假动作。真标题只能靠
      //     LLM 重新读原文再产一次 —— 那是重做，成本高且违背「老卡不返工」。
      //     所以：**新卡走真 title，老卡保持现状**，等它们自然衰减。
      // ══════════════════════════════════════════════════════════════════
      const llmTitle = sanitizeTitle(String(it.title || '').trim(), content);
      const scene = sanitizeTitle(String(it.scene_name || '').trim() || content.slice(0, 30), content);
      // 真标题优先；LLM 没给合格 title 才用 scene 兜底
      const finalTitle = llmTitle || scene;
      if (!scene && !finalTitle) continue;
      const first = win.messages[0];
      const last = win.messages[win.messages.length - 1];
      // ── [2026-10-24 by Phoebe · Round 11 抓到的零接线] ──
      //   症状：L1 卡（pm:）落盘时**没有 importance / is_axiom**。
      //   后果：只有蒸馏卡 + 历史回填卡有代谢字段，**新产的 L1 卡永远缺这一维**
      //         ⇒ 四股力的重要度/衰减对它等于不存在（一直按兜底值算）。
      //   之前回填脚本只补了存量，写入路径没接 ⇒ 修完还会继续产新的脏卡。
      //   典型「修数据不修管道」，必须接在写入侧。
      const imp0 = scoreImportance({ title: finalTitle, summary: content.slice(0, 100), content, role: 'user' });
      lines.push(JSON.stringify({
        id: 'pm_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
        content,
        type,
        priority: Number.isFinite(Number(it.priority)) ? Number(it.priority) : 60,
        // ── [2026-11-05 by Phoebe · C3 修活 bug：主路径从来没写过 title] ──
        //   【病灶】L664-668 的注释自己承认「L1 卡落盘对象里根本没有 title 字段」，
        //     但只改了 normalizeL1（读侧），**写入侧一直没接**。
        //     实测：10-24 之后 2903 张 pm 卡 title 全空（98.1%），
        //     scene_name 却 100% 有值 ⇒ 两者本来是同一个值，只是没写那个键。
        //   【为什么必须写】检索/展示/去重/标题闸门都按 title 走；
        //     缺 title 只能靠读侧用 scene_name 顶替，多一层隐式约定易漏。
        //   【本改】只修写入路径，**不动任何存量卡**（User红线：老卡不返工）。
        //     取值 = finalTitle（LLM 真标题优先，scene 兜底）。
        //     [2026-11-06 二次修正] 上一版写的是 title: scene，那只把脏值复制了一遍；
        //     现在优先用 LLM 产的 it.title（过同一道 sanitizeTitle 闸门）。
        title: finalTitle,
        scene_name: scene,
        importance: imp0.importance,
        is_axiom: imp0.is_axiom,
        importance_signals: imp0.signals,
        // [2026-11-05 by Phoebe · C4] 同上：窗口全量记录，不再截断到前 8 条
        source_message_ids: win.messages.map((m) => String(m.id || messageKey(m))),
        metadata: {
          activity_start_time: new Date(first.timestamp).toISOString(),
          activity_end_time: new Date(last.timestamp).toISOString(),
          evidence: String(it.evidence || '').slice(0, 80),
        },
        timestamps: [nowIso],
        createdAt: nowIso,
        updatedAt: nowIso,
        // ── [2026-11-05 by Phoebe · 补 eventTs · 主路径] 同口径见上方说明 ──
        eventTs: (function () {
          const t0 = epochMsOf(win.messages[0].timestamp);
          return Number.isFinite(t0) && t0 > 0 ? t0 : Date.parse(String(nowIso));
        })(),
        // [红队 P1-1] 同口径：真的用了消息时间才 activity_start，回退则 extracted_at
        eventTsSource: (function () {
          const t0 = epochMsOf(win.messages[0].timestamp);
          return Number.isFinite(t0) && t0 > 0 ? 'activity_start' : 'extracted_at';
        })(),
        sessionKey: win.sessionKey,
        sessionId: win.sessionKey,
        source_session_id: win.sessionKey,
        schema: 'phoebe-memory.l1.v1',
        // 期8.3.1：事实卡自带实体（content + scene_name 是 L1 的全部文本面）
        entities: extractEntities({ content, scene_name: scene }),
      }));
      processed.add('fp:' + fp);
    }
    if (lines.length > 0) {
      const file = d.records + '/' + localDate(win.messages[win.messages.length - 1].timestamp) + '.jsonl';
      const n = appendLines(file, lines, opts.maxBytes);
      // [红队 P1] 落盘失败 ⇒ 本窗口视为未提交，游标不推进（否则这批卡永久丢）
      if (n === 0 && lines.length > 0) { failed++; break; }
      written += n;
    }
    // ── [2026-10-29 by Phoebe · 踩刹车后补的第二采集点] ──
    //   LLM 主路径是**日常唯一在跑的路径**（实测 10-27 占 100%、今天 97%）。
    //   原来采集器只挂兜底 ⇒ 一周后采到的全是"LLM 限流那天"的样本，
    //   而那盘五子棋恰恰是被这条路丢的（提示词问的是"技术问题还有用吗"）。
    //   ⛔ 纯旁路：不参与 lines 的构成、不改返回值、异常全吞。
    //   放在落盘成功之后：这一窗确实处理完了，采到的才是"真被丢下的"。
    if (missPool) {
      try { collectLlmMisses(missPool, win, norm); } catch { /* 采集失败不影响主链路 */ }
    }
    // 只有「跑完 + 落盘成功」的窗口才提交消息键
    for (const m of win.messages) processed.add(m._key || messageKey(m));
    // [红队 R2 P1] 游标写失败 ⇒ 本窗不算提交（下一轮重跑，最多重复，不会丢）
    const okCursor = saveExtractCursor(d, processed, all, cur);
    if (okCursor !== true) { failed++; break; }
    committed++;
  }

  if (committed > 0) {
    saveExtractCursor(d, processed, all, cur);
  }
  result = {
    windows: wins.length, committed, extracted, written, failed, fallback: state_fallback,
    // [2026-11-05 · 兜底三档观测] fallbackLlm=备用LLM救回 / fallbackSkipped=主动放弃
    fallbackLlm: state_fallback_llm, fallbackSkipped: state_fallback_skipped,
    skipped: all.length - wins.reduce((a, w) => a + w.messages.length, 0),
  };
  } finally { try { clearInterval(hb); } catch {} }
  } finally {
    try { lock.release(); } catch {}
  }
  return result;
}

/** 读取本插件自己产的 L1 卡（与 tdai records 同构，便于检索层统一读）。 */
export function readOwnRecords(root, opts) {
  const o = opts || {};
  const d = dirs(root);
  if (!existsSync(d.records)) return { cards: [], files: 0 };
  let names = [];
  try { names = readdirSync(d.records).filter((f) => f.endsWith('.jsonl')).sort(); } catch { return { cards: [], files: 0 }; }
  const cards = [];
  for (const name of names) {
    const day = name.slice(0, 10);
    let raw = '';
    try { raw = readFileSync(d.records + '/' + name, 'utf8'); } catch { continue; }
    for (const line of raw.split('\n')) {
      if (!line) continue;
      let rec; try { rec = JSON.parse(line); } catch { continue; }
      const content = String(rec.content || '').trim();
      if (!content) continue;
      const t = Date.parse(String(rec.createdAt || '')) || Date.parse(day + 'T00:00:00Z') || 0;
      cards.push({
        id: 'pm:' + String(rec.id || sha1_16(content)),
        title: String(rec.scene_name || rec.type || '记忆'),
        summary: content.slice(0, 100),
        content,
        createdAt: t,
        layer: rec.type === 'persona' || rec.type === 'instruction' ? 'global' : 'project',
        _source: 'phoebe-ingest',
        _kind: String(rec.type || 'episodic'),
        source_message_ids: Array.isArray(rec.source_message_ids) ? rec.source_message_ids.slice() : [],
      });
    }
  }
  return { cards, files: names.length };
}
