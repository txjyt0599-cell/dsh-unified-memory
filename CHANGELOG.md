# Changelog

## v2.0.2 — 2026-11-07

### 修复

- **memory_search 翻页断层**：旧实现用 `seen = (page - 1) * 30` 写死偏移。第一页若用 `limit:5` 只给 5 条，第二页 `limit:30` 会从第 31 条切 ⇒ **第 6~30 条整段跳过**；page≥3 时阶梯 30+20+10 也与 30 的倍数不符。
  改为按 `session + query` 记录**已发放 id 游标**，翻页用 `excludeIds` 精确续读，只取本组 `limit` 条。任意 limit 变化都不再漏条。
- 工具描述补充：翻页请沿用同一 `limit`（建议 30）。

### 测试

- 新增 `selftest-memory-search-paging.mjs`（9 项）：先 5 条 → 第二页必须从第 6 条续（旧版是第 31 条）、三页合并 45 条无洞无重、覆盖连续。
- 生产 verify 全绿；开源 selftest 43/43；check-as-stranger --full 44 套件全绿。

## v2.0.1 — 2026-11-07

### 修复

- **热度直通区不是严格时间倒序**：`buildHotBuffer` 先拼「近期轮次(3)」再拼「近期卡(5)」，两段各自有序但拼接后整体无序
  （实测 17:53 → 17:52 → 16:08 → **17:54** → 14:49）。改为两段先收集、合并后统一 `b.t - a.t` 排序，再按 2200 字预算截断。
- **cross-session-pulse 与 hot 卡段重复**：两者调用同一个 `recentCrossSession`（同 4h 窗口、同 perSessionCap，limit 4 vs 5）
  ⇒ pulse 必然是 hot 的子集，同一事件被注入两遍。pulse 现在跳过 hot 已送出的 id。

### 测试

- 新增 `selftest-prefetch-hot.mjs`（4 项）：hot 块非空、整体严格时间倒序、最新卡在最前、pulse 同源不重复。
- 生产 verify 全绿；开源 selftest 42/42；check-as-stranger --full 43 套件全绿。

## v2.0.0 — 2026-11-07

### 本版新增（定版补充）

- **与生产分支全量对齐**：9 个新模块（card-locator / time-window / shadow-decay / persona-drift /
  entry-shadow / signal-miss / l0-cache / l1-l2-link / shard-files）+ 28 项修复
  （P0 2 / P1 8 / P2 6 / 复审整改 5 / 检索与衰减 3），共 81 文件、+5,750 −1,078 行。
- **结构树**：`docs/STRUCTURE.md`（Mermaid 分层图 + 依赖边）+ `docs/structure.json` +
  `npm run structure` 一键重算；另有 normify 项目 `normify-unified-memory`（112 模块 / 488 API / 102 依赖）。
- **隐私门禁加固（红队复审整改）**：英文助手名规则上线，全仓库 538 处个人化文本清零；
  发布链 `npm run check:release` 全链 exit 0（personal 0 / security 0 / data-leak 0 / 陌生人 42 套件全绿）。

### 修复：运行期代码里的个人痕迹（重要）

社区反馈 `section.js` 把作者本机的硬件公理（显卡型号 / 显存 / 防误报规则）
硬编码进静态段，于是**每个使用者每一轮 system prompt 都被注入约 250 字符
与该用户机器完全无关的内容**。已全面清理同类问题：

| 位置 | 问题 | 处理 |
|---|---|---|
| `lib/section.js` | 作者本机硬件公理焊进 system prompt 静态段 | 改为 `config.hostAxioms`（字符串数组，**默认空**）；能力保留、个人数据移除 |
| `lib/scoring/importance.js` | 重要度正则写死具体显卡型号（示例显卡/示例核显/示例副卡） | 改为通用硬件词 |
| `lib/scenes.js` | 场景根表写死作者的项目目录 | 默认空表 + `config.sceneRoots` / `makeSceneRoots()` |
| `lib/retrieval/*` | 检索域词表写死作者项目词汇（项目甲 / 素材图） | 移除，只留通用技术/记忆词 |
| `lib/diary/index.js` | 日记技术词过滤含作者显卡型号与私有项目名 | 移除 |
| `lib/retrieval/zstd-extract.py` | 转录导出把角色名硬编码成作者助手的自称/称呼 | 改用标准 `user`/`assistant` |

**新增防回归闸门**：`scripts/check-personal-data.mjs`，扫描 `lib/` 下所有运行期文件
（跳过注释），命中「具体硬件型号 / 助手自称 / 作者私有项目名 / 开发机路径」即失败，
已接入 `npm run check`。

### 修复：一条会随时间失效的测试（AA19c）

`selftest-ingest` 的 AA19c 断言「beliefRevision 关闭时不得写卡」，但夹具旧卡的
`createdAt` 是固定时间戳，而 distill 用 `Date.now()` 算 ageDays —— 跑得越晚旧卡越"老"，
一旦超过 `retireAfterDays`，去重就会走「退役旧卡 + 写新卡」分支，断言必然变红。
（实测：2026-10-23 通过，2026-11-07 失败，代码未变。）
已把夹具阈值改成「今天距该时间戳的天数 + 100 天」，让测试与真实时间脱钩；
**断言本身未改**。全套自测由 40/41 恢复为 **41/41**。

### 新增：检索档位与按需分页

#### 枚举意图档（enumerate）

「列出所有变更」「按序号逐条列一遍」「从头到尾完整记录」这类查询要的是**完整集合**，
不是最相关的那几条。原先它们会落到 temporal（30 条）或 factual（24 条）档，
长链（几十次变更）必然答不全。新增 `enumerate` 档：topic 16 / episode 32 / **fact 60**。

判据从严，必须出现明确的"列全"信号；**不因出现「变更」二字就放行**
（「变更窗口是什么时候」仍是普通时间问）。

#### 强命令升档（只升不降）

`search(q, { k })` 的 `k` 现在有两种含义：

| 情形 | 行为 |
|---|---|
| `k` > 内部档位 | **升档**（受 `maxFactK=120` 硬上限保护） |
| `k` ≤ 内部档位 | **不动** —— 内部档位是调过的最优值，外部随手传的小值不该降级它 |
| 带 `page` / `excludeIds` | 按分页阶梯给一组 |

> 为什么「小于也不砍」很重要：早期实现一律按传入 `k` 截断，调用方传 6 就把 24 条砍成 6 条，
> 材料骤减直接导致现值准确率大幅下滑。档位属于插件，调用方只应能"要更多"，不能"要更少"。

#### 按需分页 30 → 20 → 10

一次性拉 120 条 token 太贵。现在可以按组翻页：

```js
search(q, { page: 1 })                        // 30 条, hasMore: true
search(q, { page: 2, excludeIds: ids1 })      // 20 条, 零重复
search(q, { page: 3, excludeIds: ids1.concat(ids2) })  // 10 条
```

返回体新增 `hasMore` / `page` / `pageSize` / `nextPageSize`。
池子到底就返回 0 条 + `hasMore: false`，**绝不硬凑**；库外查询仍然返回 0 条（北极星⑥）。

#### 改进：`memory_search` 把分页能力交给模型自己判断

以前模型只能传 `query / limit / temporal`，`limit` 硬上限还是 10 ——
想"多回忆一点"也拉不动，只能靠用户追问。现在：

- 新增 `page` 参数（1=30、2=20、3+=10）
- `limit` 上限 10 → **30**（盘点类查询够用）
- 返回 `hasMore`，并在工具描述里写明：**覆盖不全就自己把 page 加 1**，插件自动跳过已返回的卡

这样"分页"不再由用户触发，而是模型可自行使用的能力。

## v1.1.0 — 2026-11-01

### 新增：原文锚点（可降级查回原话）

卡片此前是可读性的天花板 —— 抽取式保真只有 18–46%，一旦把对话提炼成卡，细节就丢。
这一版给每张新卡存两件东西：

- `source_message_ids` —— 指向原文的门牌（按 id 可回查全文）
- `verbatim` —— 内联的原话片段（不依赖任何外部文件，永不失效）

读取侧是新增的 `lib/ingest/verbatim-lookup.js`：启动建一次索引（约 4.6 万条 / 300ms），
之后 O(1) 取。查不到返回 `null`，**不猜**。

两个字段都不参与 BM25（BM25 只读 title/summary/content），老卡词频分布零扰动。

### 改进：回溯电梯改成二级降级

之前 `resolveSourceRef` 是 `sessionId` 判断在前，而新卡 100% 有 `sessionId` ——
结果 `source_message_ids` 那条分支**一次都没跑过**，等于白加。

现在：

```
一级  message_ids  ── 按 id 精确取原文（约 1ms，不用猜关键词）
二级  sessionId    ── grep 关键词模糊搜（旧卡 / 锚点丢失时的兜底）
```

一级命中即 early-return，**失败才降级，绝不两条并跑**。

### 明确：resolved 记忆绝不降权、绝不过滤

已解决的问题往往是最有价值的经验（「串流键盘失灵，根因 XX，修法 YY」——
三个月后键盘再坏，这张卡必须能召回）。

检索侧只跳 `retired`（那是去重/版本退休），`resolved` 照常按原权重召回。
代码里焊了红线注释，并配了带变异验证的守护测试。

### 新增：字段白名单生成器

`scripts/gen-schema-whitelist.mjs` —— 终结「引用不存在字段」这类事故。
白名单不只记「存不存在」，还记**哪个库 / 覆盖率 / 语义口径**，
因为同一字段在不同库里覆盖率可以差 20% 以上。

### 新增：三个守护测试

| 测试 | 覆盖 |
|---|---|
| `selftest-resolved-no-penalty.mjs` | resolved 不降权红线（含变异验证：故意插入过滤必须变红）|
| `selftest-verbatim-anchor.mjs` | 原文锚点取值 / 回查 / 降级 / 查不到不猜 |
| `selftest-tracer-two-stage.mjs` | 二级降级链路（含 early-return 结构纪律）|

纯净安装没有用户会话数据时，依赖真实数据的断言会 **SKIP** 而不是 FAIL。

---

## v1.0.0 — 2026-10-31

首个公开发布版。
