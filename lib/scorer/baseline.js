/**
 * baseline 打分器：零依赖，char-bigram 词面重合 + importance + recency。
 * 契约（Scorer）：score(query, candidates) → Map<id, number[0,1]>
 * 期1 只做「够用」的基线，期3 再上 BM25/向量。
 */
const CJK = /[\u4e00-\u9fff]/;

function bigrams(text) {
  const s = String(text || '').toLowerCase().replace(/\s+/g, '');
  const out = new Set();
  for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2));
  return out;
}

function overlap(a, b) {
  if (!a.size || !b.size) return 0;
  let hit = 0;
  for (const g of a) if (b.has(g)) hit++;
  return hit / Math.min(a.size, b.size);
}

export function createScorer(opts = {}) {
  const wLex = opts.wLex ?? 0.6;
  const wImp = opts.wImp ?? 0.25;
  const wRec = opts.wRec ?? 0.15;
  const now = () => Date.now();
  const halfLifeMs = opts.halfLifeMs ?? 30 * 24 * 3600 * 1000;

  return {
    kind: 'baseline',

    score(query, candidates) {
      const qg = bigrams(query);
      const t = now();
      const out = new Map();
      for (const c of candidates || []) {
        const text = [c.title, c.summary, c.content].filter(Boolean).join(' ');
        const lex = overlap(qg, bigrams(text));
        const imp = Math.max(0, Math.min(1, Number(c.importance ?? 0.5)));
        const age = c.createdAt ? Math.max(0, t - c.createdAt) : halfLifeMs;
        const rec = Math.pow(0.5, age / halfLifeMs);
        const s = wLex * lex + wImp * imp + wRec * rec;
        out.set(c.id, Math.max(0, Math.min(1, s)));
      }
      return out;
    },
  };
}
