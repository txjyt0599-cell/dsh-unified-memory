import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { dataPath, dshHome } from './paths.js';
import { DEFAULT_LIVE } from './ingest/config.js';
import { resolveLlm } from './ingest/llm.js';
import { resolveEndpoint, inheritFromProfile } from './embedding/client.js';
import { isCompatible } from './embedding/index-store.js';
import { publicBaseUrl, readEndpointOverrides, mergeEndpointOverrides, hasPendingEndpointRestart, saveEndpointOverrides } from './endpoint-config.js';

const API = '/api/unified-memory';
const mounted = new WeakSet();

export const BOOLEAN_FIELDS = [
  'enabled', 'capture', 'extract', 'distill',
  'consolidationWindowEnabled', 'concentrationEnabled', 'concentrationBoostEnabled',
  'axiomStagingEnabled', 'fourForcesEnabled', 'flashbackEnabled',
  'temporalWindowEnabled', 'temporalEarliestEnabled', 'temporalPureTimeProminence',
  'eventTsEnabled', 'vectorAutoBuildEnabled',
  'coldArchiveEnabled', 'coldArchiveAutoApply',
];

export const NUMBER_FIELDS = {
  batchMessages: [1, 64], minBatchMessages: [1, 16], maxWindowsPerRun: [1, 20],
  distillWindowMessages: [8, 128], minDistillMessages: [2, 32],
  extractIntervalMs: [30000, 3600000], distillMinGapMs: [0, 3600000],
  concentrationGate: [0, 1], concentrationAlpha: [0, 1],
  temporalMinPool: [1, 10], retireAfterDays: [1, 365],
  vectorAutoBuildIntervalMs: [300000, 7200000], vectorAutoBuildLimit: [0, 500],
  coldArchiveAgeDays: [7, 365], coldArchiveImpMax: [0, 1],
};

function hostOf(value) {
  try { return new URL(String(value || '')).host || '未配置'; }
  catch { return String(value || '').replace(/^https?:\/\//, '').split('/')[0] || '未配置'; }
}

function readJson(path, fallback = {}) {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : fallback;
  } catch { return fallback; }
}

function liveConfigPath(options = {}) {
  return options.liveConfigPath || join(dataPath('ingest'), 'config.json');
}

export function sanitizedLiveConfig(raw = {}) {
  const merged = { ...DEFAULT_LIVE, ...raw };
  const safe = {};
  for (const key of BOOLEAN_FIELDS) {
    if (typeof merged[key] === 'boolean') safe[key] = merged[key];
  }
  for (const key of Object.keys(NUMBER_FIELDS)) {
    if (Number.isFinite(Number(merged[key]))) safe[key] = Number(merged[key]);
  }
  safe.fallbackMode = ['off', 'llm', 'heuristic'].includes(merged.fallbackMode) ? merged.fallbackMode : 'off';
  const fallback = raw.fallbackLlm && typeof raw.fallbackLlm === 'object' ? raw.fallbackLlm : {};
  safe.fallbackLlm = {
    enabled: fallback.enabled === true,
    provider: String(fallback.provider || ''),
    model: String(fallback.model || ''),
    host: hostOf(fallback.baseUrl),
    credential: fallback.apiKey ? '已配置' : '未配置',
  };
  return safe;
}

export function validateConfigPatch(body = {}) {
  const clean = {};
  for (const key of BOOLEAN_FIELDS) {
    if (!(key in body)) continue;
    if (typeof body[key] !== 'boolean') return { ok: false, status: 400, error: key + ' 必须是布尔值' };
    clean[key] = body[key];
  }
  for (const [key, range] of Object.entries(NUMBER_FIELDS)) {
    if (!(key in body)) continue;
    const value = Number(body[key]);
    if (!Number.isFinite(value)) return { ok: false, status: 400, error: key + ' 必须是数字' };
    clean[key] = Math.min(range[1], Math.max(range[0], value));
  }
  if ('fallbackMode' in body) {
    if (!['off', 'llm', 'heuristic'].includes(body.fallbackMode)) {
      return { ok: false, status: 400, error: 'fallbackMode 不在允许范围内' };
    }
    clean.fallbackMode = body.fallbackMode;
  }
  const allowed = new Set([...BOOLEAN_FIELDS, ...Object.keys(NUMBER_FIELDS), 'fallbackMode', 'confirmColdArchive']);
  const unknown = Object.keys(body).filter((key) => !allowed.has(key));
  if (unknown.length) return { ok: false, status: 400, error: '存在未授权字段' };
  if (!Object.keys(clean).length) return { ok: false, status: 400, error: '没有可保存的字段' };
  return { ok: true, value: clean };
}

export function saveLiveConfig(body, options = {}) {
  const checked = validateConfigPatch(body);
  if (!checked.ok) return checked;
  const path = liveConfigPath(options);
  const current = readJson(path, {});
  if (checked.value.coldArchiveAutoApply === true && current.coldArchiveAutoApply !== true && body.confirmColdArchive !== true) {
    return { ok: false, status: 409, error: '开启自动归档需要二次确认' };
  }
  try {
    mkdirSync(join(path, '..'), { recursive: true });
    if (existsSync(path)) copyFileSync(path, path + '.dashboard-backup');
    const next = { ...current, ...checked.value };
    const temp = path + '.' + process.pid + '.' + Date.now() + '.tmp';
    writeFileSync(temp, JSON.stringify(next, null, 2) + '\n', 'utf8');
    renameSync(temp, path);
    return { ok: true, config: sanitizedLiveConfig(next), changed: Object.keys(checked.value) };
  } catch {
    return { ok: false, status: 500, error: '配置写入失败，原配置未被替换' };
  }
}

function endpointConfigs(getConfig) {
  const c = getConfig() || {};
  const profilePath = c.profilePath || join(dshHome(), 'profiles/web/cordis.patch.yml');
  const llmRaw = c.ingest?.llm || {};
  const llm = resolveLlm({ ...llmRaw, profilePath }) || resolveLlm({ ...llmRaw, enabled: true, profilePath }) || llmRaw;
  const embeddingRaw = c.retrieval?.embedding || {};
  // [2026-11-08 修复] 两处错：① inheritFromProfile() 没传 profile 路径 ⇒ 永远 null（显示未配置）；
  //   ② 它返回的是顶层 {baseUrl,model,dimensions,apiKey}，不是 {embedding:{...}}；且 profile 里没写 dimensions。
  //   统一走 resolveEndpoint（会把缺省 dimensions 补成 1024）。
  const inheritedEmb = inheritFromProfile(profilePath) || {};
  const embedding = resolveEndpoint(embeddingRaw.baseUrl ? embeddingRaw : inheritedEmb) || {};
  const fallback = resolveEndpoint(c.retrieval?.embeddingFallback || {}) || {};
  const port = Number(c.retrieval?.startluxPort || 8084);
  return {
    llm: { id: 'L1', name: '语义炼成', purpose: '对话抽取 · 记忆蒸馏', kind: 'chat', baseUrl: llm.baseUrl || '', apiKey: llm.apiKey || '', model: llm.model || '', timeoutMs: Number(llm.timeoutMs || 45000), enabled: c.ingest?.llm?.enabled !== false },
    embedding: { id: 'E1', name: '向量主路', purpose: '全库建索引 · 在线检索', kind: 'embedding', baseUrl: embedding.baseUrl || '', apiKey: embedding.apiKey || '', model: embedding.model || '', dimensions: embedding.dimensions || 0, timeoutMs: Number(embedding.timeoutMs || 12000), enabled: true },
    fallback: { id: 'E2', name: '本地向量备路', purpose: '仅查询降级 · 禁止建库', kind: 'embedding', baseUrl: fallback.baseUrl || '', apiKey: fallback.apiKey || '', model: fallback.model || '', dimensions: fallback.dimensions || 0, timeoutMs: Number(fallback.timeoutMs || 20000), enabled: c.retrieval?.embeddingFallbackLocalAutoStart !== false },
    rerank: { id: 'R1', name: '本地精排', purpose: '相关性保底 · 按需拉起', kind: 'rerank', baseUrl: 'http://127.0.0.1:' + port + '/v1', apiKey: '', model: 'startlux', timeoutMs: 5000, enabled: c.retrieval?.startluxRerank === true },
  };
}

function publicEndpoint(ep) {
  const local = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?/i.test(ep.baseUrl);
  return {
    id: ep.id, name: ep.name, purpose: ep.purpose, kind: ep.kind,
    host: hostOf(ep.baseUrl), baseUrl: publicBaseUrl(ep.baseUrl), model: ep.model || '未配置',
    path: ep.kind === 'embedding' ? '/embeddings' : '/chat/completions',
    timeoutMs: ep.timeoutMs, enabled: ep.enabled !== false,
    dimensions: ep.dimensions || null,
    credential: local || ep.kind === 'rerank' ? '本地免密' : (ep.apiKey ? '已配置' : '未配置'),
    configured: Boolean(ep.baseUrl && ep.model),
  };
}

function indexStatus(options, embedding) {
  const index = readJson(options.indexPath || join(dataPath('embeddings'), 'index.json'), {});
  const model = String(index.model || '');
  const dim = Number(index.dim || index.dimensions || 0);
  return {
    available: Boolean(model && dim), model: model || '未建立', dim,
    count: Number(index.count || 0), builtAt: index.builtAt || null,
    compatible: Boolean(model && dim && embedding.model && isCompatible({ model, dim }, embedding.model, embedding.dimensions)),
  };
}

function telemetryStatus(options) {
  const path = options.wakeLogPath || join(dataPath('logs'), 'wake.log');
  const levels = ['retrieval', 'hot-buffer', 'cross-session-pulse', 'l0-tier-open', 'l0-tier-snapshot', 'decay-shadow'];
  const groups = Object.fromEntries(levels.map((level) => [level, { level, count: 0, totalMs: 0, lastAt: null }]));
  const recent = [];
  try {
    const text = readFileSync(path, 'utf8').slice(-524288);
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      let row;
      try { row = JSON.parse(line); } catch { continue; }
      const level = String(row.level || row.type || '');
      if (!groups[level]) continue;
      const ms = Number(row.durationMs ?? row.elapsedMs ?? row.ms ?? row.costMs ?? 0);
      const at = row.ts || row.time || row.at || null;
      groups[level].count += 1;
      if (Number.isFinite(ms)) groups[level].totalMs += ms;
      if (at) groups[level].lastAt = at;
      recent.push({ level, at, ms: Number.isFinite(ms) ? ms : 0, count: Number(row.count ?? row.n ?? row.hits ?? 0) || 0 });
    }
  } catch { /* 遥测缺失不阻塞状态页 */ }
  const summary = Object.values(groups).map((group) => ({
    level: group.level, count: group.count, lastAt: group.lastAt,
    avgMs: group.count ? Math.round(group.totalMs / group.count) : 0,
  }));
  return { available: existsSync(path), levels: summary, recent: recent.slice(-12).reverse() };
}

export function buildStatus(getConfig, options = {}) {
  const c = getConfig() || {};
  const restartRequired = hasPendingEndpointRestart(c, options);
  const desired = mergeEndpointOverrides(c, readEndpointOverrides(options));
  const live = sanitizedLiveConfig(readJson(liveConfigPath(options), {}));
  const endpoints = endpointConfigs(() => desired);
  const index = indexStatus(options, endpoints.embedding);
  return {
    ok: true, now: new Date().toISOString(),
    index,
    endpoints: Object.values(endpoints).map(publicEndpoint),
    settings: live,
    retrieval: {
      vectorTopK: Number(c.retrieval?.vectorTopK || 30),
      vectorMinScore: Number(c.retrieval?.vectorMinScore ?? 0.45),
      vectorScale: Number(c.retrieval?.vectorScale ?? 1.2),
      wVector: Number(c.retrieval?.wVector ?? 0.9),
    },
    telemetry: telemetryStatus(options),
    runtime: {
      enabled: c.enabled === true,
      lastGoodAt: c.__lastGoodAt || null,
      hotConfig: true,
      coldConfig: '端点与密钥修改后需重启 DSH',
      restartRequired,
    },
    capabilities: { connectivityTest: true, hotConfig: true, rebuild: false, telemetry: true },
  };
}

async function request(ep, path, init = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.min(15000, ep.timeoutMs || 10000));
  const started = Date.now();
  try {
    const headers = { ...(init.headers || {}) };
    if (ep.apiKey) headers.authorization = 'Bearer ' + ep.apiKey;
    const response = await fetch(String(ep.baseUrl).replace(/\/+$/, '') + path, {
      ...init, headers, signal: controller.signal,
    });
    return { response, latencyMs: Date.now() - started };
  } finally { clearTimeout(timeout); }
}

export async function testConnectivity(target, getConfig, options = {}) {
  const ep = endpointConfigs(getConfig)[target];
  if (!ep) return { ok: false, error: '未知测试目标' };
  if (!ep.baseUrl || !ep.model) return { ok: false, target, error: '端点尚未配置完整' };
  try {
    if (ep.kind === 'embedding') {
      const result = await request(ep, '/embeddings', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: ep.model, input: ['ping'] }),
      });
      if (!result.response.ok) return { ok: false, target, latencyMs: result.latencyMs, error: 'HTTP ' + result.response.status };
      const payload = await result.response.json();
      const observedDim = Number(payload?.data?.[0]?.embedding?.length || 0);
      const index = indexStatus(options, ep);
      const compatible = !index.dim || !observedDim || index.dim === observedDim;
      return { ok: compatible, target, latencyMs: result.latencyMs, observedDim, compatible, message: compatible ? '向量返回与索引维度一致' : '返回维度与现有索引不一致' };
    }
    const models = await request(ep, '/models');
    if (models.response.ok) return { ok: true, target, latencyMs: models.latencyMs, message: '模型目录可达' };
    if (ep.kind === 'rerank') return { ok: false, target, latencyMs: models.latencyMs, error: 'HTTP ' + models.response.status };
    const chat = await request(ep, '/chat/completions', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: ep.model, max_tokens: 1, temperature: 0, messages: [{ role: 'user', content: 'ping' }], chat_template_kwargs: { enable_thinking: false } }),
    });
    return chat.response.ok
      ? { ok: true, target, latencyMs: chat.latencyMs, message: '对话补全可达' }
      : { ok: false, target, latencyMs: chat.latencyMs, error: 'HTTP ' + chat.response.status };
  } catch (error) {
    return { ok: false, target, error: error?.name === 'AbortError' ? '连接超时' : '网络连接失败' };
  }
}

function sendJson(res, status, value) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(value));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let text = '';
    req.on('data', (chunk) => {
      text += chunk;
      if (text.length > 65536) reject(new Error('payload too large'));
    });
    req.on('end', () => {
      try { resolve(JSON.parse(text || '{}')); } catch { reject(new Error('invalid json')); }
    });
    req.on('error', reject);
  });
}

export function createDashboardHandler(options) {
  return async function handler(req, res) {
    const path = String(req.url || '').split('?')[0];
    if (!path.startsWith(API)) return;
    try {
      if (req.method === 'GET' && path === API + '/status') return sendJson(res, 200, buildStatus(options.getConfig, options));
      if (req.method === 'GET' && path === API + '/config') return sendJson(res, 200, { ok: true, config: sanitizedLiveConfig(readJson(liveConfigPath(options), {})) });
      if (req.method === 'POST' && path === API + '/config') {
        const result = saveLiveConfig(await readBody(req), options);
        return sendJson(res, result.status || 200, result);
      }
      if (req.method === 'POST' && path === API + '/endpoint-config') {
        const result = saveEndpointOverrides(await readBody(req), options);
        return sendJson(res, result.status || 200, result);
      }
      if (req.method === 'POST' && path === API + '/test-connect') {
        const body = await readBody(req);
        return sendJson(res, 200, await testConnectivity(String(body.target || ''), options.getConfig, options));
      }
      return sendJson(res, 404, { ok: false, error: 'Not found' });
    } catch (error) {
      return sendJson(res, error.message === 'payload too large' ? 413 : 400, { ok: false, error: '请求格式无效' });
    }
  };
}

export function mountMemoryDashboard(ctx, getConfig, options = {}) {
  if (!ctx || mounted.has(ctx)) return;
  mounted.add(ctx);
  try {
    ctx.inject(['webServer'], (webCtx) => {
      const handler = createDashboardHandler({ ...options, getConfig });
      // [2026-11-08 修复] 宿主 webServer.register 现在只接受 route 对象：{kind, path, handler}。
      //   旧的两参写法 register(API, handler) 在宿主里是无效调用 ⇒ 路由没挂上 ⇒ 前端「无连接」。
      webCtx.effect(
        () => webCtx.webServer.register({ kind: 'prefix', path: API, handler }),
        'unified-memory: 记忆中枢 API',
      );
    });
  } catch { /* headless / 精简测试环境不挂网页，不影响记忆主功能 */ }
}
