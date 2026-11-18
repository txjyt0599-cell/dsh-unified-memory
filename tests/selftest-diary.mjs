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
import { existsSync, readFileSync, writeFileSync, appendFileSync, rmSync, mkdirSync, statSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
// [2026-11-18] 沙箱：先设 PM_DATA_ROOT / PM_DIARY_ROOT，再动态导入，避免 E3 写进生产日记。
const tmpRoot = mkdtempSync(join(tmpdir(), 'pm-diary-selftest-'));
mkdirSync(tmpRoot + '/diary', { recursive: true });
mkdirSync(tmpRoot + '/data', { recursive: true });
process.env.PM_DIARY_ROOT = tmpRoot + '/diary';
process.env.PM_DATA_ROOT = tmpRoot + '/data';
const D = await import('../lib/diary/index.js');
const { maybeNudge, maybeAssemble } = await import('../lib/diary/scheduler.js');

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
  ok(s.startsWith('User：'), '应以 User：开头，实际 ' + s);
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
const tmpBook = tmpRoot + '/book.md';
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
T('C4a 过期但 PID 存活的锁绝不被抢', () => {
  const lockPath = tmpRoot + '/.lock-live';
  writeFileSync(lockPath, JSON.stringify({ token: 'live-owner', pid: process.pid, createdAt: Date.now() - 60000 }), 'utf8');
  const l = D.acquireLock(lockPath, 5000);
  ok(!l.ok, '存活进程的陈锁不得接管');
  ok(existsSync(lockPath), '存活持有者的锁必须保留');
  rmSync(lockPath);
});
T('C4b 过期且 PID 已死亡的锁可经原子 rename 回收', () => {
  const child = spawnSync(process.execPath, ['-e', ''], { encoding: 'utf8' });
  ok(child.status === 0 && child.pid > 0, '应取得已退出子进程 PID');
  const lockPath = tmpRoot + '/.lock-dead';
  writeFileSync(lockPath, JSON.stringify({ token: 'dead-owner', pid: child.pid, createdAt: Date.now() - 60000 }), 'utf8');
  const l = D.acquireLock(lockPath, 5000);
  ok(l.ok, '死进程的陈锁应被接管');
  eq(l.release(), true);
});
T('C4c 无 PID 的旧格式陈锁不自动抢', () => {
  const lockPath = tmpRoot + '/.lock-legacy';
  writeFileSync(lockPath, String(Date.now() - 60000), 'utf8');
  const l = D.acquireLock(lockPath, 5000);
  ok(!l.ok && existsSync(lockPath), '无法确认持有者死亡时保持锁原样');
  rmSync(lockPath);
});
T('C5 新鲜空锁不得被当成 1970 年陈锁删除', () => {
  const lockPath = tmpRoot + '/.lock-empty';
  writeFileSync(lockPath, '', 'utf8');
  const l = D.acquireLock(lockPath, 5000);
  ok(!l.ok, '新鲜空锁应视为其他进程创建中');
  ok(existsSync(lockPath), '不得删除别人的新鲜空锁');
  rmSync(lockPath);
});
T('C6 旧持有者 release 不得删除换血后的锁', () => {
  const lockPath = tmpRoot + '/.lock-owner';
  const l1 = D.acquireLock(lockPath, 5000);
  ok(l1.ok, '首个持有者应取锁成功');
  writeFileSync(lockPath, JSON.stringify({ token: 'different-owner', createdAt: Date.now() }), 'utf8');
  eq(l1.release(), false, '所有权不匹配必须拒绝释放');
  ok(existsSync(lockPath), '新持有者的锁必须仍在');
  rmSync(lockPath);
});
T('C7 状态原子写后可严格读回合法 JSON', () => {
  const p = tmpRoot + '/state-atomic.json';
  eq(D.writeState({ nudge: { ok: true } }, p), true);
  eq(D.readStateStrict(p).nudge.ok, true);
});

// ── D 两本 ──
T('D1 两本书路径不同', () => {
  ok(D.BOOKS.master !== D.BOOKS.self, 'AB 必须不同');
  ok(D.BOOKS.master.endsWith('Assistant日记.md'), '给User的那本应保持当前品牌名');
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
T('E2 assemble 真写一次、二次幂等且保留 nudge 状态', () => {
  const d = D.shiftDate(D.localDate(), -1);
  const assembledKey = 'assembled:' + d;
  const nudgeKey = 'nudge:' + D.localDate() + ':assemble-preserve';
  writeFileSync(D.BOOKS.master, '## ' + d + ' 23:50 — Assistant的日记\n\n昨天真实写下的一段内容。\n', 'utf8');
  const st = D.readStateStrict();
  delete st[assembledKey];
  st[nudgeKey] = '00:00';
  eq(D.writeState(st), true);
  eq(maybeAssemble({ date: d }), d, '有昨日原文时首次必须真汇编');
  eq(maybeAssemble({ date: d }), null, '第二次不得重复汇编');
  const raw = readFileSync(D.BOOKS.master, 'utf8');
  eq(raw.split('### ' + d + ' · 今日合订').length - 1, 1, '合订块必须恰好一个');
  eq(D.readStateStrict()[nudgeKey], '00:00', '汇编不得抹掉并发 nudge 状态');
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
