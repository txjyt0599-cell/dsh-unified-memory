#!/usr/bin/env node
/**
 * e2e-tool-output-json.mjs —— 工具返回值必须是无损 JSON
 * [2026-10-24 by Assistant · Round 26 真机抓到的 bug]
 *
 * 症状：重启后第一次真调 diary_write，报
 *   "tool returned invalid output: value is not lossless JSON"
 *
 * 根因：writeEntry 失败分支只返回 { ok:false, reason }，
 *   而工具层直接透传 r.delta / r.file / r.skipped ⇒ 对象里带 undefined
 *   ⇒ DSH 的 ToolDefinition 要求「无损 JSON」，undefined 不合法。
 *
 * 这个测试**遍历两个工具的所有分支**，把返回值塞进 JSON.stringify 检查
 * 往返是否无损（undefined 会被静默丢掉，所以要比对 key 数量）。
 */
import { createDiaryTools } from '../lib/diary/tool.js';

let fail = 0;
const check = (n, ok, d) => { console.log((ok ? '  ✅ ' : '  ❌ ') + n + (d ? '   ' + d : '')); if (!ok) fail++; };

/** 往返检查：stringify 后 parse，key 集合必须一致（undefined 会在 stringify 时被丢弃） */
function lossless(obj, label) {
  if (obj === undefined) return { ok: false, why: '返回值本身是 undefined' };
  const s = JSON.stringify(obj);
  if (s === undefined) return { ok: false, why: 'JSON.stringify 返回 undefined' };
  let back;
  try { back = JSON.parse(s); } catch (e) { return { ok: false, why: '无法 parse: ' + e.message }; }
  const keys = (o) => (o && typeof o === 'object' ? Object.keys(o).sort().join(',') : typeof o);
  const k1 = keys(obj), k2 = keys(back);
  if (k1 !== k2) return { ok: false, why: 'key 不一致（' + k1 + ' vs ' + k2 + '）⇒ 有 undefined 被丢了' };
  // 递归查 undefined
  const hasUndef = (o) => {
    if (o === undefined) return true;
    if (o === null || typeof o !== 'object') return false;
    return Object.values(o).some(hasUndef);
  };
  if (hasUndef(obj)) return { ok: false, why: '对象里含 undefined 值' };
  return { ok: true };
}

/** 严格 Schema 类型校验：模拟 DSH 运行时的 output.schema 检查（防止把 null 传给 type:'string'） */
function checkSchema(val, schema, path = 'value') {
  if (!schema) return { ok: true };
  if (schema.type === 'object') {
    if (typeof val !== 'object' || val === null || Array.isArray(val)) {
      return { ok: false, why: path + ' must be an object' };
    }
    const props = schema.properties || {};
    for (const [k, v] of Object.entries(val)) {
      if (schema.additionalProperties === false && !props[k]) {
        return { ok: false, why: path + '.' + k + ' is not allowed by additionalProperties:false' };
      }
      if (props[k]) {
        const res = checkSchema(v, props[k], path + '.' + k);
        if (!res.ok) return res;
      }
    }
    if (Array.isArray(schema.required)) {
      for (const req of schema.required) {
        if (val[req] === undefined) return { ok: false, why: path + '.' + req + ' is required' };
      }
    }
    return { ok: true };
  }
  if (schema.type === 'string') {
    if (typeof val !== 'string') return { ok: false, why: path + ' must be a string (got ' + (val === null ? 'null' : typeof val) + ')' };
    return { ok: true };
  }
  if (schema.type === 'boolean') {
    if (typeof val !== 'boolean') return { ok: false, why: path + ' must be a boolean' };
    return { ok: true };
  }
  if (schema.type === 'integer') {
    if (!Number.isInteger(val)) return { ok: false, why: path + ' must be an integer' };
    return { ok: true };
  }
  if (schema.type === 'number') {
    if (typeof val !== 'number') return { ok: false, why: path + ' must be a number' };
    return { ok: true };
  }
  return { ok: true };
}

console.log('[构造工具]');
const tools = createDiaryTools({ getSessionKey: () => 'test-session' });
check('注册了 2 个工具', tools.length === 2, tools.map((t) => t.name).join(', '));

console.log('');
console.log('── ① diary_config（读）──');
{
  const conf = tools.find((t) => t.name === 'diary_config');
  const r = await conf.execute({}, {});
  const c = lossless(r, 'config');
  const s = checkSchema(r, conf.output?.schema);
  check('返回值无损且符合 Schema', c.ok && s.ok, (!c.ok ? c.why : s.why) || '');
}

console.log('── ② diary_write 成功路径 ──');
{
  const w = tools.find((t) => t.name === 'diary_write');
  const r = await w.execute({ text: '这是一条测试日记内容，用来验证工具返回值可序列化。', target: 'self' }, {});
  const c = lossless(r, 'write-ok');
  const s = checkSchema(r, w.output?.schema);
  check('返回值无损且符合 Schema', c.ok && s.ok, (!c.ok ? c.why : s.why) || JSON.stringify(r).slice(0, 80));
}

console.log('── ③ diary_write 失败路径（关键：这里原来会漏 undefined）──');
{
  const w = tools.find((t) => t.name === 'diary_write');
  // 空文本必然失败
  const r = await w.execute({ text: '' }, {});
  console.log('    返回: ' + JSON.stringify(r));
  const c = lossless(r, 'write-fail');
  const s = checkSchema(r, w.output?.schema);
  check('失败分支返回值也无损且符合 Schema', c.ok && s.ok, (!c.ok ? c.why : s.why) || '');
}

console.log('── ④ 全部工具的所有返回 key 都不含 undefined 且通过 Schema 检验 ──');
{
  const results = [];
  for (const t of tools) {
    for (const args of [{}, { text: '' }, { text: '测试内容够长了应该能过', target: 'self' }]) {
      let r = null;
      try { r = await t.execute(args, {}); } catch { continue; }
      const c = lossless(r, t.name);
      if (!c.ok) results.push(t.name + ' [lossless] ← ' + c.why);
      const s = checkSchema(r, t.output?.schema);
      if (!s.ok) results.push(t.name + ' [schema] ← ' + s.why);
    }
  }
  check('遍历所有工具+参数组合都无损且符合 Schema', results.length === 0, results.join(' | ') || '全过');
}

console.log('\n' + (fail === 0 ? '✅ 工具返回值全部可无损序列化' : '❌ ' + fail + ' 项失败'));
process.exit(fail === 0 ? 0 : 1);
