import { existsSync, readFileSync, statSync } from 'node:fs';
import { dataPath } from '../paths.js';

/**
 * EngramBackend —— 统一大脑只读适配器（期1 版）。
 * 期1 范围：只做 health()；recall() 明确 throw not-implemented
 *   ⇒ 由 orchestrator 自动降到下一级（设计好的降级链，不是故障）。
 * 铁律：绝不写 engrams.jsonl。
 */
// [2026-10-22 by Assistant · 交接文档坑5 修复] 与 retriever 统一指向 live（期5 迁移后的真身）。
export const DEFAULT_ENGRAM_PATH = dataPath('engram-relay/engrams.jsonl');

export function createEngramBackend(opts = {}) {
  const file = opts.file || DEFAULT_ENGRAM_PATH;

  return {
    id: 'engram',
    readOnly: true,
    /** 期1 明确未实现检索：健康≠可用，调度器要据此降级 */
    recallImplemented: false,

    health() {
      if (!existsSync(file)) return { ok: false, reason: 'not-found', file };
      try {
        const st = statSync(file);
        const raw = readFileSync(file, 'utf8');
        const firstLine = raw.split('\n', 1)[0];
        let firstOk = false;
        try { JSON.parse(firstLine); firstOk = true; } catch {}
        const lines = raw.split('\n').filter(Boolean).length;
        return { ok: firstOk, file, bytes: st.size, lines, firstLineParses: firstOk };
      } catch (e) {
        return { ok: false, reason: String(e?.message || e), file };
      }
    },

    recall() { throw new Error('engram: not-implemented in phase 1'); },
  };
}
