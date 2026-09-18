import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';

function runCommonJs(source, context) {
  const compiled = ts.transpileModule(source, {
    compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022},
  }).outputText;
  const module = {exports: {}};
  vm.runInNewContext(compiled, {module, exports: module.exports, ...context});
  return module.exports;
}

async function loadNativeExport(fetch) {
  const storage = new Map();
  const localStorage = {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: (key) => storage.delete(key),
  };
  const base = {fetch, localStorage, AbortSignal, URL, Response, Error, TypeError};
  const serviceSource = await fs.readFile(new URL('../src/serviceBridge.ts', import.meta.url), 'utf8');
  const serviceBridge = runCommonJs(serviceSource, base);
  const nativeSource = (await fs.readFile(new URL('../src/nativeExport.ts', import.meta.url), 'utf8'))
    .replace(/import \{[\s\S]*?\} from '\.\/serviceBridge';/, 'const { connectLocalRelay, getDirectServiceConfig } = serviceBridge;');
  return runCommonJs(nativeSource, {...base, serviceBridge});
}

test('native export auto-discovers the local bridge when this origin has no saved token', async (t) => {
  const requests = [];
  const native = await loadNativeExport(async (url) => {
    requests.push(String(url));
    if (String(url).endsWith('/local-bootstrap'))
      return new Response(JSON.stringify({ deviceToken: 'a'.repeat(32) }), {status: 200});
    if (String(url).endsWith('/health'))
      return new Response(JSON.stringify({ok: true}), {status: 200});
    throw new Error(`unexpected request ${url}`);
  });

  const progress = [];
  const config = await native.ensureNativeExportRelay((message) => progress.push(message));
  assert.equal(config.relayUrl, 'http://127.0.0.1:7861');
  assert.equal(config.deviceToken, 'a'.repeat(32));
  assert.deepEqual(requests, [
    'http://127.0.0.1:7861/local-bootstrap',
    'http://127.0.0.1:7861/health',
  ]);
  assert.ok(progress.some((message) => message.includes('自动发现')));
});

test('native export reports an actionable bridge failure instead of a Pro-only configuration error', async (t) => {
  const native = await loadNativeExport(async () => { throw new TypeError('network unavailable'); });
  await assert.rejects(
    () => native.ensureNativeExportRelay(() => {}),
    /本机原生导出桥接未运行|未检测到可用的本机原生导出桥接/,
  );
});

test('Pro compile requests the versioned pipeline and refuses a legacy bridge', async () => {
  for (const upgraded of [false, true]) {
    const urls = [];
    const native = await loadNativeExport(async (url) => {
      urls.push(String(url));
      if (String(url).endsWith('/local-bootstrap')) return new Response(JSON.stringify({deviceToken: 'a'.repeat(32)}));
      if (String(url).endsWith('/health')) return new Response('{}');
      if (String(url).endsWith('/jobs?profile=pro-rig-v1')) return new Response(JSON.stringify({id:'test',status:'succeeded',message:'ready',...(upgraded?{profile:'pro-rig-v1'}:{})}));
      if (String(url).endsWith('/test/output')) return new Response('runtime');
      throw Error('unexpected request');
    });
    if (upgraded) assert.equal(await (await native.compileNative(new Blob(['CAFF']),()=>{},'pro-rig-v1')).text(),'runtime');
    else await assert.rejects(()=>native.compileNative(new Blob(['CAFF']),()=>{},'pro-rig-v1'),/尚未接入 Pro/);
    assert.ok(urls.some(url=>url.endsWith('?profile=pro-rig-v1')));
    assert.equal(urls.some(url=>url.endsWith('/output')),upgraded);
  }
});
