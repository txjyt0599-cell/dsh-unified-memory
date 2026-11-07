# dsh-unified-memory v2.0.0 功能更新

> 对照上一版 v1.1.1 的完整差异（101 个文件，+8,963 / −1,114 行）。

## 一 · 新增模块（9 个）

| 模块 | 作用 | 你感受到的 |
|---|---|---|
| `retrieval/time-window` | 自然语言时间解析：上个月 / 去年 / 最近三天 → 精确区间 | 问「上个月的改动」不会只给近 7 天 |
| `memory/card-locator` | 卡片 id → 磁盘真实文件/行（canon id、归档全枚举、多版本行折叠、加锁） | 卡片回写不再丢字段、不再复制身份 |
| `shard-files` | 活跃 + 归档分片统一枚举与版本比较 | 轮转归档后的旧卡仍能被读到 |
| `memory/l1-l2-link` | L1↔L2 同源关系**读时**计算 | 结论卡能反查它由哪些事实得出 |
| `hypergraph/l0-cache` | L0 索引增量缓存 | 重启/刷新后不用整库重建，查询更快 |
| `scoring/shadow-decay` | 新旧衰减模型影子对比、生产基线解析 | 调衰减参数前先看数据，不拍脑袋 |
| `ingest/persona-drift` | 人格/语气漂移检测与降权 | 助手跑偏时能被发现并压回去 |
| `ingest/entry-shadow` | 入口提示的影子对照（该召回没召回） | 能定位「为什么这条没被想起来」 |
| `ingest/signal-miss` | 漏检池：记录没召回的查询与上下文 | 漏检可复盘，不靠猜 |

## 二 · 记忆卡：六分类 + 格式扩展

### 2.1 六分类（v1.1.1 完全没有）

每张结论卡新增 `titleType`：

| 类型 | 含义 |
|---|---|
| `decision` | 决定（选定方案） |
| `process` | 过程 / 做法 |
| `incident` | 事件 / 故障 |
| `fact` | 事实 / 参数 |
| `experience` | 经验 / 教训 |
| `persona` | 画像 / 偏好 |

- 取值不认识时归 `fact`，不会写脏。
- 检索时按查询意图做**档内软加权**：同类型最多 ×1.08，只在同分段内 tie-break，不会把无关卡顶上来。

### 2.2 卡片字段扩展（engram v2 补齐）

| 新字段 | 作用 |
|---|---|
| `arc_story` | 一句话「起因 → 转折 → 结果」，装配时当前情展示，**不进 BM25** |
| `source_message_ids` | 指向原始消息，可回查全文 |
| `verbatim` | 内联原话片段（≤30 字），原文丢了也能自证 |
| `status` | 状态机：active / scoped_active / superseded … |
| `scope_tags` | 作用域标签 |
| `confidence` | 置信度，低置信不参与默认检索 |
| `eventTs` / `eventStartTs` / `eventEndTs` / `eventTsSource` | 真实事件时间，与蒸馏时刻分开 |
| `mentionCount` / `adoptCount` | 提及 / 采纳次数（与 hits 分开记） |

## 三 · 命中语义：回顶 + 寿命 +1

v1.1.1 没有这套语义（`linPerHit` 不存在）。现在一张卡被**真实使用**（读进回复，不是进候选）时：

1. `hits + 1`；
2. `lastHitAt = now` → 衰减起点改为「最后一次被想起」⇒ **回顶**；
3. 寿命公式 `lifespan = 30 天 + hits × 1 天` ⇒ **每命中一次，寿命 +1 天**。

也就是越常用的记忆活得越久、掉得越慢；只进候选不计数，防刷票。

## 四 · 衰减模型：指数 → 线性

- 旧：指数半衰期（参数无法用现有数据验证）。
- 新：`recency = 1 − ageDays / lifespan`，寿命 = 30 + hits×1 天，从创建起平滑下降，到期归零。
- 衰减锚点 `decayAnchorOf` = max(lastHitAt, createdAt)；没被用过的卡按出生时间算。

## 五 · 检索：分页与升档

- **按需分页**：`pageSizeFor` → 30 / 20 / 10 阶梯；返回 `hasMore` / `page` / `pageSize` / `nextPageSize`（v1.1.1 全都没有）。
- **k 只升不降**：调用方 k 大于档位就升（上限 120），小于档位**不降级**。
- **守门模板剥离** `stripAskTemplate`：长问句不再因为模板尾巴稀释覆盖率而空回。
- **时间词剥离** `stripTimeWords` / `isPureTimeQuery`：纯时间问句与带主题的时间问句分开处理。

## 六 · 写入与纠错

- **兜底三档** `fallbackMode`：`off`（默认）/ `llm`（备用模型重试）/ `heuristic`（离线启发式产卡）。
- **证据按需展开**：`source_message_ids` 不再默认整窗塞进回复，可 `includeSource` / `grepSource` 按需取。
- **停写 `promotedFrom`**：改为读时用 `l1-l2-link` 现算（写时快照在架构上必空，58.5% 拿不到）。
- **纠错**：`memory_refute` 失败不再假报成功；更正事实写盘失败会明确返回。

## 七 · 场景隔离与配置

- 场景根表支持 `config.sceneRoots` / `makeSceneRoots()`（v1.1.1 只有硬编码表）。
- `config.hostAxioms`：机器公理从代码挪到配置，默认空 ⇒ 不渲染。

## 八 · 删除 / 停用

- 删除 `docs/FAILURE-MODES.md`（内部排障史，不进发布物）。
- 停用写时 `promotedFrom`（字段保留历史，新卡不再写）。
- 旧卡补偿参数 `initHalfLife` 的两种错误实现被替换为「补衰减起点」（0.4645 → 0.7095）。

## 九 · 升级说明

- 数据目录由 `PM_DATA_ROOT`（或 `DSH_HOME`）决定，默认 `~/.dsh/unified-memory`。
- 从 1.x 升级：数据目录不变，已有数据可直接读取；配置项按段合并，缺项用默认值。
