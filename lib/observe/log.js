import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { compact } from './rotate.js';
import { dataPath } from '../paths.js';

/**
 * wake/miss 双日志器。
 * - 采样：wake 全量、miss 抽样（config.logs.missSampleRate）
 * - 上限：单文件 maxBytes，超了轮转一份历史
 * - 原子：写临时文件 + rename（Windows 先 unlink 目标）
 * - **永不抛**：日志失败不影响主流程
 */
export function createLogger(config, tag = 'unified-memory') {
  const dir = config?.dir || dataPath('logs');
  const maxBytes = config?.maxBytes ?? 2 * 1024 * 1024;
  const keep = config?.keepRotations ?? 1;
  const missRate = config?.missSampleRate ?? 0.2;
  let disabled = false;

  const safe = (fn) => { try { if (!disabled) fn(); } catch { /* 日志失败不阻断 */ } };

  function ensureDir() {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }

  function rotate(file) {
    try {
      if (!existsSync(file)) return;
      if (statSync(file).size <= maxBytes) return;
      const text = readFileSync(file, 'utf8');
      const next = compact(text, maxBytes, Math.floor(maxBytes / 4));
      const tmp = file + '.tmp';
      writeFileSync(tmp, next, 'utf8');
      const old = file + '.1';
      if (keep > 0 && existsSync(old)) { try { unlinkSync(old); } catch {} }
      if (existsSync(file)) { try { unlinkSync(file); } catch {} }
      renameSync(tmp, file);
    } catch { /* 轮转失败不阻断 */ }
  }

  function write(name, line) {
    const file = join(dir, name);
    ensureDir();
    appendFileSync(file, line.endsWith('\n') ? line : line + '\n', 'utf8');
    rotate(file);
  }

  return {
    wake(entry) { safe(() => write('wake.log', JSON.stringify({ t: new Date().toISOString(), ...entry }))); },
    miss(entry) {
      if (Math.random() > missRate) return;   // 抽样
      safe(() => write('miss.log', JSON.stringify({ t: new Date().toISOString(), ...entry })));
    },
    disable() { disabled = true; },
    get dir() { return dir; },
  };
}
