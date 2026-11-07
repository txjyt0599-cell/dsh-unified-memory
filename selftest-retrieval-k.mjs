/**
 * selftest-retrieval-k.mjs —— 检索档位 / 强命令升档 / 按需分页验收
 *
 * ## 为什么需要
 *   「列出所有变更」「按序号逐条列一遍」这类查询要的是完整集合，不是最相关的几条。
 *   旧实现有两个坑：
 *     ① 只有 factual/temporal/reasoning 三档，长链查询落在 30 条档位，几十行的链必然答不全；
 *     ② 调用方传进来的 k 被当成截断上限 —— 传小值（如 6）会把内部 24 条砍成 6 条，
 *        材料骤减直接导致准确率下滑。
 *
 * ## 验什么
 *   K1 枚举意图识别（且不误伤普通时间问）
 *   K2 档位与阶梯常量
 *   K3 强命令**只升不降**（k 小于档位时不动档位）
 *   K4 分页阶梯 30 → 20 → 10，第 4 组起固定 10
 *   K5 memory_search 暴露 page / hasMore 给模型
 */
import { ADAPTIVE_K, STAGE_GUARD } from './lib/retrieval/types.js';
import { resolveAdaptiveK, pageSizeFor, classifyQuery } from './lib/retrieval/rrf.js';
import { createMemoryTools } from './lib/retrieval/tools.js';

let pass = 0, fail = 0;
const fails = [];
function check(g, name, ok, detail) {
  if (ok) { pass++; console.log('  PASS ' + name + (detail ? '   ' + detail : '')); }
  else { fail++; fails.push(name); console.log('  FAIL ' + name + (detail ? '   ' + detail : '')); }
}

console.log('── K · 检索档位与分页 ──');
check('K', 'K1a 枚举意图 → enumerate', classifyQuery('列出所有变更记录') === 'enumerate');
check('K', 'K1b 「从最初到现在」→ enumerate', classifyQuery('这个值从最初到现在经历过哪些变更') === 'enumerate');
check('K', 'K1c 普通时间问不被误判', classifyQuery('变更窗口是什么时候') !== 'enumerate', classifyQuery('变更窗口是什么时候'));
check('K', 'K1d 普通事实问仍是 factual', classifyQuery('这个功能怎么用') === 'factual');
check('K', 'K2a enumerate 档 fact=60', ADAPTIVE_K.enumerate.fact === 60, String(ADAPTIVE_K.enumerate.fact));
check('K', 'K2b maxFactK=120', STAGE_GUARD.maxFactK === 120, String(STAGE_GUARD.maxFactK));
check('K', 'K3a 强命令升档 30 → 60', resolveAdaptiveK('temporal', { requestedK: 60 }).fact === 60);
check('K', 'K3b **小 k 不降档**（factual 保持 24）', resolveAdaptiveK('factual', { requestedK: 6 }).fact === 24, String(resolveAdaptiveK('factual', { requestedK: 6 }).fact));
check('K', 'K3c 超上限夹到 120', resolveAdaptiveK('factual', { requestedK: 999 }).fact === 120);
check('K', 'K4a 阶梯 30/20/10', pageSizeFor(1) === 30 && pageSizeFor(2) === 20 && pageSizeFor(3) === 10);
check('K', 'K4b 第 4 组起仍是 10（不归零）', pageSizeFor(4) === 10 && pageSizeFor(99) === 10);

const tools = createMemoryTools({ retriever: null, getCardFromSources: () => null, logger: {}, getSessionId: () => 'selftest' });
const st = (tools || []).find((t) => t.name === 'memory_search');
check('K', 'K5a 参数含 page', !!(st && st.parameters && st.parameters.properties && st.parameters.properties.page));
check('K', 'K5b 输出 schema 含 hasMore', !!(st && st.output && st.output.schema && st.output.schema.properties && st.output.schema.properties.hasMore));
check('K', 'K5c 描述含分页指引', String(st && st.description || '').indexOf('page 加 1') >= 0);

console.log('');
console.log('RETRIEVAL-K ' + (fail === 0 ? 'DONE' : 'FAILED') + '  pass=' + pass + ' fail=' + fail);
if (fail) { console.log('失败项: ' + fails.join(' / ')); process.exit(1); }