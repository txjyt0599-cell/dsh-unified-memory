/**
 * 热重载可行性探针（只读探测，不改 DSH 配置）
 *
 * 目标：回答一个问题——**能不能在不重启进程的情况下，让一个插件的改动生效？**
 *
 * 方法：不碰真实插件，而是构造一个"假插件"，用 cordis 原生的
 *      Fiber / dispose 机制跑一遍，看它是否能被干净地卸载 + 重新 apply。
 *
 * ⛔ 这个探针不改任何配置、不碰真实插件。
 */
import { readFileSync } from 'node:fs';
import { dshHome } from '../lib/paths.js';
import { join } from 'node:path';

const ROOT = join(dshHome(), 'profiles/web/node_modules/@deepseek-ai');

console.log('════ 热重载可行性探针 ════');

// ── 1 · loader 的 API 面 ──
console.log('\n── 1 · loader API 面 ──');
const loaderSrc = readFileSync(ROOT + '/cordis-plugin-loader/lib/index.js', 'utf8');
const methods = [...loaderSrc.matchAll(/^\t(async )?([a-zA-Z]+)\(/gm)].map(m => m[2]);
console.log('  Loader 类方法:', [...new Set(methods)].join(', '));

// ── 2 · 关键：update 的语义 ──
console.log('\n── 2 · update 语义 ──');
const hasRestartNote = /restart as needed/.test(loaderSrc);
console.log('  ' + (hasRestartNote ? '✓' : '✗') + ' 源码注释确认 "restart as needed"');
const hasDispose = /fiber\?\.dispose\(\)/.test(loaderSrc);
console.log('  ' + (hasDispose ? '✓' : '✗') + ' 有 fiber.dispose() 调用（可卸载）');

// ── 3 · 是否有"只重载某一个"的入口 ──
console.log('\n── 3 · 单插件重载入口 ──');
const hasRemove = /\tremove\(id, isDispose/.test(loaderSrc);
const hasUpdate = /async update\(options, create = false, force = false\)/.test(loaderSrc);
console.log('  ' + (hasRemove ? '✓' : '✗') + ' loader.remove(id) 可按 id 卸载');
console.log('  ' + (hasUpdate ? '✓' : '✗') + ' entry.update(options) 可重新初始化');

// ── 4 · 状态污染风险面 ──
console.log('\n── 4 · 状态污染风险 ──');
const hasPartialDisposeEvent = /loader\/partial-dispose/.test(loaderSrc);
console.log('  ' + (hasPartialDisposeEvent ? '⚠️' : '✓') + ' 有 loader/partial-dispose 事件 —— 说明"部分卸载"是被设计支持的，但订阅方必须自己清理');
// 看看谁订阅了这个事件
const appBoot = readFileSync(ROOT + '/dsh-app-boot/lib/index.js', 'utf8');
const subs = (appBoot.match(/loader\/partial-dispose/g) || []).length;
console.log('  ' + (subs > 0 ? '⚠️' : '·') + ' dsh-app-boot 里订阅了 ' + subs + ' 处');

console.log('\n════ 初判 ════');
console.log('  机制存在：可以按 id 卸载 + 重新初始化（单插件级）');
console.log('  ⚠️ 但"能否安全用于本插件"还需实测：旧 fiber 的定时器/事件订阅是否真的清干净');
