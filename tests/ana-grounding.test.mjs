import test from 'node:test';
import assert from 'node:assert/strict';
import { supportCorrection, installAnaGrounding, ANA_GROUNDING_HASH } from '../src/anaGrounding.mjs';

test('support foot stays at rest while preserving slight relative knee lift', () => {
  const result = supportCorrection([-.46, -.461], [-.446, -.446]);
  assert.ok(Math.abs(result.correction - .014) < 1e-9);
  assert.ok(Math.abs(result.residual[0]) < 1e-9);
  assert.ok(Math.abs(result.residual[1] - .001) < 1e-9);
  assert.equal(supportCorrection([0, 0], [NaN, 1]).valid, false);
  assert.equal(supportCorrection([0, 0], [1, 1]).correction, 0);
});

test('same-frame matrix correction is non-accumulating, reversible and hash gated', () => {
  const parameters = { values: new Float32Array([1]), defaultValues: new Float32Array([0]) };
  const drawables = { ids: ['ArtMesh17', 'ArtMesh18'], opacities: [1, 1], vertexPositions: [[0, -.46], [1, -.461]] };
  const core = { parameters, drawables, update() { drawables.vertexPositions.forEach((v, i) => v[1] = -.46 - i * .001 + parameters.values[0] * .014); } };
  const internal = { coreModel: { _model: core }, drawingMatrix: {}, updateTransform() { Object.assign(this.drawingMatrix, { c: 2, d: -3, tx: 5, ty: 6 }); } };
  // Store identity only; the adapter invokes this method with apply(this, args).
  // oxlint-disable-next-line typescript/unbound-method
  const original = internal.updateTransform;
  assert.equal(installAnaGrounding(internal, 'other-model'), null);
  const lock = installAnaGrounding(internal, ANA_GROUNDING_HASH);
  assert.equal(parameters.values[0], 1);
  for (let i = 0; i < 100; i++) internal.updateTransform();
  assert.ok(Math.abs(internal.drawingMatrix.ty - 6.042) < 1e-9);
  assert.ok(Math.abs(internal.drawingMatrix.tx - 4.972) < 1e-9);
  lock.setEnabled(false); internal.updateTransform();
  assert.equal(internal.drawingMatrix.ty, 6);
  lock.dispose();
  // oxlint-disable-next-line typescript/unbound-method
  assert.equal(internal.updateTransform, original);
});
