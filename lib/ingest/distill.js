/**
 * ingest/distill.js —— 期7-C：engram 蒸馏（超图自产）
 * [2026-10-22 by Assistant · 期7-C]
 *
 * 搬什么：engram-relay 的 maybeDistill()（relay.js:625）——把最近回合蒸成
 *         {kind, layer, title, summary, content, causes} 的卡。
 *
 * 治本点（三处，都不是"照着搬"）：
 *   ① **卡写进超图自己的** engrams.jsonl（ingest/engrams.jsonl），
 *      不再寄生在 engram-relay 的 store 里。删旧插件后新卡照产。
 *   ② 游标落盘 + 消息键去重（同 7-B），重启不重复蒸馏、不漏段。
 *   ③ **2-gram 去重 + 过时治理**沿用旧插件的成熟规则（同标题就地刷新、
 *      异标题且旧节点已过时就退役旧节点），但去重对象是"本插件自己的卡库"，
 *      与旧库解耦 —— 这样即使两库并存也不会互相打架。
 *
 * 另外保留 fallbackDistill（LLM 空返回时的启发式），保证「记忆不断流」。
 */
import { recordFault } from '../faults.js';
import { DEFAULT_INGEST_ROOT } from '../hypergraph/source.js';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import {
  dirs, ensureDirs, appendLines, localDate, loadCursor, saveCursor, messageKey, sha1_16, acquireLock,
  atomicWriteJson,
} from './core.js';
import { complete, parseJsonArray } from './llm.js';
import { normalizeEngrams } from './normalize.js';
// [2026-10-23 by Assistant · 期8.1] 认知信用协议：新卡落盘即带 v2 状态机字段
// [2026-10-23 · 期8.1/8.2 阻断3] 补 judgeConflict / normalizeEngramV2 ——
//   红队 C-1 实证：这两个函数在 lib/ 生产链路里**零调用**（只有 bench/trace 在用），
//   判决与状态机是空转。接线点就在这里：distill 写卡前先判决，refute 就回写旧卡。
import { STATUS, inferSourceWeight, judgeConflict, normalizeEngramV2 } from './belief.js';
// [2026-10-23 by Assistant · 期8.3.1] 写入侧实体抽取（与 extract.js 同一规则、同一文件）。
//   engram 卡落盘即带 entities ⇒ 超图不必走 deriveEntities 退化路径。
//   规则法、零 LLM 额外开销 —— distill 是高频路径，不许变慢。
import { extractEntities } from './entities.js';
// [2026-10-24 by Assistant · Step 1] 确定性重要度打分（红白双队签字）
//   替换写死的 importance: 0.6 —— 那等于没有这一维（实测 5,097/5,735 张都是 0.6）。
import { scoreImportance } from '../scoring/importance.js';
// [2026-10-26 · 字段口径统一] 归属会话只认这一份判据
import { sessionIdOf } from '../card-session.js';
// [2026-10-26 by Assistant · 问题生命周期根因治理]
//   入口列表重排（待关闭的问题卡优先）+ 解决识别 + 证据判定，全部在写盘前同步完成，零额外 LLM 开销。
import { buildEntryList, isProblemCard, detectResolution } from './resolution.js';

export const DISTILL_SYSTEM_PROMPT = `你是记忆提取器。从「最近对话回合」中提取**可复用的事实**，最多 3 条。

## 判断标准
问自己：**这句话，三个月后拿来回答一个技术问题，还有用吗？**

✅ 要提取：
- 某个东西的**行为/根因**：「DSH 进程 Idle 优先级导致定时器数小时不触发」
- 某个**决定/约定**：「记忆写入必须用落盘游标」
- 某个**参数/阈值**：「L0 门槛取 25，真命中 36~142 分」
- 用户的**稳定偏好/底线**

❌ 不要提取（作为**新事实卡**）：
- 「它其实命中了」「补测试并做最终验证」← 过程叙述
- 「这让我重新审视」「现在去查」← 心理活动/下一步计划
- 「系统存在三个问题：1)…2)…」← 会议纪要（应拆成多条独立事实）

⚠️ **但「问题已解决」不是普通事实，它要写进 resolves，不要当过程叙述丢掉。**
详见下方「状态转移」。

## 输出格式
- kind: fact | decision | event | note
- layer: global(跨项目通用) | project(仅本项目) | session(仅本次会话)
- title: **名词性结论标题**，不超过 20 字，**必须含具体名词**（进程/配置/函数/参数/文件名等）
  ✅ 「Idle优先级导致定时器不跳」  ✅ 「L0门槛取25」
  ❌ 「它其实命中了」            ❌ 「补测试并做最终验证」
- summary: 一句话摘要（30 字内），须能独立看懂
- content: 完整细节（含关键参数/原因/后果，200 字内）
- causesOf: 导致这条记忆的已有记忆标题（从「已有记忆入口」精确引用，最多 2 个；没有就 []）
- arcStory: （可选）一句话写清这件事的「起因 → 转折 → 结果」，不超过 60 字。
  例：「想省 token → 发现 L0 霸榜 → 改分档 tie-break，检索延时从 5.1s 降到 0.76s」。
  只在**确实有因果链**时写；纯粹的单点事实留空字符串。
- resolves: **状态转移**。本轮对话里若有「某个已有问题已经解决了」，把**被关闭的那张问题卡的标题**原样抄进来（最多 3 个；没有就 []）

## 状态转移（resolves）—— 这是**必填字段**
「已有记忆入口」里有一节【待处理的问题卡】。请在读对话时判断：
**本轮有没有把这些问题的某几个，从"未解决"变成"已解决"？**

✅ 算已解决（写进 resolves）：
- 用户明确确认：「修好了」「这个通过了」「可以签收了」
- 有**验证证据**：测试全绿 / verify 通过 / 实测返回正确 / 断言通过 / 审计通过
- 明确说某个缺陷「已修复」「已落地」「已清」「已删除」

❌ 不算已解决：
- 只是说「我去修」「应该没问题」「看起来好了」← 只是打算/猜测
- 只是 AI 自己说「已通过」而**没有任何验证或用户确认**（会被降级为 claimed，不关卡）

例：入口里有「延迟拆分功能未落地」，本轮对话出现「三段延迟计时已落地，verify 全绿」
    ⇒ resolves: ["延迟拆分功能未落地"]

## 硬性要求
1. title 和 content 都必须出现**具体名词**，不能全是"这/那/它/我"。
2. 宁缺毋滥：抽不出合格的，返回 [] 比产出流水账更好。
3. 只输出 JSON 数组，不要任何其他文字。`;

const LAYERS = new Set(['global', 'project', 'session']);
const KINDS = new Set(['fact', 'decision', 'event', 'note']);

/**
 * 读本插件自己的卡库（engrams.jsonl）。
 *
 * [2026-10-22 by Assistant · 自测抓到] 这是**追加式日志**：退役一张卡是再追加
 * 一行 {id, status:'retired'}，原行不动。所以必须按 id 取最后一条
 * （last-write-wins），否则退役卡会被当成活卡参与去重，甚至再被"刷新"回活态。
 */
export function readOwnEngrams(root) {
  const d = dirs(root);
  if (!existsSync(d.engrams)) return [];
  let raw = '';
  try { raw = readFileSync(d.engrams, 'utf8'); } catch { return []; }
  const byId = new Map();
  for (const line of raw.split('\n')) {
    if (!line) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (!o || !o.id) continue;
    byId.set(String(o.id), o);
  }
  return Array.from(byId.values());
}

/** 2-gram（中文）重叠率，用于重复判定。 */
export function bigramOverlap(a, b) {
  // [红队 P1] 旧实现只切中文连续片段 ⇒ 纯英文/单字标题返回 0 ⇒ 重复漏判。
  //   现在：中文按 2-gram，英文/数字按「小写单词」也计入同一集合（都是"信息单元"）。
  const grams = (s) => {
    const set = new Set();
    const text = String(s || '').toLowerCase();
    for (const seg of text.match(/[\u4e00-\u9fff]+/g) || []) {
      if (seg.length === 1) { set.add(seg); continue; }
      for (let i = 0; i < seg.length - 1; i++) set.add(seg.slice(i, i + 2));
    }
    for (const w of text.match(/[a-z0-9][a-z0-9_.-]*/g) || []) {
      if (w.length >= 2) set.add('w:' + w);
    }
    return set;
  };
  const A = grams(a); const B = grams(b);
  if (A.size === 0 || B.size === 0) return 0;
  let hit = 0;
  for (const g of A) if (B.has(g)) hit++;
  return hit / Math.max(A.size, B.size);
}

/** 启发式兜底：LLM 空返回时至少留一条，保证不断流。 */
export function fallbackDistill(conversation) {
  // [2026-10-22 by Assistant · 旁路实跑抓到] 真实对话里 assistant 常回大段 HTML/CSS，
  //   旧启发式会把 `</div>` 这种标签当标题沉淀成卡（实跑产出 title="</div>"）。
  //   先剥标记再判，纯标记内容一律不产卡。
  const stripMarkup = (s) => String(s || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\{\s*[^{}]*\}/g, ' ')          // CSS 花括号块
    .replace(/^[\s#>*\-`]+/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
  const rawText = String(conversation || '');
  const text = stripMarkup(rawText);
  // [2026-10-22 修正] 原阈值 40 太高：一句完整的结论（38 字）会被误拒。
  //   真正的门槛应该放在**选中的那句话**上（见下方 scored 的 length>=12 过滤），
  //   这里只挡掉"什么都没有"的极端情况。
  if (text.length < 16) return [];
  // [2026-10-22 by Assistant · 实跑抓到质量事故]
  //   原兜底直接从对话尾部切 200 字当卡，产出这种垃圾：
  //     title="这是客观事实"  content="这是客观事实,不能回避。 AI：Assistant这就查上游仓库..."
  //     title="Assistant重新测试: AI"  content="Assistant重新测试: AI：**决定性证据:..."
  //   问题：① 把「AI：」这类说话人前缀当正文；② 挑中的是过场话（"这是客观事实"）而非结论；
  //        ③ 把多轮对话粘成一坨（含 markdown 残留）。
  //
  //   重写：**只挑"像结论"的单句**，且必须通过质量门槛。
  const stripWho = (s) => {
    let t = String(s || '');
    // [关键] 反复剥：一行里可能套多层前缀（"Assistant重新测试: AI：xxx"）
    for (let i = 0; i < 4; i++) {
      const before = t;
      t = t.replace(/^\s*(用户|助手|AI|assistant|user)\s*[:：]\s*/i, '');
      // "Assistant重新测试:" 这种「动作:」前缀也剥（≤8 字 + 冒号）
      t = t.replace(/^\s*[\u4e00-\u9fffA-Za-z]{1,8}\s*[:：]\s*(?=[\u4e00-\u9fffA-Za-z])/,'');
      t = t.replace(/\*\*|__|`/g, '');
      t = t.replace(/^[\s#>*\-•·]+/, '');
      if (t === before) break;
    }
    return t.trim();
  };

  // 把整段切成句子，逐句打分挑最好的一句
  const ROLE_PREFIX = /^\s*(用户|助手|AI|assistant|user)\s*[:：]/i;
  const rawSentences = String(text || '')
    .split(/[。！？\n]/)
    .map(stripWho)
    .filter((s) => s.length >= 12 && s.length <= 120);

  // 过场话/口头禅黑名单（这些即使出现在末尾也不是"记忆"）
  const NOISE = /^(这是客观事实|好的|明白|收到|继续|下面|接下来|那么|其实|所以|但是|不过|然后|现在|让我|我来|我先|Assistant这就|Assistant拿到|确?认了一下|等等)/;

  // [2026-10-22 by Assistant · 实跑抓到自产蒸馏卡是「过程叙述」]
  //   实测产出的垃圾标题：「这让我必须重新审视:」「这没问题」「它用的是「这是关于期」
  //                    「Assistant差点被「5/5」「先验证定时器是否真的」「AI：现在不再自相矛」
  //   这些是"我在做事的心理活动"，不是"发生了什么/得出了什么"。
  //   长期记忆要的是**名词性结论**，不是过程碎碎念。
  const PROCESS_NOISE = /^(这让我|这没问题|这说明我|这就是|那我|那我先|先验证|先看|先查|接下来|然后我|现在我|我一直在|我不该|我得|我要|它用的是|它其实|Assistant差点|Assistant这|让我先|AI[：:])/;
  // 必须含具体对象（技术名词/数字/文件等）
  const CONCRETE = /([a-zA-Z]{3,}|[0-9]+|窗口|游标|索引|配置|进程|定时器|优先级|接口|函数|模块|参数|阈值|测试|日志|卡片|记忆|蒸馏|提取|捕获|检索|注入|向量|缓存|门禁|熔断|队列|字段|路径|文件|目录|端口|版本|红队|报告|审计|验收|画像|开关|批次|重启|部署|构建|编译|超时|限流|异常|错误|崩溃|泄漏|阻塞|并发|锁|降级|回退|迁移|替换)/;
  // 结论信号（有这些词才更像"值得记的事"）
  const SIGNAL = /(完成|修复|根治|解决|发现|确认|决定|改成|实现|上线|新增|删除|失败|原因|因为|结论|规则|必须|不要|以后|要求|证明|验证|证据|问题|坑|落地|通过|复核|无阻断|搬迁|接入)/;

  const scored = [];
  for (const s of rawSentences) {
    if (NOISE.test(s)) continue;
    // [2026-10-22] 过程叙述不收
    if (PROCESS_NOISE.test(s)) continue;
    // [2026-10-22] 必须有具体对象
    if (!CONCRETE.test(s)) continue;
    let score = 0;
    if (SIGNAL.test(s)) score += 3;
    if (/[0-9]/.test(s)) score += 1;          // 带数字/参数的信息量大
    if (s.length >= 18 && s.length <= 90) score += 1;  // 长度适中
    if (/[：:]/.test(s)) score -= 1;           // 带冒号多半是半句
    if (score >= 3) scored.push({ s, score });
  }
  if (scored.length === 0) return [];
  scored.sort((a, b) => b.score - a.score);
  const best = scored[0].s;

  // 标题：取这句里最有信息量的短片段，绝不用"AI："或纯助词
  let title = best.replace(/^[\s#>*\-`]+/, '')
    .split(/[，。！？,.!?;；\n]/)[0]
    .replace(/[\[\]()（）#`*]/g, '').trim().slice(0, 14);
  if (!title || !/[\u4e00-\u9fff]/.test(title) || title.length < 4) {
    title = best.slice(0, 14);
  }
  // 最后一关：标题不能是黑名单词/说话人
  if (NOISE.test(title) || /^(assistant|user|ai|助手|用户|对话|div|span|style|html|body)$/i.test(title)) {
    return [];
  }
  return [{ kind: 'note', layer: 'session', title, summary: best.slice(0, 80), content: best }];
}

/** 读最近 N 条未蒸馏的 L0 消息（来自本插件自己的 conversations/）。 */
/**
 * [2026-10-26 by Assistant · 并发归属污染 P0] **只在指定会话自己的消息里**取最近 N 条。
 *
 * 事故（实测坐实）：
 *   readRecentL0() 取的是「最近两天的**共享** .jsonl」再按时间取最后 40 条，
 *   **完全不管这 40 条是谁说的**；而写卡时统一盖 opts.sessionId（触发蒸馏的那个会话）。
 *   ⇒ 两个窗口同时活跃时，A 窗口的对话会被记成 B 窗口的卡（张冠李戴）。
 *   实测证据：本窗口 07:26 做的「prefetch 脉冲注入」被盖成了 session-80d54d89 的章。
 *
 * 危害：sourceSessionId 是案卷回溯 / 跨会话脉搏排除 / 一切归属判断的地基。
 *   它一错，脉搏会把本窗口自己的卡当成"别的窗口"推回来（实测已发生 2 条）。
 *
 * 铁律（白队裁定）：
 *   ① 只用 sessionKey **严格相等** 的消息；
 *   ② **没有 sessionKey 的旧消息一律不得进入蒸馏池** —— 宁可少记，不可错记；
 *   ③ 不做任何"按内容反查归属"的回填 —— 风险高于收益，存量按历史污染处理。
 */
export function readRecentL0ForSession(d, limit, sessionKey) {
  // [红队陷阱2配套] **双边归一化**再比：调用方可能传带前缀的、盘上可能存不带前缀的。
  //   只比单边会静默漏光所有消息（"过滤对了但一条都取不到"是最难查的形态）。
  const sk = normalizeSid(sessionKey);
  if (!sk) return [];                     // 没有当前会话身份 ⇒ 一条都不取（绝不错记）
  if (!existsSync(d.conversations)) return [];
  let names = [];
  try { names = readdirSync(d.conversations).filter((f) => f.endsWith('.jsonl')).sort(); } catch { return []; }
  const tail = names.slice(-2);
  const out = [];
  for (const name of tail) {
    let raw = '';
    try { raw = readFileSync(d.conversations + '/' + name, 'utf8'); } catch { continue; }
    for (const line of raw.split('\n')) {
      if (!line) continue;
      let m; try { m = JSON.parse(line); } catch { continue; }
      const ts = Number(m.timestamp);
      if (!Number.isFinite(ts) || typeof m.content !== 'string') continue;
      const k = normalizeSid(sessionIdOf(m));
      // 严格相等（归一化后）：别的窗口、以及无 sessionKey 的旧消息，全部挡在外面。
      // 【红队陷阱1】过滤发生在 slice 之前 ⇒ 并发时本会话依然拿满自己的 40 条，窗口不变窄。
      if (k !== sk) continue;
      out.push({ sessionKey: k, role: m.role, content: m.content, timestamp: ts, id: String(m.id || '') });
    }
  }
  out.sort((a, b) => a.timestamp - b.timestamp);
  return out.slice(-(Number(limit) || 40));
}

/**
 * [2026-10-26 by Assistant · 红队陷阱2] 没有显式会话身份时，**锁定最近一条有归属的消息所属会话**。
 *
 * 为什么不能直接"停产"：后台定时 / 手动 runDistillNow 并不携带 sessionId，
 *   一律拒绝会让蒸馏静默停摆（reason='no-session'），比污染更难被发现。
 * 为什么也不能"混采"：那正是本次 P0 事故本身。
 * ⇒ 折中且唯一安全的做法：**只挑一个会话**（最近活跃的那个）来蒸馏，
 *   并用它自己的 sid 盖章 —— 谁的消息盖谁的章。
 *
 * 归一化：兼容 sessionKey / sessionId 两种字段、以及带不带 'session-' 前缀。
 */
export function normalizeSid(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  return s.indexOf('session-') === 0 ? s : ('session-' + s);
}

/** 返回最近一条**有归属**消息的归一化 sid；没有则返回 ''。 */
export function resolveDistillSession(d) {
  try {
    if (!existsSync(d.conversations)) return '';
    let names = [];
    try { names = readdirSync(d.conversations).filter((f) => f.endsWith('.jsonl')).sort(); } catch { return ''; }
    const tail = names.slice(-2);
    let best = '';
    let bestTs = -1;
    for (const name of tail) {
      let raw = '';
      try { raw = readFileSync(d.conversations + '/' + name, 'utf8'); } catch { continue; }
      for (const line of raw.split('\n')) {
        if (!line) continue;
        let m; try { m = JSON.parse(line); } catch { continue; }
        const sid = normalizeSid(sessionIdOf(m));
        if (!sid) continue;
        const ts = Number(m.timestamp);
        if (Number.isFinite(ts) && ts >= bestTs) { bestTs = ts; best = sid; }
        else if (!Number.isFinite(ts) && !best) { best = sid; }
      }
    }
    return best;
  } catch { return ''; }
}

export function readRecentL0(d, limit) {
  if (!existsSync(d.conversations)) return [];
  let names = [];
  try { names = readdirSync(d.conversations).filter((f) => f.endsWith('.jsonl')).sort(); } catch { return []; }
  const tail = names.slice(-2);
  const out = [];
  for (const name of tail) {
    let raw = '';
    try { raw = readFileSync(d.conversations + '/' + name, 'utf8'); } catch { continue; }
    for (const line of raw.split('\n')) {
      if (!line) continue;
      let m; try { m = JSON.parse(line); } catch { continue; }
      const ts = Number(m.timestamp);
      if (!Number.isFinite(ts) || typeof m.content !== 'string') continue;
      out.push({ sessionKey: String(m.sessionKey || m.sessionId || ''), role: m.role, content: m.content, timestamp: ts, id: String(m.id || '') });
    }
  }
  out.sort((a, b) => a.timestamp - b.timestamp);
  return out.slice(-(Number(limit) || 40));
}

/**
 * 跑一轮蒸馏。
 * @returns {Promise<{items:number, written:number, refreshed:number, retired:number, llm:string, reason?:string}>}
 */
import { ingestWithConcentration } from './concentrate.js';
// [2026-10-23 · 白队补充1 消费者：事实覆写 ⇒ 依据它的 L3 结论自动作废]
import { buildRefuteLines } from './refute-scan.js';

/**
 * [2026-10-23 by Assistant · 红白双队 记忆动力学 接线]
 *   之前 concentrate.js 只是"写好了"，**没有任何调用者** ⇒ hits 恒为 0
 *   ⇒ "重复产生浓度"从未真正发生。这里把它接进蒸馏写盘路径。
 *   默认关闭（concentrationEnabled !== true 时走原路径，逐位等同）。
 */

/**
 * [2026-10-26 by Assistant · Phase 2 蒸馏窗口角色配额]
 *
 * 实测病灶：本会话最近 40 条 L0 是 user=5 / assistant=35，**assistant 占 87.5%（18,278 字）**。
 *   为什么？User说 1 句，Assistant中间调 7 次工具，每次都产出一条独立的 assistant 消息
 *   （capture 只留 user/assistant，tool 早被过滤），于是 1 问配 7 答。
 *   后果：喂给蒸馏 LLM 的原料 87.5% 是Assistant自己说的话 ⇒ 蒸出来的卡七成是自我叙述，
 *   而User的关键指令（改参数、定边界）被淹在独白里。importance.js 的「只认 role:user」
 *   拦得住打分，拦不住原料配比。
 *
 * 解法：**连续 assistant 折叠**（红队 Turn Collapsing + 白队防守补丁）。
 *   · 同一轮里连续的 assistant 消息合并成 1 条；
 *   · 中间几条**不删**，只抽「动作 + 根因 + 结果」干货（白队：全删会丢因果链）；
 *   · 最后一条**完整保留**（那是这一轮的最终结论）。
 *   ⇒ 40 条原料 → 约 10~13 条，user 占比自然从 12.5% 升到 30%+，
 *     同时把"调工具走到一半的中间猜测"挡在蒸馏原料之外。
 *
 * 铁律：**只作用于提示词构建，不改动游标键**。
 *   游标键来自原始 recent（distill.js:748），若在这里改消息集合会让游标对不上、消息永不入账。
 */
export function summarizeIntermediateAssistant(text) {
  const lines = String(text || '').split('\n').map((s) => s.trim()).filter(Boolean);
  if (!lines.length) return '';
  // 优先挑含文件名 / 根因 / 报错 / 数字指标的干货行，剔除「~我现在去查一下」这类寒暄
  const KEY = /(\.m?js|\.py|\.jsonl|\.json|\.md|根因|发现|报错|原因|实测|结果|通过|失败|=>|→|\d+%|\d+\s*ms|\d+\s*张|\d+\s*条)/i;
  const picked = lines.filter((l) => KEY.test(l));
  const chosen = (picked.length ? picked : lines).slice(0, 2).join('；');
  return '[中间排查: ' + chosen.slice(0, 140) + ']';
}

export function collapseAssistantMonologues(messages) {
  const list = Array.isArray(messages) ? messages : [];
  const out = [];
  let group = [];
  const flush = () => {
    if (!group.length) return;
    if (group.length === 1) { out.push(group[0]); group = []; return; }
    const last = group[group.length - 1];
    const mids = group.slice(0, -1).map((m) => summarizeIntermediateAssistant(m.content)).filter(Boolean).join(' ');
    out.push(Object.assign({}, last, {
      // 中间干货在前、最终结论在后，读起来仍是一条连贯发言
      content: (mids ? mids + '\n' : '') + String(last.content || ''),
      collapsedFrom: group.length,   // 诊断用：这一条合并了几段
    }));
    group = [];
  };
  for (const m of list) {
    if (m && m.role === 'assistant') { group.push(m); continue; }
    flush();
    out.push(m);
  }
  flush();
  return out;
}

// ══════════════════════════════════════════════════════════════════════
// [2026-10-28 by Assistant · P1] 零延迟体温交接 ongoing-thread —— 独立可调用
//
// 【为什么要抽出来】
//   原实现嵌在 runDistill 主体里，而 runDistill 在 `llm: off` 时第 429 行就返回；
//   ingest/index.js 的 kickDistill 更是连 LLM 通道都没有就 return。
//   ⇒ 本机 llm:off 期间，ongoing-thread.json 一次都不会更新。
//   这不是"偶尔没跟上"，是**结构性永远不会写**。
//
// 【三要素】未竟任务 + 上一刻心境/默契 + 下一步约定（≤100 字）
//   刻意克制：只写"下一句接得上"需要的，不写流水账。
//   纯确定性提炼（不调 LLM、零成本、绝不阻塞）。
//
// 【为什么不能只放 pre-step】
//   Hot Buffer 每轮都跑，在那里算会拖慢每次回复；这里是回合后的轻量收尾。
// ══════════════════════════════════════════════════════════════════════
export function writeOngoingThread(p) {
  const params = p || {};
  try {
    const fresh = Array.isArray(params.fresh) ? params.fresh : [];
    // ── [2026-10-28 by Assistant · User指出的真 bug：问答必须配成同一对] ──
    //   ❌ 旧写法：
    //        lastUser = reverse().find(role==='user')       ← 最后一条提问
    //        lastAsst = reverse().find(role==='assistant')  ← 最后一条回复
    //      两个"最后"各自独立找 ⇒ **不保证是一对**。
    //      更糟的是：我（Assistant）在一轮里会分多次回复（每次工具调用都产一条 assistant），
    //      所以"最后一条 assistant"往往只是过程里的一句话，不是这轮问的答案。
    //      实测 L0 顺序：user 20:32:01 → asst 13 → 19 → 26 → 34
    //      ⇒ 旧逻辑会拿 20:32:34 那句当"回答"，而它答的其实是 20:32:01 那个问题的第 4 段。
    //   ✅ 正确做法（User要的）：
    //        先定位**最后一条 user**，然后只在**它之后**的 assistant 里找答案。
    //        这样 A（问）和 B（答）天然是同一对。
    let lastUserIdx = -1;
    for (let i = fresh.length - 1; i >= 0; i--) {
      if (fresh[i] && fresh[i].role === 'user') { lastUserIdx = i; break; }
    }
    const lastUser = lastUserIdx >= 0 ? fresh[lastUserIdx] : null;
    if (!lastUser) return { ok: false, reason: 'no-user' };
    // 只在这条提问**之后**找回答 ⇒ 保证同属一轮
    let lastAsst = null;
    for (let i = fresh.length - 1; i > lastUserIdx; i--) {
      if (fresh[i] && fresh[i].role === 'assistant') { lastAsst = fresh[i]; break; }
    }
    // 边界：提问之后没有任何回答（会话被打断）⇒ vibe 留空，**绝不回退去拿上一轮的回答**
    //   那正是"问是新的、答是旧的"这种错配的来源。
    // ── [2026-10-28 by Assistant · 体温交接必须干净] ──
    //   实测抓到的脏数据：vibe = "**成功了!两处现在解析到完全同一个文件。** <div id=\"v"
    //   —— 把回复开头的 HTML 卡片碎片当心境记了下来。
    //   交接是给"下一句接得上"用的短句，混进标签/代码/卡片碎片就等于没写。
    //   只做三件保守清洗（不判断语义，避免误删人话）：
    //     ① 去 HTML/SVG 标签本身  ② 去 markdown 符号与卡片残片  ③ 折叠空白
    // ── [2026-10-28 by Assistant · 第二次修脏数据：CSS 整块漏网] ──
    //   实测重启后抓到：vibe = "vcp-root{box-sizing:border-box;pad"
    //   —— 卡片 <style> 标签被删了，但**块内的 CSS 文本**原样留下。
    //   原因：正则只删"尖括号标签本身"，不删标签之间的内容。
    //   ⇒ 必须先整块删掉 <style>…</style> / <script>…</script>（含内容），再处理别的。
    const clean = (s) => String(s || '')
      // ① 先整块删"带内容的标签对"（关键！否则 CSS/JS 正文会漏出来）
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
      .replace(/<svg[^>]*>[\s\S]*?<\/svg>/gi, ' ')     // SVG 内部路径数据同样是噪音
      .replace(/<!--[\s\S]*?-->/g, ' ')                  // HTML 注释
      // ② 再删剩下的单个标签
      .replace(/<\/?[a-zA-Z][^>]{0,200}>/g, ' ')
      .replace(/&[a-zA-Z]{2,8};/g, ' ')                // HTML 实体
      .replace(/[#*_`>|]+/g, ' ')                     // markdown 记号
      // ③ 去掉 CSS 规则残留形态：形如 selector{prop:val;…} 的整段
      .replace(/[^{};]+\{[^{}]*\}/g, ' ')
      // ④ 去掉 key=value 形态（id/class/style/width… 等）
      .replace(/\b(id|class|style|viewBox|xmlns|width|height|fill|stroke|d|transform)\s*=\s*["'][^"']*["']/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const clip = (s, n) => clean(s).slice(0, n);
    const pending = clip(lastUser.content, 46);
    const vibe = clip(lastAsst && lastAsst.content, 34);
    const mNext = String(lastUser.content || '').match(/(下一步|接下来|接着|还没|待办|之后再)[^。！？\n]{0,40}/);
    const thread = {
      updatedAt: params.nowIso || new Date().toISOString(),
      eventTs: Number(params.eventTs) || Date.now(),
      sessionId: params.sessionId || null,
      pending,
      vibe,
      next: mNext ? clip(mNext[0], 46) : '',
      chars: 0,
    };
    thread.chars = (thread.pending + thread.vibe + thread.next).length;
    const threadFile = String(params.root || DEFAULT_INGEST_ROOT).replace(/[\\/]+$/, '') + '/ongoing-thread.json';
    atomicWriteJson(threadFile, thread);
    return { ok: true, chars: thread.chars, file: threadFile };
  } catch (e) {
    recordFault('distill', 'ongoing-thread', e);
    return { ok: false, reason: 'error', message: String(e && e.message || e) };
  }
}

export async function runDistill(p) {
  const params = p || {};
  const opts = params.opts || {};
  const ep = params.llm || null;
  const d = dirs(opts.root);
  ensureDirs(d);
  if (!ep) return { items: 0, written: 0, refreshed: 0, retired: 0, llm: 'off', reason: 'no-llm' };
  // [红队 P0] 并发保护：蒸馏是 read-modify-write（读卡库→判定→追加），必须串行。
  const lock = opts.disableLock ? { release() {} } : acquireLock(d, 'distill', opts.lockTtlMs);
  if (!lock) return { items: 0, written: 0, refreshed: 0, retired: 0, llm: 'ready', reason: 'locked' };
  try {
  const completeFn = typeof params.completeFn === 'function' ? params.completeFn : complete;
  // [2026-10-23 · 期8.1/8.2 阻断3] 认知信用判决总开关，**默认 false**。
  //    DESIGN §八：「全部新增能力默认关闭，逐个开启实测」。
  //    关闭（缺省 / false / 任意非 true 值）时，下面每一处 belief 分支都不进，
  //    distill 的行为与开关引入前**逐位相同**（dedup / refresh / retire / 落盘计数全不变）。
  //    打开后：写卡前对「已有同主题且仍然新鲜」的旧卡做一次 judgeConflict，
  //    refute ⇒ 新卡 active + 旧卡 append 一条 status=refuted 版本行（照抄 retireLines 手法）；
  //    fork   ⇒ 新卡 scoped_active + 旧卡 append 一条 scoped_active 版本行；
  //    merge / ignore ⇒ 仍然跳过（与关闭时相同）。
  const beliefRevision = opts.beliefRevisionEnabled === true;

  const cur = loadCursor(d, 'distill', null, { processedKeys: [], retiredKeys: [], updatedAt: null });
  const processed = new Set(Array.isArray(cur.processedKeys) ? cur.processedKeys : []);
  for (const k of (Array.isArray(cur.retiredKeys) ? cur.retiredKeys : [])) processed.add(k);
  // [2026-10-26 · P0 归属污染修复 + 红队陷阱2] 必须先拿到"我是谁"，再取消息。
  //   ① 显式传入 sessionId ⇒ 严格用它；
  //   ② 没传（后台定时 / 手动触发）⇒ **锁定最近一条有归属消息所属会话**，
  //      绝不把两个窗口的消息混进同一批蒸馏，也绝不静默停产。
  //   ③ 一条有归属的消息都没有 ⇒ 才返回 no-session（此时本来也没东西可蒸）。
  const __explicitSid = normalizeSid(opts.sessionId || opts.sessionKey || '');
  const __distillSessionId = __explicitSid || resolveDistillSession(d);
  if (!__distillSessionId) {
    return { items: 0, written: 0, refreshed: 0, retired: 0, llm: 'ready', reason: 'no-session' };
  }
  const recent = readRecentL0ForSession(d, opts.distillWindowMessages || 40, __distillSessionId);
  const fresh = recent.filter((m) => !processed.has(messageKey(m)));
  const minFresh = Number.isFinite(Number(opts.minDistillMessages)) ? Number(opts.minDistillMessages) : 4;
  if (fresh.length < minFresh) {
    return { items: 0, written: 0, refreshed: 0, retired: 0, llm: 'ready', reason: 'not-enough-new' };
  }

  const existing = readOwnEngrams(opts.root);
  // ── [2026-10-26 根因修复] 入口列表装配 ──
  //   原来：existing.filter(非retired).map(...).join('\n').slice(0,1800)
  //     数据源稳定 createdAt 升序 ⇒ slice 永远切最老那批。
  //     实测 305 张 → 只装 50 张（16.4%），覆盖停在 10-22 16:31，
  //     库内最新卡 10-23 01:15 被挡在 8.7 小时之外；门外 255 张里有 61 张问题卡。
  //     ⇒ 模型永远看不到"该关闭哪些问题"，于是终态卡一张都产不出来。
  //   现在：问题卡优先（精简格式，实测装下 32 张 vs 原来 0 张）+ 最新卡兜底。
  const entryBuilt = buildEntryList(existing, {
    budgetChars: Number.isFinite(Number(opts.entryBudgetChars)) ? Number(opts.entryBudgetChars) : 1800,
    problemQuota: Number.isFinite(Number(opts.entryProblemQuota)) ? Number(opts.entryProblemQuota) : undefined,
  });
  // [2026-10-26 · Phase 2] 连续 assistant 折叠后再拼提示词（**只影响提示词，游标键仍取原始 recent**）
  const collapsed = collapseAssistantMonologues(fresh);
  const conversation = collapsed.map((m) => (m.role === 'user' ? '用户：' : 'AI：') + m.content).join('\n');
  const userText = '已有记忆入口：\n' + entryBuilt.text + '\n\n最近对话回合：\n' + conversation.slice(0, 3800);

  // [红队 R2 P1] 周期心跳（不是只在调用前 touch 一次）：
  //   LLM 最坏路径可达 2.5 分钟，单次 touch 抵不住 TTL 到期被别人强夺。
  const hb = setInterval(() => { try { lock.touch && lock.touch(); } catch (e) { recordFault('distill', 'catch', e); } }, 30000);
  if (hb && typeof hb.unref === 'function') hb.unref();
  let raw = null;
  try { raw = await completeFn(ep, DISTILL_SYSTEM_PROMPT, userText); }
  finally { try { clearInterval(hb); } catch (e) { recordFault('distill', 'catch', e); } }
  let parsed = parseJsonArray(raw);
  // [2026-10-22 by Assistant] 同 extract：先归一化，归一不出东西才走启发式兜底。
  parsed = parsed ? normalizeEngrams(parsed, { maxItems: 3 }) : null;
  if (!parsed || parsed.length === 0) parsed = fallbackDistill(conversation);
  // [2026-10-26 by Assistant · 确定性兜底] resolves 不能只依赖模型听话。
  //   模型经常把"已解决"当过程叙述丢掉（这正是本轮的根因）。
  //   这里不额外产卡，只保证 resolves 通道在模型沉默时**依然靠代码判定**——
  //   具体判定在下方 detectResolution()，它只需要一份待关闭清单，与 parsed 无关。
  //   所以即使 parsed 为空数组，生命周期依然能被关闭（LLM 不产卡 ≠ 问题没解决）。

  const nowIso = new Date().toISOString();
  const nowMs = Date.now();
  // ── [2026-10-27 by Assistant · 第0步 补 eventTs 真实时间源] ──
  //   病灶：原来卡片只有 createdAt = nowMs（蒸馏那一刻），
  //        事件真实发生时间（User说那句话的时刻）完全丢失。
  //        实测全库 7118 张卡 eventTs 出现 0 次。
  //   修法：从本轮 fresh 消息里取真实时间：
  //        · eventStartTs = 本轮第一条消息的 timestamp（事情开始）
  //        · eventEndTs   = 本轮最后一条消息的 timestamp（事情结束）
  //        · eventTs      = eventStartTs（单值口径，供排序直接使用）
  //   兜底：fresh 无有效 ts ⇒ 退回 nowMs（并标 eventTsSource='fallback-now'，便于事后审计）
  const __freshTs = fresh
    .map((m) => Number(m.timestamp))
    .filter((t) => Number.isFinite(t) && t > 0);
  const eventStartTs = __freshTs.length ? Math.min(...__freshTs) : nowMs;
  const eventEndTs = __freshTs.length ? Math.max(...__freshTs) : nowMs;
  const eventTs = eventStartTs;
  const eventTsSource = __freshTs.length ? 'l0-message-ts' : 'fallback-now';
  const sessionId = String(opts.sessionId || '');
  const cwd = opts.cwd ? String(opts.cwd) : null;
  const retireAfterDays = Number.isFinite(Number(opts.retireAfterDays)) ? Number(opts.retireAfterDays) : 14;
  const live = existing.slice();
  const lines = [];
  const retireLines = [];
  // [2026-10-23 by Assistant · 期8.1] v2 信用字段的 scope 口径（判决探针与正式卡共用，避免两处算得不一样）
  //   project 用 cwd 归一化，session 用 sessionId，其余 global
  const scopeTagsOf = (ly) => (ly === 'project' && cwd
    ? [String(cwd).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'global']
    : (ly === 'session' && sessionId ? ['session:' + String(sessionId).slice(-8)] : ['global']));
  // [阻断3] 本轮的判决统计（只在开关打开时非零，便于运维/自测核对）
  let beliefRefuted = 0;
  let beliefForked = 0;
  let refreshed = 0;
  let retired = 0;
  let written = 0;

  for (const item of parsed) {
    if (!item || typeof item !== 'object') continue;
    const kind = String(item.kind || '');
    const layer = String(item.layer || '');
    const title = String(item.title || '').trim();
    const summary = String(item.summary || '').trim();
    const content = String(item.content || '').trim();
    if (!KINDS.has(kind) || !LAYERS.has(layer)) continue;
    if (!title || !summary) continue;
    if (layer === 'project' && !cwd) continue;
    if (layer === 'session' && !sessionId) continue;

    // ══════════════════════════════════════════════════════════════
    // [2026-10-23 · 期8.1/8.2 阻断3] 认知信用判决（beliefRevisionEnabled 打开才走）
    //
    // 为什么必须在**这里**判：上面的 dedup 三分支只回答「要不要写」，
    //   没回答「这张新卡和旧卡是并存、补充还是推翻」。红队 C-1 实证
    //   judgeConflict 在 lib/ 里零调用 ⇒ 状态机空转、DESIGN §三 铁律
    //   「会话进行中不落盘任何推翻」没有执行者。
    //
    // 判决口径（DESIGN §2.2）：
    //   refute —— 新卡 active，旧卡 append 一条 status=refuted 版本行（不删旧卡）
    //   fork   —— 新卡 scoped_active，旧卡 append 一条 scoped_active 版本行
    //   merge  —— 视为补充，仍按现状写入（新卡 active）
    //   ignore —— 新证据更弱 ⇒ 新卡 superseded（若已有同 key 旧卡则不重复写）
    //
    // 只在「已有同主题卡」时才可能 refute：没有任何旧卡就无从推翻。
    // ══════════════════════════════════════════════════════════════
    let preVerdict = null;
    let preOld = null;
    if (beliefRevision) {
      try {
        // 同主题的判据与 dedup 保持一致（同标题 / 2-gram ≥ 0.55），但**不看 retired**：
        //   已退役的旧卡不需要再被 refute 一次（它已经不在检索池里）。
        let topic = null;
        for (const e of live) {
          if (e.status === 'retired' || e.status === 'refuted') continue;
          if (String(e.title || '') === title) { topic = e; break; }
          if (bigramOverlap(title, String(e.title || '')) >= 0.55) { topic = e; break; }
        }
        if (topic) {
          const probe = {
            title, summary, content,
            scope_tags: scopeTagsOf(layer),
            confidence: inferSourceWeight({ role: 'user', text: content || summary }),
          };
          const v = judgeConflict(probe, normalizeEngramV2(topic));
          preVerdict = v;
          preOld = topic;
          if (v.action === 'refute') {
            // 旧卡：append-only 版本行，status=refuted（手法同 retireLines）
            const refutedRow = Object.assign({}, topic, {
              status: STATUS.REFUTED,
              refuted_at: nowIso,
              refuted_by: 'distill.beliefRevision',
              updatedAt: nowIso,
            });
            retireLines.push(JSON.stringify(refutedRow));
            // [2026-10-22 by Assistant · 自测抓到的同一类坑] 必须同步改内存副本：
            //   否则同批次后续条目还会把它当活卡，重复 refute / 或又判成 dup。
            topic.status = STATUS.REFUTED;
            topic.refuted_at = nowIso;
            beliefRefuted++;
          } else if (v.action === 'fork') {
            // 条件分裂：旧卡也标成 scoped_active，检索时才按 scope 精确限定
            const forkedRow = Object.assign({}, topic, {
              status: STATUS.SCOPED_ACTIVE,
              updatedAt: nowIso,
            });
            retireLines.push(JSON.stringify(forkedRow));
            topic.status = STATUS.SCOPED_ACTIVE;
            beliefForked++;
          }
          // merge / ignore 不在这里落盘：merge 仍写新卡；ignore 交给下方 skip。
        }
      } catch (e) {
        // 判决层任何异常都不许影响蒸馏本身（铁律：写入侧不拖垮回合）
        preVerdict = null;
        preOld = null;
      }
    }

    // 与已有卡去重（只针对本插件自己的卡库）
    let dup = null;
    for (const e of live) {
      // [2026-10-23 · 阻断3] refuted 卡同样不该再参与去重（它已被推翻、不在检索池里）。
      //   用 beliefRevision 门住：开关关闭时条件与原实现逐位相同（那时库里也没有 refuted 卡）。
      if (e.status === 'retired') continue;
      if (beliefRevision && e.status === STATUS.REFUTED) continue;
      if (String(e.title || '') === title) { dup = e; break; }
      const ov = bigramOverlap(title, String(e.title || ''));
      if (ov >= 0.55) { dup = e; break; }
    }
    if (dup) {
      const ageDays = (nowMs - Number(dup.createdAt || 0)) / 86400000;
      if (String(dup.title || '') === title) {
        // [红队 P0] 刷新必须**落盘**（追加一行新版本），只改内存等于重启后整条丢失。
        //   读方是 last-write-wins，追加就等价于"更新"。
        const touched = Object.assign({}, dup, { summary, content, updatedAt: nowIso, refreshedAt: nowIso });
        retireLines.push(JSON.stringify(touched));
        dup.summary = summary; dup.content = content; dup.updatedAt = nowIso;
        refreshed++;
      } else if (Number.isFinite(ageDays) && ageDays >= retireAfterDays) {
        retireLines.push(JSON.stringify(Object.assign({}, dup, { status: 'retired', retiredAt: nowIso })));
        // [2026-10-22 by Assistant · 自测抓到] 必须**同步改内存副本**：
        //   否则后续条目的去重循环还能匹配到这张已被退役的卡 ⇒ 重复写退役行、
        //   并且会让本该跳过的重复条目又写一张新卡（一次蒸馏产出 3 条重复）。
        dup.status = 'retired';
        dup.retiredAt = nowIso;
        retired++;
        // 退役后允许新卡写入
      } else {
        continue;   // 旧卡还新 ⇒ 视为重复汇报，跳过
      }
      if (String(dup.title || '') === title) continue;
    }

    const id = 'pmi_' + nowMs.toString(36) + '_' + Math.random().toString(36).slice(2, 7);
    const causes = Array.isArray(item.causesOf)
      ? item.causesOf.map((t) => {
          const hit = existing.find((e) => String(e.title || '') === String(t));
          return hit ? hit.id : null;
        }).filter(Boolean)
      : [];
    // scopeTags / conf 已在判决段算过（同一口径，避免两处算法漂移）
    const scopeTags = scopeTagsOf(layer);
    const conf = inferSourceWeight({ role: 'user', text: content || summary });

    // [2026-10-24 Step 1] 重要度确定性打分（原来是写死的 0.6）
    //   信号：被纠错 +0.40 / 决策 +0.30 / 硬件环境 +0.25 / 情绪 +0.15；基础 0.25
    //   基石（is_axiom）免时间衰减。
    const imp0 = scoreImportance({ title, summary, content, role: 'user' });

    const card = {
      kind, layer,
      projectId: layer === 'project' ? (cwd || null) : null,
      title, summary, content,
      links: [], sessionId: sessionId || null, sessionKey: sessionId || null, source_session_id: sessionId || null,
      causes, effects: [], importance: imp0.importance,
      // ── [2026-10-27 by Assistant · 第2步 arc_story 微叙事] ──
      //   一句话记录「起因 → 转折 → 结果」，让卡不再是孤立切片。
      //   【铁律】**不参与 BM25**：BM25 索引读的是 title/summary/content，
      //     这里新增的独立字段不会被分词器看到 ⇒ 老卡词频分布零扰动（红队最先担心的点）。
      //   只在装配渲染时作为 [前情脉络] 展示。
      //   取值：优先模型给的 arcStory；没给就用 causes 拼一句确定性的。
      arc_story: (function () {
        const fromModel = String(item.arcStory || item.arc_story || '').trim();
        if (fromModel) return fromModel.slice(0, 160);
        const cs = (causes || []).length;
        if (!cs) return '';
        // 确定性兜底：有前因就写「接续自 …」
        const names = (causes || []).slice(0, 2).join('、');
        return ('接续自：' + names).slice(0, 160);
      })(),
      is_axiom: imp0.is_axiom,
      importance_signals: imp0.signals,
      id, createdAt: nowMs, hits: 0, lastHitAt: null,
      // [2026-10-27 · 第0步] 真实事件时间（不是蒸馏时刻）
      eventTs, eventStartTs, eventEndTs, eventTsSource,
      // ── 期8 v2 字段 ──
      // [阻断3] 判决结果落到新卡：refute ⇒ active；fork ⇒ scoped_active；
      //   ignore ⇒ superseded（新证据更弱，不参与默认检索）；merge ⇒ active。
      status: (preVerdict && preVerdict.action === 'fork') ? STATUS.SCOPED_ACTIVE
        : (preVerdict && preVerdict.action === 'ignore') ? STATUS.SUPERSEDED
          : STATUS.ACTIVE,
      scope_tags: scopeTags,
      confidence: conf,
      supporting_facts: [],
      refute_by: [],
      supersedes: [],
      is_tentative: false,
      trace: preVerdict
        ? (preVerdict.action + ' vs ' + String(preOld && preOld.title || '') + ' — ' + preVerdict.reason)
        : '',
      updatedAt: nowIso,
      schema: 'unified-memory.engram.v2',
      // 期8.3.1：engram 卡自带实体（title + summary + content 是 engram 的全部文本面）
      entities: extractEntities({ title, summary, content }),
    };
        // ── [2026-10-23 · 红白双队：浓度引擎接线] ──
        //   默认关闭。开启后：同主题重复 ⇒ 不新建卡，老卡 hits += 1；
        //   事实冲突（如 4GB→16GB）⇒ 覆写文本但继承 hits（红队安全阀1）。
        let finalCard = card;
        if (opts && opts.concentrationEnabled === true) {
          try {
            const pool = existing || [];
            const sim = (a, b) => {
              const ta = String(a && a.title || '').trim();
              const tb = String(b && b.title || '').trim();
              if (ta && ta === tb) return 1.0;
              const ca = String(a && a.content || '').slice(0, 200);
              const cb = String(b && b.content || '').slice(0, 200);
              return ca && ca === cb ? 1.0 : 0;
            };
            const res = ingestWithConcentration(card, pool, { similarity: sim });
            if (res.action === 'insert') {
              finalCard = res.card;
            } else if (res.action === 'update') {
              // 覆写/加浓度：不再新增行，改为给老卡追加一条版本行（append-only 保序）
              finalCard = res.card;
              retireLines.push(JSON.stringify(Object.assign({}, res.card, { updatedAt: nowIso })));
              // ── [白队补充1 消费者接线] 若是事实覆写，连带作废依据旧事实的 L3 结论 ──
              if (res.card && res.card.needsEngramRefute === true && res.refuteScopes) {
                try {
                  const rr = buildRefuteLines(pool, res.refuteScopes, {
                    nowIso, reason: 'upstream-fact-overridden',
                  });
                  for (const ln of rr.lines) retireLines.push(ln);
                } catch (e) { /* 作废失败不阻断主流程 */ }
              }
            } else {
              // skip-machine：机器来源不加票，跳过写盘
              continue;
            }
          } catch (e) { finalCard = card; }
        }
        lines.push(JSON.stringify(finalCard));
    live.push(card);
    written++;
  }

  // ══════════════════════════════════════════════════════════════════
  // [2026-10-26 by Assistant · 问题生命周期落盘]
  //   把本轮识别出的「问题已解决」写回：给被关闭的旧卡追加一条 status=resolved 版本行。
  //   铁律：
  //     · 只追加、不删除 —— 保留 resolvedBy 证据，可回滚
  //     · 有用户确认或工具验证证据 ⇒ resolved（真关闭）
  //     · 只有 AI 自称 ⇒ claimed（降权但不关卡，防自嗨）
  //     · refuted 的卡不碰（它已经因"事实错了"沉底，语义不同）
  // ══════════════════════════════════════════════════════════════════
  let resolvedCount = 0;
  let claimedCount = 0;
  try {
    const problemPool = live.filter((c) => isProblemCard(c));
    const llmResolves = [];
    for (const item of parsed) {
      if (item && Array.isArray(item.resolves)) {
        for (const t of item.resolves) llmResolves.push(String(t || ''));
      }
    }
    // 用户是否在本轮明确确认过（"修好了/通过/签收"）
    const hasUserConfirm = fresh.some((m) => m.role === 'user'
      && /(修好|通过|签收|可以了|搞定|没问题|验收)/.test(String(m.content || '')));

    const { candidates } = detectResolution(conversation, problemPool, { llmResolves, hasUserConfirm });
    // [2026-10-26] 同标题只关一次：库里存在历史遗留的同名重复卡（实测 18 组），
    //   回放时会同时匹配到它们，逐个写 resolved 会产出多条重复版本行。
    //   这里按标题去重，只关最新那条 —— 其他同名副本是历史噪音，不该重复落盘。
    const closedTitles = new Set();
    const closedCanonIds = new Set();
    // [2026-10-26 四次修复] 预先收集「库里已经闭环过的」canon id。
    //   实测场景：pmi_xxx 还是 active，但它的 pmi:pmi_xxx 变体已是 resolved
    //   —— 同一张卡的两个版本状态不一致（历史遗留），按单版本的 status 判会漏。
    //   正确口径：**同一张卡只要任一版本已闭环，就算这件事已处理完**。
    const alreadyResolvedCanon = new Set();
    for (const c of live) {
      if (String(c.status || '') === STATUS.RESOLVED || String(c.status || '') === STATUS.CLAIMED) {
        alreadyResolvedCanon.add(canonId(c.id));
      }
    }
    // [2026-10-26 二次修复] 光按标题去重还不够：库里同一张卡存在**两种 id 形式**
    //   pmi_xxx 与 pmi:pmi_xxx（历史前缀不一致遗留，与 readOwnIngest 那个坑同源）。
    //   只按标题去重时它们仍会各写一条。这里同时按「归一化 id」去重。
    const canonId = (x) => String(x || '').replace(/^pmi:pmi_/, 'pmi_').replace(/^pmi:/, '');
    for (const cand of candidates) {
      const target = cand.card;
      if (!target || !target.id) continue;
      if (String(target.status || '') === 'refuted') continue;
      const tKey = String(target.title || '').trim();
      if (tKey && closedTitles.has(tKey)) continue;
      const cid = canonId(target.id);
      if (cid && closedCanonIds.has(cid)) continue;
      // [2026-10-26 三次修复] 已经闭环过的卡不再重复关。
      //   实测：上一轮已把 <card-id> 标 resolved（19:25:18），
      //   本轮同一张卡的另一个 id 形式（pmi:<card-id>）又写了一条 resolved，
      //   造成"同一张卡两条闭环版本行"。已闭环 = 这件事已经处理完，无需再关。
      if (String(target.status || '') === STATUS.RESOLVED) continue;
      if (String(target.status || '') === STATUS.CLAIMED) continue;
      if (cid && alreadyResolvedCanon.has(cid)) continue;   // 同卡另一版本已闭环
      if (tKey) closedTitles.add(tKey);
      if (cid) closedCanonIds.add(cid);
      const nextStatus = cand.evidence ? STATUS.RESOLVED : STATUS.CLAIMED;
      const row = Object.assign({}, target, {
        status: nextStatus,
        resolvedAt: nowIso,
        resolvedBy: 'distill.resolution',
        resolutionEvidence: cand.reason,
        updatedAt: nowIso,
      });
      retireLines.push(JSON.stringify(row));
      // 同步内存副本：同批次后续条目不该再把它当"待关闭"候选
      target.status = nextStatus;
      target.resolvedAt = nowIso;
      if (nextStatus === STATUS.RESOLVED) resolvedCount++; else claimedCount++;
    }
  } catch (e) {
    // 生命周期落盘失败绝不阻断蒸馏主流程（铁律：写入侧不拖垮回合）
    resolvedCount = 0; claimedCount = 0;
  }

  const allLines = retireLines.concat(lines);
  // [红队 R2 P0] appendLines 失败时**绝不能推进游标**：
  //   否则这批对话永久不会被重试 ⇒ 蒸馏输入静默丢失（和 extract 犯过的同一个错）。
  if (allLines.length > 0) {
    const n = appendLines(d.engrams, allLines, opts.maxBytes);
    if (n === 0) {
      return { items: parsed.length, written: 0, refreshed: 0, retired: 0, llm: 'ready', reason: 'append-failed', beliefRevision, beliefRefuted: 0, beliefForked: 0 };
    }
  }

  const keys = Array.from(new Set(recent.map((m) => messageKey(m)))).slice(-4000);
  // [红队 R2 P1] 不用时间戳水位；被淘汰键进 retiredKeys（精确）
  const retiredKeys = new Set(Array.isArray(cur.retiredKeys) ? cur.retiredKeys : []);
  const allKeys = Array.from(processed).concat(keys);
  let keptKeys = allKeys;
  if (allKeys.length > 8000) {
    for (const k of allKeys.slice(0, allKeys.length - 8000)) retiredKeys.add(k);
    keptKeys = allKeys.slice(-8000);
  }
  const okCursor = saveCursor(d, 'distill', null, {
    processedKeys: keptKeys,
    retiredKeys: Array.from(retiredKeys).slice(-20000),
    updatedAt: nowIso,
  });
  if (okCursor !== true) {
    return { items: parsed.length, written, refreshed, retired, llm: 'ready', reason: 'cursor-failed' };
  }
  // ══════════════════════════════════════════════════════════════════
  // [2026-10-27 by Assistant · 第4步 零延迟体温交接 ongoing-thread]
  //
  // 【为什么放这里而不是 pre-step】
  //   Hot Buffer 是每轮 pre-step 都跑的；在那调 LLM 会拖慢每一次回复。
  //   distill 本来就是回合后的异步阶段，在这里顺手写盘 ⇒ Hot Buffer 只做文件直读，0 延迟。
  //
  // 【三要素】未竟任务 + 上一刻心境/默契 + 下一步约定（≤100 字）
  //   刻意克制：只写"下一句接得上"需要的，不写流水账。
  //   提取方式：优先用本轮最后一条 user 消息 + 最后一条 assistant 摘要做确定性提炼
  //             （不调 LLM，零成本；质量不如 LLM 但绝不阻塞、绝不失败）
  // ══════════════════════════════════════════════════════════════════
  // [2026-10-28 by Assistant · P1 修一个"注释说得通、实际永远不执行"的坑]
  //   原实现把写盘放在 distill 主体里 —— 但 distill 在没有 LLM 通道时
  //   第 429 行就 `return { llm: 'off' }` 了（ingest/index.js:327 更早就 return，
  //   连 runDistill 都不会进）⇒ 本机 llm:off 期间 ongoing-thread.json
  //   **一次都不会更新**，注释写的"每回合顺手写盘"从未成立。
  //   修法：抽成独立导出的 writeOngoingThread()，由 ingest 在回合收尾
  //   无条件调用（不依赖 LLM），distill 里有料时也顺手刷新一次。
  try {
    writeOngoingThread({ root: opts.root, fresh, sessionId, eventTs, nowIso });
  } catch (e) { recordFault('distill', 'ongoing-thread', e); }

  return {
    items: parsed.length, written, refreshed, retired, llm: 'ready',
    // [阻断3] 只在开关打开时非零；关闭时恒为 0（与旧实现一致）
    beliefRevision, beliefRefuted, beliefForked,
    // [2026-10-26] 问题生命周期：真正关闭几张 / 仅 AI 自称几张
    resolved: resolvedCount, claimed: claimedCount,
    entryStats: entryBuilt.stats,
  };
  } finally {
    try { lock.release(); } catch (e) { recordFault('distill', 'catch', e); }
  }
}
