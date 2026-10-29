/**
 * alias.js —— 必中通道词表 + 熔断规则。只读旁挂 triggers 文件，绝不写库。
 * 依据：DESIGN §1.4 / §0.6 / §3.6 验收 F。
 *
 * 核心结论（实测）：
 *   · minChars=2 单独用是废的（30 条闲聊误触发 15 次）
 *   · 主熔断是「>=2 个不同词命中」（15 -> 2）
 *   · 纯领域词（拉丁/数字标识符）保留单词豁免（实测闲聊里出现 0 次，成本为 0）
 */

import { readFileSync, existsSync } from 'node:fs';
import { ALIAS_RULES, STOPWORDS, isDomainTerm } from './types.js';
import { createTokenizer } from './tokenize.js';

/** 词表内部数据（WeakMap，不导出） */
const HIDDEN = new WeakMap();

/** 用于词表匹配的分词器：segment 能出多字词，bigram 补 2 字词 */
const segTok = createTokenizer({ mode: 'segment' });
const biTok = createTokenizer({ mode: 'bigram' });

function charLen(s) {
  let n = 0;
  for (const _ of s) n++;
  return n;
}

/**
 * 从 triggers 旁挂文件建词表（只读）。
 *
 * @param {{previewPath:string, minChars?:number, maxDf?:number, stopwords?:Set<string>}} opts
 */
export function createAliasIndex(opts) {
  const minChars = opts && opts.minChars !== undefined ? opts.minChars : ALIAS_RULES.minChars;
  const maxDf = opts && opts.maxDf !== undefined ? opts.maxDf : ALIAS_RULES.maxDf;
  const extraStop = (opts && opts.stopwords) || null;
  const path = opts && opts.previewPath;

  const map = new Map();          // term -> string[] (docIds)
  const truncated = [];           // 因 df > maxDf 被剔除的词
  const seenCard = new Set();
  let maxDfSeen = 0;
  let records = 0;
  let readError = null;

  if (!path || !existsSync(path)) {
    readError = 'preview-not-found: ' + String(path);
  } else {
    let raw = '';
    try { raw = readFileSync(path, 'utf8'); } catch (e) { readError = String(e && e.message || e); }
    if (!readError) {
      for (const line of raw.split('\n')) {
        if (!line) continue;
        let rec;
        try { rec = JSON.parse(line); } catch { continue; }
        const id = rec && rec.id;
        if (!id) continue;
        records++;
        seenCard.add(id);
        for (const t of (rec.triggers || [])) {
          const k = String(t).toLowerCase().trim();
          if (!k) continue;
          if (charLen(k) < minChars) continue;
          if (extraStop && extraStop.has(k)) continue;
          let arr = map.get(k);
          if (arr === undefined) { arr = []; map.set(k, arr); }
          arr.push(id);
        }
      }
    }
  }

  for (const [k, arr] of map) {
    if (arr.length > maxDf) { truncated.push(k); }
    if (arr.length > maxDfSeen) maxDfSeen = arr.length;
  }

  const idx = {
    size: map.size,
    coverage: seenCard.size,
    maxDf: maxDfSeen,
    truncatedTerms: truncated,
    records,
    path: path || null,
    error: readError,
  };
  HIDDEN.set(idx, map);
  return idx;
}

function termsOf(idx, query) {
  const map = HIDDEN.get(idx);
  if (!map) throw new Error('matchAlias: 传入的不是 createAliasIndex 的返回值');
  const cands = new Set();
  // segment：多字词
  for (const w of segTok.tokenize(query)) cands.add(w);
  // bigram：补 2 字词（triggers 里 2 字词占 41.8%）
  for (const w of biTok.tokenize(query)) cands.add(w);
  const hits = [];
  for (const w of cands) {
    if (charLen(w) < ALIAS_RULES.minChars) continue;
    const docs = map.get(w);
    if (docs === undefined) continue;
    hits.push({ term: w, docs, df: docs.length, isDomain: isDomainTerm(w) });
  }
  return hits;
}

/**
 * 匹配。熔断规则写在返回值里，由调用方决定怎么用（DESIGN §1.4）。
 *
 * @param {object} idx
 * @param {string} query
 * @param {object} [tok]  兼容入参（词表匹配不依赖它，见 termsOf）
 * @param {{minDistinctHits?:number,domainBypass?:boolean,dropStopwords?:boolean,maxResults?:number}} [opts]
 */
export function matchAlias(idx, query, tok, opts) {
  const minDistinct = opts && opts.minDistinctHits !== undefined ? opts.minDistinctHits : ALIAS_RULES.minDistinctHits;
  const domainBypass = opts && opts.domainBypass !== undefined ? opts.domainBypass : ALIAS_RULES.domainBypass;
  const dropStop = opts && opts.dropStopwords !== undefined ? opts.dropStopwords : true;
  const maxResults = opts && opts.maxResults !== undefined ? opts.maxResults : ALIAS_RULES.maxResults;

  const empty = { confident: false, matchedTerms: [], docs: [], reason: 'no-term', blockedTerms: [] };

  if (!idx || idx.error === 'preview-not-found' || idx.size === 0) {
    return Object.assign({}, empty, { reason: idx && idx.error ? idx.error : 'empty-alias' });
  }

  const raw = termsOf(idx, query);
  if (!raw.length) return empty;

  // 停用词过滤（只服务 alias；BM25 不需要）
  const blocked = [];
  const kept = [];
  for (const h of raw) {
    if (dropStop && STOPWORDS.has(h.term) && !h.isDomain) { blocked.push(h.term); continue; }
    kept.push(h);
  }
  if (!kept.length) {
    return { confident: false, matchedTerms: [], docs: [], reason: 'all-stopwords', blockedTerms: blocked };
  }

  // 熔断判定（DESIGN §1.4 规则 A/B/C）
  const distinct = new Set(kept.map(function (h) { return h.term; })).size;
  const hasDomain = kept.some(function (h) { return h.isDomain; });
  let confident = false;
  let reason = null;
  if (distinct >= minDistinct) confident = true;
  else if (domainBypass && hasDomain) confident = true;
  else reason = 'too-few-hits';

  // 候选卡：按 1/ln(2+df) 加权（df 越小越可信），同卡多词累加
  const score = new Map();
  for (const h of kept) {
    const w = 1 / Math.log(2 + h.df);
    for (const id of h.docs) score.set(id, (score.get(id) || 0) + w);
  }
  const docs = Array.from(score.entries())
    .sort(function (a, b) { return b[1] - a[1]; })
    .slice(0, maxResults);

  return {
    confident,
    matchedTerms: kept.map(function (h) { return h.term; }),
    docs,
    reason,
    blockedTerms: blocked,
  };
}

/** 词表健康（进 retriever.health()） */
export function aliasHealth(idx, aliveCards) {
  if (!idx) return { ready: false, size: 0, coverage: 0, reason: 'not-loaded' };
  const ratio = aliveCards > 0 ? idx.coverage / aliveCards : 0;
  const stale = ratio < 0.60;
  return {
    ready: idx.size > 0 && !stale,
    size: idx.size,
    coverage: idx.coverage,
    coverageRatio: Number(ratio.toFixed(4)),
    maxDf: idx.maxDf,
    stale,
    reason: idx.error || (stale ? 'alias-stale' : null),
  };
}

export default { createAliasIndex, matchAlias, aliasHealth };
