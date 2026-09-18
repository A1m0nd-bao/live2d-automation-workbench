import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import fs from 'node:fs/promises';
import baseline from '../src/data/ana-motion-baseline-v1.json' with { type: 'json' };
import { prepareMotionWorkflow, readRuntimePackage, resolvePackagePath } from '../src/runtimeMotionWorkflow.mjs';

const parameters = [...new Set(baseline.motions.flatMap(m => m.adapted.Curves.map(c => c.Id)))].map(id => ({
  id, min: id.includes('Eye') && id.includes('Open') ? 0 : -30,
  max: id.includes('Eye') && id.includes('Open') ? 1 : 30,
  defaultValue: id.includes('Eye') && id.includes('Open') ? 1 : 0,
}));
parameters.push({ id: 'ParamActionWave', min: 0, max: 1, defaultValue: 0 });

async function fixture() {
  const zip = new JSZip();
  zip.file('ana/model.model3.json', JSON.stringify({ Version: 3, FileReferences: {
    Moc: 'model.moc3', Textures: ['textures/0.png'],
    Motions: { Original: [{ File: 'old.motion3.json', Name: 'keep-me' }] },
  } }));
  zip.file('ana/model.moc3', new Uint8Array([77, 79, 67, 51, 1, 2, 3]));
  zip.file('ana/textures/0.png', new Uint8Array([1, 2, 3]));
  zip.file('ana/old.motion3.json', JSON.stringify({ Version: 3, Curves: [] }));
  return zip;
}

test('unverified model retains its original motions and is not auto-approved', async () => {
  const zip = await fixture();
  const result = await prepareMotionWorkflow(await zip.generateAsync({ type: 'uint8array' }));
  assert.equal(result.baselineApplied, false);
  assert.equal(result.manifest.FileReferences.Motions.MorphBaseline, undefined);
});

test('trial appends all 9 curves, preserves MOC, textures, prior motions and source blob', async () => {
  const zip = await fixture(); const input = await zip.generateAsync({ type: 'uint8array' });
  const result = await prepareMotionWorkflow(input, { trialParameters: parameters });
  assert.equal(result.manifest.FileReferences.Motions.MorphBaseline.length, 9);
  assert.equal(result.report.status, 'trial-requires-visual-review');
  assert.equal(result.report.automaticAcceptance, false);
  assert.equal(result.manifest.FileReferences.Motions.Original[0].Name, 'keep-me');
  for (const name of ['ana/model.moc3', 'ana/textures/0.png', 'ana/old.motion3.json']) {
    assert.deepEqual(await result.zip.file(name).async('uint8array'), await zip.file(name).async('uint8array'));
  }
  assert.equal((await JSZip.loadAsync(input)).file('_morph_motion_workflow.json'), null);
  const reopened = await prepareMotionWorkflow(result.derived);
  assert.equal(reopened.manifest.FileReferences.Motions.MorphBaseline.length, 9);
  assert.equal(reopened.mocHash, result.mocHash);
  const curves = JSON.parse(await result.zip.file('ana/_morph_baseline_v1/official_03_mapped.motion3.json').async('string')).Curves;
  assert.deepEqual(curves, baseline.motions.find(m => m.file === 'official_03_mapped.motion3.json').adapted.Curves);
});

test('missing required bindings refuses trial, never invents parameters', async () => {
  const input = await (await fixture()).generateAsync({ type: 'uint8array' });
  await assert.rejects(prepareMotionWorkflow(input, { trialParameters: parameters.filter(p => p.id !== 'ParamRotation_leftKnee') }), /缺少 ParamRotation_leftKnee/);
});

test('references cannot escape ZIP, access a server, or select multiple models', async () => {
  assert.equal(resolvePackagePath('ana/model.model3.json', '../texture.png'), 'texture.png');
  for (const bad of ['../../escape.png', 'https://example.com/moc', '/token', '%2e%2e/escape', '..\\escape']) {
    assert.throws(() => resolvePackagePath('ana/model.model3.json', bad));
  }
  const zip = await fixture(); zip.remove('ana/model.moc3');
  await assert.rejects(readRuntimePackage(await zip.generateAsync({ type: 'uint8array' })), /缺少引用文件/);
  zip.file('extra.model3.json', '{}');
  await assert.rejects(readRuntimePackage(await zip.generateAsync({ type: 'uint8array' })), /仅含一个/);
});

test('stale report cannot certify a changed MOC', async () => {
  const result = await prepareMotionWorkflow(await (await fixture()).generateAsync({ type: 'uint8array' }), { trialParameters: parameters });
  result.zip.file('ana/model.moc3', 'another model');
  await assert.rejects(prepareMotionWorkflow(await result.zip.generateAsync({ type: 'uint8array' })), /记录与 MOC 不一致/);
});

test('locally approved Ana auto-integrates without modifying MOC', async t => {
  const source = new URL('../outputs/ana-aligned-v9-refined-20260913/ana-aligned-runtime.zip', import.meta.url);
  let file; try { file = await fs.readFile(source); } catch { return t.skip('Private Ana fixture is intentionally not committed'); }
  const before = await readRuntimePackage(file); const result = await prepareMotionWorkflow(file);
  assert.equal(result.baselineApplied, true);
  assert.equal(result.report.status, 'approved-ana-motion-profile');
  assert.equal(result.mocHash, before.mocHash);
  assert.equal(result.manifest.FileReferences.Motions.MorphBaseline.length, 9);
});
