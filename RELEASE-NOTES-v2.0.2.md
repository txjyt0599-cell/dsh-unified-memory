# v2.0.2 — memory_search 翻页断层修复

> 2026-11-07 · 补丁版（无数据变更）

## 病根
旧实现 `seen = (page - 1) * 30` 把偏移写死：
- 第一页用 `limit:5` 只给 5 条，第二页 `limit:30` 从第 **31** 条切 ⇒ 第 6~30 条整段跳过；
- 阶梯是 30+20+10（合计 60），与 "page-1 乘 30" 不符，page≥3 也错位。

结果：模型以为翻页能凑满 60 条，实际中间有洞 —— 长链必然答不全。

## 修法
按 `session + query` 记录**已发放 id 游标**，翻页时作为 `excludeIds` 传给检索层，只取本组 `limit` 条。
任意 limit 变化都不再漏条；游标 30 分钟过期、超 4000 条自动清。

## 测试
| 项 | 结果 |
|---|---|
| 新增 `selftest-memory-search-paging.mjs` | 9 / 9 |
| 生产 verify | 全绿 |
| 开源 selftest | 43 / 43 |
| `check-as-stranger --full` | 44 套件全绿 |
