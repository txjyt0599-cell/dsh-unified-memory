# 测试套件

所有 `selftest*.mjs` 回归套件都在本目录。

- 跑单个：`node tests/selftest-<name>.mjs`
- 全量（陌生人环境）：`npm run check:as-stranger -- --full`
- 发现器要求至少发现一套；**0 套直接判失败**，不允许把空集合当全绿。

测试通过 `../lib/...` 导入运行时代码，默认工作目录是仓库根。
