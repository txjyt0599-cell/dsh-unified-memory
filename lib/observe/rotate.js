/**
 * 日志轮转纯函数：不碰磁盘，便于单测。
 * 策略：超 maxBytes 时保留**尾部** targetBytes（最新） + 一行省略标记。
 */
export function compact(text, maxBytes, targetBytes) {
  const src = String(text ?? '');
  const bytes = (s) => Buffer.byteLength(s, 'utf8');
  if (bytes(src) <= maxBytes) return src;
  const marker = '…(前段已轮转)\n';
  let keep = src;
  // 从尾部按字节裁，避免切碎 UTF-8
  while (bytes(keep) > targetBytes && keep.length > 0) {
    keep = keep.slice(Math.max(1, Math.floor(keep.length * 0.1)));
  }
  return marker + keep;
}
