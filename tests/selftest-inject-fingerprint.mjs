#!/usr/bin/env node
/**
 * selftest-inject-fingerprint.mjs —— 消息尾去重指纹（R3-P0-2 真实长度版）
 *
 * 旧实现只取 slice(100,220)+slice(-180)：生产 3.5K~5K 文本会漏掉中间 hot 块。
 * 本测试用真实长度（L0≥1500、hot≈400、pulse≥500）+ 多步消息（只有 hot+pulse）验证。
 */
import assert from 'node:assert/strict';
import {
  contentTextOf, messagesHaveBlock, trimInjectedBlocks, injectionBlockHashes, extractInjectionBlock,
  mergeInjectionHashes, injectionHashesMatch, injectionFingerprint,
} from '../lib/inject-fingerprint.js';

let pass = 0, fail = 0;
const fails = [];
function check(name, fn) {
  try { fn(); pass++; console.log('  PASS ' + name); }
  catch (e) { fail++; fails.push(name); console.log('  FAIL ' + name + '  ' + (e && e.message || e)); }
}

const l0Body = 'L0正文段落。'.repeat(220);           // 约 1540 字
const hotBody = '热区条目内容。'.repeat(58);         // 约 464 字
const pulseBody = '脉搏条目内容。'.repeat(70);        // 约 560 字
const l0 = '<unified-memory>\n' + l0Body + '\n</unified-memory>';
const hot = '<hot-memory>\n' + hotBody + '\n</hot-memory>';
const pulse = '<cross-session-pulse>\n' + pulseBody + '\n</cross-session-pulse>';
const full = l0 + '\n' + hot + '\n' + pulse;
const content = [{ type: 'text', text: full }];
const s2 = JSON.stringify(content);

check('I1 真实长度下完整提取三段块', () => {
  const block = extractInjectionBlock(contentTextOf(content));
  assert.equal(block.replace(/\\n/g, '\n'), full);
  assert.ok(block.includes('<hot-memory>') && block.includes('<cross-session-pulse>'));
});
check('I2 同块三段哈希完全相等', () => {
  const h = injectionBlockHashes(full);
  assert.ok(h.l0 && h.hot && h.pulse);
  assert.ok(injectionHashesMatch(injectionBlockHashes(extractInjectionBlock(contentTextOf(content))), h));
});
check('I3 中间 hot 块 403 字节变化必须被识别（旧 slice 指纹会碰撞）', () => {
  const changedHot = hot.replace('热区条目内容。', '热区条目改动！');
  const changed = l0 + '\n' + changedHot + '\n' + pulse;
  const oldFp = function (t) { const s = String(t).replace(/\\n/g, '\n').replace(/\s+/g, ' '); return s.slice(100, 220) + '|' + s.slice(-180); };
  assert.equal(oldFp(full), oldFp(changed), 'old slice fingerprint should collide');
  assert.ok(!injectionHashesMatch(injectionBlockHashes(changed), injectionBlockHashes(full)));
});
check('I4 pulse 块变化被识别', () => {
  const changed = full.replace('脉搏条目内容。', '脉搏条目改动！');
  assert.ok(!injectionHashesMatch(injectionBlockHashes(changed), injectionBlockHashes(full)));
});
check('I5 无 L0 的 hot+pulse 消息 + 另一条 L0 消息可合并匹配', () => {
  const hotPulseOnly = hot + '\n' + pulse;
  const merged = mergeInjectionHashes([
    injectionBlockHashes(l0),
    injectionBlockHashes(hotPulseOnly),
  ]);
  assert.ok(injectionHashesMatch(merged, injectionBlockHashes(full)));
});
check('I7 引号/反斜杠原始 content 不被 JSON 转义破坏', () => {
  const special = '<unified-memory>\nC:\\Users\\Administrator\\"引号卡"\n</unified-memory>';
  const c = [{ type: 'text', text: special }];
  const oldEscaped = extractInjectionBlock(JSON.stringify(c));
  const raw = extractInjectionBlock(contentTextOf(c));
  assert.ok(!injectionHashesMatch(injectionBlockHashes(oldEscaped), injectionBlockHashes(special)), 'old JSON.stringify path should mismatch');
  assert.ok(injectionHashesMatch(injectionBlockHashes(raw), injectionBlockHashes(special)), 'raw content path should match');
});
check('I8 diary-nudge 去重扫全量历史（不能只看最近4条）', () => {
  const history = Array.from({ length: 10 }, function (_, i) { return { role: 'user', content: [{ type: 'text', text: '普通消息' + i }] }; });
  history[0] = { role: 'user', content: [{ type: 'text', text: '<diary-nudge>old</diary-nudge>' }] };
  assert.equal(history.slice(-4).some(m => contentTextOf(m.content).includes('<diary-nudge>')), false);
  assert.equal(messagesHaveBlock(history, '<diary-nudge>'), true);
});
check('I9 增量注入只剥离未变化的块', () => {
  const fullHashes = injectionBlockHashes(full);
  assert.equal(trimInjectedBlocks(full, fullHashes), '');
  const changedHot = full.replace('热区条目内容。', '热区条目改动！');
  const onlyL0 = { l0: fullHashes.l0, hot: '', pulse: '' };
  const r1 = trimInjectedBlocks(changedHot, onlyL0);
  assert.ok(r1.includes('<hot-memory>') && !r1.includes('<unified-memory>'));
  const onlyHot = { l0: '', hot: fullHashes.hot, pulse: '' };
  const r2 = trimInjectedBlocks(full, onlyHot);
  assert.ok(r2.includes('<unified-memory>') && !r2.includes('<hot-memory>'));
});
check('I10 ongoing-thread 纳入哈希与增量剥离', () => {
  const ongoing = '<ongoing-thread>\n旧局势快照\n</ongoing-thread>';
  const withOngoing = full + '\n' + ongoing;
  const h = injectionBlockHashes(withOngoing);
  assert.ok(h.ongoing);
  assert.equal(trimInjectedBlocks(withOngoing, h), '');
  const changed = withOngoing.replace('旧局势快照', '新局势快照');
  const r = trimInjectedBlocks(changed, injectionBlockHashes(full));
  assert.ok(r.includes('<ongoing-thread>') && !r.includes('<unified-memory>'));
});
check('I11 跨轮合并保旧 hot/pulse，不整包清零', () => {
  const prior = injectionBlockHashes(full);
  const step2 = l0.replace('L0正文段落。', 'L0正文段落B。');
  const merged = mergeInjectionHashes([prior, injectionBlockHashes(step2)]);
  assert.ok(merged.hot && merged.pulse, '旧 hot/pulse 必须保留');
  const step3 = step2 + '\n' + hot;
  const r = trimInjectedBlocks(step3, merged);
  assert.ok(!r.includes('<hot-memory>'), '同 HOT-1 不应重复注入');
  assert.ok(!r.includes('<unified-memory>'), '已注入的 L0_B 不应重复注入');
});
check('I6 兼容旧 API 的 fingerprint 返回三段 JSON', () => {
  const fp = JSON.parse(injectionFingerprint(full));
  assert.ok(fp.l0 && fp.hot && fp.pulse);
});

console.log('');
console.log('INJECT-FINGERPRINT-DONE checks=' + (pass + fail) + ' passed=' + pass + ' failed=' + fail);
if (fail > 0) { console.log('失败项: ' + fails.join(', ')); process.exit(1); }
