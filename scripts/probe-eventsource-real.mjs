/**
 * 用真实运行环境验证事件源（只读）。
 * 本轮团队只有 lead，无法发真实派单 ⇒ 改为验证「事件源在当前 DSH 里到底能不能读」。
 */
import fs from 'node:fs';
import path from 'node:path';
import { zstdDecompressSync } from 'node:zlib';

const ROOT = '~/.dsh/sessions';
// 找本会话（最近修改的）
let best = null;
function walk(d, depth) {
  if (depth > 3) return;
  let ents = []; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p, depth + 1);
    else if (/\.zstd$/.test(e.name)) {
      try {
        const st = fs.statSync(p);
        if (!best || st.mtimeMs > best.mtime) best = { p, mtime: st.mtimeMs, size: st.size };
      } catch {}
    }
  }
}
walk(ROOT, 0);
console.log('最新会话文件:', best && best.p.split('sessions')[1]);
console.log('  size:', best && best.size, 'mtime:', best && new Date(best.mtime).toLocaleTimeString('zh-CN'));

if (best) {
  const raw = zstdDecompressSync(fs.readFileSync(best.p)).toString('utf8');
  const evs = [];
  for (const L of raw.split('\n')) { if (!L.trim()) continue; try { evs.push(JSON.parse(L)); } catch {} }
  console.log('  事件总数:', evs.length);
  const types = {};
  for (const e of evs) types[e.type] = (types[e.type] || 0) + 1;
  console.log('  事件类型分布（前 6）:', Object.entries(types).sort((a,b)=>b[1]-a[1]).slice(0,6).map(([k,v])=>k+'='+v).join(' '));

  // 用 sliceNewEvents 真跑一遍：取最近 10 条之后作为"新增"
  const { sliceNewEvents } = await import('file:///D:/dsh-plugins/dsh-unified-memory/lib/dispatch/event-source.js');
  const cut = Math.max(0, evs.length - 10);
  const sliced = sliceNewEvents(evs, { eventCountBefore: cut });
  console.log('\nsliceNewEvents(eventCountBefore=' + cut + ') 结果:', sliced.length, '条（预期 10）');
  console.log('判定:', sliced.length === 10 ? '✅ 切片正确' : '❌ 切片异常');

  // 找一个真实的 user/message 的 messageId 做定位测试
  const withMid = evs.filter(e => e.type === 'user/message').find(e => {
    const m = (e.data && e.data.message) || e.data;
    return m && m.source && m.source.messageId;
  });
  if (withMid) {
    const m = (withMid.data && withMid.data.message) || withMid.data;
    const sid = m.source.messageId;
    const idx = evs.indexOf(withMid);
    const s2 = sliceNewEvents(evs, { messageId: sid });
    console.log('\n按真实 messageId 定位:', String(sid).slice(0, 40));
    console.log('  该消息位于第', idx, '条；切片结果', s2.length, '条（预期', evs.length - idx - 1, '）');
    console.log('  判定:', s2.length === evs.length - idx - 1 ? '✅ 定位正确' : '❌ 定位异常');
  } else {
    console.log('\n（会话里没有带 messageId 的 user/message —— 无真实团队消息，跳过定位测试）');
  }
}
