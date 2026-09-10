import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

function setup({ connected = true, fetch } = {}) {
  const module = { exports: {} };
  const requests = [];
  const source = readFileSync(new URL('../src/prepQueue.ts', import.meta.url), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(code, { module, exports: module.exports, require: () => ({ getDirectServiceConfig: () => connected ? { relayUrl: 'http://127.0.0.1:7861', deviceToken: 'device-only' } : null }),
    FormData, Error, Object, AbortSignal, fetch: async (url, options) => {
      requests.push({ url, options });
      return fetch ? fetch(url, options) : Response.json({ id: 'a'.repeat(32), status: 'queued' });
    } });
  return { api: module.exports, requests };
}

test('refresh converts stale legacy spinner to actionable failure', () => {
  const { api } = setup();
  const old = api.recoverPrepState({ prepState: 'queued', prepMessage: '正在连接Image-2' });
  assert.equal(old.prepState, 'failed');
  assert.match(old.prepMessage, /没有可恢复/);
  const durable = api.recoverPrepState({ prepState: 'running', prepJobId: 'a'.repeat(32) });
  assert.equal(durable.prepState, 'queued');
  assert.match(durable.prepMessage, /不会重新生成/);
  assert.equal(api.recoverPrepState({ prepState: 'needs-review' }).prepState, 'needs-review');
});

test('upload uses one stable ID, chosen provider and device token, no login or provider key', async () => {
  const { api, requests } = setup();
  const file = new File(['image'], 'reference.png', { type: 'image/png' });
  await api.submitPrep('a'.repeat(32), file, 'image2', 'character');
  const request = requests[0];
  assert.equal(request.url, 'http://127.0.0.1:7861/prep/jobs');
  assert.equal(request.options.body.get('job_id'), 'a'.repeat(32));
  assert.equal(request.options.body.get('provider'), 'image2');
  assert.equal(request.options.headers['X-Morph-Device-Token'], 'device-only');
  assert.equal(request.options.headers.Authorization, undefined);
  assert.equal(requests.length, 1);
});

test('network failures never silently repeat a paid submission', async () => {
  const { api, requests } = setup({ fetch: async () => { throw new Error('Failed to fetch'); } });
  await assert.rejects(api.submitPrep('a'.repeat(32), new File(['test'], 'a.png'), 'image2', 'test'), /不会因此重跑/);
  assert.equal(requests.length, 1);
});

test('no relay fails early, not through the private login bridge', async () => {
  const { api, requests } = setup({ connected: false });
  await assert.rejects(api.prepRequest('/health'), /不再使用旧网站/);
  assert.equal(requests.length, 0);
});

test('server missing-key error is actionable, not a permanent connecting spinner', async () => {
  const { api } = setup({ fetch: async () => Response.json({ detail: '尚未配置 AI_GATEWAY_API_KEY' }, { status: 503 }) });
  await assert.rejects(api.prepRequest('/health'), /AI_GATEWAY_API_KEY/);
});

test('candidate persistence precedes QA; normal and recovered tasks cannot silently bypass QA', () => {
  const source = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
  const complete = source.slice(source.indexOf('async function refreshPrep'), source.indexOf('async function regenerate'));
  assert.ok(complete.indexOf('await saveAsset') < complete.indexOf('await assertLive2dFriendlyFrame'));
  assert.match(complete, /prepState: 'needs-review', prepAccepted: false/);
  assert.match(complete, /!t.remoteJobId && t.prepAutoSplit/);
  assert.match(source, /prepProvider: job.provider, prepAutoSplit: false/);
});
