import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import * as jsx from 'react/jsx-runtime';

function compile(path, require, extra = {}) {
  const exports = {};
  const source = readFileSync(new URL(path, import.meta.url), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText;
  vm.runInNewContext(code, { exports, require, AbortSignal, fetch, Headers, Error, ...extra });
  return exports;
}

test('batch delivery endpoints use device auth, one request and distinct ZIP response', async () => {
  const calls = [];
  const api = compile('../src/batchQueue.ts', () => ({ getDirectServiceConfig: () => ({ relayUrl: 'http://relay', deviceToken: 'device' }) }), {
    fetch: async (url, options) => { calls.push([url, options]); return url.endsWith('/output') ? new Response('zip') : Response.json({ ready: 0 }); },
  });
  assert.equal(api.BATCH_DEFAULTS.provider, 'image2');
  assert.equal(api.BATCH_DEFAULTS.upstream_route, 'yangzxo');
  await api.batchRequest('/batch/delivery', { method: 'POST', body: '{}' });
  const blob = await api.batchRequest('/batch/delivery/output');
  assert.equal(await blob.text(), 'zip');
  assert.equal(calls[0][1].headers['X-Morph-Device-Token'], 'device');
  assert.equal(calls[0][1].method, 'POST');
  assert.equal(calls.length, 2);
});

test('rendered component separates base and multistate delivery, including blocked state', () => {
  const batch = { id: 'batch', name: 'fixture', state: 'completed', settings: { friendly: false },
    succeeded: 28, failed: 8, total: 36, items: [],
    delivery: { state: 'blocked', states: ['action_02_wave_arms_only'], provider: 'image2', ready: 0, resolved_base_count: 28, needs_attention: 0, running: 0, items: [], message: 'HTTP 402' } };
  let stateIndex = 0;
  const panel = compile('../src/BatchPanel.tsx', name => {
    if (name === 'react/jsx-runtime') return jsx;
    if (name === 'react') return { ...React, useEffect: () => {}, useRef: value => ({ current: value }),
      useState: value => [stateIndex++ === 0 ? [batch] : typeof value === 'function' ? value() : value, () => {}] };
    if (name === './live2dPro') return { LIVE2D_PRO_STATES: [] };
    return {};
  });
  const html = renderToStaticMarkup(React.createElement(panel.default, { onProduce() {}, runtimeCounts: {}, seedFiles: [] }));
  assert.match(html, /基础拆件 28\/36/);
  assert.match(html, /多状态 PSD 0\/36/);
  assert.match(html, /可复用基础 PSD 28\/36/);
  assert.match(html, /服务暂停.*HTTP 402/);
  assert.match(html, /下载基础 PSD（不含新动作）/);
  assert.match(html, /disabled=""[^>]*>下载已完成多状态 PSD/);
});

test('bulk native import uses ready variant PSDs, including recovered original failures', () => {
  const source = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
  const flow = source.slice(source.indexOf('async function produceSplitBatch'), source.indexOf('async function proStatePsd'));
  assert.match(flow, /delivery \? variants\.has\(item\.id\)/);
  assert.match(flow, /\/pose-jobs\/\$\{variant\.run_id\}\/output/);
  assert.match(flow, /不会用基础 PSD 冒充完成/);
  assert.match(flow, /delivery\?\.states \?\? stateIds/);
});
