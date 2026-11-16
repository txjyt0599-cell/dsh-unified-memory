#!/usr/bin/env node
/**
 * check-package-contents.mjs —— 检查真实 tarball 内容：该有的在，内部记录不在。
 *
 * 依赖 npm pack --dry-run --json（不写盘），退出码 0 = 通过。
 */
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
let raw = "";
try {
  raw = execSync("npm pack --dry-run --json", { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
} catch (e) {
  console.error("npm pack 失败: " + ((e && e.stderr) || e));
  process.exit(1);
}
const info = JSON.parse(raw);
const files = (info[0] && info[0].files ? info[0].files : []).map((f) => f.path.replace(/\\/g, "/"));
const set = new Set(files);

const required = ["package.json", "README.md", "README.zh-CN.md", "LICENSE", "client.js", "cordis.patch.yml", "docs/configuration.md", "lib/index.js"];
const forbiddenExact = ["docs/PUSH-TO-GITHUB.md", "docs/PARITY-REPORT.md", "docs/structure.json", "docs/STRUCTURE.md"];
const forbiddenPrefixes = ["tests/", "scripts/", ".github/", "releases/"];

const missing = required.filter((f) => !set.has(f));
const forbidden = files.filter((f) => forbiddenExact.includes(f) || forbiddenPrefixes.some((p) => f.startsWith(p)) || /\.(log|out\.txt|bak)$/.test(f));

if (missing.length || forbidden.length) {
  if (missing.length) console.error("❌ tarball 缺少必需文件: " + missing.join(", "));
  if (forbidden.length) console.error("❌ tarball 夹带内部/测试记录: " + forbidden.slice(0, 20).join(", "));
  process.exit(1);
}
const libCount = files.filter((f) => f.startsWith("lib/")).length;
console.log("✅ tarball 内容干净: " + files.length + " 个文件，其中 lib/ " + libCount + " 个；无内部文档/测试/脚本");
