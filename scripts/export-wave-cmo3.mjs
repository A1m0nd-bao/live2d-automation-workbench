import fs from 'node:fs/promises';
import path from 'node:path';
import { initializeCanvas } from 'ag-psd';
import sharp from 'sharp';
import { importPsd, extractVariantManifest } from '../src/vendor/stretchystudio/io/psd.js';
import { generateCmo3 } from '../src/vendor/stretchystudio/io/live2d/cmo3writer.js';
import {
  matchTag,
  analyzeGroups,
  estimateSkeletonFromBounds,
  buildArmatureNodes,
} from '../src/vendor/stretchystudio/io/armatureOrganizer.js';
import { generateMesh } from '../src/vendor/stretchystudio/mesh/generate.js';

// ag-psd only needs this small canvas surface while decoding layer pixels.
class MockCanvas {
  constructor(width, height) {
    this.width = width;
    this.height = height;
    this.data = new Uint8ClampedArray(width * height * 4);
  }
  getContext() {
    return {
      getImageData: () => ({ data: this.data, width: this.width, height: this.height }),
      putImageData: (imageData) => this.data.set(imageData.data),
      createImageData: (width, height) => ({ data: new Uint8ClampedArray(width * height * 4), width, height }),
    };
  }
}

initializeCanvas(
  (width, height) => new MockCanvas(width, height),
  (width, height) => ({ data: new Uint8ClampedArray(width * height * 4), width, height }),
);

const source = process.argv[2] || '/Users/baotianrong/Downloads/00-cubism-import-free-v5.psd';
const output = process.argv[3] || '/Users/baotianrong/Downloads/动作替换首范例-多动作形态键-20260907.cmo3';
const raw = await fs.readFile(source);
const input = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
const parsed = importPsd(input);
const manifest = extractVariantManifest(input);
const actionIds = [
  'action_02_wave_arms_only',
  'action_03_hand_on_hip_arms_only',
  'action_04_arms_crossed_crossed_arms',
  'action_05_thinking_arms_only',
  'action_06_lean_forward_greeting_upper_body',
];
const actions = actionIds.map((id) => manifest.variants.find((variant) => variant.id === id));
if (actions.some((action) => !action)) {
  throw new Error('PSD 缺少多动作导出所需的 action_02 至 action_06 图层组。');
}
const stateCount = actions.length + 1; // 0 = neutral, 1..5 = actionIds order
const alternatePartByName = new Map();
for (let state = 1; state < stateCount; state += 1) {
  for (const part of actions[state - 1].parts) {
    alternatePartByName.set(part.name, { ...part, state });
  }
}

// Keep neutral art and the five selectable action states; expressions remain
// out of this experiment so the action selector is easy to audit.
const kept = parsed.layers.filter((layer) =>
  !layer.name.includes('__') || alternatePartByName.has(layer.name),
);

// A delta slot can replace one canonical layer, or an entire canonical set.
// The full-body greeting PSD uses composite eyes/brows/mouth_nose/handwear
// layers, while the neutral pose keeps those components split.
const replacementTargets = (slot) => ({
  handwear: ['handwear-l', 'handwear-r'],
  eyes: ['irides-l', 'irides-r', 'eyelash-l', 'eyelash-r', 'eyewhite-l', 'eyewhite-r'],
  brows: ['eyebrow-l', 'eyebrow-r'],
  mouth_nose: ['mouth', 'nose'],
}[slot] ?? [slot]);
const canonicalIndexForSlot = (slot) => {
  for (const candidate of replacementTargets(slot)) {
    const index = kept.findIndex((layer) => layer.name === candidate);
    if (index >= 0) return index;
  }
  return -1;
};
const ids = kept.map((_, index) => `psd_${index}`);
const tags = Object.fromEntries(kept.map((layer) => [matchTag(layer.name), layer]));
const { groupDefs, assignments } = buildArmatureNodes(
  estimateSkeletonFromBounds(kept, parsed.width, parsed.height),
  analyzeGroups(tags),
  kept,
  ids,
  () => crypto.randomUUID(),
);
const groups = groupDefs.map((group) => ({
  id: group.id,
  name: group.name,
  parent: group.parentId,
  boneRole: group.boneRole,
  transform: {
    x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1,
    pivotX: group.pivotX, pivotY: group.pivotY,
  },
}));

async function fullCanvasPng(layer) {
  const tile = await sharp(Buffer.from(layer.imageData.data), {
    raw: { width: layer.imageData.width, height: layer.imageData.height, channels: 4 },
  }).png().toBuffer();
  return sharp({
    create: { width: parsed.width, height: parsed.height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  }).composite([{ input: tile, left: layer.x, top: layer.y }]).png().toBuffer();
}

function fullCanvasPixels(layer) {
  const pixels = new Uint8ClampedArray(parsed.width * parsed.height * 4);
  const { width, height, data } = layer.imageData;
  for (let row = 0; row < height; row += 1) {
    const destination = ((layer.y + row) * parsed.width + layer.x) * 4;
    pixels.set(data.subarray(row * width * 4, (row + 1) * width * 4), destination);
  }
  return pixels;
}

const meshes = [];
for (let index = 0; index < kept.length; index += 1) {
  const layer = kept[index];
  const alternate = alternatePartByName.get(layer.name) ?? null;
  const slot = alternate?.slot ?? layer.name;
  // Match the base CMO's contour-following triangulation. Four-corner meshes
  // can only bend like cards, which is why the earlier action export lacked
  // the base model's natural breathing and secondary motion.
  const mesh = generateMesh(fullCanvasPixels(layer), parsed.width, parsed.height);
  if (!mesh.triangles.length) throw new Error(`${layer.name} 无法生成有效网格。`);
  const canonicalIndex = alternate ? canonicalIndexForSlot(slot) : index;
  const assignment = assignments.get(canonicalIndex);
  const stateOpacities = Array(stateCount).fill(alternate ? 0 : 1);
  if (alternate) {
    stateOpacities[alternate.state] = 1;
  } else {
    for (let state = 1; state < stateCount; state += 1) {
      const replacesThisLayer = actions[state - 1].parts.some((part) =>
        replacementTargets(part.slot).includes(layer.name),
      );
      if (replacesThisLayer) stateOpacities[state] = 0;
    }
  }
  meshes.push({
    name: layer.name,
    partId: `psd_${index}`,
    parentGroupId: assignment?.parentGroupId ?? null,
    vertices: mesh.vertices.flatMap((vertex) => [vertex.restX, vertex.restY]),
    uvs: Array.from(mesh.uvs),
    triangles: mesh.triangles.flat(),
    pngData: await fullCanvasPng(layer),
    texWidth: parsed.width,
    texHeight: parsed.height,
    tag: matchTag(slot),
    // importPsd returns PSD layers from front → back. Cubism draws a larger
    // drawOrder on top, so preserving the raw index reverses the artwork
    // (the back hair obscures the face, as seen in the first verification).
    drawOrder: assignment?.drawOrder ?? (kept.length - index),
    actionSwitch: {
      id: 'ParamAction',
      name: 'Action',
      stateOpacities,
    },
  });
}

const { cmo3 } = await generateCmo3({
  canvasW: parsed.width,
  canvasH: parsed.height,
  meshes,
  groups,
  actionSwitches: [{ id: 'ParamAction', name: 'Action', min: 0, max: actions.length, defaultVal: 0 }],
  modelName: '动作替换首范例-多动作形态键',
  generateRig: true,
  generatePhysics: true,
});

await fs.mkdir(path.dirname(output), { recursive: true });
await fs.writeFile(output, cmo3);
console.log(JSON.stringify({
  output,
  bytes: cmo3.byteLength,
  canvas: [parsed.width, parsed.height],
  meshes: meshes.length,
  states: ['neutral', ...actions.map((action) => action.id)],
}, null, 2));
