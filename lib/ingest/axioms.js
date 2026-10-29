/**
 * [2026-10-23 by Assistant · 红队修正3：安全公理晋升（Staging Axioms）]
 *
 * 铁律（守护 99.7% Prefix Cache）：
 *   **当前正在进行的对话中，严禁修改 System Prompt 的任何一个字节。**
 *   公理只进 axioms_pending.jsonl，在下一次冷启动/新 Session 时才合入。
 *
 * 晋升条件（红队版，比白队严格）：
 *   · hits >= 8
 *   · confidence >= 0.9
 *   · 跨越 >= 3 个不同 session
 *   · 且**不含机器来源**的刷票
 *
 * 合入后：L1 卡打 status = 'solidified_to_axiom'，从 RRF 检索池退役
 *   （它已永远活在 System Prompt 里，不该再占 Top5 座位）。
 */
import { readFileSync, writeFileSync, existsSync, appendFileSync, mkdirSync } from 'node:fs';
import { dataPath } from '../paths.js';

export const AXIOM_RULES = Object.freeze({
  MIN_HITS: 8,
  MIN_CONFIDENCE: 0.9,
  MIN_SESSIONS: 3,
});

const dirOf = (p) => String(p || '').replace(/[\\/][^\\/]*$/, '');
const readJsonl = (p) => {
  try { return readFileSync(p, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); }
  catch (e) { return []; }
};

/** 判断一张卡是否够格晋升为公理 */
export function qualifiesAsAxiom(card) {
  if (!card) return { ok: false, reason: 'no-card' };
  const hits = Number(card.hits) || 0;
  const conf = Number(card.confidence) || 0;
  const sessions = Array.isArray(card.session_keys) ? card.session_keys.length
    : (card.last_session ? 1 : 0);

  if (hits < AXIOM_RULES.MIN_HITS) return { ok: false, reason: 'hits<' + AXIOM_RULES.MIN_HITS, hits, conf, sessions };
  if (conf < AXIOM_RULES.MIN_CONFIDENCE) return { ok: false, reason: 'conf<' + AXIOM_RULES.MIN_CONFIDENCE, hits, conf, sessions };
  if (sessions < AXIOM_RULES.MIN_SESSIONS) return { ok: false, reason: 'sessions<' + AXIOM_RULES.MIN_SESSIONS, hits, conf, sessions };
  if (String(card.sourceType || '') === 'system_log') return { ok: false, reason: 'machine-source-never-axiom' };
  return { ok: true, hits, conf, sessions };
}

/**
 * 把够格的卡写入待审池（**不碰 System Prompt**）。
 * @returns {{ staged: number, path: string }}
 */
export function stageAxioms(cards, pendingPath) {
  const p = pendingPath || dataPath('axioms_pending.jsonl');
  try { mkdirSync(dirOf(p), { recursive: true }); } catch (e) {}

  const existing = new Set(readJsonl(p).map(x => String(x.id)));
  let staged = 0;
  for (const c of (Array.isArray(cards) ? cards : [])) {
    const q = qualifiesAsAxiom(c);
    if (!q.ok) continue;
    const id = String(c && c.id || '');
    if (!id || existing.has(id)) continue;
    const line = JSON.stringify({
      id,
      title: String(c.title || ''),
      text: String(c.content || c.summary || '').slice(0, 400),
      hits: q.hits,
      confidence: q.conf,
      sessions: q.sessions,
      stagedAt: new Date().toISOString(),
      status: 'pending',
    });
    try { appendFileSync(p, line + '\n', 'utf8'); staged++; existing.add(id); } catch (e) {}
  }
  return { staged, path: p };
}

/**
 * 冷启动时调用：读出待审公理 + 返回应退役的卡 id 列表。
 * **只在进程启动 / 新 Session 首次装配时调用**，绝不在中途调用。
 */
export function consumeAxioms(pendingPath) {
  const p = pendingPath || dataPath('axioms_pending.jsonl');
  if (!existsSync(p)) return { axioms: [], retireIds: [] };
  const all = readJsonl(p);
  const pending = all.filter(x => x.status === 'pending');
  return {
    axioms: pending.map(x => ({ id: x.id, title: x.title, text: x.text })),
    retireIds: pending.map(x => String(x.id)),
  };
}

/** 撤销公理：从待审池标记 revoked（配合对话指令「撤销公理：xxx」） */
export function revokeAxiom(pendingPath, idOrTitle) {
  const p = pendingPath || dataPath('axioms_pending.jsonl');
  if (!existsSync(p)) return { revoked: 0 };
  const all = readJsonl(p);
  let n = 0;
  for (const a of all) {
    if (a.status !== 'pending') continue;
    if (String(a.id) === String(idOrTitle) || String(a.title).includes(String(idOrTitle))) {
      a.status = 'revoked'; a.revokedAt = new Date().toISOString(); n++;
    }
  }
  if (n > 0) writeFileSync(p, all.map(x => JSON.stringify(x)).join('\n') + '\n', 'utf8');
  return { revoked: n };
}

export default { AXIOM_RULES, qualifiesAsAxiom, stageAxioms, consumeAxioms, revokeAxiom };
