#!/usr/bin/env node
/**
 * selftest-embed-memo.mjs —— 查询向量缓存不得缓存 null（红队 R2·P0）
 *
 * 反例：第一查 500（embedQuery 返回 null），服务恢复后 30 秒内同句再查；
 * 旧实现会把 null 写进 30s 缓存 → 第二查仍返回 null；新实现必须重新请求并拿到向量。
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRetriever } from '../lib/retrieval/retriever.js';

let pass = 0, fail = 0;
const fails = [];
function check(name, fn) {
  try { fn(); pass++; console.log('  PASS ' + name); }
  catch (e) { fail++; fails.push(name); console.log('  FAIL ' + name + '  ' + (e && e.message || e)); }
}
function makeServer() {
  const state = { ok: false };
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      if (!state.ok) { res.writeHead(500); res.end('boom'); return; }
      let input = [];
      try { input = JSON.parse(body).input || []; } catch {}
      const data = (Array.isArray(input) ? input : [input]).map((t, i) => ({
        index: i, embedding: Array.from({ length: 1024 }, (_, k) => Math.sin((String(t).length + k) * 0.001)),
      }));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data }));
    });
  });
  return new Promise(resolve => srv.listen(0, '127.0.0.1', () => resolve({ srv, state, url: 'http://127.0.0.1:' + srv.address().port + '/v1' })));
}
const ep = url => ({ baseUrl: url, apiKey: 'sk-test', model: 'BAAI/bge-m3', dimensions: 1024, timeoutMs: 3000, batchSize: 16 });

const s = await makeServer();
const rt = createRetriever({ embedding: ep(s.url), vectorBreaker: { threshold: 99, baseCooldownMs: 60000, maxCooldownMs: 60000 } }, { wake() {}, miss() {} });
await rt.warmup();
await rt.search('记忆索引重建', {});
const h1 = rt.health().vector;
if (!h1 || h1.lastBackend === null || h1.lastBackend === undefined) { s.srv.close(); console.log('EMBED-MEMO-SKIPPED (no vector attempt without cards)'); process.exit(0); }
s.state.ok = true;
await rt.search('记忆索引重建', {});
const h2 = rt.health().vector;
check('E1 第一查失败（后端 none）', () => assert.ok(h1.lastBackend !== 'online', 'lastBackend=' + h1.lastBackend));
check('E2 服务恢复后同句复查必须拿到向量（不得命中 null 缓存）', () => {
  assert.equal(h2.lastBackend, 'online', 'lastBackend=' + h2.lastBackend + ' last=' + JSON.stringify(h2.last));
});
s.srv.close();
console.log('');
console.log('EMBED-MEMO-DONE checks=' + (pass + fail) + ' passed=' + pass + ' failed=' + fail);
if (fail > 0) { console.log('失败项: ' + fails.join(', ')); process.exit(1); }
