import { openSync, closeSync, writeSync, readFileSync, unlinkSync, statSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { HARD } from './types.js';

/**
 * 文件锁（红队第 6 条）。
 * 'wx' = O_CREAT|O_EXCL，Windows 上可用，原子。
 * ⚠️ 坑 5：进程崩溃锁不自动释放 ⇒ 必须靠 staleMs 清理。
 */
export function acquireLock(lockPath, opts = {}) {
  const staleMs = opts.staleMs ?? HARD.LOCK_STALE_MS;
  const now = Date.now();

  // 先查 stale
  if (existsSync(lockPath)) {
    try {
      const st = statSync(lockPath);
      const age = now - st.mtimeMs;
      if (age > staleMs) {
        unlinkSync(lockPath);   // 过期锁清掉
      } else {
        throw Object.assign(new Error('LockTimeout: 锁被占用（' + Math.round(age / 1000) + 's）'), { code: 'LockTimeout' });
      }
    } catch (e) {
      if (e.code === 'LockTimeout') throw e;
    }
  }

  mkdirSync(dirname(lockPath), { recursive: true });
  let fd;
  try {
    fd = openSync(lockPath, 'wx');
  } catch (e) {
    if (e.code === 'EEXIST') {
      throw Object.assign(new Error('LockTimeout: 竞争失败（另一个进程刚建锁）'), { code: 'LockTimeout' });
    }
    throw e;
  }
  writeSync(fd, JSON.stringify({ pid: process.pid, at: now }));
  closeSync(fd);
  return { path: lockPath, pid: process.pid, release: () => releaseLock(lockPath) };
}

export function releaseLock(lockPath) {
  try { if (existsSync(lockPath)) unlinkSync(lockPath); return true; }
  catch { return false; }
}

/** 读锁里的 pid（诊断用） */
export function peekLock(lockPath) {
  try { return JSON.parse(readFileSync(lockPath, 'utf8')); } catch { return null; }
}
