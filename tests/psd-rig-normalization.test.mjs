import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePsdRigLayers } from '../src/psdRigNormalization.js';
import { analyzeGroups, buildArmatureNodes, matchTag } from '../src/vendor/stretchystudio/io/armatureOrganizer.js';

function layer(name, x, y, width, height, rectangles) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (const [left, top, right, bottom] of rectangles) {
    for (let py = top; py < bottom; py += 1) for (let px = left; px < right; px += 1) {
      const i = (py * width + px) * 4;
      data.set([120, 130, 140, 255], i);
    }
  }
  return { name, x, y, width, height, opacity: 1, blendMode: 'normal', visible: true, imageData: { data, width, height } };
}

test('normalization repairs the neck painter order and derives paired legs and shoes', () => {
  const source = [
    layer('topwear', 20, 20, 60, 45, [[0, 0, 60, 45]]),
    layer('neck', 42, 8, 16, 32, [[0, 0, 16, 32]]),
    layer('face', 30, 0, 40, 30, [[0, 0, 40, 30]]),
    layer('front hair', 28, 0, 44, 22, [[0, 0, 44, 22]]),
    // A genuine disconnected leg pair.
    layer('legwear', 25, 60, 50, 70, [[0, 0, 20, 70], [30, 0, 50, 70]]),
    // A connected shoe silhouette: split with a reported, non-destructive seam.
    layer('footwear', 26, 125, 48, 20, [[0, 0, 48, 20]]),
  ];
  const normalized = normalizePsdRigLayers(source);
  assert.equal(normalized.lowerBodyRigReady, true);
  assert.deepEqual(normalized.layers.slice(0, 4).map(l => matchTag(l.name)), ['front hair', 'face', 'neck', 'topwear']);
  assert.ok(normalized.layers.some(l => matchTag(l.name) === 'legwear-l'));
  assert.ok(normalized.layers.some(l => matchTag(l.name) === 'legwear-r'));
  assert.ok(normalized.layers.some(l => matchTag(l.name) === 'footwear-l'));
  assert.ok(normalized.layers.some(l => matchTag(l.name) === 'footwear-r'));
  assert.ok(normalized.audit.actions.some(a => a.layer === 'footwear' && a.mode === 'center-seam'));
  // The source is untouched: that matters for review and for rerunning See-Through.
  assert.equal(source.filter(l => l.name === 'legwear').length, 1);
  assert.equal(source.filter(l => l.name === 'footwear').length, 1);
});

test('an incomplete lower body cannot create independent knee controls', () => {
  const source = [
    layer('legwear-l', 50, 40, 15, 55, [[0, 0, 15, 55]]),
    layer('legwear-r', 20, 40, 15, 55, [[0, 0, 15, 55]]),
    layer('footwear-l', 50, 90, 15, 10, [[0, 0, 15, 10]]),
  ];
  const normalized = normalizePsdRigLayers(source);
  assert.equal(normalized.lowerBodyRigReady, false);
  const layers = normalized.layers;
  const map = Object.fromEntries(layers.map(l => [matchTag(l.name), l]));
  const skeleton = { pelvis: { x: 40, y: 65 }, waist: { x: 40, y: 40 }, lHip: { x: 57, y: 45 }, rHip: { x: 27, y: 45 }, lKnee: { x: 57, y: 70 }, rKnee: { x: 27, y: 70 } };
  const built = buildArmatureNodes(skeleton, analyzeGroups(map), layers, layers.map((_, i) => `p${i}`), () => crypto.randomUUID(), { lowerBodyRigReady: normalized.lowerBodyRigReady });
  assert.equal(built.groupDefs.some(group => group.boneRole === 'leftKnee'), false);
  assert.equal(built.groupDefs.some(group => group.boneRole === 'rightKnee'), false);
});
