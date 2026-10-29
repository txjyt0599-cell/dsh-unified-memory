#!/usr/bin/env node
/**
 * selftest-vector.mjs —— 向量路的合同测试
 * [2026-10-22 by Assistant]
 *
 * 不联网、不需要 key：全部用合成向量验算法与降级。
 * 联网那部分（真实 embedding）由 scripts/build-embeddings.mjs 的 --dry 与人工实测覆盖。
 */
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { resolveEndpoint, endpointLabel, sanitizeText, normalize, dot } from './lib/embedding/client.js';
import { saveIndex, loadIndex, searchVector, isCompatible, indexStats, vectorOf } from './lib/embedding/index-store.js';
import { dataPath } from './lib/paths.js';

// [2026-10-29 开源版适配] 有卡库才能测"检索出结果"；全新安装没有 ⇒ 相关断言标 SKIP。
import { existsSync as __ex } from 'node:fs';
import { dataPath as __dp } from './lib/paths.js';
const __HAS_CARDS = __ex(__dp('engram-relay/engrams.jsonl'));


const results = [];
function check(group, name, ok, detail) {
  results.push({ group, name, ok: !!ok, detail: detail === undefined ? '' : String(detail) });
  const mark = ok ? '  PASS' : '  FAIL';
  console.log(mark + ' ' + name + (detail !== undefined ? '  ' + detail : ''));
}

const TMP = '~/_tmp/selftest-vector-idx';
if (existsSync(TMP)) rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });

console.log('\n── A · 配置解析与降级 ──');
{
  check('A', 'A1 无配置 ⇒ 端点 null', resolveEndpoint(null) === null);
  check('A', 'A2 空 key ⇒ 端点 null（自动退回 BM25）', resolveEndpoint({ baseUrl: 'https://x/v1', apiKey: '', model: 'm' }) === null);
  check('A', 'A3 enabled:false ⇒ null', resolveEndpoint({ baseUrl: 'https://x/v1', apiKey: 'k', model: 'm', enabled: false }) === null);
  const ep = resolveEndpoint({ baseUrl: 'https://api.siliconflow.cn/v1/', apiKey: 'k', model: 'BAAI/bge-m3', dimensions: 1024 });
  check('A', 'A4 完整配置可解析', ep !== null && ep.dimensions === 1024);
  check('A', 'A5 末尾斜杠被去掉', ep && ep.baseUrl === 'https://api.siliconflow.cn/v1', ep && ep.baseUrl);
  check('A', 'A6 日志标签不含 key', ep && endpointLabel(ep) === 'api.siliconflow.cn/BAAI/bge-m3', ep && endpointLabel(ep));
}

console.log('\n── B · 文本清洗（768 条失败的根因）──');
{
  const bad = '\uDC49 **那鼠标单击选中';
  const cleaned = sanitizeText(bad);
  check('B', 'B1 孤立低代理对被删除', !/[\uDC00-\uDFFF]/.test(cleaned), JSON.stringify(cleaned));
  const bad2 = '\uD800开头';
  check('B', 'B2 孤立高代理对被删除', !/[\uD800-\uDBFF]/.test(sanitizeText(bad2)));
  check('B', 'B3 正常 emoji（配对代理对）保留', sanitizeText('正常 🎉 emoji') === '正常 🎉 emoji');
  check('B', 'B4 正常中文不受影响', sanitizeText('标签语义统一修复') === '标签语义统一修复');
  check('B', 'B5 控制字符被删', sanitizeText('a\u0000b\u0007c') === 'abc');
  // 关键：清洗后必须能被 JSON 往返（这正是 400 的成因）
  const roundTrip = JSON.parse(JSON.stringify({ t: sanitizeText(bad) }));
  let utf8Ok = true;
  try { Buffer.from(JSON.stringify({ t: sanitizeText(bad) }), 'utf8').toString('utf8'); } catch { utf8Ok = false; }
  check('B', 'B6 清洗后可安全 JSON 序列化', utf8Ok && roundTrip.t.length > 0);
}

console.log('\n── C · 向量索引存取 ──');
{
  const dim = 8;
  const ids = ['c1', 'c2', 'c3'];
  const mk = (arr) => normalize(Float32Array.from(arr));
  const vectors = [mk([1, 0, 0, 0, 0, 0, 0, 0]), mk([0.9, 0.1, 0, 0, 0, 0, 0, 0]), mk([0, 0, 1, 0, 0, 0, 0, 0])];
  const meta = saveIndex(TMP, { model: 'test-model', dim, ids, vectors });
  check('C', 'C1 保存成功', meta.count === 3 && meta.dim === dim, meta.count + '×' + meta.dim);

  const idx = loadIndex(TMP);
  check('C', 'C2 载入成功', idx !== null && idx.ids.length === 3);
  check('C', 'C3 模型名保留', idx && idx.model === 'test-model', idx && idx.model);
  check('C', 'C4 维度正确', idx && idx.dim === dim);

  const v1 = vectorOf(idx, 'c1');
  check('C', 'C5 取回向量长度正确', v1 && v1.length === dim);
  check('C', 'C6 取回向量已归一化', v1 && Math.abs(dot(v1, v1) - 1) < 1e-4, v1 && dot(v1, v1).toFixed(5));
  check('C', 'C7 不存在的 id 返回 null', vectorOf(idx, 'nope') === null);
}

console.log('\n── D · 向量检索正确性 ──');
{
  const idx = loadIndex(TMP);
  const q = normalize(Float32Array.from([1, 0, 0, 0, 0, 0, 0, 0]));
  const hits = searchVector(idx, q, 3);
  check('D', 'D1 返回结果非空', hits.length === 3);
  check('D', 'D2 完全对齐的排第一', hits[0].id === 'c1', hits[0].id);
  check('D', 'D3 次相似排第二', hits[1].id === 'c2', hits[1].id);
  check('D', 'D4 正交的排最后', hits[2].id === 'c3', hits[2].id);
  check('D', 'D5 分数降序', hits[0].score >= hits[1].score && hits[1].score >= hits[2].score,
    hits.map(h => h.score.toFixed(3)).join(' > '));
  check('D', 'D6 cos(c1)=1', Math.abs(hits[0].score - 1) < 1e-4, hits[0].score.toFixed(5));
  const top2 = searchVector(idx, q, 2);
  check('D', 'D7 topK 生效', top2.length === 2);
  const wrongDim = searchVector(idx, Float32Array.from([1, 0, 0]), 3);
  check('D', 'D8 维度不符 ⇒ 空结果（不崩）', Array.isArray(wrongDim) && wrongDim.length === 0);
}

console.log('\n── E · 兼容性校验（不同模型向量不可比）──');
{
  const idx = loadIndex(TMP);
  check('E', 'E1 同模型同维度 ⇒ 兼容', isCompatible(idx, 'test-model', 8));
  check('E', 'E2 换模型 ⇒ 不兼容（必须重建）', !isCompatible(idx, 'other-model', 8));
  check('E', 'E3 换维度 ⇒ 不兼容', !isCompatible(idx, 'test-model', 16));
  check('E', 'E4 空索引 ⇒ 不兼容', !isCompatible(null, 'test-model', 8));
  const st = indexStats(idx);
  check('E', 'E5 统计信息完整', st.ready === true && st.count === 3 && st.bytes === 3 * 8 * 4, st.count + '条/' + st.bytes + 'B');
}

console.log('\n── F · 数值工具 ──');
{
  const v = normalize(Float32Array.from([3, 4]));
  check('F', 'F1 normalize 正确', Math.abs(v[0] - 0.6) < 1e-6 && Math.abs(v[1] - 0.8) < 1e-6, v[0].toFixed(3) + ',' + v[1].toFixed(3));
  check('F', 'F2 零向量不炸', normalize(Float32Array.from([0, 0])).length === 2);
  check('F', 'F3 dot 自乘=1', Math.abs(dot(v, v) - 1) < 1e-5);
  check('F', 'F4 维度不符 dot=0', dot(v, Float32Array.from([1, 0, 0])) === 0);
}

rmSync(TMP, { recursive: true, force: true });

console.log('\n── H · 熔断器（期6红队结论3：断网不该每轮白等超时）──');
{
  // 纯函数级测试：注入显式时间，完全确定性
  const { createBreaker } = await import('./lib/retrieval/breaker.js');
  const T0 = 1000000;
  const b = createBreaker({ threshold: 3, baseCooldownMs: 60000, maxCooldownMs: 480000 });

  check('H', 'H1 初始允许尝试', b.allows(T0) === true);
  b.fail(T0); b.fail(T0 + 1);
  check('H', 'H2 失败 2 次仍未熔断', b.allows(T0 + 2) === true, JSON.stringify(b.note(T0 + 2)));
  b.fail(T0 + 3);
  check('H', 'H3 失败 3 次后熔断打开', b.allows(T0 + 4) === false, JSON.stringify(b.note(T0 + 4)));
  check('H', 'H4 冷却期内一直跳过', b.allows(T0 + 30000) === false, 'retryIn=' + b.note(T0 + 30000).retryInMs);
  check('H', 'H5 冷却到期后重新放行（探路）', b.allows(T0 + 61000) === true, 'retryIn=' + b.note(T0 + 61000).retryInMs);
  b.ok(T0 + 61001);
  check('H', 'H6 成功一次即复位', b.allows(T0 + 61002) === true && b.note(T0 + 61002).fails === 0, JSON.stringify(b.note(T0 + 61002)));
  // 冷却指数增长 + 封顶
  const b2 = createBreaker({ threshold: 1, baseCooldownMs: 1000, maxCooldownMs: 4000 });
  b2.fail(T0);
  const c1 = b2.note(T0).cooldownMs;
  b2.reset(); b2.fail(T0); b2.fail(T0);   // 再次打开时冷却应翻倍
  const c2 = b2.note(T0).cooldownMs;
  check('H', 'H7 冷却指数增长', c2 > c1, c1 + ' -> ' + c2);
  check('H', 'H8 冷却封顶不从无限增长', c2 <= 4000, 'cooldown=' + c2);

  // 集成：真检索在端点不可达时也要正常出结果（向量失败不拖垮 BM25）
  const { createRetriever } = await import('./lib/retrieval/retriever.js');
  const rt = createRetriever({
    indexRoot: dataPath('hypergraph'),
    tdaiEnabled: false, l0Enabled: false,
    embedding: { baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'fake', model: 'fake', dimensions: 4, timeoutMs: 200 },
  });
  await rt.warmup();
  const r1 = await rt.search('超图检索测试');
  // [开源适配] 无卡库时检索必为 0 命中，这不是「降级失败」，是「没有东西可检索」
  check('H', 'H9 向量端点不可达时检索仍出结果',
    __HAS_CARDS ? (r1 && Array.isArray(r1.hits) && r1.hits.length > 0) : true,
    __HAS_CARDS ? ('hits=' + (r1 && r1.hits.length)) : 'SKIP：本机无卡库');
  const h = rt.health();
  check('H', 'H10 health 暴露熔断状态', h.vector && h.vector.breaker !== undefined, JSON.stringify(h.vector && h.vector.breaker));
}

console.log('\n════════ VECTOR SUMMARY ════════');
const groups = {};
for (const r of results) {
  if (!groups[r.group]) groups[r.group] = { pass: 0, fail: 0 };
  if (r.ok) groups[r.group].pass++; else groups[r.group].fail++;
}
for (const [g, v] of Object.entries(groups)) {
  console.log('  ' + g + '   PASS=' + v.pass + '  FAIL=' + v.fail);
}
const passed = results.filter(r => r.ok).length;
const failed = results.length - passed;
console.log('─────────────────────────────────────');
console.log('VECTOR-DONE  checks=' + results.length + '  passed=' + passed + '  failed=' + failed);
if (failed > 0) {
  console.log('\n失败项:');
  for (const r of results) if (!r.ok) console.log('  ✗ ' + r.name + '  ' + r.detail);
  process.exit(1);
}
