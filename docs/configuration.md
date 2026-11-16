# 配置说明

`config.json` 是纯 JSON，不能写注释，所以说明放在这里。

## 配置文件在哪

插件首次启动时会生成：

```
$PM_DATA_ROOT/ingest/config.json
```

`PM_DATA_ROOT` 默认是 `~/.dsh/unified-memory`。改完保存即生效，**不需要重启 DSH**。

首次启动还会把这份说明复制到 `$PM_DATA_ROOT/ingest/configuration.md`，方便直接对照。

## 写入链开关

| 键 | 默认 | 作用 |
|---|---|---|
| `enabled` | `true` | 总闸。`false` 时三条链全部停止，连对话都不记录 |
| `capture` | `true` | L0 原始对话落盘（不调模型） |
| `extract` | `true` | L1 事实卡提取（需要 LLM） |
| `distill` | `true` | L2 长期记忆蒸馏（需要 LLM） |

`extract` / `distill` 在没有 LLM 配置时会**打印告警后优雅跳过**，不会报错。LLM 配置写在 `cordis.patch.yml` 的 `config.llm` 里。

## 检索行为

| 键 | 默认 | 作用 |
|---|---|---|
| `fourForcesEnabled` | `true` | 四股力乘法门控：相关度是门票，重要度 / 新鲜度 / 强度只在相关池内调名次。改 `false` 即回滚到旧排序 |
| `flashbackEnabled` | `false` | 双轨闪回，最多补 1 条远期同构记忆，不参与主排序 |

## 冷宫归档（默认关，故意的）

| 键 | 默认 | 作用 |
|---|---|---|
| `coldArchiveEnabled` | `false` | 定时统计冷卡（只统计，不搬） |
| `coldArchiveAutoApply` | `false` | 是否真的搬进冷宫。**搬卡不可逆**，默认不自动，要开请自行确认 |
| `coldArchiveAgeDays` | `60` | 多少天没被用到算冷 |

也可以不开定时器，手动执行（先确认再跑）：

```bash
node scripts/cold-archive.mjs --apply
```

## 优先级

**这些开关只从 `config.json` 读（活配置）。** 写在 `cordis.patch.yml` 里的同名键对写入链**不生效**。

唯一例外是 `fourForcesEnabled`：在 profile 里显式写了会优先于本文件。

## 模型端点与密钥

网页控制台可以配置 L1 / E1 / E2 / R1 四条线路（Base URL、模型名、维度、超时、启停）。

- 控制台录入的密钥写入 `$PM_DATA_ROOT/ingest/model-endpoints.json`（本机文件，权限 600）；
- 状态接口**永不回显**密钥；
- 密钥也可以来自你的 DSH profile；
- 把 `model-endpoints.json` 当密钥文件保护，不要提交到版本库。

## 数据目录

```
config.json     本配置
conversations/  L0 原始对话
records/        L1 事实卡
engrams.jsonl   L2 长期记忆
model-endpoints.json  控制台保存的模型线路与密钥
```
