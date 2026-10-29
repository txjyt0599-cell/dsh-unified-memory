/**
 * retrieval/embed-fallback-server.js —— 本地 bge-m3 向量备路【自管生命周期】
 * [2026-10-26 by Assistant · 回应终审 P1「运行态不通过」]
 *
 * ## 为什么需要这个文件（终审抓到的真问题）
 *
 * 备路配了 `http://127.0.0.1:<PORT>/v1`（llama-swap），但**llama-swap 代理进程被杀掉后没人拉起**：
 *   · 日志里没有 shutdown/exit/error，只有两条 listening 横幅 ⇒ 进程被外部终止
 *   · 8013/8081 都不监听 ⇒ 备路成了死配置，主路一挂就彻底黑掉
 *
 * User 2026-09-22 定过硬要求（原话 emuc2dk8w-w）：
 *   「我做的是 dsh 插件，你给我要手动启动的脚本，设计有问题。功能要内置在插件里。」
 *   ⇒ **插件能力所需的外部服务，由插件自己负责拉起。**
 *
 * ## 设计（照抄 startlux-rerank.js 已验证的模式）
 *   1. 零常驻：平时不占资源，需要时秒级拉起
 *   2. 复用优先：若端口已有服务（外部启动/上次没死），直接复用，不重复拉
 *   3. 单飞：并发调用共享同一个启动 Promise，不会拉出多个进程
 *   4. 空闲自杀：一段时间没人用就关掉，释放显存
 *   5. 失败安全：文件缺失/超时/拉不起来 ⇒ 返回 ok:false，调用方退回纯 BM25（绝不抛）
 *
 * ## 与 llama-swap 的关系
 *   两种部署都能工作：
 *     · 若 llama-swap 活着且端口可响应 → reused:true，本模块不介入
 *     · 若 llama-swap 死了 → 本模块**直连 8013** 拉起 llama-server 顶上
 *   ⇒ 备路从此不依赖那个"会被杀掉的代理进程"。
 */
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';

export const DEFAULT_LLAMA_SERVER = 'E:/AI/llamacpp-rocm-b1322/llama-server.exe';
export const DEFAULT_EMBED_MODEL = 'E:/AI/models/bge-m3-q8_0.gguf';
export const DEFAULT_EMBED_PORT = 8013;
export const DEFAULT_IDLE_SHUTDOWN_MS = 10 * 60 * 1000;   // 空闲 10 分钟关闭（向量调用没 rerank 那么频繁）

let activeServerProcess = null;
let idleTimer = null;
let isStarting = null;

export function isEmbedServerAvailable(opts) {
  const srv = (opts && opts.serverBin) || DEFAULT_LLAMA_SERVER;
  const mdl = (opts && opts.modelPath) || DEFAULT_EMBED_MODEL;
  return existsSync(srv) && existsSync(mdl);
}

function clearIdleTimer() {
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
}

export function stopEmbedServer() {
  clearIdleTimer();
  if (activeServerProcess) {
    try { activeServerProcess.kill(); } catch {}
    activeServerProcess = null;
  }
}

function scheduleIdleShutdown(ms) {
  clearIdleTimer();
  const timeout = Number.isFinite(Number(ms)) ? Number(ms) : DEFAULT_IDLE_SHUTDOWN_MS;
  if (timeout <= 0) { stopEmbedServer(); return; }
  idleTimer = setTimeout(() => { stopEmbedServer(); }, timeout);
  if (idleTimer.unref) idleTimer.unref();
}

/** 探活：/v1/models 或 /health 任一可响应即视为就绪。 */
async function probeServer(port, timeoutMs) {
  const t = Number(timeoutMs) || 500;
  for (const path of ['/health', '/v1/models']) {
    try {
      const res = await fetch('http://127.0.0.1:' + port + path, { signal: AbortSignal.timeout(t) });
      if (res.ok) return true;
    } catch {}
  }
  return false;
}

/**
 * 确保本地 embedding 服务在跑。
 * @returns {Promise<{ok:boolean, reused?:boolean, ms?:number, error?:string}>}
 */
export async function ensureEmbedServer(opts) {
  const o = opts || {};
  const port = Number(o.port) || DEFAULT_EMBED_PORT;
  const readyTimeoutMs = Number(o.readyTimeoutMs) || 20000;

  // 1) 已有服务（llama-swap 活着 / 上次没死）⇒ 直接复用
  if (await probeServer(port, 400)) return { ok: true, reused: true };
  // 2) 正在启动 ⇒ 复用同一个 Promise（单飞）
  if (isStarting) return isStarting;

  isStarting = (async () => {
    try {
      const srv = o.serverBin || DEFAULT_LLAMA_SERVER;
      const mdl = o.modelPath || DEFAULT_EMBED_MODEL;
      const ctx = Number(o.contextSize) || 512;
      if (!existsSync(srv) || !existsSync(mdl)) {
        return { ok: false, error: 'files-missing', srv: existsSync(srv), mdl: existsSync(mdl) };
      }
      clearIdleTimer();
      stopEmbedServer();

      // 关键：--embeddings + --pooling cls（bge-m3 的正确池化），-ngl 999 走 GPU
      const child = spawn(srv, [
        '-m', mdl,
        '--embeddings',
        '--pooling', 'cls',
        '--host', '127.0.0.1',
        '--port', String(port),
        '-c', String(ctx),
        '-ngl', '999',
        '--no-webui',
      ], { windowsHide: true, stdio: 'ignore' });

      activeServerProcess = child;
      child.on('exit', () => { if (activeServerProcess === child) activeServerProcess = null; });
      child.on('error', () => { if (activeServerProcess === child) activeServerProcess = null; });

      const t0 = Date.now();
      let ready = false;
      while (Date.now() - t0 < readyTimeoutMs) {
        await new Promise((r) => setTimeout(r, 150));
        if (await probeServer(port, 300)) { ready = true; break; }
      }
      if (!ready) {
        stopEmbedServer();
        return { ok: false, error: 'timeout', ms: Date.now() - t0 };
      }
      return { ok: true, reused: false, ms: Date.now() - t0 };
    } catch (e) {
      return { ok: false, error: String(e && e.message || e) };
    } finally {
      isStarting = null;
    }
  })();

  return isStarting;
}

/** 每次成功用完后调用，重置空闲计时。 */
export function touchEmbedServer(idleMs) {
  scheduleIdleShutdown(idleMs);
}
