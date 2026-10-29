/**
 * embedding/client.js —— OpenAI 兼容的向量端点客户端
 * [2026-10-22 by Assistant · 向量接入第一块]
 *
 * 为什么需要：
 *   现在的检索是**纯 BM25**（词面匹配）。
 *   User问「Assistant刚才说了什么」，「刚才/说了/什么」和「标签语义统一修复」字面零共享
 *   ⇒ 倒排直接把它挡在候选外，注入里自然没有它 ⇒ 别的会话「答不上来」。
 *   向量（bge-m3 / 1024 维）能把「语义相近但字面不同」的卡捞回来。
 *
 * 铁律：
 *   1. **永不让向量拖垮检索**：超时/无 key/断网/5xx ⇒ 一律返回 null，调用方退回纯 BM25。
 *   2. **绝不打印 key**：日志只报 host 与模型名。
 *   3. **批量**：一次最多 batchSize 条，避免大请求被打回。
 */

import { readFileSync as fsReadFileSync, existsSync as fsExistsSync } from 'node:fs';

const DEFAULT_TIMEOUT_MS = 12000;
const DEFAULT_BATCH = 32;

/**
 * [2026-10-22 by Assistant · key 不过手] 从 profile 的 tdai-memory 段继承 embedding 配置。
 *
 * 为什么要这样：Assistant**不得接收/索要用户的密钥**（AGENTS.md 铁律），
 *   但向量端点必然要 key。折中：让插件**自己**从 profile 读 tdai 那段已有的
 *   embedding 配置（baseUrl/model/dimensions/apiKey 都在），key 不进Assistant上下文、不进日志。
 *
 * 失败一律返回 null（不抛）。
 */
export function inheritFromProfile(profilePath) {
  try {
    const p = String(profilePath || '');
    if (!p) return null;
    if (!fsExistsSync(p)) return null;
    const lines = fsReadFileSync(p, 'utf8').split(/\r?\n/);
    let inEmb = false, embIndent = -1;
    const got = { baseUrl: '', model: '', dimensions: 0, apiKey: '' };
    for (const raw of lines) {
      const line = String(raw).replace(/\t/g, '  ');
      const t = line.trim();
      const ind = line.length - line.trimStart().length;
      if (/^embedding:\s*$/.test(t)) { inEmb = true; embIndent = ind; continue; }
      if (!inEmb) continue;
      if (t === '' || t.startsWith('#')) continue;
      if (ind <= embIndent) { inEmb = false; continue; }
      const m = t.match(/^(baseUrl|model|dimensions|apiKey):\s*(.*)$/);
      if (!m) continue;
      const v = m[2].trim().replace(/^['"]|['"]$/g, '');
      if (m[1] === 'baseUrl') got.baseUrl = v;
      else if (m[1] === 'model') got.model = v;
      else if (m[1] === 'dimensions') got.dimensions = Number(v) || 0;
      else if (m[1] === 'apiKey') got.apiKey = v;
    }
    if (!got.baseUrl || !got.model || !got.apiKey) return null;
    return got;
  } catch {
    return null;
  }
}

/** 从配置解析出可用端点；缺关键字段 ⇒ null（= 向量关闭）。 */
export function resolveEndpoint(cfg) {
  const c = cfg || {};
  if (c.enabled === false) return null;
  const baseUrl = String(c.baseUrl || '').trim().replace(/\/+$/, '');
  const apiKey = String(c.apiKey || '').trim();
  const model = String(c.model || '').trim();
  if (!baseUrl || !apiKey || !model) return null;
  return {
    baseUrl: baseUrl,
    apiKey: apiKey,
    model: model,
    dimensions: Number(c.dimensions) || 1024,
    sendDimensions: c.sendDimensions === true,
    timeoutMs: Number(c.timeoutMs) || DEFAULT_TIMEOUT_MS,
    batchSize: Number(c.batchSize) || DEFAULT_BATCH,
  };
}

/** 只用于日志：host + 模型名（绝不带 query、绝不带 key）。 */
export function endpointLabel(ep) {
  if (!ep) return 'off';
  let host = '';
  try { host = new URL(ep.baseUrl).host; } catch { host = 'invalid-url'; }
  return host + '/' + ep.model;
}

/**
 * 批量嵌入。
 * @returns {Promise<Float32Array[]|null>} 成功返回与 texts 等长的向量数组；任何异常返回 null。
 */
export async function embedTexts(ep, texts) {
  if (!ep || !Array.isArray(texts) || texts.length === 0) return null;
  const out = [];
  for (let i = 0; i < texts.length; i += ep.batchSize) {
    const batch = texts.slice(i, i + ep.batchSize);
    const got = await embedBatch(ep, batch);
    if (got === null) return null;   // 任一批失败 ⇒ 整体放弃（宁可退回 BM25，也不要半套索引）
    for (const v of got) out.push(v);
  }
  return out;
}

async function embedBatch(ep, batch) {
  const controller = new AbortController();
  const timer = setTimeout(function () { controller.abort(); }, ep.timeoutMs);
  try {
    // 清洗后再发：孤立代理对会让整个请求 400
    const clean = batch.map(function (t) { return sanitizeText(t); });
    const body = { model: ep.model, input: clean, encoding_format: 'float' };
    if (ep.sendDimensions) body.dimensions = ep.dimensions;
    const res = await fetch(ep.baseUrl + '/embeddings', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + ep.apiKey,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      // 不抛：调用方只需要知道「没拿到」，退回 BM25 即可
      return null;
    }
    const json = await res.json();
    const data = Array.isArray(json && json.data) ? json.data : null;
    if (!data || data.length !== batch.length) return null;
    // OpenAI 兼容端点可能乱序返回（理论上按 index），按 index 归位
    const rows = new Array(batch.length);
    for (let k = 0; k < data.length; k++) {
      const d = data[k];
      const idx = Number.isInteger(d && d.index) ? d.index : k;
      rows[idx] = Float32Array.from(d && d.embedding ? d.embedding : []);
    }
    for (const r of rows) if (!r || r.length === 0) return null;
    return rows;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** 单条嵌入（查询用）。失败返回 null。 */
export async function embedQuery(ep, query) {
  const text = String(query || '').trim();
  if (!text) return null;
  const got = await embedTexts(ep, [text]);
  return got && got[0] ? got[0] : null;
}

/**
 * [2026-10-22 by Assistant · 修 768 条失败] 清洗非法 Unicode。
 *
 * 为什么必须有：engram 里有 768 张卡的 title/summary 含**孤立代理对**
 *   （如 "\udc49 **那鼠标单击选"）——JSON.stringify 后是非法 UTF-8，
 *   embdeding 端点直接 400 整批拒绝。表现是「重跑时每一批都失败」。
 *   （这些卡本身也是脏数据：title 是从正文截断出来的句子残片。）
 *
 * 做法：删掉孤立代理对 + 控制字符，不动正常文本。
 */
export function sanitizeText(s) {
  const t = String(s === undefined || s === null ? '' : s);
  return t
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, '')
    .replace(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
}

/** L2 归一化（写入索引前统一，cosine 退化为点积）。 */
export function normalize(vec) {
  let sum = 0;
  for (let i = 0; i < vec.length; i++) sum += vec[i] * vec[i];
  const n = Math.sqrt(sum);
  if (!(n > 0)) return vec;
  const out = new Float32Array(vec.length);
  for (let i = 0; i < vec.length; i++) out[i] = vec[i] / n;
  return out;
}

/** 点积（两边都已归一化时 = cosine）。 */
export function dot(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}
