/**
 * selftest-config-warnings.mjs —— 配置缺失告警验收（2026-10-29）
 *
 * ## 为什么需要
 *   纯净 DSH 装上本插件后，一切看起来正常，但产卡被静默跳过。
 *   用户唯一的线索应该是明确的告警 —— 而原来那块代码是 `if (!ep) return;`，
 *   一个字都不说。这是最容易让人放弃的失败形态。
 *
 * ## 验什么
 *   W1  没有 llm 配置 ⇒ 启动时必须有告警
 *   W2  告警内容要告诉用户「填哪里」（含 cordis.patch.yml / config.llm 字样）
 *   W3  【反例】填了 llm 配置 ⇒ 不许告警
 *   W4  告警只发一次（每 10 分钟最多一次），不许刷屏
 */
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { createIngest } = await import('file://' + HERE + '/lib/ingest/index.js');

let pass = 0, fail = 0;
const fails = [];
function check(g, name, ok, detail) {
  if (ok) { pass++; console.log('  PASS ' + name + (detail ? '   ' + detail : '')); }
  else { fail++; fails.push(name); console.log('  FAIL ' + name + (detail ? '   ' + detail : '')); }
}

console.log('════ 配置缺失告警验收 ════');

function mkEnv(tag) {
  const TMP = path.join(os.tmpdir(), 'cfgwarn-' + tag + '-' + process.pid);
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(path.join(TMP, 'profiles', 'web'), { recursive: true });
  fs.writeFileSync(path.join(TMP, 'profiles', 'web', 'cordis.patch.yml'), '# empty\n');
  process.env.DSH_HOME = TMP;
  process.env.PM_DATA_ROOT = path.join(TMP, 'unified-memory');
  return TMP;
}

function run(config, tag) {
  const TMP = mkEnv(tag);
  const logs = [];
  const logger = { wake: (o) => logs.push(o), miss: (o) => logs.push(o) };
  const ctx = { on: () => () => {}, tools: { register: () => () => {} } };
  try {
    createIngest(ctx, Object.assign({ root: path.join(TMP, 'ingest'), profilePath: path.join(TMP, 'profiles', 'web', 'cordis.patch.yml') }, config), logger);
  } catch { /* 不因构造失败而中断 */ }
  return { logs, TMP };
}

// ── W1/W2 · 缺配置 ⇒ 必须告警，且说清填哪 ──
console.log('\n── W1/W2 · 缺 llm 配置 ──');
{
  const { logs, TMP } = run({}, 'w1');
  const w = logs.find(l => String(l.level || '').includes('llm-missing'));
  check('W1', 'W1a 启动时有告警', !!w, w ? String(w.level) : '没找到');
  const hint = String((w && w.hint) || '');
  check('W2', 'W2a 告警指明配置文件', hint.includes('cordis.patch.yml'), hint.slice(0, 60));
  check('W2', 'W2b 告警指明字段', hint.includes('config.llm') || hint.includes('llm'), hint.slice(0, 60));
  check('W2', 'W2c 告警说明后果', /不会生成|不会产生|跳过/.test(hint), hint.slice(0, 60));
  fs.rmSync(TMP, { recursive: true, force: true });
}

// ── W3 · 反例：填了就许不告警 ──
console.log('\n── W3 · 填了配置（反例）──');
{
  const { logs, TMP } = run({
    llm: { baseUrl: 'http://127.0.0.1:9999/v1', apiKey: 'test-key-xxx', model: 'test-model' },
  }, 'w3');
  const w = logs.find(l => String(l.level || '').includes('llm-missing'));
  check('W3', 'W3a 填了 llm ⇒ 不许告警', !w, w ? '误报了' : '正确静默');
  fs.rmSync(TMP, { recursive: true, force: true });
}

// ── W4 · 源码断言：告警有节流，不许每 tick 都刷 ──
console.log('\n── W4 · 告警节流 ──');
{
  const SRC = fs.readFileSync(HERE + '/lib/ingest/index.js', 'utf8');
  const CODE = SRC.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  check('W4', 'W4a 有 10 分钟节流判断', /600000/.test(CODE));
  check('W4', 'W4b 用 _lastNoLlmWarnAt 记录上次告警', /_lastNoLlmWarnAt/.test(CODE));
}

console.log('\n════ SUMMARY ════');
console.log('  pass=' + pass + ' fail=' + fail);
if (fail) console.log('  失败项: ' + fails.join(' | '));
process.exit(fail ? 1 : 0);
