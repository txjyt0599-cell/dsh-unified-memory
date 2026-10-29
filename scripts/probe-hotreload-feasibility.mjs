/**
 * 热重载可行性最终判定（2026-10-28）
 *
 * 前面已验证：cordis 的 fiber.dispose() 能干净卸载（5 类副作用都归零）。
 * 现在要回答最后一个问题：**在 DSH 插件内部，能不能拿到 loader 并触发重载？**
 *
 * 如果拿不到 = 这个能力存在但没有入口 ⇒ 我们只能在"插件外部"动手（写个脚本调 DSH）
 * 如果拿得到 = 可以直接做一个"热重载工具"
 */
import { readFileSync } from 'node:fs';
import { dshHome } from '../lib/paths.js';
import { join } from 'node:path';

const ROOT = join(dshHome(), 'profiles/web/node_modules/@deepseek-ai');

console.log('════ 热重载可行性最终判定 ════');

// 1 · ctx.loader 是否在插件 ctx 上可达
const bootSrc = readFileSync(ROOT + '/dsh-app-boot/lib/index.js', 'utf8');
console.log('\n── 1 · ctx.loader 可达性 ──');
console.log('  ' + (/ctx\.loader\.entries\(\)/.test(bootSrc) ? '✓' : '✗') + ' dsh-app-boot 里直接用了 ctx.loader');

// 2 · loader 上按 id 找 entry 的方法
const loaderSrc = readFileSync(ROOT + '/cordis-plugin-loader/lib/index.js', 'utf8');
const hasStore = /this\.tree\.store/.test(loaderSrc);
const hasEntries = /entries\(\)/.test(loaderSrc);
console.log('\n── 2 · 按 id 定位 entry ──');
console.log('  ' + (hasStore ? '✓' : '✗') + ' tree.store（可用 id 索引）');
console.log('  ' + (hasEntries ? '✓' : '✗') + ' entries() 可遍历');

// 3 · 关键：有没有"卸载→重装"的完整闭环
const hasRemove = /\tremove\(id/.test(loaderSrc);
const hasUpdate = /async update\(options, create/.test(loaderSrc);
console.log('\n── 3 · 闭环 ──');
console.log('  [' + (hasRemove ? '✓' : ' ') + '] remove(id)   → 卸载');
console.log('  [' + (hasUpdate ? '✓' : ' ') + '] update()     → 重装');
console.log('  ⇒ ' + (hasRemove && hasUpdate ? '闭环存在：可以"先 remove 再 update"' : '闭环不完整'));

// 4 · 但！DSH 自己的插件是通过 bundle 声明的，remove 后可能无法自己恢复
console.log('\n── 4 · 关键风险 ──');
const patchPath = join(dshHome(), 'profiles/web/cordis.patch.yml');
try {
  const patch = readFileSync(patchPath, 'utf8');
  const hasOurPlugin = /unified-memory/.test(patch);
  console.log('  ' + (hasOurPlugin ? '⚠️' : '·') + ' 本插件在 cordis.patch.yml 里' + (hasOurPlugin ? '被声明' : '未被声明'));
  console.log('  ⇒ remove 之后，DSH 不会自动把它装回来（patch 只在启动时解析）');
  console.log('  ⇒ 必须在 remove 后**自己再 create**，否则插件就消失了');
} catch (e) {
  console.log('  ✗ 读不到 patch：' + e.message);
}

console.log('\n════ 判定 ════');
console.log('  机制：✅ 可行（已验证 5 类副作用能干净卸载）');
console.log('  入口：⚠️ 没有现成 UI/API —— 需要我们自己写');
console.log('  风险：⚠️ remove 后必须自己 create 回来，否则插件消失');
console.log('\n  ⇒ 结论：**可以做，但必须先有一个"能把自己装回来"的保险机制**');
