import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import ts from 'typescript';

const compile = (source) => 'data:text/javascript;base64,' + Buffer.from(ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
}).outputText).toString('base64');
const policyUrl = compile(await readFile(new URL('../src/prepPolicy.ts', import.meta.url), 'utf8'));
const { selectPreparation } = await import(policyUrl);
const bridgeSource = (await readFile(new URL('../src/serviceBridge.ts', import.meta.url), 'utf8'))
  .replace("'./prepPolicy'", JSON.stringify(policyUrl));
const bridge = await import(compile(bridgeSource));

test('new and legacy tasks default to generation; only explicit confirmation bypasses', async () => {
  for (const mode of [undefined, 'generate', 'unexpected', null]) {
    let generated = 0, skipped = 0;
    const result = await selectPreparation(mode, {
      generate: async () => { generated++; return 'generated'; },
      confirmedSource: async () => { skipped++; return 'original'; },
    });
    assert.equal(result, 'generated'); assert.equal(generated, 1); assert.equal(skipped, 0);
  }
  assert.equal(await selectPreparation('confirmed-source', {
    generate: async () => { throw Error('must not generate'); },
    confirmedSource: async () => 'confirmed',
  }), 'confirmed');
});

test('generation failure stops the pipeline, never falls back to the original', async () => {
  let submitted = false;
  await assert.rejects(async () => {
    await selectPreparation('generate', {
      generate: async () => { throw Error('provider unavailable'); },
      confirmedSource: async () => { throw Error('unexpected bypass'); },
    });
    submitted = true;
  }, /provider unavailable/);
  assert.equal(submitted, false);
});

test('direct relay affects splitting only; selected provider reaches private prep API', async () => {
  const original = { window: globalThis.window, localStorage: globalThis.localStorage, fetch: globalThis.fetch };
  const calls = [];
  try {
    globalThis.window = { location: { origin: bridge.SERVICE_ORIGIN } };
    globalThis.localStorage = { getItem: () => JSON.stringify({relayUrl:'http://127.0.0.1:7861', deviceToken:'test-only-device-token'}) };
    globalThis.fetch = async (url, options) => {
      calls.push({url, options});
      if (options?.body instanceof FormData && url === '/api/live2d-prep') return new Response(new Uint8Array([1,2,3]));
      return Response.json({ready:true, id:'a'.repeat(32), status:'queued'});
    };
    await bridge.serviceRequest('prepHealth');
    assert.equal(calls.at(-1).url, '/api/live2d-prep');
    for (const provider of ['doubao', 'image2']) {
      await bridge.serviceRequest('prepare', {image:new Blob(['test']), name:'source.png', provider});
      assert.equal(calls.at(-1).url, '/api/live2d-prep');
      assert.equal(calls.at(-1).options.body.get('provider'), provider);
      assert.equal(calls.at(-1).options.headers, undefined, 'relay credential must not reach prep API');
    }
    await bridge.serviceRequest('submit', {image:new Blob(['test']), name:'prepared.png'});
    assert.match(calls.at(-1).url, /^http:\/\/127\.0\.0\.1:7861\/jobs/);
    // On Pages an unopened private bridge must stop, not send raw input to relay.
    globalThis.window.location.origin = 'https://example.github.io';
    const count = calls.length;
    await assert.rejects(bridge.serviceRequest('prepHealth'), /连接/);
    assert.equal(calls.length, count);
  } finally { Object.assign(globalThis, original); }
});

test('standard and Pro flows share policy, and replacement clears prior acceptance', async () => {
  const app = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8');
  const pipeline = app.slice(app.indexOf('async function startImagePipeline'), app.indexOf('async function refresh'));
  assert.match(pipeline, /selectPreparation\(t.prepMode/);
  assert.doesNotMatch(pipeline, /hasDirectServiceConfig/);
  assert.match(pipeline, /async function startProBasePipeline[\s\S]*await startImagePipeline\(t\)/);
  const replace = app.slice(app.indexOf('async function replace'), app.indexOf('return (\n    <main'));
  assert.match(replace, /prepAccepted: false/); assert.match(replace, /prepMode: 'generate'/);
});
