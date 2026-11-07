/**
 * retrieval/startlux-rerank.js —— 本地 StartLux-4B 决策模型按需精排（保底链路）
 * [2026-10-23 by Assistant]
 *
 * 核心设计：
 *   1. 【按需拉起，零常驻】：平时 0 显存占用，不占 GPU。触发时秒级拉起，执行完或空闲超时自动关闭释放。
 *   2. 【轻量上下文】：-c 1024（不用 8k），显存缩减至 ~2.6GB。
 *   3. 【极速判定】：关思考（enable_thinking: false），GPU 批量判 3~5 条候选仅需 ~500-750ms。
 *   4. 【容错降级】：模型文件缺失/超时/服务故障时安全降级，不阻断主检索流程。
 */
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';

export const DEFAULT_LLAMA_SERVER = 'E:/AI/llamacpp-rocm-b1322/llama-server.exe';
export const DEFAULT_STARTLUX_MODEL = 'E:/AI/models/StartLux-Decision-v1.1-4B-AutoThink-Q4_K_M.gguf';
export const DEFAULT_PORT = 8084;
export const DEFAULT_CONTEXT_SIZE = 1024;
export const DEFAULT_IDLE_SHUTDOWN_MS = 30000; // 空闲 30 秒自动杀进程释放显存

let activeServerProcess = null;
let idleTimer = null;
let isStarting = null;

export function isStartLuxAvailable(opts = {}) {
  const srv = opts.serverBin || DEFAULT_LLAMA_SERVER;
  const mdl = opts.modelPath || DEFAULT_STARTLUX_MODEL;
  return existsSync(srv) && existsSync(mdl);
}

function clearIdleTimer() {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
}

function scheduleIdleShutdown(ms) {
  clearIdleTimer();
  const timeout = Number.isFinite(Number(ms)) ? Number(ms) : DEFAULT_IDLE_SHUTDOWN_MS;
  if (timeout <= 0) {
    stopStartLuxServer();
    return;
  }
  idleTimer = setTimeout(() => {
    stopStartLuxServer();
  }, timeout);
  if (idleTimer.unref) idleTimer.unref();
}

export function stopStartLuxServer() {
  clearIdleTimer();
  if (activeServerProcess) {
    try {
      activeServerProcess.kill();
    } catch {}
    activeServerProcess = null;
  }
}

async function probeModelsEndpoint(port, timeoutMs = 400) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/models`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function ensureStartLuxServer(opts = {}) {
  const port = Number(opts.port) || DEFAULT_PORT;
  const readyTimeoutMs = Number(opts.readyTimeoutMs) || 6000;

  // 1. 若端点已有服务响应（外部启动或之前已启动），直接复用
  if (await probeModelsEndpoint(port, 400)) {
    return { ok: true, reused: true };
  }

  // 2. 如果正在启动中，等待现有启动 Promise
  if (isStarting) {
    return isStarting;
  }

  isStarting = (async () => {
    try {
      const srv = opts.serverBin || DEFAULT_LLAMA_SERVER;
      const mdl = opts.modelPath || DEFAULT_STARTLUX_MODEL;
      const ctxSize = Number(opts.contextSize) || DEFAULT_CONTEXT_SIZE;

      if (!existsSync(srv) || !existsSync(mdl)) {
        return { ok: false, error: 'files-missing', srv: existsSync(srv), mdl: existsSync(mdl) };
      }

      clearIdleTimer();
      stopStartLuxServer();

      const child = spawn(srv, [
        '-m', mdl,
        '--host', '127.0.0.1',
        '--port', String(port),
        '-ngl', '99',
        '-c', String(ctxSize),
        '--no-warmup',
      ], {
        windowsHide: true,
        stdio: 'ignore',
      });

      activeServerProcess = child;
      child.on('exit', () => {
        if (activeServerProcess === child) activeServerProcess = null;
      });

      const t0 = Date.now();
      let ready = false;
      while (Date.now() - t0 < readyTimeoutMs) {
        await new Promise((r) => setTimeout(r, 120));
        if (await probeModelsEndpoint(port, 300)) {
          ready = true;
          break;
        }
      }

      if (!ready) {
        stopStartLuxServer();
        return { ok: false, error: 'timeout', ms: Date.now() - t0 };
      }

      return { ok: true, reused: false, ms: Date.now() - t0 };
    } finally {
      isStarting = null;
    }
  })();

  return isStarting;
}

/**
 * 批量精排 L0 记忆候选
 * @param {string} query 用户问题
 * @param {Array<{id: string, text: string}>} candidates 候选列表
 * @param {object} opts
 * @returns {Promise<{ ok: boolean, relevantIds: Set<string>, judgments: Array<{id: string, relevant: boolean}>, ms: number }>}
 */
export async function rerankL0Candidates(query, candidates, opts = {}) {
  const t0 = Date.now();
  if (!candidates || candidates.length === 0) {
    return { ok: true, relevantIds: new Set(), judgments: [], ms: 0 };
  }

  const port = Number(opts.port) || DEFAULT_PORT;
  const autoShutdown = opts.autoShutdown !== false;
  const idleShutdownMs = opts.idleShutdownMs !== undefined ? Number(opts.idleShutdownMs) : DEFAULT_IDLE_SHUTDOWN_MS;

  const srvRes = await ensureStartLuxServer(opts);
  if (!srvRes.ok) {
    return { ok: false, relevantIds: new Set(candidates.map((c) => c.id)), judgments: [], error: srvRes.error, ms: Date.now() - t0 };
  }

  // 格式化提示词
  const candLines = candidates.map((c, i) => `[${i + 1}] id: ${c.id}\n内容: ${String(c.text || '').replace(/\s+/g, ' ').slice(0, 160)}`).join('\n\n');
  const prompt = [
    '请判断以下历史对话候选是否与用户当前的问题相关。严格只输出 JSON 数组，格式为：[{"id":"...", "relevant": true/false}]，禁止任何解释：',
    '',
    `用户问题: ${query}`,
    '',
    '候选列表:',
    candLines,
  ].join('\n');

  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'startlux',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 300,
        temperature: 0,
        chat_template_kwargs: { enable_thinking: false },
      }),
      signal: AbortSignal.timeout(Number(opts.queryTimeoutMs) || 5000),
    });

    if (!res.ok) {
      return { ok: false, relevantIds: new Set(candidates.map((c) => c.id)), judgments: [], error: 'http-' + res.status, ms: Date.now() - t0 };
    }

    const data = await res.json();
    const rawOut = String(data.choices?.[0]?.message?.content || '').trim();

    // 解析 JSON 数组
    const m = rawOut.match(/\[[\s\S]*\]/);
    let list = [];
    if (m) {
      try { list = JSON.parse(m[0]); } catch {}
    }

    const relevantIds = new Set();
    const judgments = [];
    for (const item of list) {
      if (item && item.id) {
        const isRel = item.relevant === true;
        judgments.push({ id: item.id, relevant: isRel });
        if (isRel) relevantIds.add(item.id);
      }
    }

    return {
      ok: true,
      relevantIds,
      judgments,
      ms: Date.now() - t0,
    };
  } catch (err) {
    return {
      ok: false,
      relevantIds: new Set(candidates.map((c) => c.id)),
      judgments: [],
      error: String(err?.message || err),
      ms: Date.now() - t0,
    };
  } finally {
    if (autoShutdown) {
      scheduleIdleShutdown(idleShutdownMs);
    }
  }
}
