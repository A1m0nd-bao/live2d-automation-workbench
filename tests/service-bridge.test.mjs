import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

function setup(blocked = false) {
  const module = { exports: {} }, listeners = {}, timers = new Map(); let message, sequence = 0;
  const popup = { closed: false, focus() {}, postMessage(data) { message = data; } };
  const window = { location: { origin: 'https://a1m0nd-bao.github.io' }, open: () => blocked ? null : popup,
    addEventListener: (name, listener) => { listeners[name] = listener; },
    setTimeout: fn => { const id = ++sequence; timers.set(id, () => { timers.delete(id); fn(); }); return id; }, clearTimeout: id => timers.delete(id) };
  const code = ts.transpileModule(readFileSync(new URL('../src/serviceBridge.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(code, { module, exports: module.exports, window, crypto: { randomUUID: () => `id-${++sequence}` }, URLSearchParams, Map, Error });
  return { api: module.exports, popup, timers, reply(patch = {}) { listeners.message({ origin: module.exports.SERVICE_ORIGIN, source: popup, data: { ...message, result: { ready: true } }, ...patch }); }, getMessage: () => message };
}

test('disconnected service fails without same-origin Pages API fetch', async () => { const { api } = setup(); await assert.rejects(api.serviceRequest('health'), /连接任务服务/); });
test('popup blocking is actionable', () => { const { api } = setup(true); assert.throws(() => api.connectService(), /弹出窗口/); });
test('accepts only matching origin, popup and nonce', async () => {
  const s = setup(); s.api.connectService(); const pending = s.api.serviceRequest('health');
  s.reply({ origin: 'https://example.com' }); assert.equal(s.timers.size, 1);
  s.reply({ source: {} }); assert.equal(s.timers.size, 1);
  s.reply({ data: { ...s.getMessage(), nonce: 'wrong', result: {} } }); assert.equal(s.timers.size, 1);
  s.reply(); assert.equal((await pending).ready, true); assert.equal(s.timers.size, 0);
});
test('server error is surfaced and request released', async () => { const s = setup(); s.api.connectService(); const pending = s.api.serviceRequest('health'); s.reply({ data: { ...s.getMessage(), error: 'service unavailable' } }); await assert.rejects(pending, /service unavailable/); assert.equal(s.timers.size, 0); });
test('uncertain submission does not silently retry', async () => { const s = setup(); s.api.connectService(); const pending = s.api.serviceRequest('submit'); [...s.timers.values()][0](); await assert.rejects(pending, /请勿重复提交/); assert.equal(s.timers.size, 0); });
