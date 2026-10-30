#!/usr/bin/env node
/**
 * selftest-bm25-roundtrip.mjs —— BM25 索引往返等价性验收
 * [2026-10-31 by Assistant · 红队三审批准的范围]
 *
 * ## 它证明什么
 *   「索引序列化 → 反序列化 → 重建」与「直接建索引」在**打分上完全等价**。
 *   这是任何索引缓存方案能被验收的前提。
 *
 * ## 红队三审的硬要求（每条都对应一个反例）
 *   ① 引用隔离：dump 出来的 postings/dfMap 必须与原件**不共享**
 *      —— 否则 A/B 是同一对象，"逐位一致"是自欺
 *   ② 严格校验：坏 N / 坏 docIdx / 坏 df / 坏 lens 必须**抛错**，不许降级
 *   ③ tokenizer 只收 descriptor，不接受现成对象
 *   ④ 全量 + 边界 k + 平分 + 长 posting + 异常输入
 *   ⑤ 分层比较：结构层允许 builtAt 不同，查询层必须逐位相同
 *
 * 用法：node selftest-bm25-roundtrip.mjs
 * 退出码：0 全绿 / 1 有失败
 */
import { createBm25Index, searchBm25, dumpInternals, createBm25FromInternals } from './lib/retrieval/bm25.js';
import { createTokenizer } from './lib/retrieval/tokenize.js';
import { FIELD_WEIGHT } from './lib/retrieval/types.js';

let pass = 0, fail = 0;
const fails = [];
function check(name, ok, detail) {
  if (ok) { pass++; console.log('  PASS ' + name + (detail ? '   ' + detail : '')); }
  else { fail++; fails.push(name); console.log('  FAIL ' + name + (detail ? '   ' + detail : '')); }
}

/** 确定性伪随机（固定种子，结果可复现） */
let seed = 20261031;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const ri = (n) => Math.floor(rnd() * n);

// ═══ 构造测试语料（含极端形态）═══
const DOCS = [];
const WORDS = ['记忆', '检索', '延迟', '插件', '安装', '报错', '超频', '显存', '测试', '日记',
  '归档', '评论', '视频', '缓存', '索引', '分词', '打分', '排序', '配置', '模型'];
for (let i = 0; i < 400; i++) {
  const n = 2 + ri(10);
  let t = '';
  for (let j = 0; j < n; j++) t += WORDS[ri(WORDS.length)];
  DOCS.push({ id: 'd' + i, title: t.slice(0, 12), summary: t, content: t + ' ' + 'ENG' + (i % 7) });
}
// 平分用例：三条完全同内容的文档 ⇒ 分数必然相同，考验排序稳定性
DOCS.push({ id: 'tie-a', title: '平分用例', summary: '平分 用例', content: '平分 用例' });
DOCS.push({ id: 'tie-b', title: '平分用例', summary: '平分 用例', content: '平分 用例' });
DOCS.push({ id: 'tie-c', title: '平分用例', summary: '平分 用例', content: '平分 用例' });
// 空文档
DOCS.push({ id: 'empty', title: '', summary: '', content: '' });

const TOK_DESC = { mode: 'bigram' };
const tokFactory = { createTokenizer };

console.log('── 语料 ──');
console.log('  docs =', DOCS.length);

// ═══════════════════════════════════════════════
// A · 直接建（基准）
// ═══════════════════════════════════════════════
const A = createBm25Index(DOCS, createTokenizer({ mode: 'bigram' }));

// ═══════════════════════════════════════════════
// B · 走 dump → 隔离 → 重建（完全独立的路径）
// ═══════════════════════════════════════════════
console.log('');
console.log('── A · 引用隔离（红队 P0-1）──');
const snap1 = dumpInternals(A);
{
  // ① 修改 dump 结果，A 必须不受影响
  //
  //   ⚠️ 这里必须改**已有数组的内容**，不能只 set 一个新 key ——
  //   我第一版只做了 postings.set()，结果浅拷贝的实现照样 PASS（假绿）。
  //   真浅拷贝时改已有数组的元素会直接改到原索引。
  //   而且必须改**这条查询会遍历到**的词，否则改了也测不出来（我第一次又错了）
  const Q0 = '记忆';
  const before = JSON.stringify(searchBm25(A, Q0, 10));
  const hitTerm = [...snap1.postings.keys()].find((t) => t === Q0) || [...snap1.postings.keys()][0];
  const anyArr = snap1.postings.get(hitTerm);
  const origFirst = anyArr[0];
  anyArr[0] = 999999;                        // ← 改已有数组元素（浅拷贝在此暴露）
  snap1.postings.set('注入的假词', [0, 99]);
  snap1.dfMap.set('注入的假词', 1);
  snap1.ids[0] = '被篡改';
  snap1.lens[0] = 999999;
  const after = JSON.stringify(searchBm25(A, '记忆', 10));
  check('改 dump 的已有数组元素不影响原索引', before === after);
  anyArr[0] = origFirst;

  // ② dump 两次，互相独立
  const s1 = dumpInternals(A), s2 = dumpInternals(A);
  check('两次 dump 的 postings 不是同一对象', s1.postings !== s2.postings);
  check('两次 dump 的数组不是同一引用', s1.postings.get([...s1.postings.keys()][0]) !== s2.postings.get([...s2.postings.keys()][0]));

  // ③ 修改原索引后 dump（通过重建一个再验证）
  const s3 = dumpInternals(A);
  const k0 = [...s3.postings.keys()][0];
  s3.postings.get(k0).push(0, 1);   // 故意破坏
  let threw = false;
  try { createBm25FromInternals(s3, TOK_DESC, tokFactory); } catch { threw = true; }
  check('被破坏的快照会被 validator 拒绝', threw);
}

// ═══════════════════════════════════════════════
// C · 严格校验（红队 P0-2）
// ═══════════════════════════════════════════════
console.log('');
console.log('── B · 坏数据必须抛错（反例）──');
function mustThrow(name, mutator) {
  const s = dumpInternals(A);
  mutator(s);
  let e = null;
  try { createBm25FromInternals(s, TOK_DESC, tokFactory); } catch (err) { e = String(err && err.message || err); }
  check(name, !!e, e ? e.slice(0, 60) : '没有抛错 ← 危险');
}
mustThrow('N 与 ids 不一致被拒', (s) => { s.N = s.ids.length + 1; });
mustThrow('ids/lens 长度不一致被拒', (s) => { s.lens = new Float64Array(3); });
mustThrow('docIdx 越界被拒', (s) => { const k = [...s.postings.keys()][0]; s.postings.get(k)[0] = 999999; });
mustThrow('docIdx 非整数被拒', (s) => { const k = [...s.postings.keys()][0]; s.postings.get(k)[0] = 1.5; });
mustThrow('weight 非有限被拒', (s) => { const k = [...s.postings.keys()][0]; s.postings.get(k)[1] = NaN; });
mustThrow('同一 doc 重复被拒', (s) => { const k = [...s.postings.keys()][0]; const a = s.postings.get(k); a.push(a[0], 1); });
mustThrow('dfMap 与实际不符被拒', (s) => { const k = [...s.postings.keys()][0]; s.dfMap.set(k, 999); });
mustThrow('dfMap 有 postings 没有的词被拒', (s) => { s.dfMap.set('不存在的词', 1); });
mustThrow('k1 非法被拒', (s) => { s.k1 = 0; });
mustThrow('b 越界被拒', (s) => { s.b = 1.5; });

console.log('');
console.log('── C · tokenizer 合同（红队 P0-3）──');
{
  const s = dumpInternals(A);
  let e1 = null; try { createBm25FromInternals(s, { tokenize: () => [] }, tokFactory); } catch (err) { e1 = err.message; }
  check('不接受现成 tok 对象（无 mode）', !!e1, e1 && e1.slice(0, 50));

  let e2 = null; try { createBm25FromInternals(s, TOK_DESC); } catch (err) { e2 = err.message; }
  check('不注入 tokFactory 被拒', !!e2, e2 && e2.slice(0, 50));

  const B = createBm25FromInternals(dumpInternals(A), TOK_DESC, tokFactory);
  check('合法 descriptor 可重建', !!B && B.N === A.N);
}

// ═══════════════════════════════════════════════
// D · 逐位等价（核心判据）
// ═══════════════════════════════════════════════
console.log('');
console.log('── D · 逐位等价 ──');
const B = createBm25FromInternals(dumpInternals(A), TOK_DESC, tokFactory);

{
  // 结构层：允许 builtAt 不同
  const sa = dumpInternals(A), sb = dumpInternals(B);
  check('结构层 ids 相同', JSON.stringify(sa.ids) === JSON.stringify(sb.ids));
  check('结构层 postings 词表相同', sa.postings.size === sb.postings.size, sa.postings.size + ' vs ' + sb.postings.size);
  check('结构层 dfMap 相同', sa.dfMap.size === sb.dfMap.size);
  let postSame = true;
  for (const [k, v] of sa.postings) {
    const w = sb.postings.get(k);
    if (!w || v.length !== w.length) { postSame = false; break; }
    for (let i = 0; i < v.length; i++) if (v[i] !== w[i]) { postSame = false; break; }
    if (!postSame) break;
  }
  check('结构层 postings 逐项相同（含顺序）', postSame);
}

const QUERIES = ['记忆', '检索 延迟', '插件 安装 报错', '超频', '缓存 索引 分词',
  'a', 'ENG3', '', 'zzzz不存在的词', '记忆'.repeat(30), '记忆检索延迟插件安装报错超频显存测试日记'];
const KS = [0, 1, 5, 12, 16, 20, 24, 25, 30, 35, -1, DOCS.length, DOCS.length * 2, undefined];

let mismatches = 0, compared = 0;
for (const q of QUERIES) {
  for (const k of KS) {
    let ra, rb;
    try { ra = searchBm25(A, q, k); } catch (e) { ra = 'ERR:' + e.message; }
    try { rb = searchBm25(B, q, k); } catch (e) { rb = 'ERR:' + e.message; }
    compared++;
    // 逐位：id 顺序 + 分数（用 IEEE 十六进制比，避免 toFixed 掩盖）
    const norm = (r) => Array.isArray(r) ? r.map((x) => [String(x[0]), f64hex(x[1])]) : String(r);
    if (JSON.stringify(norm(ra)) !== JSON.stringify(norm(rb))) {
      mismatches++;
      if (mismatches <= 3) console.log('    差异 q=' + JSON.stringify(q) + ' k=' + k + '  A=' + JSON.stringify(ra).slice(0, 80));
    }
  }
}
check('查询层逐位相同（' + compared + ' 组）', mismatches === 0, mismatches ? mismatches + ' 组不一致' : '全部一致');

function f64hex(n) {
  const b = new DataView(new ArrayBuffer(8));
  b.setFloat64(0, n);
  return Array.from(new Uint8Array(b.buffer)).map((x) => x.toString(16).padStart(2, '0')).join('');
}

// ═══════════════════════════════════════════════
// E · 平分与长 posting
// ═══════════════════════════════════════════════
console.log('');
console.log('── E · 平分与极端 posting ──');
{
  const ra = searchBm25(A, '平分用例', -1);
  const rb = searchBm25(B, '平分用例', -1);
  check('平分用例 id 顺序一致', JSON.stringify(ra.map((x) => x[0])) === JSON.stringify(rb.map((x) => x[0])),
    ra.map((x) => x[0]).join(','));
  const ties = ra.filter((x) => String(x[0]).startsWith('tie-'));
  check('平分文档都能被召回', ties.length === 3, 'n=' + ties.length);

  // 最长 posting
  const sa = dumpInternals(A);
  let maxTerm = null, maxLen = -1;
  for (const [term, arr] of sa.postings) if (arr.length > maxLen) { maxLen = arr.length; maxTerm = term; }
  const la = searchBm25(A, maxTerm, -1);
  const lb = searchBm25(B, maxTerm, -1);
  check('最长 posting 查询逐位一致（df=' + (maxLen / 2) + '）',
    JSON.stringify(la.map((x) => [x[0], f64hex(x[1])])) === JSON.stringify(lb.map((x) => [x[0], f64hex(x[1])])));
}

// ═══════════════════════════════════════════════
// F · 全词表覆盖（红队：不能只抽样）
// ═══════════════════════════════════════════════
console.log('');
console.log('── F · 全词表逐词回放 ──');
{
  const s = dumpInternals(A);
  const terms = [...s.postings.keys()];
  let bad = 0;
  const t0 = Date.now();
  for (const t of terms) {
    const ra = searchBm25(A, t, -1);
    const rb = searchBm25(B, t, -1);
    if (JSON.stringify(ra.map((x) => [x[0], f64hex(x[1])])) !== JSON.stringify(rb.map((x) => [x[0], f64hex(x[1])]))) {
      bad++; if (bad <= 3) console.log('    词表差异 term=' + JSON.stringify(t));
    }
  }
  check('全 ' + terms.length + ' 个 term 逐词回放一致', bad === 0, '耗时 ' + (Date.now() - t0) + 'ms，不一致 ' + bad);
}

// ═══════════════════════════════════════════════
// ═══════════════════════════════════════════════
// G · 真实数据规模下的接缝代价（红队关心的：接缝本身要花多少）
// ═══════════════════════════════════════════════
console.log('');
console.log('── G · 接缝自身代价（真实规模）──');
{
  // 用合成大语料逼近真实规模：真实卡库 6340 卡 / 13 万词 / 56 万 pair
  //   词池必须够大，否则 bigram 词表只有几百个，测不出深拷贝的真实代价
  //   注意：必须用**真随机**，我第一版用 (i*31+j*17)%len 这种线性同余，
  //   结果每篇文档内容完全一样，词表只剩 44 个 —— 测出来的"1ms"毫无意义。
  const CHARS = '记忆检索延迟插件安装报错超频显存测试日记归档评论视频缓索引分词打排序配置模型圣殿菲比修女';
  const BIG = [];
  for (let i = 0; i < 6340; i++) {
    let t = '';
    for (let j = 0; j < 120; j++) t += CHARS[ri(CHARS.length)];
    BIG.push({ id: 'b' + i, title: t.slice(0, 12), summary: t.slice(0, 60), content: t });
  }
  const bigTok = createTokenizer({ mode: 'bigram' });
  const bIdx = createBm25Index(BIG, bigTok);
  const t0 = Date.now();
  const dumped = dumpInternals(bIdx);
  const tDump = Date.now() - t0;
  const t1 = Date.now();
  const rebuilt = createBm25FromInternals(dumped, TOK_DESC, tokFactory);
  const tRebuild = Date.now() - t1;
  check('大语料下 dump+重建可用', !!rebuilt && rebuilt.N === bIdx.N);
  console.log('     合成语料 docs=' + BIG.length + ' vocab=' + bIdx.vocabSize + ' pairs=' + bIdx.postingsPairs);
  console.log('     dump(深拷贝)=' + tDump + 'ms  重建(含校验)=' + tRebuild + 'ms');
  // 合成语料的词表结构与真实不同（真实 13 万词/56 万 pair），
  // 所以这两个数**不能外推**。真实规模请跑：
  //   node scripts/bench-bm25-serialize.mjs   或 bench-warmup-phases.mjs
  console.log('     ⚠️ 合成语料词表结构与真实不同，此数不可外推（真实见 bench 脚本）');
}

console.log('');
console.log('════ SUMMARY ════');
console.log('  pass=' + pass + ' fail=' + fail);
if (fail) console.log('  失败项: ' + fails.join(' | '));
process.exit(fail ? 1 : 0);
