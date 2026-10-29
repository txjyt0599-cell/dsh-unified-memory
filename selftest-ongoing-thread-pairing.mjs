/**
 * selftest-ongoing-thread-pairing.mjs —— 交接问答配对验收（2026-10-28）
 *
 * ## User指出的真 bug
 *   旧实现各自找"最后一条 user"和"最后一条 assistant"：
 *     lastUser = reverse().find(role==='user')
 *     lastAsst = reverse().find(role==='assistant')
 *   两个"最后"独立找 ⇒ **不保证是一对**。
 *   而且Assistant一轮里会分多次回复 ⇒ "最后一条 assistant"常是过程句，不是答案。
 *
 *   ⚠️ 更严重的形态（User原话）：
 *     「记录的回答是上一个，我提问的记录却是我下个会话新触发的问」
 *     = 问来自新一轮、答还是旧一轮的 —— 典型的错配。
 *
 * ## 反例（必须能抓到）
 *   P1 一轮里问→答A→答B→答C：必须取"答C"（同轮最后一句），且问=那轮的问
 *   P2 提问之后**没有**回答（会话被打断）：vibe 必须空，**绝不许回退拿上一轮的答**
 *   P3 两轮连续：必须取后一轮的问 + 后一轮的答（不能跨轮）
 */
import { writeOngoingThread } from './lib/ingest/distill.js';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let pass = 0, fail = 0;
const fails = [];
function check(g, name, ok, detail) {
  if (ok) { pass++; console.log('  PASS ' + name + (detail ? '   ' + detail : '')); }
  else { fail++; fails.push(name); console.log('  FAIL ' + name + (detail ? '   ' + detail : '')); }
}

console.log('════ ONGOING-THREAD 问答配对验收 ════');
const tmp = mkdtempSync(join(tmpdir(), 'thread-'));
function run(fresh) {
  // [2026-10-28 加固] 变异/异常时 writeOngoingThread 可能返回 null 或不写文件，
  //   直接 JSON.parse 会抛错把整个测试带崩（今天第 N 次"测试崩了报绿"）。
  //   ⇒ 这里统一兜底：拿不到就当 {} 返回，让断言去判，不许崩。
  const root = mkdtempSync(join(tmp, 'r-'));
  let r = null;
  try { r = writeOngoingThread({ root, fresh, sessionId: 's1', nowIso: new Date().toISOString() }); }
  catch (e) { r = { ok: false, reason: 'threw:' + String(e && e.message || e) }; }
  const f = join(root, 'ongoing-thread.json');
  let t = {};
  try { t = JSON.parse(readFileSync(f, 'utf8')); } catch { t = {}; }
  return { r: r || { ok: false, reason: 'null-return' }, t };
}

// ── P1 · 一次问、多次答 ──
console.log('\n── P1 · 一轮多答 ──');
{
  const { r, t } = run([
    { role: 'user', content: 'User的问题A' },
    { role: 'assistant', content: '回答第一段' },
    { role: 'assistant', content: '回答第二段' },
    { role: 'assistant', content: '回答结论段' },
  ]);
  check('P1', 'P1a 写入成功', r.ok === true, JSON.stringify(r));
  check('P1', 'P1b 问 = 那轮的提问', String(t.pending).includes('问题A'), t.pending);
  check('P1', 'P1c 答 = 同轮最后一句', String(t.vibe).includes('结论段'), t.vibe);
}

// ── P2 · 提问后没有回答（关键反例）──
console.log('\n── P2 · 提问后无回答（不许回退拿旧答）──');
{
  const { t } = run([
    { role: 'user', content: '上一轮的问题OLD' },
    { role: 'assistant', content: '上一轮的回答OLD' },
    { role: 'user', content: '这一轮的新问题NEW' },   // ← 之后没有 assistant
  ]);
  check('P2', 'P2a 问 = 新问题', String(t.pending).includes('新问题NEW'), t.pending);
  check('P2', 'P2b 答必须为空（绝不许拿上一轮的"上一轮的回答OLD"）',
    String(t.vibe || '') === '', JSON.stringify(t.vibe));
  check('P2', 'P2c 答里不许出现旧回答', !String(t.vibe || '').includes('OLD'), t.vibe);
}

// ── P3 · 两轮连续，不能跨轮 ──
console.log('\n── P3 · 两轮连续 ──');
{
  const { t } = run([
    { role: 'user', content: '第一轮问' },
    { role: 'assistant', content: '第一轮答' },
    { role: 'user', content: '第二轮问' },
    { role: 'assistant', content: '第二轮答' },
  ]);
  check('P3', 'P3a 问 = 第二轮问', String(t.pending).includes('第二轮问'), t.pending);
  check('P3', 'P3b 答 = 第二轮答', String(t.vibe).includes('第二轮答'), t.vibe);
  check('P3', 'P3c 不串到第一轮', !String(t.vibe).includes('第一轮答'), t.vibe);
}

// ── P4 · 没有 user ──
console.log('\n── P4 · 无提问 ──');
{
  const { r } = run([{ role: 'assistant', content: '只有回答' }]);
  check('P4', 'P4a 返回 no-user（不许抛错）',
    r && r.ok === false && /no-user/.test(String(r.reason || '')), String((r && r.reason) || ''));
}

// ── P6 · 脏数据清洗（2026-10-28 实测抓到）──
//   现象：vibe = "vcp-root{box-sizing:border-box;pad"
//   —— <style> 标签删了，但**块内 CSS 文本**漏网。
console.log('\n── P6 · CSS/HTML 清洗 ──');
{
  const dirty = '<div id="vcp-root" style="background:#fff"><style>#vcp-root{box-sizing:border-box;padding:26px}</style>~做好了<div class="x">第二句</div></div>';
  const { t } = run([
    { role: 'user', content: '问问题' },
    { role: 'assistant', content: dirty },
  ]);
  check('P6', 'P6a CSS 声明已清干净', !/box-sizing|padding:/.test(String(t.vibe || '')), t.vibe);
  check('P6', 'P6b HTML 标签已清干净', !/<[a-z]/.test(String(t.vibe || '')), t.vibe);
  check('P6', 'P6c 人话保留住了', /|做好了/.test(String(t.vibe || '')), t.vibe);
  check('P6', 'P6d 第二句也在（不是只剩第一段）', /第二句/.test(String(t.vibe || '')), t.vibe);
}

// ── P7 · SVG 内部路径也是噪音 ──
console.log('\n── P7 · SVG 清洗 ──');
{
  const dirty = '<svg viewBox="0 0 24 24"><path d="M12 2L2 7l10 5 10-5-10-5z"/></svg>这是要说的话';
  const { t } = run([
    { role: 'user', content: '问' },
    { role: 'assistant', content: dirty },
  ]);
  check('P7', 'P7a SVG 路径数据已清', !/M12 2L2|viewBox/.test(String(t.vibe || '')), t.vibe);
  check('P7', 'P7b 人话保留', /这是要说的话/.test(String(t.vibe || '')), t.vibe);
}

// ── P5 · 源码断言：不许再各找各的 ──
console.log('\n── P5 · 源码不许回退 ──');
{
  const SRC = readFileSync('D:/dsh-plugins/dsh-unified-memory/lib/ingest/distill.js', 'utf8');
  const CODE = SRC.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  check('P5', 'P5a 用 lastUserIdx 定位后再找答', /lastUserIdx/.test(CODE));
  check('P5', 'P5b 只在提问之后找答（i > lastUserIdx）', /i > lastUserIdx/.test(CODE));
}

try { rmSync(tmp, { recursive: true, force: true }); } catch {}

console.log('\n════ SUMMARY ════');
console.log('  pass=' + pass + ' fail=' + fail);
if (fail) console.log('  失败项: ' + fails.join(' | '));
process.exit(fail ? 1 : 0);
