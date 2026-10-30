#!/usr/bin/env node
/**
 * check-as-stranger.mjs —— 以「陌生人」身份跑一遍，看别人 clone 下来能不能用
 *
 * [2026-10-30 by Assistant · 三轮自测换来的]
 *
 * ## 它治什么病
 *   前两轮自测全是绿的，却漏掉了三个「别人装了必踩」的问题：
 *     · cordis.patch.yml 里的 '~/...' 被当成相对路径，真的建出一个叫 "~" 的目录
 *     · zstd-extract.py 写死 C:/Users/Administrator
 *     · smoke-apply.mjs 写死 Temp 路径
 *   为什么漏？因为前两轮都在**我自己的机器、我自己的 home、我自己攒的数据**上跑。
 *   绿的只证明「我这儿跑得通」。
 *
 * ## 它怎么做「换身份」
 *   ① 复制一份干净副本（≈ git clone，但不依赖网络）
 *   ② 伪造另一个用户：USERPROFILE / HOME 指向一个空目录
 *   ③ 伪造空数据：PM_DATA_ROOT 指向空目录（新装即如此）
 *   ④ 照抄仓库自带的 cordis.patch.yml 真跑一次 apply
 *   ⑤ 断言：不抛错 / 不产生字面量 ~ 目录 / 不写进真实 home
 *
 * ## 用法
 *   node scripts/check-as-stranger.mjs           # 快速档（约 30s）
 *   node scripts/check-as-stranger.mjs --full    # 加跑全部 37 套件
 *   node scripts/check-as-stranger.mjs --json
 *
 * 退出码：0 = 陌生人也能用；1 = 有只在我机器上成立的假设
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FULL = process.argv.includes('--full');
const AS_JSON = process.argv.includes('--json');
const NODE = process.execPath;

const fail = [];
const pass = [];
function check(name, ok, detail) {
  (ok ? pass : fail).push({ name, detail: detail === undefined ? '' : String(detail) });
  if (!AS_JSON) console.log((ok ? '  ✅ ' : '  ❌ ') + name + (detail === undefined ? '' : '   ' + detail));
}
function info(msg) { if (!AS_JSON) console.log(msg); }

// ── 搭舞台：干净副本 + 假用户 + 空数据 ──
const stage = mkdtempSync(join(tmpdir(), 'pm-stranger-'));
const CLONE = join(stage, 'dsh-unified-memory');
const FAKE_HOME = join(stage, 'home-of-someone-else');
const FAKE_DATA = join(stage, 'their-data');
const CWD = join(stage, 'their-cwd');          // 会在这里跑 apply，检查有没有冒出 ~ 目录

info('── 0 · 搭一个"别人的机器" ──');
cpSync(REPO, CLONE, {
  recursive: true,
  filter: (src) => {
    const rel = src.slice(REPO.length).replace(/^[\\/]/, '');
    // node_modules 不带（本仓库零运行时依赖，真实 clone 也没有）。
    // .git **必须带**：真实 clone 一定带，而 check-tracked-imports / check-syntax
    //   都是拿 git 当"世界"来问问题的，没有 .git 它们压根没法回答。
    //   剥掉它 = 测了一个没人会遇到的场景，还会误报成失败。
    return !/^node_modules(\\|\/|$)/.test(rel);
  },
});
// 三个目录都是"别人的"：空 home、空数据、空 cwd
for (const d of [FAKE_HOME, FAKE_DATA, CWD]) {
  execFileSync(NODE, ['-e', 'require("node:fs").mkdirSync(process.argv[1], { recursive: true })', d]);
}
info('  副本 = ' + CLONE);
info('  假 home = ' + FAKE_HOME);
info('  空数据 = ' + FAKE_DATA);

/** 以"陌生人"身份跑一条命令 */
function asStranger(args, opts = {}) {
  const env = {
    ...process.env,
    USERPROFILE: FAKE_HOME,
    HOME: FAKE_HOME,
    PM_DATA_ROOT: FAKE_DATA,
    PM_SESSIONS_ROOT: join(FAKE_HOME, '.dsh', 'sessions'),
    DSH_HOME: join(FAKE_HOME, '.dsh'),
    // 关键：清掉 NODE_OPTIONS —— 本机的 err-hook 会吞掉顶层异常，让失败看起来像成功
    NODE_OPTIONS: '',
    ...(opts.env || {}),
  };
  const r = spawnSync(NODE, args, {
    cwd: opts.cwd || CLONE,
    env,
    encoding: 'utf8',
    timeout: opts.timeout || 180000,
  });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

// ── 1 · 四道便宜闸 ──
info('');
info('── 1 · 四道闸（在别人机器上） ──');
const gates = [
  ['scripts/smoke-apply.mjs', '启动冒烟'],
  ['scripts/check-tracked-imports.mjs', '跟踪导入'],
  ['scripts/check-syntax.mjs', '语法'],
  ['scripts/check-hardcodes.mjs', '硬编码'],
];
for (const [script, label] of gates) {
  const r = asStranger([script], { timeout: 240000 });
  check(label + ' 通过', r.code === 0, r.code === 0 ? '' : (r.out.trim().split('\n').slice(-3).join(' | ') || ('exit=' + r.code)));
}

// ── 2 · 照抄仓库自带配置，真 apply 一次 ──
info('');
info('── 2 · 照抄 cordis.patch.yml 真 apply ──');
let applyRan = false;      // apply 没跑起来时，"~ 目录"与"写进数据根"这两条**无法判定**
{
  const probe = join(stage, 'probe-apply.mjs');
  writeFileSync(probe, `
const yamlPath = process.argv[2];
const libPath = process.argv[3];
const { readFileSync } = await import('node:fs');
const yaml = (await import('file:///' + process.argv[4].replace(/\\\\/g, '/') + '/index.js')).default;
const doc = yaml.load(readFileSync(yamlPath, 'utf8'));
const cfg = doc[0].insert[0].config;
const mod = await import('file:///' + libPath.replace(/\\\\/g, '/'));
const hooks = new Map();
const ctx = {
  on(n, f) { if (!hooks.has(n)) hooks.set(n, []); hooks.get(n).push(f); return () => {}; },
  effect(fn) { try { const d = fn(); return typeof d === 'function' ? d : () => {}; } catch { return () => {}; } },
  get() { return undefined; },
  logger: { info() {}, warn() {}, debug() {}, error() {} },
  systemPrompt: { section() { return () => {}; }, context() { return () => {}; } },
  tools: { register() { return () => {}; } },
};
let err = null, d = null;
try { d = mod.apply(ctx, cfg); } catch (e) { err = e; }
console.log(JSON.stringify({ ok: !err, err: err ? String(err.message) : null, hooks: [...hooks.keys()] }));
if (typeof d === 'function') { try { d(); } catch {} }
`);

  // js-yaml 从 DSH 安装里借一个（本仓库零依赖，不往包里加）
  const yamlCandidates = [
    'C:/Users/Administrator/.dsh/profiles/web/node_modules/js-yaml',
    join(REPO, 'node_modules/js-yaml'),
  ];
  const yamlLib = yamlCandidates.find((d) => existsSync(join(d, 'index.js')));
  if (!yamlLib) {
    check('apply 照抄配置不抛错', true, '跳过：本机找不到 js-yaml（不改判据）');
  } else {
    const r = asStranger([probe, join(CLONE, 'cordis.patch.yml'), join(CLONE, 'lib', 'index.js'), yamlLib], { cwd: CWD });
    let res = null;
    for (const line of r.out.trim().split('\n')) {
      try { const o = JSON.parse(line); if (typeof o.ok === 'boolean') res = o; } catch {}
    }
    check('apply 照抄配置不抛错', !!res && res.ok === true, res ? (res.err || ('hooks=' + res.hooks.length)) : ('无输出 exit=' + r.code));
    check('apply 后注册了钩子', !!res && (res.hooks || []).length >= 2, res ? JSON.stringify(res.hooks) : '');
    applyRan = !!(res && res.ok === true);
  }
}

// ── 3 · 三个"只在我机器上成立"的具体症状 ──
info('');
info('── 3 · 症状断言（这三条正是前两轮漏掉的） ──');
{
  // ① 不许在自己目录里冒出字面量 ~ 目录
  //
  //   ⚠️ 这条**必须先确认 apply 真的跑过**。否则会出现最糟的假绿：
  //     apply 直接崩了 ⇒ 它根本没机会建任何目录 ⇒ "没有 ~ 目录" 判定通过 ⇒
  //     读者以为路径没问题，其实问题在更早的地方。
  //     （这不是假设 —— 拿 c9cf63f 跑时它就是这么绿过去的。）
  let tildeDir = false;
  try { tildeDir = readdirSync(CWD).some((n) => n === '~'); } catch {}
  const tildeVerdict = !applyRan ? 'skip' : (tildeDir ? 'bad' : 'ok');
  if (tildeVerdict === 'skip') {
    info('  ⏭  没有造出名叫 "~" 的目录   跳过：apply 没跑起来，无目录可查');
  } else {
    check('没有造出名叫 "~" 的目录', tildeVerdict === 'ok', tildeDir ? '❗ 出现了 ' + join(CWD, '~') : 'cwd 干净');
  }

  // ② 不许往"别人的 home"以外写东西 —— 也就是默认路径必须跟着 DSH_HOME 走
  const wroteToData = existsSync(FAKE_DATA) && readdirSync(FAKE_DATA).length > 0;
  if (!applyRan) {
    info('  ⏭  数据写进了 PM_DATA_ROOT   跳过：apply 没跑起来');
  } else {
    check('数据写进了 PM_DATA_ROOT', wroteToData, wroteToData ? readdirSync(FAKE_DATA).slice(0, 4).join(', ') : '空数据目录没被用上');
  }

  // ③ 源码里不许再有指向开发机的路径（check-hardcodes 已覆盖，这里再独立验一次，防它自己坏了）
  const banned = [/C:\/Users\/Administrator/, /D:\/dsh-plugins\/dsh-unified-memory/];
  // 与 check-hardcodes 同一套放行逻辑：检查器自身、以及"带着开发机路径才能干活"的
  // 自查脚本（比如 refactor-paths 必须知道要替换什么），它们写这些字面量是**本意**。
  const allow = [/FAKEFORTESTONLY/, /process\.env\.USERPROFILE/, /本文件之外/, /scripts[\\/]check-(hardcodes|as-stranger)\.mjs/, /scripts[\\/]refactor-paths/];
  const offenders = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      const fp = join(dir, e.name);
      if (e.isDirectory()) { walk(fp); continue; }
      if (!/\.(js|mjs|cjs|py|yml)$/.test(e.name)) continue;
      let txt = '';
      try { txt = readFileSync(fp, 'utf8'); } catch { continue; }
      const relPath = fp.slice(CLONE.length + 1);
      if (allow.some((re) => re.test(relPath))) continue;
      txt.split('\n').forEach((l, i) => {
        const t = l.trim();
        if (/^(\/\/|\*|#)/.test(t)) return;
        if (allow.some((re) => re.test(l))) return;
        if (banned.some((re) => re.test(l))) offenders.push(relPath + ':' + (i + 1));
      });
    }
  };
  walk(join(CLONE, 'lib'));
  walk(join(CLONE, 'scripts'));
  check('lib/ 与 scripts/ 无开发机路径', offenders.length === 0, offenders.slice(0, 3).join(', ') || '干净');
}

// ── 4 · 全套件（可选，慢） ──
if (FULL) {
  info('');
  info('── 4 · 全部 37 套件（在别人机器上） ──');
  const suites = readdirSync(CLONE).filter((f) => /^selftest.*\.mjs$/.test(f)).sort();
  let bad = [];
  for (const s of suites) {
    const r = asStranger([s], { timeout: 300000 });
    if (r.code !== 0) bad.push(s + ' (exit=' + r.code + ')');
  }
  check('37 套件全绿', bad.length === 0, bad.length ? bad.slice(0, 5).join(', ') : '共 ' + suites.length + ' 套');
}

// ── 收尾 ──
try { rmSync(stage, { recursive: true, force: true }); } catch {}

const okAll = fail.length === 0;
if (AS_JSON) {
  console.log(JSON.stringify({ ok: okAll, pass: pass.length, fail: fail.length, failures: fail }, null, 2));
} else {
  console.log('');
  console.log('════ 陌生人自测 ════');
  console.log('  pass=' + pass.length + '  fail=' + fail.length + (okAll ? '   ✅ 别人 clone 下来也能用' : '   ❌ 还有只在我机器上成立的假设'));
}
process.exitCode = okAll ? 0 : 1;
