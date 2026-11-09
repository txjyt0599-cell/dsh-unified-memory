import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import vm from 'node:vm';
import {
  sanitizedLiveConfig, validateConfigPatch, saveLiveConfig,
  buildStatus, testConnectivity, mountMemoryDashboard,
} from './lib/dashboard.js';
import {
  publicBaseUrl, applyEndpointOverrides, hasPendingEndpointRestart, saveEndpointOverrides,
} from './lib/endpoint-config.js';

const temp = mkdtempSync(join(tmpdir(), 'unified-memory-dashboard-'));
const liveConfigPath = join(temp, 'config.json');
const indexPath = join(temp, 'index.json');
const wakeLogPath = join(temp, 'wake.log');
const marker = 'unit-test-only-not-a-credential';
writeFileSync(liveConfigPath, JSON.stringify({
  enabled: true, capture: true, fallbackMode: 'llm', customFutureField: { keep: true },
  fallbackLlm: { enabled: true, provider: 'mock', baseUrl: 'https://example.invalid/v1', model: 'mock-model', apiKey: marker },
}));
writeFileSync(indexPath, JSON.stringify({ model: 'mock-embedding', dim: 3, count: 42, builtAt: '2026-11-08T00:00:00Z', ids: ['private-id'] }));
writeFileSync(wakeLogPath, [
  JSON.stringify({ level: 'retrieval', durationMs: 12, count: 2, ts: '2026-11-08T00:00:00Z', text: 'must-not-leak' }),
  JSON.stringify({ level: 'hot-buffer', ms: 5, hits: 1, ts: '2026-11-08T00:01:00Z' }),
].join('\n'));
const config = {
  enabled: true,
  ingest: { llm: { enabled: true, baseUrl: 'https://chat.example.invalid/v1', model: 'mock-chat', apiKey: marker } },
  retrieval: {
    embedding: { baseUrl: 'https://vector.example.invalid/v1', model: 'mock-embedding', dimensions: 3, apiKey: marker },
    embeddingFallback: { baseUrl: 'http://127.0.0.1:8013/v1', model: 'mock-embedding', dimensions: 3 },
    startluxRerank: true,
  },
};
const getConfig = () => config;
const options = { liveConfigPath, indexPath, wakeLogPath, endpointConfigPath: join(temp, 'model-endpoints.json') };

try {
  const safe = sanitizedLiveConfig(readFileSync(liveConfigPath, 'utf8').length ? JSON.parse(readFileSync(liveConfigPath, 'utf8')) : {});
  assert.equal(safe.fallbackLlm.credential, '已配置');
  assert.equal(JSON.stringify(safe).includes(marker), false);
  assert.equal('apiKey' in safe.fallbackLlm, false);

  assert.equal(validateConfigPatch({ concentrationGate: 99 }).value.concentrationGate, 1);
  assert.equal(validateConfigPatch({ batchMessages: -4 }).value.batchMessages, 1);
  assert.equal(validateConfigPatch({ enabled: 'yes' }).ok, false);
  assert.equal(validateConfigPatch({ apiKey: marker }).ok, false);

  const denied = saveLiveConfig({ coldArchiveAutoApply: true }, options);
  assert.equal(denied.status, 409);
  assert.equal(JSON.parse(readFileSync(liveConfigPath, 'utf8')).coldArchiveAutoApply, undefined);
  const saved = saveLiveConfig({ concentrationAlpha: 0.5, fourForcesEnabled: true }, options);
  assert.equal(saved.ok, true);
  assert.equal(saved.config.concentrationAlpha, 0.5);
  assert.equal(JSON.stringify(saved).includes(marker), false);
  const onDisk = JSON.parse(readFileSync(liveConfigPath, 'utf8'));
  assert.equal(onDisk.customFutureField.keep, true, '未知未来字段必须原样保留');
  assert.equal(onDisk.fallbackLlm.apiKey, marker, '已有密钥应原样保留而不是被擦除');
  assert.equal(existsSync(liveConfigPath + '.dashboard-backup'), true, '写前滚动备份必须存在');

  assert.doesNotThrow(() => buildStatus(() => ({ enabled: true, profilePath: join(temp, 'missing-profile.yml') }), options));
  const status = buildStatus(getConfig, options);
  assert.equal(status.index.count, 42);
  assert.equal(status.index.compatible, true);
  assert.equal(status.endpoints.length, 4);
  assert.equal(status.telemetry.levels.find((x) => x.level === 'retrieval').count, 1);
  const serialized = JSON.stringify(status);
  assert.equal(serialized.includes(marker), false);
  assert.equal(serialized.includes('must-not-leak'), false);
  assert.equal(serialized.includes('private-id'), false);
  assert.equal(serialized.includes('"apiKey"'), false);
  assert.equal(serialized.includes('https://vector.example.invalid/v1'), true);

  assert.equal(publicBaseUrl('https://user:pass@example.com/v1?key=secret#frag'), 'https://example.com/v1');
  assert.equal(hasPendingEndpointRestart(config, options), false, '空覆盖配置不应触发重启');
  // [2026-11-09] 开源控制台支持 write-only API Key：允许保存，但永不回显。
  assert.equal(saveEndpointOverrides({ target: 'llm', apiKey: marker }, options).ok, true);
  assert.equal(saveEndpointOverrides({ target: 'llm', baseUrl: 'https://user:pass@example.com/v1' }, options).ok, false);
  assert.equal(saveEndpointOverrides({ target: 'llm', baseUrl: 'file:///tmp/model' }, options).ok, false);
  const savedEndpoint = saveEndpointOverrides({ target: 'llm', baseUrl: 'https://new.example.com/v1', model: 'new-chat', timeoutMs: 30000, enabled: true }, options);
  assert.equal(savedEndpoint.ok, true);
  assert.equal(savedEndpoint.restartRequired, true);
  assert.equal(readFileSync(options.endpointConfigPath, 'utf8').includes(marker), true, 'API Key 应写入本机覆盖配置（write-only）');
  assert.equal(JSON.stringify(buildStatus(getConfig, options)).includes(marker), false, '状态接口不得回显密钥');
  assert.equal(hasPendingEndpointRestart(config, options), true, '保存后当前配置必须显示待重启');
  const merged = applyEndpointOverrides(config, options);
  assert.equal(merged.ingest.llm.baseUrl, 'https://new.example.com/v1');
  assert.equal(merged.ingest.llm.model, 'new-chat');
  assert.equal(merged.ingest.llm.apiKey, marker, '覆盖地址时必须保留原密钥');
  assert.equal(hasPendingEndpointRestart(merged, options), false, '启动合并后应清除待重启标记');
  const desiredStatus = buildStatus(getConfig, options);
  assert.equal(desiredStatus.runtime.restartRequired, true);
  assert.equal(desiredStatus.endpoints.find((x) => x.id === 'L1').baseUrl, 'https://new.example.com/v1');
  assert.equal(JSON.stringify(desiredStatus).includes(marker), false);
  assert.equal(saveEndpointOverrides({ target: 'embedding', dimensions: 3, timeoutMs: 15000 }, options).ok, true);
  assert.equal(existsSync(options.endpointConfigPath + '.dashboard-backup'), true);
  assert.equal(saveEndpointOverrides({ target: 'rerank', startluxPort: 8090, enabled: true }, options).ok, true);
  const rerankMerged = applyEndpointOverrides(config, options);
  assert.equal(rerankMerged.retrieval.startluxPort, 8090);
  assert.equal(rerankMerged.retrieval.startluxRerank, true);
  assert.equal(saveEndpointOverrides({ target: 'llm', reset: true }, options).ok, true);
  assert.equal(applyEndpointOverrides(config, options).ingest.llm.model, 'mock-chat');

  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (url, init) => {
      assert.equal(String(url), 'https://vector.example.invalid/v1/embeddings');
      assert.equal(init.headers.authorization, 'Bearer ' + marker);
      return new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2, 0.3] }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const tested = await testConnectivity('embedding', getConfig, options);
    assert.equal(tested.ok, true);
    assert.equal(tested.observedDim, 3);
    assert.equal(JSON.stringify(tested).includes(marker), false);
  } finally { globalThis.fetch = originalFetch; }

  let registrations = 0;
  const fakeCtx = {
    inject(names, callback) {
      assert.deepEqual(names, ['webServer']);
      callback({
        effect(fn) { assert.equal(typeof fn(), 'function'); },
        // [2026-11-08 基线更新] 宿主 register 改为 route 对象 {kind,path,handler}
        webServer: { register(route) { assert.equal(route.path, '/api/unified-memory'); assert.equal(typeof route.handler, 'function'); registrations++; } },
      });
    },
  };
  mountMemoryDashboard(fakeCtx, getConfig, options);
  mountMemoryDashboard(fakeCtx, getConfig, options);
  assert.equal(registrations, 1, '同一上下文不能重复注册路由');
  assert.doesNotThrow(() => mountMemoryDashboard({ inject() { throw new Error('headless'); } }, getConfig, options));

  const client = readFileSync(new URL('./client.js', import.meta.url), 'utf8');
  // [2026-11-09] 开源控制台允许 write-only 密钥输入；但包里绝不能内置任何真实密钥。
  assert.equal(client.includes('apiKey'), true, '控制台应提供 write-only 密钥输入');
  assert.equal(/sk-[A-Za-z0-9]{16,}/.test(client), false, '浏览器包不得内置任何真实密钥');
  assert.equal(client.includes("id: 'unified-memory'"), true);
  // [2026-11-08 基线更新] 宿主不存在 main.entries 槽，旧断言把「静默失效的注册」锁成了通过。
  //   改为校验真实可渲染槽：main（整页）+ sidebar.panellist（侧栏入口）。
  assert.equal(client.includes("name: 'main'"), true);
  assert.equal(client.includes("name: 'sidebar.panellist'"), true);
  assert.equal(client.includes("name: 'settings.section'"), true);
  assert.equal(client.includes("'/endpoint-config'"), true);
  assert.equal(client.includes('Base URL'), true);
  assert.equal(client.includes('恢复配置继承'), true);
  let moduleDef;
  vm.runInNewContext(client, { window: { __ModuleLoader__: { load(def) { moduleDef = def; } } } });
  assert.equal(moduleDef.id, 'dsh-unified-memory');
  const ReactStub = { createElement: () => ({}) };
  const plugin = moduleDef.factory(() => ReactStub);
  const entries = [];
  const slots = {
    inject(name, callback) { return callback(); },
    register(descriptor, component) { entries.push({ descriptor, component }); return () => {}; },
  };
  plugin.apply({ get(name) { assert.equal(name, 'slots'); return slots; } });
  assert.deepEqual(Array.from(entries, (x) => x.descriptor.name).sort(), ['main', 'settings.section', 'sidebar.panellist']);
  assert.equal(client.includes('ResizeObserver'), true, '必须用实测宽度档位而非容器查询');
  assert.equal(client.includes('el.dataset.pmW'), true);
  assert.equal(client.includes('ref: rootRef'), true);
  assert.equal(client.includes('[data-pm-w="xs"]'), true);
  assert.equal(client.includes('.pm-shell.pm-embedded{min-height:0}'), true, '嵌入模式保留控制台外壳，仅放松高度');
  assert.equal(client.includes("!embedded && h('aside'"), false, '嵌入页也必须保留侧栏导航（布局基准）');
  assert.equal(client.includes('.pm-side{display:none}'), false, '侧栏窄宽度收图标栏，不得隐藏');
  assert.equal(client.includes('container-type'), false, 'inline-size containment 会让嵌入抽屉宽度塌陷，禁止回退');
  assert.equal(client.includes('@container'), false, '禁止残留容器查询');
  assert.equal(client.includes('@media(max-width:'), false, '禁止残留媒体查询');
  assert.equal(client.includes('.pm-endpoint-foot{border-top:1px solid var(--dsw-alias-color-border-primary);padding-top:14px;display:flex;flex-direction:row;flex-wrap:wrap'), true, '操作区恢复一行式卡片视觉，仅允许换行防裁切');
  assert.equal(client.includes('.pm-endpoint-actions .pm-btn{height:28px;padding:0 10px;font-size:10px;flex:none}'), true, '按钮保持小巧不撑满');
  assert.equal(client.includes('flex-wrap:wrap'), true);
  assert.equal(client.includes('pm-endpoint-actions'), true);
  console.log('PASS dashboard: redaction, endpoint editor, container layout, telemetry, route, client');
} finally {
  rmSync(temp, { recursive: true, force: true });
}
