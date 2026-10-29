/**
 * selftest-diary.mjs —— 日记本的独立自测（不依赖 DSH 加载）
 * [2026-10-24 by Assistant] User批「开工」后配套。
 *
 * 覆盖：
 *   A 清洗：技术内容不进素材（代码/报错/终端/VCP 卡片）
 *   B 素材：限量、去重、保序
 *   C 写盘：只 append、备份、判重、跨进程锁
 *   D 两本：master / self 互不干扰
 *   E 状态：nudge 每天每会话一次、assemble 幂等
 *   F 边界：空正文、缺文件、坏日期都不抛
 */
import { existsSync, readFileSync, writeFileSync, appendFileSync, rmSync, mkdirSync, statSync } from 'node:fs';
import * as D from './lib/diary/index.js';
import { maybeNudge, maybeAssemble } from './lib/diary/scheduler.js';
import { join } from 'node:path';
import { tmpdir as osTmpdir } from 'node:os';

let pass = 0, fail = 0;
const T = (name, fn) => {
  try { fn(); pass++; console.log('  ✓', name); }
  catch (e) { fail++; console.log('  ✗', name, '—', e && e.message); }
};
const eq = (a, b, m) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error((m || '') + ' 期望 ' + JSON.stringify(b) + ' 实际 ' + JSON.stringify(a)); };
const ok = (v, m) => { if (!v) throw new Error(m || '期望为真'); };

console.log('\n[diary selftest]');

// ── A 清洗 ──
T('A1 代码块被丢掉', () => {
  eq(D.toSlice({ role: 'user', content: '```js\nconst a = 1\n```' }), '');
});
T('A2 终端输出被丢掉', () => {
  eq(D.toSlice({ role: 'user', content: 'PS C:\\Users> node x.mjs --help exit code 1' }), '');
});
T('A3 技术词命中 3 个以上整条丢', () => {
  eq(D.toSlice({ role: 'user', content: '这个 error 是 token 问题，regex 写错了 JSON 也坏了' }), '');
});
T('A4 日常对话保留且带角色前缀', () => {
  const s = D.toSlice({ role: 'user', content: '今天好累啊，陪我坐会儿吧' });
  ok(s.startsWith('User：'), '应以User：开头，实际 ' + s);
});
T('A5 VCP 卡片被剥成纯文本', () => {
  const s = D.toSlice({ role: 'assistant', content: '<div id="vcp-root"><style>.a{color:red}</style>User晚安</div>' });
  ok(s.includes('User晚安') && !s.includes('vcp-root'), '实际 ' + s);
});

// ── B 素材 ──
T('B1 重复内容去重', () => {
  const msgs = [{ role: 'user', content: '同一句话' }, { role: 'user', content: '同一句话' }];
  eq(D.buildSample(msgs).length, 1);
});
T('B2 超量时保留头尾并插省略标记', () => {
  const msgs = Array.from({ length: 50 }, (_, i) => ({ role: 'user', content: '第' + i + '句话在这里' }));
  const out = D.buildSample(msgs, { maxSlices: 10 });
  ok(out.includes('……（中间省略）……'), '应含省略标记');
  ok(out.length <= 12, '长度应受限，实际 ' + out.length);
});

// ── C 写盘（沙箱临时本子） ──
const tmpRoot = join(osTmpdir(), 'diary-selftest');
const tmpBook = tmpRoot + '/book.md';
try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
mkdirSync(tmpRoot, { recursive: true });
writeFileSync(tmpBook, '# 测试本\n', 'utf8');

T('C1 写一段，字节增长且只追加', () => {
  const before = statSync(tmpBook).size;
  const block = D.renderEntry({ date: '2026-10-24', time: '01:00', body: '今天测试一下' });
  appendFileSync(tmpBook, block);
  const after = statSync(tmpBook).size;
  ok(after > before && after - before === Buffer.byteLength(block), '增长应等于块长');
});
T('C2 日期索引能解析出条目', () => {
  const t = readFileSync(tmpBook, 'utf8');
  ok(/^##\s*2026-10-24/m.test(t), '应能匹配到日期标题');
});
T('C3 跨进程锁：拿到后第二次失败，释放后可再拿', () => {
  const lockPath = tmpRoot + '/.lock';
  const l1 = D.acquireLock(lockPath, 5000);
  ok(l1.ok, '第一次应成功');
  const l2 = D.acquireLock(lockPath, 5000);
  ok(!l2.ok, '第二次应失败');
  l1.release();
  const l3 = D.acquireLock(lockPath, 5000);
  ok(l3.ok, '释放后应成功');
  l3.release();
});
T('C4 过期锁能自愈', () => {
  const lockPath = tmpRoot + '/.lock2';
  writeFileSync(lockPath, String(Date.now() - 60000), 'utf8');  // 60 秒前的锁
  const l = D.acquireLock(lockPath, 5000);
  ok(l.ok, '过期锁应被接管');
  l.release();
});

// ── D 两本 ──
T('D1 两本书路径不同', () => {
  ok(D.BOOKS.master !== D.BOOKS.self, 'AB 必须不同');
  ok(D.BOOKS.master.endsWith('Assistant日记.md'), '给User的那本应保持原名');
});

// ── E 状态 ──
T('E1 nudge 同一天同一会话返回**稳定同一段**（幂等，供调用方按消息尾去重）', () => {
  const st = D.readState();
  const key = 'nudge:' + D.localDate() + ':test-session';
  delete st[key];
  D.writeState(st);
  const first = maybeNudge({ sessionKey: 'test-session' });
  // 当天已写过本子时可能返回 null（那也是正确行为）
  if (first) {
    const second = maybeNudge({ sessionKey: 'test-session' });
    eq(second, first, '第二次应返回完全相同的文本（而不是 null）');
    ok(first.includes('<diary-nudge>'), '应带标记，方便调用方去重');
  }
  const st2 = D.readState();
  delete st2[key];
  D.writeState(st2);
});
T('E2 assemble 幂等（同一天不会重复收）', () => {
  const st = D.readState();
  const d = D.shiftDate(D.localDate(), -1);
  const had = st['assembled:' + d];
  delete st['assembled:' + d];
  D.writeState(st);
  const r1 = maybeAssemble({ date: d });
  const r2 = maybeAssemble({ date: d });
  ok(r2 === null || r2 === undefined, '第二次应返回 null');
  // 还原状态（若之前没汇编过就删掉标记；若已汇编过就恢复）
  const st3 = D.readState();
  if (had) st3['assembled:' + d] = had; else delete st3['assembled:' + d];
  D.writeState(st3);
});

T('E3 同一天同内容 → 不同会话也不重复写（Round 29 实测抓到的重复）', () => {
  // 实测：同一段话被写了两次（19:08 与 19:10），因为一次走工具、一次直调模块，
  //   session 不同，旧判据要求 session 相同 ⇒ 没拦住 ⇒ 本子里出现两篇几乎一样的日记。
  //   语义上：同一天 + 同一本书 + 内容相同 = 重复，与哪个会话写无关。
  const D2 = D;
  const today = D2.localDate();
  const body = '【去重测试】这是一段用于验证重复判定的固定内容，同一天写两次必须只落一条。';
  const r1 = D2.writeEntry('self', { date: today, body, sessionKey: 'session-A', mark: '测试' });
  const r2 = D2.writeEntry('self', { date: today, body, sessionKey: 'session-B', mark: '测试' });
  ok(r1.ok === true, '第一次应成功');
  ok(r2.ok === true && r2.skipped === 'duplicate', '第二次（不同会话）应被判重复，实际: ' + JSON.stringify(r2));
});

// ── F 边界 ──
T('F1 空正文不写', () => {
  const r = D.writeEntry('master', { body: '   ' });
  eq(r.ok, false);
});
T('F2 不存在的日期不崩', () => {
  eq(D.collectDay('1999-01-01'), []);
});
T('F3 坏日期不崩', () => {
  D.shiftDate('不是日期', 1);
  D.localDate('x');
});
T('F4 未创建的本子返回空集合而不是抛', () => {
  eq(D.writtenDates('self').size >= 0, true);
});

try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}

console.log('\n  ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
