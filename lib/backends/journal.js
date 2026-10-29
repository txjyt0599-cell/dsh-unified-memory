import { existsSync, readFileSync, statSync } from 'node:fs';
import { diaryRoot, normalize } from '../paths.js';

/**
 * JournalBackend —— 日记**只读**后端（期1 版）。
 * 铁律：
 *  - 只 open('r') + read，绝不写（写只能由User/Assistant自己用 write 工具）
 *  - 日记是「内心悄悄话」，**不参与检索、不拆成记忆卡**
 *  - 期1 只提供 health() 与 readRaw()，不提供 recall（不检索）
 */
export const DEFAULT_JOURNAL_PATHS = [
  normalize(diaryRoot() + '/Assistant日记.md'),
];

export function createJournalBackend(opts = {}) {
  const paths = opts.paths || DEFAULT_JOURNAL_PATHS;
  const readOnly = true;

  function pick() {
    for (const p of paths) {
      try { if (existsSync(p)) return p; } catch {}
    }
    return null;
  }

  return {
    id: 'journal',
    readOnly,

    /** 健康检查：文件在不在、多大、mtime */
    health() {
      const file = pick();
      if (!file) return { ok: false, reason: 'not-found', paths };
      try {
        const st = statSync(file);
        return { ok: true, file, bytes: st.size, mtime: st.mtimeMs };
      } catch (e) {
        return { ok: false, reason: String(e?.message || e), file };
      }
    },

    /** 只读直读（给User看 / Assistant念出来用）——**不参与注入** */
    readRaw({ maxChars = 20000 } = {}) {
      const file = pick();
      if (!file) return { ok: false, reason: 'not-found' };
      try {
        const text = readFileSync(file, 'utf8');
        return { ok: true, file, text: text.slice(0, maxChars), truncated: text.length > maxChars };
      } catch (e) {
        return { ok: false, reason: String(e?.message || e) };
      }
    },

    /** 明确没有检索能力——这是设计，不是缺陷 */
    recall() { throw new Error('journal: recall is intentionally unsupported (日记不参与检索)'); },
  };
}
