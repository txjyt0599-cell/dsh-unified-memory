# Changelog

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
