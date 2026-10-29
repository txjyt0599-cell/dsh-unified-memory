# 配置说明（config.json 是纯 JSON，不能写注释，所以说明放在这里）

本目录下的 config.json 由插件首次启动时生成，可自由修改。
**修改后即时生效，不需要重启。**

## 写入链开关

| 键 | 默认 | 作用 |
|---|---|---|
| enabled | true | 总闸。false 时三条链全部停止，连对话都不记录 |
| capture | true | L0 原始对话落盘（不调模型） |
| extract | true | L1 事实卡提取（需要 LLM） |
| distill | true | L2 长期记忆蒸馏（需要 LLM） |

extract / distill 在没有 LLM 配置时会**优雅跳过并打印告警**，不会报错。
LLM 配置在 cordis.patch.yml 的 config.llm 里填。

## 检索行为

| 键 | 默认 | 作用 |
|---|---|---|
| fourForcesEnabled | true | 四股力乘法门控：相关度是门票，重要度/新鲜度/强度只在相关池内调名次。改 false 即回滚到旧排序 |
| flashbackEnabled | false | 双轨闪回，最多补 1 条远期同构记忆，不参与主排序 |

## 冷宫归档（默认关，故意的）

| 键 | 默认 | 作用 |
|---|---|---|
| coldArchiveEnabled | false | 定时统计冷卡（只统计，不搬） |
| coldArchiveAutoApply | false | 是否真的搬进冷宫。**搬卡不可逆**，默认不自动，要开请自行确认 |
| coldArchiveAgeDays | 60 | 多少天没被用到算冷 |

要真搬也可以不用定时器，手动跑：

```
node scripts/cold-archive.mjs --apply
```

## 优先级说明

**这些开关只从本文件读（活配置）。** 写在 `cordis.patch.yml` 里的同名键对写入链**不生效**。

唯一例外是 `fourForcesEnabled` —— 那条在 profile 里显式写了会优先于本文件。

## 同目录下的其它东西

```
config.json     本配置
conversations/  L0 原始对话
records/        L1 事实卡
engrams.jsonl   L2 长期记忆
```
