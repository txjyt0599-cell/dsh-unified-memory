#!/usr/bin/env node
/**
 * check-release-tag.mjs —— 发布标签与包版本、版本说明必须一致。
 *
 * 用法：
 *   GITHUB_REF_NAME=v2.1.5 node scripts/check-release-tag.mjs
 *   node scripts/check-release-tag.mjs v2.1.5
 *
 * 退出码：0 = 一致；1 = 任一不一致。
 */
import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";

const tag = process.env.GITHUB_REF_NAME || process.argv[2] || "";
if (!tag) { console.error("缺少标签名：请设置 GITHUB_REF_NAME 或传入参数"); process.exit(1); }
if (!/^v\d+\.\d+\.\d+$/.test(tag)) { console.error("标签格式必须为 vX.Y.Z，实际: " + tag); process.exit(1); }

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const expected = "v" + pkg.version;
if (tag !== expected) { console.error("标签 " + tag + " 与 package.json 版本 " + pkg.version + " 不一致"); process.exit(1); }

let described = "";
try { described = execFileSync("git", ["describe", "--tags", "--exact-match", "HEAD"], { encoding: "utf8" }).trim(); } catch {}
if (!described) { console.error("当前 HEAD 不是标签提交（git describe --tags --exact-match 失败）"); process.exit(1); }
if (described !== tag) { console.error("HEAD 指向 " + described + "，不是 " + tag); process.exit(1); }

const notes = ["releases/" + tag + ".md", "RELEASE-NOTES-" + tag + ".md"].find((p) => existsSync(p));
if (!notes) { console.error("找不到版本说明：releases/" + tag + ".md 或 RELEASE-NOTES-" + tag + ".md"); process.exit(1); }

console.log("✅ 发布标签一致: " + tag + " / package.json " + pkg.version + " / " + notes);
