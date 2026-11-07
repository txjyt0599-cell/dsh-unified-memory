/**
 * gen-structure.mjs —— 生成开源版的模块结构图（机器算，不手画）
 *
 * 用法：node scripts/gen-structure.mjs
 * 产出：docs/structure.json（机器可读）+ docs/STRUCTURE.md（人读 + Mermaid 图）
 */
import { readdirSync, readFileSync, writeFileSync, statSync, mkdirSync, existsSync } from 'node:fs';
import { join, relative, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LIB = join(ROOT, 'lib');
const DOCS = join(ROOT, 'docs');

const LABELS = {
  '(root)': '入口与编排',
  ingest: '写入链（L0 捕获 / L1 提取 / L2 蒸馏）',
  retrieval: '检索链（BM25 / 重排 / 工具）',
  hypergraph: '超图存储与索引',
  memory: '卡片定位与 L1-L2 关联',
  'working-memory': '分层工作记忆（预算 / 淘汰 / 扩散）',
  scoring: '四股力 / 衰减 / 采纳',
  scorer: '基线打分',
  diary: '日记',
  dispatch: '派单台账与热重载',
  embedding: '向量索引',
  backends: '存储后端',
  observe: '日志与轮转',
};

const files = [];
function walk(d) {
  for (const e of readdirSync(d)) {
    const p = join(d, e);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(js|mjs|py)$/.test(e)) files.push(p);
  }
}
walk(LIB);

const rel = (p) => relative(ROOT, p).split(sep).join('/');
const modOf = (p) => { const r = relative(LIB, p).split(sep); return r.length === 1 ? '(root)' : r[0]; };

const info = new Map();
for (const f of files) {
  const t = readFileSync(f, 'utf8');
  const exports = new Set();
  for (const m of t.matchAll(/export\s+(?:async\s+)?(?:function|const|let|class)\s+([A-Za-z0-9_$]+)/g)) exports.add(m[1]);
  for (const m of t.matchAll(/export\s*\{([^}]+)\}/g)) {
    for (const part of m[1].split(',')) { const n = part.trim().split(/\s+as\s+/).pop().trim(); if (n) exports.add(n); }
  }
  const imports = [];
  for (const m of t.matchAll(/(?:from|import)\s+['"](\.[^'"]+)['"]/g)) imports.push(m[1]);
  info.set(f, { rel: rel(f), mod: modOf(f), exports: [...exports], imports, lines: t.split('\n').length });
}

const fileEdgeMap = new Map();
const edgeMap = new Map();
for (const [f, v] of info) {
  for (const spec of v.imports) {
    const base = join(dirname(f), spec);
    const cands = [base, base + '.js', base + '.mjs', join(base, 'index.js'), join(base, 'index.mjs')];
    let target = null;
    for (const c of cands) if (info.has(c)) { target = c; break; }
    if (!target) continue;
    const a = v.mod, b = info.get(target).mod;
    if (a === b) continue;
    const k = a + ' -> ' + b;
    edgeMap.set(k, (edgeMap.get(k) || 0) + 1);
    fileEdgeMap.set(rel(f) + ' -> ' + info.get(target).rel, 1);
  }
}

const mods = {};
for (const [, v] of info) {
  const m = mods[v.mod] || (mods[v.mod] = { files: 0, exports: 0, lines: 0, names: [] });
  m.files++; m.exports += v.exports.length; m.lines += v.lines;
  m.names.push(v.rel.replace(/^lib\//, ''));
}
for (const m of Object.values(mods)) m.names.sort();

const edgeList = [...edgeMap.entries()].map(([k, n]) => { const [from, to] = k.split(' -> '); return { from, to, n }; }).sort((a, b) => b.n - a.n || a.from.localeCompare(b.from));
const fileList = [...info.values()].map((v) => ({ path: v.rel, mod: v.mod, exports: v.exports, lines: v.lines })).sort((a, b) => a.path.localeCompare(b.path));
const totals = { files: files.length, modules: Object.keys(mods).length, exports: Object.values(mods).reduce((a, b) => a + b.exports, 0), edges: edgeList.length };

if (!existsSync(DOCS)) mkdirSync(DOCS);
writeFileSync(join(DOCS, 'structure.json'), JSON.stringify({ generatedAt: new Date().toISOString(), totals, mods, files: fileList, fileEdges: [...fileEdgeMap.keys()].map((k) => { const [from, to] = k.split(' -> '); return { from, to }; }), edgeList }, null, 2), 'utf8');

const order = ['(root)', 'ingest', 'retrieval', 'hypergraph', 'memory', 'working-memory', 'scoring', 'scorer', 'diary', 'dispatch', 'embedding', 'backends', 'observe'];
const rows = order.filter((k) => mods[k]).map((k) => {
  const m = mods[k];
  return '| `' + k + '` | ' + (LABELS[k] || '') + ' | ' + m.files + ' | ' + m.exports + ' | ' + m.lines + ' |';
}).join('\n');
const edgeRows = edgeList.map((e) => '| `' + e.from + '` -> `' + e.to + '` | ' + e.n + ' |').join('\n');
const mermaid = [
  '```mermaid',
  'flowchart TD',
  '  subgraph ENTRY[入口与编排]',
  '    IDX[index.js 插件入口]',
  '    ORC[orchestrator 编排]',
  '    SEC[section 系统提示段]',
  '    PRE[prefetch 预取]',
  '  end',
  '  subgraph ING[写入链]',
  '    CAP[capture L0 捕获] --> EXT[extract L1 提取] --> DIS[distill L2 蒸馏]',
  '  end',
  '  subgraph RET[检索链]',
  '    TOK[tokenize + query-terms] --> BM[bm25] --> RRF[rrf 融合] --> RTR[retriever] --> TLS[tools: memory_search]',
  '    TW[time-window] --> RTR',
  '  end',
  '  subgraph ORG[记忆组织]',
  '    HG[hypergraph 超图]',
  '    MEM[memory 定位 / L1-L2]',
  '    WM[working-memory 预算 / 淘汰]',
  '  end',
  '  subgraph SCO[打分与衰减]',
  '    FF[four-forces 四股力]',
  '  end',
  '  subgraph EXT2[外设]',
  '    DIA[diary 日记]',
  '    DSP[dispatch 派单]',
  '    EMB[embedding 向量]',
  '  end',
  '  IDX --> ING',
  '  IDX --> RET',
  '  IDX --> ORG',
  '  IDX --> EXT2',
  '  RET --> ORG',
  '  ING --> ORG',
  '  ORG --> SCO',
  '```',
].join('\n');

const md = [
  '# 开源版结构图（dsh-unified-memory）',
  '',
  '> 自动生成，勿手改。重新生成：node scripts/gen-structure.mjs（或 npm run structure）',
  '> 生成时间：' + new Date().toISOString(),
  '',
  '## 一 · 总览',
  '',
  '| 指标 | 数值 |',
  '|---|---|',
  '| 源码文件（lib，js/mjs/py） | ' + totals.files + ' |',
  '| 模块（一级目录） | ' + totals.modules + ' |',
  '| 导出 API | ' + totals.exports + ' |',
  '| 跨模块依赖边 | ' + totals.edges + ' |',
  '',
  '## 二 · 分层图',
  '',
  mermaid,
  '',
  '## 三 · 模块清单',
  '',
  '| 模块 | 职责 | 文件 | 导出 | 行数 |',
  '|---|---|---:|---:|---:|',
  rows,
  '',
  '## 四 · 跨模块依赖边（按次数降序）',
  '',
  '| 边 | 次数 |',
  '|---|---:|',
  edgeRows,
  '',
  '## 五 · 文件明细',
  '',
  ...order.filter((k) => mods[k]).flatMap((k) => ['### ' + k + ' · ' + (LABELS[k] || ''), '', mods[k].names.map((n) => '- ' + n).join('\n'), '']),
  '## 六 · 说明',
  '',
  '- 本图只覆盖 lib/（插件运行时代码），不含 scripts/（测试/工具）。',
  '- 边为相对 import 的静态解析结果；动态 import() 若带变量不会被计入。',
  '- 与生产版（normify-unified-memory）分属两棵树：本图只描述开源仓库自身。',
].join('\n');
writeFileSync(join(DOCS, 'STRUCTURE.md'), md, 'utf8');
console.log('structure: ' + totals.files + ' files / ' + totals.modules + ' modules / ' + totals.exports + ' exports / ' + totals.edges + ' edges');