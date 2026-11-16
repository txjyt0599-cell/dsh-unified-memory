# 脚本目录说明

本目录是开发与维护工具，不是插件运行时依赖。按用途分四类：

| 前缀 / 文件 | 用途 | 入口 |
|---|---|---|
| `check-*.mjs`、`smoke-apply.mjs`、`security-audit.mjs`、`data-leak-audit.mjs` | 质量与发布检查 | `npm run check` / `npm run audit` |
| `gen-structure.mjs` | 生成 `docs/STRUCTURE.md`（`docs/structure.json` 按需生成） | `npm run structure` |
| `selftest-*-mutation.*` | 变异测试，用于证明对应检查真的会红 | `node scripts/selftest-*-mutation.*` |
| `e2e-*`、`eval-*`、`bench-*`、`proto-*`、`acceptance-*` | 回归、评估与基准脚本 | 手动执行；需要真实数据的会自行跳过 |
| `backfill-*`、`fix-*`、`migrate-*`、`compact-*` | 数据维护工具；会改数据 | 先备份、先 `--dry`，确认后再执行 |
| `probe-*`、`diag-*`、`refactor-*` | 一次性探针/迁移工具，不是受支持入口 | 仅作历史参考 |

约定：

- 任何修改数据的脚本都必须先说明读写范围、预演方式与恢复方法；
- 新增检查脚本必须带一个会失败的负例；
- 不留“零引用但仍被当成入口”的脚本；待复核清单见开发记录，不按零引用直接删除。
