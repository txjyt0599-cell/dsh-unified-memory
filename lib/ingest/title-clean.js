/**
 * lib/ingest/title-clean.js —— 标题清洗（挡住 HTML 碎片 / 代码块 / 表格线当标题）
 * [2026-10-24 by Assistant · goal round 4]
 *
 * 实跑抓到：注入文本里出现 "- [卡] </style>：…" / "- [卡] ▼ ▼ ┌───…"。
 * 根因：抽标题时遇到 VCP 卡片 / 代码块 / 表格 / 树形图，把装饰字符当成了标题。
 * 危害：注入难看 + 字面检索被符号污染。
 *
 * 策略：**先剥后判**。剥完还剩"人话"才用；否则退回正文首句；还不行写「（无标题）」。
 */
const TAG = /<\/?[a-zA-Z][^>]{0,300}>/g;
const ATTR = /\b[a-zA-Z-]+\s*=\s*("[^"]*"|'[^']*'|[^\s>"]+)?/g;   // class="x" / class=
const BOXCH = /[\u2500-\u257F\u2580-\u259F\u25A0-\u25FF]/g;       // 制表符/方块/几何图形
const RULE = /^[\s=\-_*#>|~.·—–]{3,}$/;                              // ==== / ---- / ****
const ONLY_SYMBOLS = /^[\s\p{P}\p{S}]*$/u;

export function cleanTitle(raw, fallbackText) {
  let t = String(raw || '');
  t = t.replace(TAG, ' ');
  // [2026-10-24 实测补] 被截断的开标签：'<s' / '<div class="' —— 没有 '>' 收尾，
  //   TAG 匹配不到。先把「从 '<' 到行尾」整段砍掉（标题本就不该含尖括号）。
  t = t.replace(/<[^<>]{0,200}$/g, ' ');
  t = t.replace(/<[^>]{0,120}$/g, ' ');
  t = t.replace(/^\s*(?:```|~~~)/, ' ');
  t = t.replace(/`{1,3}/g, ' ');
  t = t.replace(BOXCH, ' ');
  t = t.replace(ATTR, ' ');
  t = t.replace(/^[#>*\-\s|]+/, ' ');
  t = t.replace(/\s+/g, ' ').trim();
  // 剥完还是「只有符号 / 只有下划线短横 / 太短」⇒ 无效
  if (RULE.test(t) || ONLY_SYMBOLS.test(t) || t.length < 2) t = '';

  if (!t && fallbackText) {
    // [2026-10-24 实测补] 兜底正文同样要**完整清洗**：
    //   上次只剥了 TAG/BOXCH，正文里的「…） <s」这种截断标签原样漏了出来，
    //   于是脏标题又被写回记忆（实测 2 张）。
    let body = String(fallbackText)
      .replace(TAG, ' ')
      .replace(/<[^<>]{0,200}$/g, ' ')
      .replace(/<[^>]{0,120}$/g, ' ')
      .replace(BOXCH, ' ')
      .replace(ATTR, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const m = /^(.{3,40}?)[。！？.!?:：]/.exec(body);
    t = (m ? m[1] : body.slice(0, 24)).trim();
  }

  // ── [2026-10-24 by Assistant · Round 27] 「以冒号结尾的半句话」不是标题 ──
  //   实测 397 张卡标题是「这样：」「麻烦你回一句：」这种**引导语** ——
  //   因为抽标题时取正文第一行，而第一行常只是"某某："，真正内容在下一行。
  //   修法：标题以冒号/破折号结尾时，把冒号后面的内容补上来。
  if (/[：:]\s*$/.test(t) && fallbackText) {
    const body0 = String(fallbackText).replace(TAG, ' ').replace(BOXCH, ' ').replace(/\s+/g, ' ').trim();
    const m2 = /[：:]\s*(.{6,60}?)(?:[。！？；]|$)/.exec(body0);
    if (m2 && m2[1]) {
      let tail = m2[1].replace(/^[\s，、：:\-\*]+/, '').trim();
      // [Round 27] 补语里如果还有"Xxx："这种二级引导语，继续往后取
      const m3 = /[：:]\s*(.{6,40})$/.exec(tail);
      if (m3 && m3[1].length >= 6) tail = m3[1].trim();
      tail = tail.replace(/^[\-\*\s]+/, '').trim();
      if (tail.length >= 6 && !ONLY_SYMBOLS.test(tail)) {
        // 前缀是纯引导语（"这样"/"麻烦你回一句"）时，直接用 tail 当标题更好
        const head = t.replace(/[：:]\s*$/, '').replace(/\*\*/g, '').trim();
        const isLeadIn = head.length <= 6 || /^(这样|那么|所以|因此|另外|同时|然后|麻烦你|请|注意|说明|举个例子)/.test(head);
        t = (isLeadIn ? tail : head + '：' + tail).slice(0, 60);
      }
    }
    if (/[：:]\s*$/.test(t)) t = '';   // 补不上 ⇒ 判无效，走兜底
  }

  // [2026-10-24 实测补] **最终校验**：不管来自原标题还是兜底，只要还脏就判无效。
  //   这一道是必须的 —— 前面每道 replace 都可能漏（截断标签、生僻符号）。
  //
  // [2026-10-28 by Assistant · 老红项根因之二]
  //   原来这里写死填字面量 '（无标题）'。后果是**脏数据被伪装成合法标题**：
  //   体检判它不合格 → 但写入侧/读侧都没人拦它 → 它就一直躺在库里当标题，
  //   而"（无标题）"本身又通过了"有值"的检查，问题被藏了起来。
  //   ⇒ 改成返回空串，把"这张卡没有可用标题"这个事实**如实交给上游**：
  //     写侧可以据此丢卡，读侧可以据此从正文提炼，体检可以据此报红。
  //   ⛔ 绝不在这里编一个占位符假装合格。
  const INVALID = '';
  if (!t || RULE.test(t) || ONLY_SYMBOLS.test(t) || t.length < 2) t = INVALID;
  if (/<\/?[a-zA-Z]|\b[a-zA-Z-]+\s*=\s*["']?/.test(t)) t = INVALID;
  return t.slice(0, 60);
}

export function isDirtyTitle(t) {
  const s = String(t || '');
  if (!s.trim()) return true;
  if (s.length < 2) return true;
  if (/<\/?[a-zA-Z]/.test(s)) return true;
  if (/\/style|\/div|\/span|\/table|\/section/i.test(s)) return true;
  if (/\b[a-zA-Z-]+\s*=\s*["']?/.test(s)) return true;    // 属性残留（含截断）
  if (BOXCH.test(s)) { BOXCH.lastIndex = 0; return true; }
  if (RULE.test(s)) return true;
  if (ONLY_SYMBOLS.test(s)) return true;
  return false;
}


/**
 * [2026-10-24 Round 16] tdai 模板标题改善。
 *
 * 问题：tdai 库 60%（1859/3176）的标题是「我（AI）和用户讨论XXX」这类场景模板句，
 *   召回时只看到「我（AI）和用户讨论电脑故障问题」，根本不知道聊了什么。
 *   而 content 其实很丰富（1885/1908 有实质结论）。
 *
 * 做法：从 content 提炼一句能自足的短句当标题（规则法，零 LLM）。
 *   提炼不出 / 还是模板句 / 太泛 ⇒ 返回 null（保留原标题，不硬造）。
 */
// [Round 16 五次修正] 变体比想象的多：
//   「我（AI）和用户…」「我（AI）与用户…」「我（AI）在和Assistant（用户）…」
//   「我（AI/Assistant）和User…」「我（AI）协助User…」
//   共同点：以「我（…）」开头。统一收这个前缀，后面往往已是可读内容。
// [Round 16 八次修正] 还有不带括号的变体：「我在和喜欢硬件电脑的用户进行角色扮演…」
//   这类标题其实**已经是叙述句**，但主语是"我在和用户"，读起来像流水账。
//   统一按「以 我在/我（xx） 开头」识别为模板句。
const TD_TEMPLATE = /^我[（(][^）)]{0,10}[）)]|^用户[（(]User[）)]|^我\(AI\)|^我在(和|与)/;
const TD_LEAD = /^(用户希望|用户要求|用户说|用户表示|用户提到|用户在|AI在|Assistant在|这让我|其实|所以)/;

export function betterTdaiTitle(rawTitle, content) {
  const title = String(rawTitle || '');
  if (!TD_TEMPLATE.test(title)) return null;
  const text = String(content || '').replace(/\s+/g, ' ').trim();
  if (text.length < 12) return null;
  // [Round 16 五次修正] 有些标题剥掉「我（AI）」前缀后**本身就是好标题**
  //   （如「我（AI）与用户调试NextHubKVM的鼠标映射」→「调试NextHubKVM的鼠标映射」）。
  //   优先走这条路：比从 content 提炼更贴近原意。
  // [Round 16 六次修正] 前缀剥离必须**严格**，否则会吃掉正文：
  //   坏例：「我（AI）和用户讨论Chatbox…」 → 剥成「box…」（"Chat" 被连词吃掉）。
  //   约束：只允许剥「我（…）」+ 可选单个连接词 + 可选一个身份括号，
  //        且**剥完必须以汉字/英文字母开头**，不能以半截单词开头。
  const stripped = title
    .replace(/^我[（(][^）)]{0,10}[）)]\s*/, '')                    // 去掉「我（…）」
    .replace(/^(和|与|协助|为|帮)\s*(用户|User|Assistant)?[（(][^）)]{0,6}[）)]\s*/, '')  // 去掉「和用户（xxx）」
    .replace(/^(和|与|协助|为|帮)\s*(用户|User|Assistant)\s*/, '')       // 去掉「和用户」
    .trim();
  // [Round 16 七次修正] 剥前缀后如果是「讨论XXX / 制定XXX准则 / 协助XXX」这类
  //   **只有动作、没有实质**的标题，不如从 content 提炼（content 里通常有具体结论）。
  //   实测：「讨论电脑故障问题」远不如「AI在回答电脑故障排查问题时」信息量大。
  const VAGUE = /^(讨论|制定|协助|处理|进行|开展|分析|调试|排查)/;
  const isVague = VAGUE.test(stripped) && stripped.length < 18;
  if (!isVague && stripped.length >= 8 && stripped.length <= 30 && !TD_TEMPLATE.test(stripped)) {
    return stripped;
  }
  const mm = /^(.{6,80}?)[。！？；]/.exec(text);
  const sentence = (mm ? mm[1] : text).trim();
  const clauses = sentence.split(/[，,]/).map((x) => x.trim()).filter(Boolean);
  let s = '';
  for (const cl of clauses) {
    let cur = cl;
    const lead = TD_LEAD.exec(cur);
    if (lead) {
      const rest = cur.slice(lead[0].length).trim();
      if (rest.length >= 6 && !/^(的|了|是|在|和|与|及)/.test(rest)) cur = rest;
    }
    if (cur.length >= 6 && cur.length <= 30) { s = cur; break; }
    if (cur.length > 30) {
      const cut = cur.slice(0, 26);
      const p2 = Math.max(cut.lastIndexOf('、'), cut.lastIndexOf(' '), cut.lastIndexOf('的'));
      s = (p2 > 12 ? cut.slice(0, p2) : cut).trim();
      break;
    }
    if (cur.length >= 6) { s = cur; break; }
  }
  if (!s) return null;
  s = s.replace(/^[，、：:\s]+|[，、：:\s]+$/g, '');
  // [Round 16 三次修正] 两类最常见的脏标题（实测 1039 张可疑里主要是它们）：
  //   ① 占位符噪声："用户（未具名）拥有…" / "用户（[用户身份]）…"
  //   ② 时间戳截断："用户（Assistant）在 2026-08-13T14:28:0"
  // [Round 16 四次修正] 占位符还有 [用户] / [用户身份] 这种带方括号的变体
  s = s.replace(/[（(]\s*\[?[^）)]{0,8}\]?\s*[）)]/g, function (m0) {
    // 只清「明显是占位符」的：短、且含 用户/身份/未具名/Assistant/AI/User
    return /用户|身份|未具名|Assistant|AI|User/.test(m0) && m0.length <= 12 ? '' : m0;
  });
  s = s.replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z?/g, '').replace(/\d{4}年\d{1,2}月\d{1,2}日/g, '');
  s = s.replace(/\s{2,}/g, ' ').trim();
  s = s.replace(/^[，、：:\s]+|[，、：:\s]+$/g, '');
  if (/^(在|的|了|是|和|与|及)\s*/.test(s)) return null;
  if (s.length < 6) return null;
  if (TD_TEMPLATE.test(s)) return null;
  if (/^(讨论|关于|有关)/.test(s)) return null;
  if (/问题$/.test(s) && s.length < 12) return null;
  return s;
}



/**
 * [2026-10-24 by Assistant · Round 28] 按**词边界**截断，不硬切英文单词。
 *
 * 实测问题：normalize.js 用 content.slice(0,16) 兜底当标题，
 *   于是出现「工具schema缺ite」（缺 r）、「Cubism预乘Alph」（缺 a）、
 *   「recall与searc」（缺 h）、「canvas勿用inse」（缺 r）—— 132 张这种残词。
 *
 * 规则：若切点落在英文/数字词的中间，回退到该词开头（宁短勿断）。
 *   中文没有词边界问题，照切。
 */
export function cutAtWord(text, n) {
  const s = String(text || '');
  const max = Math.max(1, Number(n) || 16);
  if (s.length <= max) return s;
  let cut = s.slice(0, max);
  // 若下一字符仍是字母/数字 ⇒ 说明切断了一个词，回退到该词开头
  const next = s.charAt(max);
  if (/[A-Za-z0-9]/.test(next)) {
    // 找 cut 里最后一个连续字母/数字段的起点
    const m = /[A-Za-z0-9]+$/.exec(cut);
    if (m && m.index > 0) cut = cut.slice(0, m.index);
  }
  // 去掉结尾的标点/空白
  return cut.replace(/[\s，,、：:\-]+$/, '');
}

