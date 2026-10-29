/**
 * selftest-defaults.mjs —— 开箱即用默认值验收（2026-10-29）
 *
 * ## 为什么需要
 *   原版这些开关默认 false，是因为原版机器上有手写的 config.json 覆盖了它们。
 *   开源用户没有那个文件 ⇒ 拿到全 false ⇒ **装完什么都不记录，也不报错**。
 *   实测：新目录首启 _missing=true，enabled/capture/extract/distill 全是 false。
 *
 * ## 验什么
 *   D1 新用户首启 ⇒ 总闸与三条链默认开（不然装了等于没装）
 *   D2 四股力默认开（核心卖点，默认关等于没发布）
 *   D3 冷宫归档**必须保持关**（搬卡是不可逆物理动作，不能默认自动）
 *   D4 首启自动落盘配置模板（让可调项从隐形变可见）
 */
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

let pass = 0, fail = 0;
const fails = [];
function check(g, name, ok, detail) {
  if (ok) { pass++; console.log('  PASS ' + name + (detail ? '   ' + detail : '')); }
  else { fail++; fails.push(name); console.log('  FAIL ' + name + (detail ? '   ' + detail : '')); }
}

console.log('════ 开箱即用默认值验收 ════');

const TMP = path.join(os.tmpdir(), 'defaults-' + process.pid);
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(path.join(TMP, 'profiles', 'web'), { recursive: true });
fs.writeFileSync(path.join(TMP, 'profiles', 'web', 'cordis.patch.yml'), '# empty\n');
process.env.DSH_HOME = TMP;
process.env.PM_DATA_ROOT = path.join(TMP, 'unified-memory');

const { createIngest } = await import('file://' + HERE + '/lib/ingest/index.js');
const cfgMod = await import('file://' + HERE + '/lib/ingest/config.js');

// 首启前：文件不该存在
console.log('\n── D4 · 首启生成模板 ──');
check('D4', 'D4a 首启前模板不存在（前提条件）', !fs.existsSync(cfgMod.DEFAULT_CONFIG_PATH));

const logs = [];
const logger = { wake: (o) => logs.push(o), miss: (o) => logs.push(o) };
const ctx = { on: () => () => {}, tools: { register: () => () => {} } };
createIngest(ctx, {
  root: path.join(TMP, 'ingest'),
  profilePath: path.join(TMP, 'profiles', 'web', 'cordis.patch.yml'),
}, logger);

check('D4', 'D4b 首启后模板已生成', fs.existsSync(cfgMod.DEFAULT_CONFIG_PATH));
const tpl = logs.find(x => String(x.level || '').includes('template-written'));
check('D4', 'D4c 有模板生成日志', !!tpl, tpl ? String(tpl.level) : '无');

// 默认值
console.log('\n── D1 · 写入链默认开 ──');
const L = cfgMod.loadLiveConfig();
check('D1', 'D1a 总闸 enabled 默认开', L.enabled === true, String(L.enabled));
check('D1', 'D1b capture 默认开', L.capture === true, String(L.capture));
check('D1', 'D1c extract 默认开', L.extract === true, String(L.extract));
check('D1', 'D1d distill 默认开', L.distill === true, String(L.distill));

console.log('\n── D2 · 四股力默认开 ──');
check('D2', 'D2a fourForcesEnabled 默认开', L.fourForcesEnabled === true, String(L.fourForcesEnabled));

console.log('\n── D3 · 冷宫必须保持关（反例）──');
check('D3', 'D3a coldArchiveEnabled 必须为 false', L.coldArchiveEnabled === false, String(L.coldArchiveEnabled));
check('D3', 'D3b coldArchiveAutoApply 必须为 false', L.coldArchiveAutoApply === false, String(L.coldArchiveAutoApply));

console.log('\n── D5 · 落盘模板内容正确 ──');
{
  const c = JSON.parse(fs.readFileSync(cfgMod.DEFAULT_CONFIG_PATH, 'utf8'));
  check('D5', 'D5a 模板里 enabled=true', c.enabled === true, String(c.enabled));
  check('D5', 'D5b 模板里 fourForcesEnabled=true', c.fourForcesEnabled === true, String(c.fourForcesEnabled));
  check('D5', 'D5c 模板里 coldArchive 仍为 false', c.coldArchiveEnabled === false, String(c.coldArchiveEnabled));
  check('D5', 'D5d 模板键数合理（>20）', Object.keys(c).length > 20, String(Object.keys(c).length));
}

fs.rmSync(TMP, { recursive: true, force: true });

console.log('\n════ SUMMARY ════');
console.log('  pass=' + pass + ' fail=' + fail);
if (fail) console.log('  失败项: ' + fails.join(' | '));
process.exit(fail ? 1 : 0);
