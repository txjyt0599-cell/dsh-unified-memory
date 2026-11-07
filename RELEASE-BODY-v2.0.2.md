# v2.0.2 更新

## 修复
- **memory_search 翻页断层**：旧实现用 `(page-1)*30` 写死偏移，第一页 `limit:5` 后第二页 `limit:30` 会从第 31 条切，第 6~30 条被整段跳过（page≥3 的 30+20+10 阶梯同样错位）。
  改为按 session+query 记录已发放 id，翻页用 excludeIds 精确续读，只取本组条数。
- 工具描述补充「翻页沿用同一 limit（建议 30）」。

## 测试
- 新增回归 `selftest-memory-search-paging.mjs`：9/9（含「5 条后续读必须从第 6 条」）
- 开源 selftest 43/43 · check-as-stranger --full 44 套件全绿
