# v2.0.1 更新

## 修复
- **热度直通区排序**：轮次段与卡段各自有序、拼接后整体无序（实测 17:53→17:52→16:08→17:54）。
  现在两段合并后统一按时间倒序，再按预算截断。
- **跨对话脉搏重复**：pulse 与 hot 卡段同源（同窗口，limit 4 vs 5），pulse 必然是 hot 子集。
  现在 pulse 跳过 hot 已送出的 id，不再同一事件说两遍。

## 测试
- 新增回归测试 `selftest-prefetch-hot.mjs`：4/4
- 开源 selftest 42/42 · check-as-stranger --full 43 套件全绿
