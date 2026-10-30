import { readFileSync, readdirSync } from 'node:fs';

/** Read recent L0 records once and expose complete user/assistant rounds as BM25 documents. */
export const DEFAULT_L0_RECENT_DAYS = 30;

/**
 * [2026-10-27 by Assistant · 第一优先：双目录活水]
 *
 * 病灶（实测）：index.js 的 conversationsDir 只指向 memory-tdai/conversations，
 *   该目录最后一份是 2026-10-22；而 capture.js 从 10-23 起写的是
 *   ingest/conversations（最后一份 10-27）。
 *   ⇒ 近 5 天的对话原话**根本没进 L0 索引**，问「这几天做了什么」只能捞出更早的旧提问。
 *
 * 修法：convDir 支持 **字符串或数组**，多目录合并读取；
 *   按消息 id 去重（实测 10-22 两目录重名文件有 471 条同 id 消息，不去重会重复计数）。
 *   保留旧的单字符串签名 ⇒ 所有既有调用点零改动、行为不变。
 */

/** 归一化目录参数：字符串 / 数组 / 空 ⇒ 数组 */
export function normalizeConvDirs(convDir) {
  if (Array.isArray(convDir)) return convDir.map(function (x) { return String(x || ''); }).filter(Boolean);
  const s = String(convDir || '');
  if (!s) return [];
  return s.split(/[;,|]/).map(function (x) { return x.trim(); }).filter(Boolean);
}

/**
 * [2026-10-27 by Assistant · 第二优先：剥 HTML/CSS]
 *
 * 实测：3049 张 l0round 里 142 张（4.7%）含 HTML 标签，48 张含 <style>，
 *   HTML 标签字符占全库 content 的 4.2%，单卡最高 2376 字符。
 *   Assistant的回复带整套 #vcp-root 样式表 ⇒ 既污染 BM25 词频，又白吃 L0 token。
 *   这里做**只剥标签不删正文**的安全清洗（<style>/<script> 整块删，其余标签只去尖括号）。
 */
export function stripMarkup(s) {
  let t = String(s || '');
  // ① <style>/<script> 整块删（含内容）
  t = t.replace(/<style[\s\S]*?<\/style>/gi, ' ');
  t = t.replace(/<script[\s\S]*?<\/script>/gi, ' ');
  // ② 其余标签只剥标签本身，保留里面的文字
  t = t.replace(/<[^>]{1,2000}>/g, ' ');
  // ③ 实体与多余空白
  t = t.replace(/&nbsp;/gi, ' ').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
       .replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/&#39;/gi, "'");
  t = t.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n');
  return t.trim();
}

/**
 * [2026-10-27 by Assistant · 第二优先：问+答双锚标题]
 *
 * 病灶：原来 title 只取用户提问前 80 字 ⇒ 搜索命中的全是「User以前问过什么」，
 *   Assistant干完活的结论埋在 12000 字 content 里，被标题挡在门外。
 * 修法：title = 「问: 提问前 35 字 → 答: 回复结论前 55 字」，零 LLM 开销。
 *   结论提取优先级：<h1> 文本 > 首段非空正文。
 */
export function buildDualAnchorTitle(userText, assistantText, opts) {
  const o = opts || {};
  const uMax = Number(o.userChars) || 35;
  const aMax = Number(o.answerChars) || 55;
  const u = stripMarkup(userText).replace(/\s+/g, ' ').trim().slice(0, uMax);
  let a = '';
  const rawA = String(assistantText || '');
  // ① 优先取 <h1> 标题（Assistant的视觉卡标题通常是最凝练的结论）
  const h1 = rawA.match(/<h1[^>]*>([\s\S]{1,300}?)<\/h1>/i);
  if (h1) a = stripMarkup(h1[1]).replace(/\s+/g, ' ').trim();
  // ② 退化为剥完标签后的首段正文
  if (!a) {
    const plain = stripMarkup(rawA).replace(/\s+/g, ' ').trim();
    // 跳过常见的开场白（如括号里的表情/语气描写）
    const cleaned = plain.replace(/^[（(][^）)]{0,40}[）)]\s*/, '').replace(/^[^\s~〜]{0,8}[~〜]?\s*/u, '');
    a = cleaned.trim();
  }
  a = a.slice(0, aMax);
  if (!a) return u;
  return '问: ' + u + ' → 答: ' + a;
}

export function buildL0RoundCards(convDir, opts = {}) {
 const out = []; let files =0; let messages =0;
 const days = Number.isFinite(Number(opts.recentDays)) ? Math.max(0, Number(opts.recentDays)) : DEFAULT_L0_RECENT_DAYS;
 const now = Number.isFinite(Number(opts.nowMs)) ? Number(opts.nowMs) : Date.now();
 const since = Number.isFinite(Number(opts.sinceMs)) ? Number(opts.sinceMs) : now - days *86400000;
 const stripOn = opts.stripMarkup !== false;      // 默认剥，可显式关掉回滚
 const dualOn = opts.dualAnchorTitle !== false;   // 默认双锚，可显式关掉回滚
 const dirs = normalizeConvDirs(convDir);
 if (!dirs.length) { Object.defineProperty(out,'stats',{value:{files:0,messages:0,rounds:0,sinceMs:since,dirs:[]},enumerable:false}); return out; }

 // ① 多目录收集：同一 id 只留一份（先到先得，目录顺序即优先级）
 const seenMsgId = new Set();
 const bySession = new Map();
 for (const dir of dirs) {
   let names = []; try { names = readdirSync(dir).filter(f => f.endsWith('.jsonl')).sort(); } catch { continue; }
   for (const name of names) {
     // ── [2026-10-27 by Assistant · 跨时区日期错配修复] ──
     //
     // 病灶（实测）：文件名按**本地日期**（北京）命名，但这里按 UTC 解析：
     //   北京 10-27 凌晨 1:34 的消息 ⇒ 写进 2026-10-27.jsonl
     //   但它的 timestamp 是 2026-10-26T17:34Z（UTC）
     //   而 fileDay = 2026-10-27T00:00Z 比 now(10-26T20:05Z) 还晚 4 小时
     //   ⇒ 命中 `fileDay > now` ⇒ **整个文件被跳过**（判定为「未来的文件」）
     //
     // 后果：**每天北京时间 00:00~08:00 产生的对话，当天全部进不了 L0 索引。**
     //   实测证据：改前最新卡只到 10-26T03:32Z，而当时是 10-26T20:05Z，
     //   中间 17 小时的对话一条都没进索引。
     //
     // 修法（方案 A，最小改动）：文件名日期按**本地时区**（+08:00）解析，
     //   与「文件按本地日期命名」这一事实对齐 ⇒ fileDay 表示「这个本地日的第一刻」= UTC 前一天 16:00。
     //   同时**去掉 `fileDay > now` 这一条**：它本来就是错的（本地日期永远可能「晚于」UTC 现在）。
     //   真正的未来过滤交给逐条消息的 `ts > now` 判断（那才是精确的）。
     const day = name.slice(0,10);
     const LOCAL_TZ_OFFSET_MS = Number.isFinite(Number(opts.tzOffsetMs))
       ? Number(opts.tzOffsetMs)
       : 8 * 3600000;   // 北京 +08:00
     const parsedFileDay = Date.parse(day + 'T00:00:00Z');
     const fileDay = Number.isFinite(parsedFileDay) ? parsedFileDay - LOCAL_TZ_OFFSET_MS : NaN;
     if (!Number.isFinite(fileDay) || fileDay + 86400000 < since) continue;
     let raw; try { raw = readFileSync(dir + '/' + name, 'utf8'); } catch { continue; }
     files++;
     for (const line of raw.split('\n')) {
       if (!line) continue; let o; try { o = JSON.parse(line); } catch { continue; }
       const sessionKey = String(o.sessionKey || o.sessionId || '');
       const tsRaw = o.timestamp !== undefined ? o.timestamp : o.recordedAt;
       const ts = typeof tsRaw === 'number' ? tsRaw : (tsRaw ? Date.parse(String(tsRaw)) : NaN);
       const role = String(o.role || '').toLowerCase();
       if (!sessionKey || !Number.isFinite(ts) || ts < since || ts > now || (role !== 'user' && role !== 'assistant')) continue;
       // ── [2026-10-27 · 去重口径修正] ──
       //   实测教训：只按 id 去重会**误杀真实消息**——
       //   库里 40688 个唯一 id 里有 9803 个重复，但**内容全部相同、时间戳不同**
       //   （典型：每轮都注入的 instruction-hint 模板消息）。
       //   按 id 合并会把这些"同一模板在不同时刻发生"的真实轮次删掉
       //   （实测 107427 → 40688，少了一半以上）。
       //   正确口径：**id + 时间戳** 才是唯一键；只有完全相同的 (id, ts)
       //   才是跨目录重复拷贝（10-22 那 471 条属于这一类）。
       const mid = String(o.id || '');
       if (mid) {
         const dedupeKey = mid + '|' + String(ts);
         if (seenMsgId.has(dedupeKey)) continue;
         seenMsgId.add(dedupeKey);
       }
       let a = bySession.get(sessionKey); if (!a) bySession.set(sessionKey, a = []);
       const rawContent = String(o.content || '').trim();
       if (!rawContent) continue;
       a.push({
         role,
         content: stripOn ? stripMarkup(rawContent) : rawContent,
         rawContent,
         ts,
         id: mid,
       });
       messages++;
     }
   }
 }
 // ══════════════════════════════════════════════════════════════════
 // ② 逐会话配对成完整轮次 ——「一问多答」全量合并
 //
 // [2026-10-27 by Assistant · 挖穿 91.8% 回复黑洞]
 //
 // 【病灶】原实现只取 user 后**第一条** assistant：
 //     let j=i+1; while(...) j++;
 //     const answer = j<a.length && a[j].role==='assistant' ? a[j] : null;
 //   ⇒ Agent 模式下标准一问多答（问一句 → 跑十几个工具 → 十几条 assistant），
 //     只记住第 1 条「好的User，Assistant先去查一下」，后面真正的结论全被丢弃。
 //
 // 【实测规模】全库 user 8,903 / assistant 100,951 / L0 轮次 8,301
 //   ⇒ **92,650 条 assistant（91.8%）从未进入 L0 索引**。
 //   典型受害者：19:31:10「补好了,三处都写清楚了」——它是该轮第 9 条 assistant。
 //
 // 【红队死律 1：跨会话串台】✅ 本实现天然满足：
 //   外层已经是 `for (const [sessionKey, a] of bySession)`，
 //   每个 `a` 只含**同一会话**的消息，向后收集不可能吃到别的会话。
 //   再补一道防御：收集循环里显式校验 role，且遇 user 即停。
 //
 // 【红队死律 2：尾结论置顶】✅ 已实现：
 //   最后一条 assistant 是唯一给出「最终交付」的那条 ⇒ 放最前面完整保留；
 //   中间过程每条只留前 120 字，折叠到后面，防止被渲染/预算截断时砍掉结论。
 //   双锚 title 的「答:」也取最后一条。
 // ══════════════════════════════════════════════════════════════════
 const STEP_CLIP = Number(opts.stepClipChars) || 120;      // 中间步骤每条保留字数
 const MERGE_HEAD = Number(opts.mergeHeadChars) || 10000;  // 最终答复保留字数
 // ── [2026-10-27 by Assistant · 红队第 2 点：巨无霸卡封顶] ──
 //   实测最大一轮合并了 **960 条** assistant（长时间无人介入的自动化任务）。
 //   若把 960 条步骤全拼进去，单卡会有几十万字，撑爆内存/预算。
 //   封顶策略：
 //     · 最终答复完整保留（上限 MERGE_HEAD=10000 字）——**结论永远不砍**
 //     · 中间步骤最多 STEP_MAX 条（默认 15），超出时**保留头 10 + 尾 5**
 //       （头部是「开始干什么」，尾部是「快结束时在干什么」，中间重复过程价值最低）
 //     · 步骤区总字符再封 STEPS_TOTAL_MAX（默认 3000 字）
 const STEP_MAX = Number(opts.stepMaxCount) || 15;
 const STEP_KEEP_HEAD = 10;
 const STEP_KEEP_TAIL = 5;
 const STEPS_TOTAL_MAX = Number(opts.stepsTotalMaxChars) || 3000;

 for (const [sessionKey, a] of bySession) {
   a.sort((x,y) => (x.ts-y.ts) || String(x.id).localeCompare(String(y.id)));
   let seq=0;
   for (let i=0;i<a.length;i++) {
     const u=a[i]; if(u.role!=='user' || !u.content) continue;

     // ① 收集：本 user 之后、下一个 user 之前的**全部** assistant（同会话内）
     const answers = [];
     let j = i + 1;
     while (j < a.length && a[j].role !== 'user') {
       if (a[j].role === 'assistant' && a[j].content) answers.push(a[j]);
       j++;
     }

     // A later user closes an unanswered round. Never pair across it.
     const stamp = String(Math.trunc(u.ts));

     // ② 无任何回答 ⇒ 仍产出一张「只有提问」的卡（保留提问意图，与原行为一致）
     let ansText = '';
     let stepCount = 0;
     if (answers.length === 1) {
       ansText = answers[0].content.slice(0, MERGE_HEAD);
     } else if (answers.length > 1) {
       // 尾结论置顶：最后一条 = 最终交付
       const finalAns = answers[answers.length - 1].content;
       const allSteps = answers.slice(0, -1);
       stepCount = allSteps.length;
       // 中间步骤选取：头部 STEP_KEEP_HEAD + 尾部 STEP_KEEP_TAIL，中间省略
       let pickedSteps = allSteps;
       let omitted = 0;
       if (allSteps.length > STEP_MAX) {
         const head = allSteps.slice(0, STEP_KEEP_HEAD);
         const tail = allSteps.slice(-STEP_KEEP_TAIL);
         omitted = allSteps.length - head.length - tail.length;
         pickedSteps = head.concat(tail);
       }
       // 生成步骤行，并做总字符封顶
       const stepLinesArr = [];
       let stepsChars = 0;
       for (let k = 0; k < pickedSteps.length; k++) {
         const one = String(pickedSteps[k].content || '').replace(/\s+/g, ' ').trim().slice(0, STEP_CLIP);
         const line = '[步骤' + (k < STEP_KEEP_HEAD || omitted === 0 ? (k + 1) : (allSteps.length - STEP_KEEP_TAIL + (k - STEP_KEEP_HEAD) + 1)) + '] ' + one;
         if (stepsChars + line.length + 1 > STEPS_TOTAL_MAX) break;
         stepLinesArr.push(line);
         stepsChars += line.length + 1;
         if (omitted > 0 && k === STEP_KEEP_HEAD - 1) {
           stepLinesArr.push('... (中间省略 ' + omitted + ' 步) ...');
         }
       }
       const stepLines = stepLinesArr.join('\n');
       ansText = '【最终答复】\n' + finalAns.slice(0, MERGE_HEAD)
         + '\n\n【中间过程(' + allSteps.length + '步，已折叠)】\n' + stepLines;
     }

     const title = dualOn
       ? buildDualAnchorTitle(u.content, answers.length ? answers[answers.length - 1].content : '')
       : u.content.slice(0,80);
     const card = {
       id:'l0round:'+sessionKey+':'+stamp+':'+seq++,
       title,
       summary:u.content.slice(0,240),
       content:ansText.slice(0, 12000),
       createdAt:u.ts,
       // [2026-10-27 by Assistant · 第0步 补 eventTs]
       //   l0round 的 createdAt 本来就等于 user 消息的真实 ts（已经是事件时间），
       //   这里显式再挂一个 eventTs 字段，让下游不必猜"该用哪个字段"。
       //   实测 3112/3112 轮次 createdAt 全部有效。
       eventTs:u.ts,
       layer:'session',
       _source:'l0',
       sessionKey,
       l0User:u.content,
       l0Assistant:ansText,
     };
     // 记录合并元信息（便于排查「这轮到底合并了几条」）
     if (stepCount > 0) {
       card.answerCount = answers.length;
       card.mergedSteps = stepCount;
     }
     out.push(card);

     // ③ 直接跳到下一个 user 前，避免重复扫描
     i = j - 1;
   }
 }
 out.sort((a,b)=>b.createdAt-a.createdAt);
 Object.defineProperty(out,'stats',{value:{files,messages,rounds:out.length,sinceMs:since,dirs},enumerable:false});
 return out;
}
