/**
 * tokenize.js —— 双档分词器（bigram 默认 / segment 用 Intl.Segmenter）。
 * 依据：DESIGN §1.2 / §3.1 验收 A。
 * 铁律：**ASCII/数字标识符整词保留**（KVMem / v1.2.3 切碎会毁掉领域查询）。
 */

const SEG_CACHE = new Map();
function segFor(locale) {
  if (typeof Intl === 'undefined' || typeof Intl.Segmenter !== 'function') return null;
  if (!SEG_CACHE.has(locale)) SEG_CACHE.set(locale, new Intl.Segmenter(locale, { granularity: 'word' }));
  return SEG_CACHE.get(locale);
}

/** CJK 段（含扩展 A 与兼容区） */
const CJK_RUN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+/g;
const CJK_CH = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
const SINGLE_CJK_RE = /^[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]$/;
/** 标识符内的合法连接符：. _ - / （版本号、路径、文件名） */
const NON_CJK_RUN = /[^\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+/g;
const IDENT_SPLIT = /[^\p{L}\p{N}._\-\/]+/u;

/**
 * 把文本拆成两种段：CJK 连续段（逐字）与非 CJK 段（整词保留）。
 * 例：'KVMem 解码 v1.2.3' -> [{cjk:false,tok:'kvmem'},{cjk:true,tok:'解码'},{cjk:false,tok:'v1.2.3'}]
 */
function splitRuns(text) {
  const s = String(text || '');
  const runs = [];
  let last = 0;
  for (const m of s.matchAll(CJK_RUN)) {
    if (m.index > last) runs.push({ cjk: false, raw: s.slice(last, m.index) });
    runs.push({ cjk: true, raw: m[0] });
    last = m.index + m[0].length;
  }
  if (last < s.length) runs.push({ cjk: false, raw: s.slice(last) });
  return runs;
}

/** bigram：CJK 段二字滑窗；非 CJK 段按标识符整词（小写） */
function tokenizeBigram(text) {
  const out = [];
  for (const run of splitRuns(text)) {
    if (run.cjk) {
      const w = run.raw;
      if (w.length === 1) { out.push(w); continue; }
      for (let i = 0; i < w.length - 1; i++) out.push(w.slice(i, i + 2));
    } else {
      for (const id of run.raw.split(IDENT_SPLIT)) {
        if (id) out.push(id.toLowerCase());
      }
    }
  }
  return out;
}

/** segment：Intl.Segmenter 分词；单字 CJK 丢弃（噪声），非 CJK 仍整词（防 Segmenter 把 v1.2.3 拆开） */
function tokenizeSegment(text) {
  const seg = segFor('zh-CN');
  if (!seg) return tokenizeBigram(text);
  const out = [];
  for (const run of splitRuns(text)) {
    if (!run.cjk) {
      for (const id of run.raw.split(IDENT_SPLIT)) if (id) out.push(id.toLowerCase());
      continue;
    }
    for (const part of seg.segment(run.raw)) {
      if (!part.isWordLike) continue;
      const w = part.segment.toLowerCase();
      if (SINGLE_CJK_RE.test(w)) continue;
      out.push(w);
    }
  }
  return out;
}

/** char-unigram（只用于验收 D 的对比组，不参与生产路径） */
function tokenizeUnigram(text) {
  const out = [];
  for (const run of splitRuns(text)) {
    if (run.cjk) { for (const ch of run.raw) out.push(ch); }
    else { for (const id of run.raw.split(IDENT_SPLIT)) if (id) out.push(id.toLowerCase()); }
  }
  return out;
}

/**
 * 创建分词器。
 * @param {{mode?: 'bigram'|'segment'|'unigram'}} [opts]
 */
export function createTokenizer(opts) {
  const mode = (opts && opts.mode) || 'bigram';
  if (mode !== 'bigram' && mode !== 'segment' && mode !== 'unigram') {
    throw new Error('createTokenizer: 未知 mode ' + mode);
  }
  const fn = mode === 'segment' ? tokenizeSegment : mode === 'unigram' ? tokenizeUnigram : tokenizeBigram;
  return { mode, tokenize(text) { return fn(text); } };
}

export { tokenizeBigram, tokenizeSegment, tokenizeUnigram, splitRuns };
export default { createTokenizer, tokenizeBigram, tokenizeSegment, tokenizeUnigram, splitRuns };
