/**
 * lib/retrieval/source-tracer.js —— 记忆原始卷宗回溯电梯
 * [2026-10-25 by Assistant · 红白双队终裁方案正式实装]
 *
 * 作用：打通 L1（提炼卡片）到 L2（原始会话录像带）的最后一公里。
 * 当用户或Assistant在 memory_get 看到卡片摘要过短、需要查阅万字表格/代码/现场细节时，
 * 顺着卡片绑定的 sessionId 直接流式解压/检索原始会话切片，200ms 内优雅直达。
 * 消除双层静默吞错，提供结构化 sourceTrace 状态对象。
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
// [2026-10-26 · 字段口径统一] 归属会话只认这一份判据
import { sessionIdOf } from '../card-session.js';
// [2026-10-31 · 二级降级] 一级精确取：按 source_message_ids 直接拿原文
import { lookupMany as lookupVerbatim } from '../ingest/verbatim-lookup.js';
import { dataPath } from '../paths.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ZSTD_EXTRACT_PY = join(__dirname, 'zstd-extract.py');
const CONV_DIR = dataPath('ingest/conversations');

/**
 * 统一来源解析器：按优先级收敛识别卡片来源
 * @param {object} card 
 * @returns {{ resolved: boolean, sessionId: string|null, kind: string, messageIds?: string[] }}
 */
export function resolveSourceRef(card) {
  if (!card || typeof card !== 'object') {
    return { resolved: false, sessionId: null, kind: 'none' };
  }
  // ══ [2026-10-31 · 二级降级] message_ids 优先，sessionId 兜底 ══
  //   业主定调：「改走二级降级肯定比一次跑两个好」。
  //
  //   病灶（改前）：sessionId 分支在前 ⇒ 新卡 100% 有 sessionId ⇒
  //     source_message_ids 是**死分支**，一次都没跑过（新增的锚点白加）。
  //
  //   现在：
  //     一级 message_ids —— 按 id 精确取原文（不用猜关键词，最准最快）
  //     二级 sessionId   —— grep 关键词模糊搜（旧卡 / 锚点丢失时兜底）
  //
  //   ⛔ 一次只跑一条路：一级命中就返回，失败才降级。绝不两条并跑。
  const msgIds = Array.isArray(card.source_message_ids) && card.source_message_ids.length
    ? card.source_message_ids.map(String).filter(Boolean)
    : [];
  const sid = sessionIdOf(card);
  if (msgIds.length) {
    // 一级：带 id 就报 id（同时把 sessionId 一并带上，供降级时使用）
    return { resolved: true, sessionId: sid || null, messageIds: msgIds, kind: 'message_ids' };
  }
  if (sid) {
    return { resolved: true, sessionId: sid, kind: 'session' };
  }
  return { resolved: false, sessionId: null, kind: 'legacy_unresolved' };
}

/**
 * 在卡片关联的会话原始记录中检索关键词/正则切片，返回结构化回溯结果
 * @param {{ sessionId?: string, grep: string, maxSnippets?: number, snippetMaxChars?: number, timeoutMs?: number }} opts
 * @returns {{
 *   status: 'hit' | 'no_match' | 'no_session_id' | 'not_found' | 'backend_error' | 'timeout',
 *   sessionId: string | null,
 *   backend: 'plain-jsonl' | 'zstd-archive' | null,
 *   matches: number,
 *   elapsedMs: number,
 *   truncated: boolean,
 *   error: string | null,
 *   snippets: string[]
 * }}
 */
export function traceSourceSnippets({
  sessionId,
  messageIds,                 // [2026-10-31 · 二级降级] 一级精确取的指针
  grep,
  maxSnippets = 3,
  snippetMaxChars = 800,
  timeoutMs = 3500,
  convDir = CONV_DIR,
} = {}) {
  const t0 = Date.now();
  const sid = String(sessionId || '').trim();
  const pattern = String(grep || '').trim();
  const ids = Array.isArray(messageIds) ? messageIds.map(String).filter(Boolean) : [];
  // [2026-10-31] 上下限只算一次，一级/二级共用（避免两处各写一遍 = 两套口径）
  const maxN = Math.min(5, Math.max(1, Number(maxSnippets) || 3));
  const maxC = Math.min(1200, Math.max(100, Number(snippetMaxChars) || 800));

  // ══ 一级：按 message_ids 精确取原文（最快最准，不用猜关键词）══
  //   业主定调「走二级降级比一次跑两个好」：命中就返回，失败才往下走。
  if (ids.length) {
    try {
      const got = lookupVerbatim(ids);
      let reg0 = null;
      if (pattern) {
        try { reg0 = new RegExp(pattern, 'i'); }
        catch { reg0 = new RegExp(pattern.replace(/[.*+?^${}()|[]\]/g, '\\$&'), 'i'); }
      }
      const picked = [];
      let truncated0 = false;
      for (const id of ids) {
        const v = got[id];
        if (!v || !v.content) continue;
        const content = String(v.content).trim();
        if (!content) continue;
        // 传了 grep ⇒ 只在命中 id 里再筛；没传 ⇒ 全都要
        if (reg0 && !reg0.test(content)) continue;
        const roleName = v.role === 'user' ? 'User' : 'Assistant';
        if (content.length > maxC) {
          truncated0 = true;
          picked.push('[' + roleName + '原话] ' + content.slice(0, maxC) + ' ...[余下截断]');
        } else {
          picked.push('[' + roleName + '原话] ' + content);
        }
        if (picked.length >= maxN) break;
      }
      if (picked.length) {
        return {
          status: 'hit',
          sessionId: sid || null,
          backend: 'verbatim-index',
          matches: picked.length,
          elapsedMs: Date.now() - t0,
          truncated: truncated0,
          candidateTruncated: false,
          channelAError: null,
          error: null,
          snippets: picked,
        };
      }
      // 一级没命中 ⇒ **静默降级**，继续走现有的 grep / zstd 通道
    } catch { /* 一级异常不阻断降级 */ }
  }

  // 若无 sessionId，明确返回 no_session_id，不伪装空命中
  if (!sid) {
    return {
      status: 'no_session_id',
      sessionId: null,
      backend: null,
      matches: 0,
      elapsedMs: Date.now() - t0,
      truncated: false,
      error: '卡片未关联有效 sessionId，无法进入原始案卷',
      snippets: [],
    };
  }

  if (!pattern) {
    return {
      status: 'no_match',
      sessionId: sid,
      backend: null,
      matches: 0,
      elapsedMs: Date.now() - t0,
      truncated: false,
      error: '检索关键词为空',
      snippets: [],
    };
  }

  const snippets = [];
  let hasTruncated = false;

  let reg = null;
  try {
    reg = new RegExp(pattern, 'i');
  } catch {
    reg = new RegExp(pattern.replace(/[.*+?^$\{}()|[\]\\]/g, '\\$&'), 'i');
  }

  let plainFoundSession = false;
  let channelAError = null;

  // ── 通道 A：本地活跃纯文本会话池（ingest/conversations/*.jsonl）──
  // [收尾修复 4] 单文件体积预检（>5MB 跳过防 OOM）+ 1500ms 超时预算
  const plainBudgetMs = 1500;
  const maxFileBytes = 5 * 1024 * 1024;
  const activeConvDir = convDir || CONV_DIR;
  if (existsSync(activeConvDir)) {
    try {
      const files = readdirSync(activeConvDir).filter((f) => f.endsWith('.jsonl')).sort().reverse();
      for (const f of files) {
        if (snippets.length >= maxN || (Date.now() - t0) > plainBudgetMs) break;
        const filePath = join(activeConvDir, f);
        try {
          const st = statSync(filePath);
          if (st.size > maxFileBytes) {
            channelAError = 'file_exceeds_max_size: ' + f + ' (' + st.size + 'B)';
            continue;
          }
        } catch (stErr) {
          channelAError = 'stat_failed: ' + f + ' (' + String(stErr && stErr.message || stErr) + ')';
          continue;
        }
        const raw = readFileSync(filePath, 'utf8');
        for (const line of raw.split('\n')) {
          if ((Date.now() - t0) > plainBudgetMs) break;
          if (!line || !line.includes(sid)) continue;
          let o; try { o = JSON.parse(line); } catch { continue; }
          const sKey = String(o.sessionKey || o.sessionId || '');
          if (sKey !== sid && !sKey.includes(sid) && !sid.includes(sKey)) continue;
          plainFoundSession = true;
          const content = String(o.content || '').trim();
          if (content && reg.test(content)) {
            const roleName = o.role === 'user' ? 'User' : 'Assistant';
            if (content.length > maxC) {
              hasTruncated = true;
              snippets.push('[' + roleName + '原话] ' + content.slice(0, maxC) + ' ...[余下截断]');
            } else {
              snippets.push('[' + roleName + '原话] ' + content);
            }
            if (snippets.length >= maxN) break;
          }
        }
      }
    } catch (e) {
      channelAError = String(e && e.message || e);
    }
  }

  if (snippets.length > 0) {
    return {
      status: 'hit',
      sessionId: sid,
      backend: 'plain-jsonl',
      matches: snippets.length,
      elapsedMs: Date.now() - t0,
      truncated: hasTruncated,
      candidateTruncated: false,
      channelAError: channelAError || null,
      error: null,
      snippets,
    };
  }

  // ── 通道 B：若文本会话池未命中，调用 zstd-extract.py 流式扫描 .dsh/sessions/ 归档 ──
  if (existsSync(ZSTD_EXTRACT_PY)) {
    try {
      const outJson = execFileSync('python', [
        ZSTD_EXTRACT_PY,
        sid,
        pattern,
        String(maxN),
        String(maxC),
      ], {
        encoding: 'utf8',
        timeout: timeoutMs,
      });

      let resObj = null;
      try {
        resObj = JSON.parse(outJson.trim());
      } catch (err) {
        return {
          status: 'backend_error',
          sessionId: sid,
          backend: 'zstd-archive',
          matches: 0,
          elapsedMs: Date.now() - t0,
          truncated: false,
          error: '解压器输出非合法 JSON: ' + String(err.message),
          snippets: [],
        };
      }

      return {
        status: resObj.status || (resObj.snippets && resObj.snippets.length ? 'hit' : 'no_match'),
        sessionId: sid,
        backend: 'zstd-archive',
        matches: Number(resObj.matches) || (resObj.snippets ? resObj.snippets.length : 0),
        elapsedMs: Date.now() - t0,
        truncated: Boolean(resObj.truncated),
        candidateTruncated: Boolean(resObj.candidateTruncated),
        channelAError: channelAError || null,
        error: resObj.error || null,
        snippets: Array.isArray(resObj.snippets) ? resObj.snippets : [],
      };
    } catch (e) {
      const isTimeout = e && (e.code === 'ETIMEDOUT' || String(e.message).includes('timed out'));
      return {
        status: isTimeout ? 'timeout' : 'backend_error',
        sessionId: sid,
        backend: 'zstd-archive',
        matches: 0,
        elapsedMs: Date.now() - t0,
        truncated: false,
        error: isTimeout ? ('案卷回溯超时（超过 ' + timeoutMs + 'ms）') : String(e && e.message || e),
        snippets: [],
      };
    }
  }

  return {
    status: channelAError ? 'backend_error' : (plainFoundSession ? 'no_match' : 'not_found'),
    sessionId: sid,
    backend: plainFoundSession ? 'plain-jsonl' : null,
    matches: 0,
    elapsedMs: Date.now() - t0,
    truncated: false,
    candidateTruncated: false,
    channelAError: channelAError || null,
    error: channelAError || (plainFoundSession ? null : '未找到会话归档文件'),
    snippets: [],
  };
}
