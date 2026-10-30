import { HARD } from './types.js';

/**
 * Episode 切分（纯函数，不碰磁盘、不调 LLM）。
 * 四步（顺序不能换）：
 *   ① 桶 = sessionId + '#' + floor(turn / windowTurns)
 *   ② 桶内按 createdAt 升序（同 ms 按 id 字典序）
 *   ③ 相邻卡 gap > 30min ⇒ 断开
 *   ④ 单集 > 24 卡 ⇒ 按序切成 ⌈n/24⌉ 片
 */
export function splitEpisodes(cards, opts = {}) {
  const o = { ...HARD, ...opts };
  const windowTurns = o.WINDOW_TURNS ?? opts.windowTurns ?? 8;
  const gapMs = o.GAP_MS ?? opts.gapMs ?? 30 * 60 * 1000;
  const capCards = o.CAP_CARDS ?? opts.capCards ?? 24;

  // ① 桶
  const buckets = new Map();
  for (const c of cards) {
    if (!c || !c.id) continue;
    const s = c.sessionId || '';
    const t = Number.isFinite(c.turn) ? c.turn : 0;
    const key = s + '#' + Math.floor(t / windowTurns);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(c);
  }

  // ② 排序 + ③ 断点
  const raw = [];
  for (const [key, arr] of buckets) {
    arr.sort((a, b) => ((a.createdAt || 0) - (b.createdAt || 0)) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    let cur = [];
    const flush = () => { if (cur.length) { raw.push({ key, cards: cur }); cur = []; } };
    for (const c of arr) {
      const prev = cur[cur.length - 1];
      if (prev && (c.createdAt - prev.createdAt) > gapMs) flush();
      cur.push(c);
    }
    flush();
  }

  // ④ 上限
  const out = [];
  for (const g of raw) {
    const n = g.cards.length;
    const k = Math.ceil(n / capCards);
    const base = Math.floor(n / k), rem = n % k;
    let off = 0;
    for (let i = 0; i < k; i++) {
      const sz = base + (i < rem ? 1 : 0);
      const slice = g.cards.slice(off, off + sz);
      off += sz;
      out.push({
        // id 必须全局唯一：sessionId 为空的卡会共用桶 key，只靠 key+i 会撞车
        id: 'ep:' + g.key + ':' + i + ':' + (slice[0].createdAt || 0),
        sessionId: slice[0].sessionId || '',
        cardIds: slice.map(c => c.id),
        startAt: slice[0].createdAt || 0,
        endAt: slice[slice.length - 1].createdAt || 0,
        projectId: slice[0].projectId ?? null,
        completeness: null,   // 由 applyCompletenessPenalty 填
        weightScale: 1,
      });
    }
  }
  return out;
}

/** 只保留 ≥3 卡的集（可造超边的候选） */
export function eligibleEpisodes(episodes) {
  return episodes.filter(e => e.cardIds.length >= HARD.MIN_MEMBERS);
}
