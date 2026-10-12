import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

function api(fetch) {
  const module = { exports: {} };
  const source = readFileSync(new URL('../src/proQueue.ts', import.meta.url), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(code, { module, exports: module.exports, require: () => ({ getDirectServiceConfig: () => ({relayUrl:'http://relay',deviceToken:'device'}) }),
    fetch, AbortSignal, Error });
  return module.exports;
}

test('new PSD pipeline endpoints are explicit; legacy runs remain on their original endpoint', () => {
  const pro = api();
  assert.equal(pro.proRunPath('a', 'psd-pose-variants-v1'), '/pose-jobs/a');
  assert.equal(pro.proRunPath('a'), '/jobs/a');
});

test('PSD/preview return bytes, report returns JSON and 404 never falls back to paid legacy queue', async () => {
  const calls=[];
  const pro=api(async (url,options) => {calls.push([url,options]);return url.endsWith('/report') ? Response.json({version:'psd-pose-variants-v1'}) : new Response('8BPS');});
  assert.equal(new TextDecoder().decode(await pro.proRequest('/pose-jobs/a/output')), '8BPS');
  assert.equal(new TextDecoder().decode(await pro.proRequest('/pose-jobs/a/states/wave/preview')), '8BPS');
  assert.equal((await pro.proRequest('/pose-jobs/a/report')).version,'psd-pose-variants-v1');
  assert.equal(calls[0][1].headers['X-Morph-Device-Token'],'device');
  const offline=api(async () => Response.json({detail:'upgrade required'},{status:404}));
  await assert.rejects(offline.proRequest('/pose-jobs'), /upgrade required/);
});

test('single and bulk Pro use PSD parts, persist version before submit, and block premature native output', () => {
  const source = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
  const sync=source.slice(source.indexOf('async function syncPro'),source.indexOf('async function retryProState'));
  assert.match(sync,/form.append\('psd', base/);
  assert.ok(sync.indexOf('rememberPrep(t, { proRunId: runId, proPipeline: pipeline') < sync.indexOf("proRequest<ProRun>('/pose-jobs', form)"));
  assert.doesNotMatch(sync,/form.append\('image'|form.append\('base_id'/);
  assert.match(sync,/run.pipeline === PSD_POSE_PIPELINE/);
  assert.match(source,/await syncPro\(ready\)/);
  assert.match(source,/不会用空状态 PSD 生成交付包/);
  assert.doesNotMatch(source,/title="逐张 See-Through"|title="批量状态图"/);
});
