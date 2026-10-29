#!/usr/bin/env node
/**
 * selftest-startlux.mjs —— StartLux 本地精排保底链路单元测试
 * [2026-10-23 by Assistant]
 */
import {
  isStartLuxAvailable,
  ensureStartLuxServer,
  stopStartLuxServer,
  rerankL0Candidates
} from './lib/retrieval/startlux-rerank.js';

let passed = 0;
let failed = 0;

function check(name, ok, detail = '') {
  if (ok) {
    passed++;
    console.log('  PASS ' + name + (detail ? ' (' + detail + ')' : ''));
  } else {
    failed++;
    console.log('  FAIL ' + name + (detail ? ' (' + detail + ')' : ''));
  }
}

console.log('\n── StartLux 本地保底链路测试 ──');

// 1. 检查模型与 server 文件
const available = isStartLuxAvailable();
check('模型与 llama-server 存在', available);

// 2. 空候选安全返回
const emptyRes = await rerankL0Candidates('测试提问', []);
check('空候选安全返回', emptyRes.ok && emptyRes.judgments.length === 0);

// 3. 真实候选精排验证
const candidates = [
  { id: 'cand_1', text: '讨论如何修复 DSH 插件的权限问题，涉及 sandbox-policy 和 approval 设置。' },
  { id: 'cand_2', text: '今天中午吃了水饺，味道还不错。' },
];

const res = await rerankL0Candidates('DSH 插件沙箱权限怎么配置？', candidates, {
  autoShutdown: true,
  idleShutdownMs: 1000,
});

check('精排请求成功', res.ok, 'ms=' + res.ms);
check('正确识别相关项', res.relevantIds.has('cand_1'), JSON.stringify(res.judgments));
check('正确过滤无关项', !res.relevantIds.has('cand_2'));

// 4. 清理并验证
stopStartLuxServer();
check('服务主动停止无抛错', true);

console.log(`\n总计 ${passed + failed} 项，通过 ${passed} 项，失败 ${failed} 项`);
process.exitCode = failed === 0 ? 0 : 1;
