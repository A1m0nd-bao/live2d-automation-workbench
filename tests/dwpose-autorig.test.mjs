import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const organizer = readFileSync(
  new URL('../src/vendor/stretchystudio/io/armatureOrganizer.js', import.meta.url),
  'utf8',
);
const engine = readFileSync(
  new URL('../src/cubismEngine.js', import.meta.url),
  'utf8',
);

test('auto-rig loads DWPose in-browser and keeps a cached fallback-safe session', () => {
  assert.match(organizer, /onnxruntime-web@1\.29\.0\/dist\/ort\.min\.mjs/);
  assert.match(organizer, /@vite-ignore/);
  assert.match(organizer, /export async function getDWPoseSession/);
  assert.match(organizer, /DWPOSE_URL/);
  assert.doesNotMatch(organizer, /兼容构建只使用图层边界估算骨架/);
});

test('Cubism generation uses AI keypoints for limbs while preserving semantic PSD parenting', () => {
  assert.match(engine, /getDWPoseSession\(onProgress\)/);
  assert.match(engine, /runDWPose\(/);
  assert.match(engine, /poseAssistedSkeleton\(/);
  assert.match(engine, /'legwear'/);
  assert.match(engine, /已回退为图层边界骨架/);
});
