/**
 * scripts/compact-engrams.mjs —— 卡片库压缩（同 id 只留最后一行）
 * [2026-10-24 by Assistant] 教训：
 *   回填 importance 时我用了「追加版本行」的手法（LWW 读方语义没错），
 *   但 selftest-p3 的 alive 判据是**按行数**数的 ⇒ 文件 6500 行变 12110 行
 *   ⇒ alive 翻倍 ⇒ C6/C10 全错。
 *
 *   追加只适合**低频的运行时更新**（hits/转发），不适合批量回填。
 *   批量回填应该**原位压缩**：同 id 只保留最后一行。
 *
 * 用法：node scripts/compact-engrams.mjs [--file <path>] [--dry]
 */
import { readFileSync, writeFileSync, renameSync, existsSync, copyFileSync, mkdirSync, statSync } from 'node:fs';
import { dataPath } from '../lib/paths.js';

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

const FILE = String(opt.file || dataPath('engram-relay/engrams.jsonl'));
if (!existsSync(FILE)) { console.error('找不到：' + FILE); process.exit(1); }

const before = statSync(FILE).size;
const raw = readFileSync(FILE, 'utf8');
const lines = raw.split(/\r?\n/).filter(Boolean);
const byId = new Map();
let noId = 0, bad = 0;
for (const line of lines) {
  let o; try { o = JSON.parse(line); } catch { bad++; continue; }
  if (!o || o.id === undefined || o.id === null) { noId++; continue; }
  byId.set(String(o.id), line);   // 后写覆盖先写
}
const kept = Array.from(byId.values());
const aliveCount = kept.filter((l) => { try { return (JSON.parse(l).status || 'active') !== 'retired'; } catch { return false; } }).length;

console.log('原行数:', lines.length, '字节:', before);
console.log('  坏行:', bad, ' 无 id:', noId);
console.log('  去重后:', kept.length, '（活卡', aliveCount + '）');
console.log('  预计字节:', Buffer.byteLength(kept.join('\n') + '\n'));

if (opt.dry === true) { console.log('（--dry：不落盘）'); process.exit(0); }

// 备份 + 原子写
const dir = dataPath('diary/backups');
try { mkdirSync(dir, { recursive: true }); } catch {}
const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
try { copyFileSync(FILE, dir + '/engrams-before-compact-' + ts + '.jsonl'); } catch (e) { console.error('备份失败，停止：', e.message); process.exit(1); }

const tmp = FILE + '.compact.tmp';
writeFileSync(tmp, kept.join('\n') + '\n', 'utf8');
renameSync(tmp, FILE);   // Windows 下 rename 会覆盖目标
const after = statSync(FILE).size;
console.log('已压缩 →', FILE, '(' + before + ' → ' + after + ' 字节)');
