const fs = require('node:fs');
const ROOT = path.resolve(__dirname, '..');
const cards = JSON.parse(fs.readFileSync(ROOT + '/docs/_fm-raw.json', 'utf8'));

const FAMILIES = [
  { id: 'silent', name: '静默失效', kw: /日志说|假成功|说成功|不生效|永不|零接线|从没(?:跑过|执行)|空转|假实现|静默(?:丢|吞|跳过)|注释说|以为.*实际|没生效|不涨|不为零|全灭/ },
  { id: 'noise', name: '噪音与误召回', kw: /噪音|硬凑|误杀|误判|霸榜|回音室|稀释|污染|噪声|不相关|召回 0/ },
  { id: 'attribution', name: '归属串台', kw: /张冠李戴|串台|归属|混采|别人的|孤儿|错写|跨会话/ },
  { id: 'volume', name: '体量与预算', kw: /预算|上限|超线|膨胀|截断|吃满|名额|占满|超限|4KB|25KB/ },
  { id: 'cache', name: '缓存与性能', kw: /缓存|前缀|重建|延迟|性能|整包|慢|秒/ },
  { id: 'data', name: '数据与清洗', kw: /标题|HTML|清洗|去重|指纹|脏|模板句|空串|碎片|重复|幻影/ },
  { id: 'judge', name: '判据与检查', kw: /判据|反例|变异|断言|假检查|这条检查|门槛|体检|验收/ },
  { id: 'optim', name: '算法与调优', kw: /衰减|四股力|重要度|新鲜度|半衰期|打分|排序|融合|RRF|BM25|向量|L0|权重/ },
];

const buckets = new Map();
const un = [];
for (const c of cards) {
  let hit = null;
  for (const f of FAMILIES) if (f.kw.test(c.text)) { hit = f; break; }
  if (!hit) { un.push(c); continue; }
  if (!buckets.has(hit.id)) buckets.set(hit.id, { meta: hit, items: [] });
  buckets.get(hit.id).items.push(c);
}

let md = '# 失效模式总表\n\n';
md += '> **这不是功能文档，是"已经踩过的坑"清单。** 遇到症状先 Ctrl+F，不要从头读。\n>\n';
md += '> 全部从代码注释自动抽取（带行号可跳转原注释）。**⛔ 禁止手改**，改注释后跑 `node scripts/_gen-fm.cjs` 重生成。\n\n';

md += '## 症状导航\n\n| 你遇到的情况 | 组 | 条数 |\n|---|---|---|\n';
const NAV = [
  ['功能"看起来没生效"但不报错', 'silent'],
  ['检索返回一堆不相关的', 'noise'],
  ['记忆张冠李戴 / 记到别人头上', 'attribution'],
  ['上下文吃满 / 预算超了', 'volume'],
  ['慢 / 缓存命中率掉', 'cache'],
  ['标题脏 / 卡片重复', 'data'],
  ['测试全绿但线上挂', 'judge'],
  ['排序打分感觉不对', 'optim'],
];
for (const [desc, id] of NAV) {
  const b = buckets.get(id);
  md += '| ' + desc + ' | ' + (b ? b.meta.name : id) + ' | ' + (b ? b.items.length : 0) + ' |\n';
}
md += '\n---\n\n';

for (const [desc, id] of NAV) {
  const b = buckets.get(id);
  if (!b || !b.items.length) continue;
  md += '## ' + b.meta.name + '（' + b.items.length + ' 条）\n\n';
  md += '| 日期 | 症状 / 根因 / 修法（摘录） | 出处 |\n|---|---|---|\n';
  for (const it of b.items) {
    const t = it.text.replace(/^\(?\[?\d{4}-\d{2}-\d{2}[^\]]*\]?\s*/, '').replace(/[\r\n]+/g, ' ').replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim().slice(0, 170);
    md += '| ' + it.date + ' | ' + t + ' | [' + it.file.split('/').pop() + ':' + it.line + '](' + it.file + '#L' + it.line + ') |\n';
  }
  md += '\n';
}

if (un.length) {
  md += '## 未能归类（' + un.length + ' 条）\n\n';
  md += '> 不是不重要，是分类关键词不够。看到就补关键词，别手工挪。\n\n';
  md += '| 日期 | 内容 | 出处 |\n|---|---|---|\n';
  for (const it of un) {
    const t = it.text.replace(/[\r\n]+/g, ' ').replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim().slice(0, 150);
    md += '| ' + it.date + ' | ' + t + ' | [' + it.file.split('/').pop() + ':' + it.line + '](' + it.file + '#L' + it.line + ') |\n';
  }
  md += '\n';
}

md += '---\n\n## 本表自身的失效模式\n\n| 症状 | 根因 | 怎么办 |\n|---|---|---|\n';
md += '| 条目和代码对不上 | 注释改了但表没重生成 | 重跑生成脚本 |\n';
md += '| 明显漏了某个坑 | 抽取靠关键词，措辞不同就漏 | 补关键词重跑，**别手工补** |\n';
md += '| 条目只写了一半 | 抽取只取单个注释块，跨块的上下文会丢 | 点出处链接看原注释 |\n';
md += '| 没人看 | 没有症状导航 | 已按 8 组分类 + 顶部导航 |\n';

fs.writeFileSync(ROOT + '/docs/FAILURE-MODES.md', md, 'utf8');
console.log('生成完成:', md.length, '字符, 总计', cards.length, '条');
for (const [desc, id] of NAV) { const b = buckets.get(id); console.log('  ' + (b ? b.meta.name : id) + ': ' + (b ? b.items.length : 0)); }
console.log('  未能归类: ' + un.length);
