/**
 * ingest/llm.js —— 期7 的 LLM 通道（提取/蒸馏共用）
 * [2026-10-22 by Assistant · 期7]
 *
 * 为什么要单独一层：
 *   ① 旧实现直接调 ctx.llm.stream()，一旦插件被拆走就断链；这里把「怎么调模型」
 *      收成一个可注入的函数，**关掉旧插件不影响**，测试里也能塞假模型。
 *   ② key 不过手：配置没给就从 profile 的 tdai-memory.llm 段继承（本机文件之间流动），
 *      Assistant不留、不打印 key。
 *   ③ 一律超时 + 失败返回 null（绝不让抽取失败拖垮回合）。
 */
import { readFileSync as fsRead, existsSync as fsExists } from 'node:fs';

const DEFAULT_TIMEOUT_MS = 45000;

/** 从 profile 里抠出 tdai-memory 的 llm 段（baseUrl/model/apiKey）。失败返回 null。 */
export function inheritLlmFromProfile(profilePath) {
  try {
    const p = String(profilePath || '');
    if (!p || !fsExists(p)) return null;
    const lines = fsRead(p, 'utf8').split(/\r?\n/);
    let i = 0;
    // 先定位 tdai-memory 段
    for (; i < lines.length; i++) if (/^-\s*id:\s*tdai-memory\s*$/.test(lines[i].trim())) break;
    if (i >= lines.length) return null;
    let inLlm = false, llmIndent = -1;
    const got = { baseUrl: '', model: '', apiKey: '' };
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j].replace(/\t/g, '  ');
      const t = line.trim();
      const ind = line.length - line.trimStart().length;
      if (t === '' || t.startsWith('#')) continue;
      if (ind === 0 && /^-\s/.test(t)) break;          // 下一段
      if (/^llm:\s*$/.test(t)) { inLlm = true; llmIndent = ind; continue; }
      if (!inLlm) continue;
      if (ind <= llmIndent) { inLlm = false; continue; }
      const m = t.match(/^(baseUrl|model|apiKey):\s*(.*)$/);
      if (!m) continue;
      // [2026-10-22 by Assistant · 旁路实跑抓到] 必须剥掉行尾注释。
      //   实测 profile 里写的是 `model: glm-4.6v-flash # [2026-09-26 Assistant] 多轮稳测里最优…`
      //   ⇒ 不剥的话 model 变成 "glm-4.6v-flash # [2026-09-26 Assistant] …"，
      //   请求必然 400/失败，而错误被吞成 null ⇒ 表现成「LLM 一直没产出」。
      //   去掉行尾的 ` # ...`（引号内的 # 不会命中这个模式）。
      const v = m[2].trim().replace(/\s+#.*$/, '').trim().replace(/^['"]|['"]$/g, '');
      if (m[1] === 'baseUrl') got.baseUrl = v;
      else if (m[1] === 'model') got.model = v;
      else if (m[1] === 'apiKey') got.apiKey = v;
    }
    if (!got.baseUrl || !got.model || !got.apiKey) return null;
    return got;
  } catch { return null; }
}

export function resolveLlm(cfg) {
  const c = cfg || {};
  if (c.enabled === false) return null;
  let baseUrl = String(c.baseUrl || '').trim().replace(/\/+$/, '');
  let apiKey = String(c.apiKey || '').trim();
  let model = String(c.model || '').trim();
  if ((!baseUrl || !apiKey || !model) && c.profilePath) {
    const inh = inheritLlmFromProfile(c.profilePath);
    if (inh) {
      if (!baseUrl) baseUrl = String(inh.baseUrl).replace(/\/+$/, '');
      if (!apiKey) apiKey = inh.apiKey;
      if (!model) model = inh.model;
    }
  }
  if (!baseUrl || !apiKey || !model) return null;
  return {
    baseUrl, apiKey, model,
    timeoutMs: Number(c.timeoutMs) || DEFAULT_TIMEOUT_MS,
    // [2026-10-22 by Assistant · 实测校准] 1500 不够：glm-4.6v-flash 会在 reasoning 里
    //   烧掉 900+ token，正文只剩几百 ⇒ 卡片输出被截断。给到 4000 留足余量。
    maxTokens: Number(c.maxTokens) || 4000,
    temperature: c.temperature === undefined ? 0.2 : Number(c.temperature),
  };
}

export function llmLabel(ep) {
  if (!ep) return 'off';
  let host = 'invalid';
  try { host = new URL(ep.baseUrl).host; } catch {}
  return host + '/' + ep.model;
}

/** 单轮补全：system + user → 文本。任何异常返回 null。 */
export async function complete(ep, system, user) {
  if (!ep) return null;
  // [2026-10-22 by Assistant · 实跑抓到] 必须处理 429：实测 glm-4.6v-flash 连续调用
  //   会触发 `{"code":1302,"message":"您的账户已达到速率限制"}`。
  //   旧实现直接 return null ⇒ 那一轮提取白跑（游标不推进是对的，但白烧一次时钟）。
  //   这里做「2 次重试 + 指数退避 + 尊重 Retry-After」，最坏 1+2+4=7s，可接受。
  //
  // [2026-10-22 by Assistant · 第14轮] 光重试不够 —— 免费档 glm-4.6v-flash 会**持续**429。
  //   实测：连续 3 次探测全是 code 1305「访问量过大」，等再久也不会好。
  //   而同一账号下 **glm-4-flash 完全可用**（实测 200，且能正确产出名词性标题）。
  //
  //   ⇒ 加**模型降级链**：主模型连续失败后，依次换备用模型，
  //     全部失败才返回 null。这是"治本"——不再靠运气等上游恢复。
  const FALLBACK_MODELS = ['glm-4-flash', 'glm-4.5-flash'];
  const models = [ep.model].concat(FALLBACK_MODELS.filter((m) => m !== ep.model));
  const maxAttemptsPerModel = 2;

  for (const model of models) {
    const epm = model === ep.model ? ep : Object.assign({}, ep, { model });
    let lastErr = null;
    for (let attempt = 1; attempt <= maxAttemptsPerModel; attempt++) {
      const out = await completeOnce(epm, system, user);
      if (out && out.ok) return out.text;
      lastErr = out;
      // 4xx（非 429）是请求本身的问题，换模型也没用
      if (!out || out.retryable !== true) { lastErr = out; break; }
      if (attempt < maxAttemptsPerModel) {
        const wait = Math.min(4000, (out.retryAfterMs || 0) || (800 * Math.pow(2, attempt - 1)));
        await new Promise((r) => setTimeout(r, wait));
      }
    }
    // 记下"这个模型不行"，继续试下一个
    if (lastErr && lastErr.status === 429) continue;
    if (lastErr && lastErr.retryable === true) continue;
    return null;
  }
  return null;
}

/** 单次尝试：{ok, text} / {ok:false, retryable, status, retryAfterMs} */
async function completeOnce(ep, system, user) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => { try { ctrl.abort(); } catch {} }, ep.timeoutMs);
  try {
    const res = await fetch(ep.baseUrl + '/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + ep.apiKey },
      body: JSON.stringify({
        model: ep.model,
        temperature: ep.temperature,
        max_tokens: ep.maxTokens,
        // 结构化抽取任务不需要思考链：不关会吃光预算导致空输出（engram-relay 已踩过）
        chat_template_kwargs: { enable_thinking: false },
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      // 429 / 5xx 值得重试；4xx（除 429）是请求本身有问题，重试没意义
      const retryable = res.status === 429 || res.status === 503 || res.status === 502 || res.status === 504;
      let retryAfterMs = 0;
      try {
        const ra = res.headers.get('retry-after');
        if (ra) {
          // [红队 R2 P2] Retry-After 有两种格式：秒数、以及 HTTP-date。
          //   只解析数字会在 date 格式下拿到 NaN ⇒ 退避时间失效。
          const asNum = Number(ra);
          if (Number.isFinite(asNum)) retryAfterMs = asNum * 1000;
          else {
            const asDate = Date.parse(ra);
            if (Number.isFinite(asDate)) retryAfterMs = Math.max(0, asDate - Date.now());
          }
        }
      } catch {}
      return { ok: false, retryable, status: res.status, retryAfterMs };
    }
    const j = await res.json();
    const text = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
    if (typeof text !== 'string') return { ok: false, retryable: false, status: 200 };
    return { ok: true, text };
  } catch (e) {
    // 超时/网络错误：可重试（但由外层 maxAttempts 兜底）
    return { ok: false, retryable: true, status: 0 };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 宽松解析：剥围栏 → 取 JSON 数组；**被截断时抢救完整对象**。
 *
 * [2026-10-22 by Assistant · 旁路实跑抓到] 实测 glm-4.6v-flash 一次调用
 *   completion_tokens=1207 里 **993 是 reasoning_tokens**，
 *   正文只分到几百 token ⇒ 6 条卡只输出到第 3 条就被截断（finish_reason 仍是 stop！）。
 *   旧实现对截断输出直接判「解析失败 ⇒ 整窗丢弃」⇒ 提取率 0（实跑连丢 2 窗）。
 *
 * 这里补第二层：整段 JSON 解析失败时，**扫出所有括号平衡的 {...} 对象**逐个解析，
 * 能救几条算几条（记忆不怕少一条，怕的是一条都没有）。
 */
export function parseJsonArray(text) {
  const t = String(text || '').trim();
  if (!t) return null;
  const cleaned = t.replace(/^```[a-z]*\s*/i, '').replace(/```\s*$/, '');
  const start = cleaned.indexOf('[');
  const end = cleaned.lastIndexOf(']');
  if (start >= 0 && end > start) {
    try {
      const arr = JSON.parse(cleaned.slice(start, end + 1));
      if (Array.isArray(arr)) return arr;
    } catch { /* 落到抢救分支 */ }
  }
  // ── 抢救：逐个抓完整的 {...} ──
  const body = start >= 0 ? cleaned.slice(start) : cleaned;
  const out = [];
  let depth = 0, inStr = false, esc = false, from = -1;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (esc) { esc = false; continue; }
    if (inStr) {
      if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '{') { if (depth === 0) from = i; depth++; }
    else if (ch === '}') {
      depth--;
      if (depth === 0 && from >= 0) {
        try {
          const obj = JSON.parse(body.slice(from, i + 1));
          if (obj && typeof obj === 'object') out.push(obj);
        } catch {}
        from = -1;
      }
      if (depth < 0) depth = 0;
    }
  }
  return out.length > 0 ? out : null;
}
