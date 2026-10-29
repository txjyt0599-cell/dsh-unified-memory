/**
 * 用真实 schema 校验器验证三个工具能否通过注册。
 * 判据来自运行时错误信息：must declare output { schema, render, presentationMeta? }
 */
import { createLedger } from 'file:///D:/dsh-plugins/dsh-unified-memory/lib/dispatch/ledger.js';
import { createDispatchTools } from 'file:///D:/dsh-plugins/dsh-unified-memory/lib/dispatch/tool.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'schema-'));
const ledger = createLedger({ path: join(tmp, 'l.json') });
const tools = createDispatchTools({ ledger, sendMessage: async () => ({}), getAgents: () => [], getSessionEvents: () => [] });

console.log('=== 三个工具的声明完整性 ===');
let allOk = true;
for (const t of tools) {
  const hasName = typeof t.name === 'string' && t.name.length > 0;
  const hasDesc = typeof t.description === 'string' && t.description.length > 0;
  const hasParams = t.parameters && t.parameters.type === 'object';
  const hasOutput = t.output && typeof t.output === 'object';
  const hasSchema = hasOutput && t.output.schema && typeof t.output.schema === 'object';
  const hasRender = hasOutput && typeof t.output.render === 'function';
  const hasExec = typeof t.execute === 'function';
  const ok = hasName && hasDesc && hasParams && hasSchema && hasRender && hasExec;
  if (!ok) allOk = false;
  console.log('  ' + (ok ? '✓' : '✗') + ' ' + t.name +
    ' | schema=' + (hasSchema ? 'Y' : 'N') + ' render=' + (hasRender ? 'Y' : 'N') +
    ' params=' + (hasParams ? 'Y' : 'N') + ' exec=' + (hasExec ? 'Y' : 'N'));
}

// 验证 render 真的能跑
console.log('\n=== render 能否正常输出 ===');
for (const t of tools) {
  try {
    const sample = t.name === 'dispatch_send' ? { ok: true, taskId: 'T1', status: 'confirmed', messageId: 'm1' }
      : t.name === 'dispatch_scan' ? { ok: true, count: 1, items: [{ taskId: 'T1', state: 'in_progress', reason: 'r' }] }
      : { ok: true, closed: { taskId: 'T1' } };
    const out = t.output.render({}, sample);
    const isText = Array.isArray(out) && out[0] && out[0].type === 'text' && typeof out[0].text === 'string';
    if (!isText) allOk = false;
    console.log('  ' + (isText ? '✓' : '✗') + ' ' + t.name + ': ' + JSON.stringify(out[0].text.slice(0, 60)));
  } catch (e) {
    allOk = false;
    console.log('  ✗ ' + t.name + ' render 抛错: ' + e.message);
  }
}

// ── [2026-10-28 by Assistant · 线上实测补的守门项] ──
//   线上真实报错：unsupported JSON schema: schema.properties.messageId.type must be
//   a single type string (type arrays are not supported)
//   ⇒ DSH 的 schema 校验器**不接受联合类型**（type: ['string','null']）。
//   我原来的测试只验"能序列化 + type=object"，压根查不到这个 —— 又一次"检查太浅"。
//   ⇒ 补：递归扫全 schema，任何 type 是数组的一律判红。
function findTypeArrays(node, path, out) {
  if (node === null || typeof node !== 'object') return;
  if (Array.isArray(node)) { node.forEach(function (v, i) { findTypeArrays(v, path + '[' + i + ']', out); }); return; }
  if (node.type !== undefined && Array.isArray(node.type)) out.push(path + '.type=' + JSON.stringify(node.type));
  for (const k of Object.keys(node)) {
    if (k === 'type') continue;
    findTypeArrays(node[k], path + '.' + k, out);
  }
}

console.log('\n=== schema 合法性（含 DSH 兼容性）===');
for (const t of tools) {
  try {
    const s = JSON.stringify(t.output.schema);
    const parsed = JSON.parse(s);
    const isObj = parsed && parsed.type === 'object';
    const badTypes = [];
    findTypeArrays(parsed, t.name, badTypes);
    const ok = isObj && badTypes.length === 0;
    if (!ok) allOk = false;
    console.log('  ' + (ok ? '✓' : '✗') + ' ' + t.name +
      ' type=object:' + (isObj ? 'Y' : 'N') +
      ' 联合类型:' + (badTypes.length ? '⛔ ' + badTypes.join('; ') : '无') +
      ' (' + s.length + ' 字节)');
  } catch (e) {
    allOk = false;
    console.log('  ✗ ' + t.name + ' schema 序列化失败: ' + e.message);
  }
}

try { rmSync(tmp, { recursive: true, force: true }); } catch {}
console.log('\n结论:', allOk ? '✅ 三个工具声明完整，render 可跑，schema 合法' : '❌ 仍有问题');
process.exit(allOk ? 0 : 1);
