#!/usr/bin/env node
/**
 * scripts/cold-archive.mjs —— 冷宫归档 CLI
 * [2026-10-24 by Assistant · Step 4]
 *
 * 用法：
 *   node scripts/cold-archive.mjs --dry            # 看看会搬多少（默认）
 *   node scripts/cold-archive.mjs --apply          # 真搬
 *   node scripts/cold-archive.mjs --apply --age 90 --imp 0.35
 */
import { runColdArchive } from '../lib/scoring/cold-archive.mjs';

const argv = process.argv.slice(2);
const opt = {};
for (let i = 0; i < argv.length; i += 1) {
  const a = argv[i];
  if (a.startsWith('--')) {
    const k = a.slice(2);
    const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
    opt[k] = v;
  }
}
const r = runColdArchive({
  file: opt.file,
  coldFile: opt.cold,
  apply: opt.apply === true,
  ageDays: opt.age ? Number(opt.age) : undefined,
  impMax: opt.imp ? Number(opt.imp) : undefined,
});
console.log(JSON.stringify(r, null, 1));
process.exit(r.ok === false ? 1 : 0);
