import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
function load(file) {
  const exports = {};
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(code, { exports, Blob, structuredClone, Uint8ClampedArray,
    require: name => name.startsWith('.') ? load(path.resolve(path.dirname(file), /\.(ts|js)$/.test(name) ? name : name + '.ts')) : require(name) });
  return exports;
}
const { repairSemanticOrder, semanticOrderReport } = load(path.resolve('src/psdSemanticOrder.ts'));
const layer = name => ({ name, left: 3, top: 4, right: 4, bottom: 5, hidden: false,
  imageData: { width: 1, height: 1, data: new Uint8ClampedArray([120, 50, 30, 255]) } });
const permutations = values => !values.length ? [[]] : values.flatMap((v, i) => permutations(values.filter((_, j) => i !== j)).map(tail => [v, ...tail]));

test('every body permutation gets only necessary semantic moves; data, offsets and unrelated order survive', () => {
  for (const order of permutations(['topwear', 'neck', 'face'])) {
    const layers = [layer(order[0]), layer('accessory-a'), layer(order[1]), layer('accessory-b'), layer(order[2])];
    const original = new Map(layers.map(l => [l, JSON.stringify(l)]));
    const report = repairSemanticOrder(layers);
    assert.equal(report.errors.length, 0);
    assert.equal(layers.filter(l => order.includes(l.name)).map(l => l.name).join(','), 'topwear,neck,face');
    assert.equal(layers.filter(l => l.name.startsWith('accessory')).map(l => l.name).join(','), 'accessory-a,accessory-b');
    for (const l of layers) assert.equal(JSON.stringify(l), original.get(l));
    assert.equal(repairSemanticOrder(layers).changed, false);
  }
});

test('each iris compares only with its own white, not the opposite eye', () => {
  const layers = ['topwear','neck','face','irides-r','eyewhite-r','eyewhite-l','irides-l'].map(layer);
  const report = repairSemanticOrder(layers);
  assert.equal(report.movedLayers.join(','), 'irides-r');
  assert.equal(report.errors.length, 0);
  assert.equal(semanticOrderReport(['irides-r','eyewhite-l'].map(layer)).errors.length, 2);
});

test('partial, duplicate, nested and dependency-bearing layers stop without mutation', () => {
  const cases = [
    ['face','neck'].map(layer), ['face','face','neck','topwear'].map(layer),
    [...['topwear','neck','face'].map(layer), { name:'eyes', children:[layer('irides-r')] }],
    [layer('face'), {...layer('neck'), clipping:true}, layer('topwear')],
    ['face','neck','topwear','action_02_wave_arms_only'].map(layer),
  ];
  for (const layers of cases) {
    const before = JSON.stringify(layers);
    assert.ok(repairSemanticOrder(layers).errors.length > 0);
    assert.equal(JSON.stringify(layers), before);
  }
});

test('actual PSD importer and Pro export correct the new copy, without changing input bytes', async () => {
  const psd = require('ag-psd');
  psd.initializeCanvas(() => { throw Error('canvas'); }, (width,height) => ({ width,height,data:new Uint8ClampedArray(width*height*4) }));
  const bytes = psd.writePsd({ width:8,height:8,children:['face','neck','topwear','irides-r','eyewhite-r','accessory'].map(layer) }, { noBackground:true });
  const before = Buffer.from(bytes).toString('hex');
  const { importPsd } = load(path.resolve('src/vendor/stretchystudio/io/psd.js'));
  const imported = importPsd(bytes);
  assert.equal(imported.quality.semanticOrder.errors.length,0);
  assert.equal(imported.quality.semanticOrder.changed,true);
  const { mergeLive2dProPsd } = load(path.resolve('src/live2dProMerge.ts'));
  const merged = mergeLive2dProPsd(bytes, []);
  const check = psd.readPsd(await merged.psd.arrayBuffer(), { useImageData:true });
  assert.equal(semanticOrderReport(check.children).errors.length,0);
  assert.equal(Buffer.from(bytes).toString('hex'),before);
  assert.equal(merged.report.cleanup.semanticOrder.neutralBaseline,'order_corrected_working_copy');
});
