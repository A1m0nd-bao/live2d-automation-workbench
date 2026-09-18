import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeGroups, buildArmatureNodes } from '../src/vendor/stretchystudio/io/armatureOrganizer.js';
import { resolveVariantLayerBinding } from '../src/variantBinding.js';

const skeleton = {
  pelvis: {x: 50, y: 80}, waist: {x: 50, y: 60}, neck: {x: 50, y: 40},
  headBase: {x: 50, y: 30}, midEye: {x: 50, y: 20},
  lShoulder: {x: 70, y: 48}, rShoulder: {x: 30, y: 48},
  lElbow: {x: 76, y: 66}, rElbow: {x: 24, y: 66},
  lHip: {x: 65, y: 80}, rHip: {x: 35, y: 80},
  lKnee: {x: 65, y: 115}, rKnee: {x: 35, y: 115},
};

test('a combined Pro arm replacement uses bothArms alongside split neutral arms', () => {
  const layers = [
    {name: 'topwear'},
    {name: 'handwear-l'},
    {name: 'handwear-r'},
    {name: 'action_05_thinking_arms_only__handwear'},
  ];
  const map = Object.fromEntries(layers
    .filter((layer) => !layer.name.includes('__'))
    .map((layer) => [layer.name, layer]));
  const { groupDefs, assignments } = buildArmatureNodes(
    skeleton,
    analyzeGroups(map),
    layers,
    layers.map((_, index) => `part-${index}`),
    (() => { let index = 0; return () => `group-${index++}`; })(),
    {combinedArmAlternates: true},
  );
  const bothArms = groupDefs.find((group) => group.boneRole === 'bothArms');
  assert.ok(bothArms, 'combined action parent must be created');
  assert.ok(groupDefs.some((group) => group.boneRole === 'leftArm'));
  assert.ok(groupDefs.some((group) => group.boneRole === 'rightArm'));

  const binding = resolveVariantLayerBinding({
    slot: 'handwear', layers, assignments, groupDefs, layerIndex: 3,
  });
  assert.equal(binding.error, undefined);
  assert.equal(binding.combinedArmState, true);
  assert.equal(binding.parentGroupId, bothArms.id);
});

test('an unknown replacement slot remains a hard stop', () => {
  const binding = resolveVariantLayerBinding({
    slot: 'missing_slot',
    layers: [{name: 'handwear-l'}, {name: 'handwear-r'}],
    assignments: new Map(),
    groupDefs: [],
    layerIndex: 0,
  });
  assert.match(binding.error, /missing_slot/);
});
