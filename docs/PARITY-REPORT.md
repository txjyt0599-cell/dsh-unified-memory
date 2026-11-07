# 开源版 vs 生产结构图 · 差异核验报告

> 生成：2026-11-07 · 依据：生产侧结构图插件产出的 tree.json（normify 项目，路径不入库）
> 被检对象：`dsh-unified-memory` 的 `lib/`
> 方法：结构树 source/api 全量比对 + 归一化后逐文件 diff（剔除命名/占位差异）

## 一 · 结论

**没有少东西。** 100 个源文件（99 代码 + 1 说明）与生产一一对应；117 个挂 `lib/` 源码的生产模块全部能找到落点。
反而查出两件事：**生产结构图本身有 6 处过期**；**开源版有 1 处在同步中被生产硬编码覆盖**（已修）。

## 二 · 文件层面

| 项 | 生产 | 开源 | 差异 |
|---|---:|---:|---|
| `lib/` 源文件（排除 .bak，含 CONFIG-NOTES.md） | 100 | 100 | **0** |
| 生产有、开源没有 | — | — | **0** |
| 开源有、生产没有 | — | — | **0** |

## 三 · 模块 / API 层面（对生产结构树）

生产树编译于 2026-11-06 08:09：125 模块 / 106 叶子 / 283 API / 64 依赖。

| 检查 | 结果 |
|---|---|
| 挂 `lib/` 源码的模块 | 117 个 |
| 这些模块的源文件在开源版存在 | **117 / 117** |
| 文件中声明的 API 能在开源代码里找到 | 178 / 184 |
| 对不上的 6 个 | `buildEpisodeEdge` / `chunkEpisode` / `assignEpisodeRoles` / `isCompatible` / `traceSourceSnippets` / `isDomainTerm` |

> 这 6 个在**生产代码里同样不存在**（实测 count=0）⇒ 是结构图过期项，不是开源缺失。
> 其余 5 个"对不上"是工具名/别名（`diary_write` / `diary_config` / `memory_search` / `memory_get` / `memory_refute`），实际都在。

## 四 · 内容层面（归一化后 diff）

剔除 `unified-memory → unified-memory`、路径占位、人称等命名差异后，24 个文件仍有差异：

| 文件 | 差异性质 |
|---|---|
| `retrieval/bm25.js` | **开源独有**：索引快照 API（dumpInternals / createBm25FromInternals） |
| `ingest/index.js` | **开源独有**：首启配置模板 + 缺 LLM 启动告警 |
| `ingest/config.js` | **开源独有**：开箱默认值 true（生产靠本机 config.json 覆盖） |
| `scenes.js` | **开源独有**：空场景表 + makeSceneRoots（不推断他人目录） |
| `diary/index.js` | **开源独有**：resolveBookPrompts |
| `ingest/CONFIG-NOTES.md` | 开源独有文档 |
| `section.js` | **回归已修**：生产硬件公理块被带进来，已恢复 config.hostAxioms |
| 其余 16 个 | 仅注释里的历史路径/称呼差异，无逻辑差异 |

## 五 · 生产结构图待修项（不是开源问题）

1. 6 个 API 已不存在 ⇒ 需 `normify_sync` 或重建对应模块。
2. 编译时间 11-06 08:09，之后 11-06~11-07 有红队修复与全量同步 ⇒ 整棵树需要重编译。
3. 依赖边 64 条是旧代码的；本次新增 9 个模块（card-locator / time-window / shadow-decay / persona-drift / entry-shadow / signal-miss / l0-cache / l1-l2-link / shard-files）需补节点与边。

## 六 · 复现方式

```bash
# 开源侧（本仓库）
npm run structure          # 生成 docs/structure.json + docs/STRUCTURE.md

# 生产侧（结构图插件）
#   normify_tree_list → normify_module_list(project="unified-memory")
#   normify_validate / normify_build 重编译
```
