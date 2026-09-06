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
const output = process.argv[3] || '/Users/baotianrong/Downloads/动作替换首范例-挥手形态键-20260906.cmo3';
const raw = await fs.readFile(source);
const input = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
const parsed = importPsd(input);
const manifest = extractVariantManifest(input);
const wave = manifest.variants.find((variant) => variant.id === 'action_02_wave_arms_only');
if (!wave) throw new Error('PSD does not contain action_02_wave_arms_only.');

const waveNames = new Set(wave.parts.map((part) => part.name));
const waveSlots = new Set(wave.parts.map((part) => part.slot));
const baseLayerForSlot = (slot) => parsed.layers.find((layer) => layer.name === slot);
for (const slot of waveSlots) {
  if (!baseLayerForSlot(slot)) throw new Error(`Wave slot ${slot} has no canonical base layer.`);
}

// Keep the neutral artwork plus the two wave alternates. Other actions and
// expressions are intentionally omitted, so the CMO opens in its base state.
const kept = parsed.layers.filter((layer) => !layer.name.includes('__') || waveNames.has(layer.name));
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
  const isWave = waveNames.has(layer.name);
  const slot = isWave ? layer.name.slice(layer.name.indexOf('__') + 2) : layer.name;
  const participates = waveSlots.has(slot);
  // Match the base CMO's contour-following triangulation. Four-corner meshes
  // can only bend like cards, which is why the earlier action export lacked
  // the base model's natural breathing and secondary motion.
  const mesh = generateMesh(fullCanvasPixels(layer), parsed.width, parsed.height);
  if (!mesh.triangles.length) throw new Error(`${layer.name} 无法生成有效网格。`);
  const canonicalIndex = isWave ? kept.findIndex((candidate) => candidate.name === slot) : index;
  const assignment = assignments.get(canonicalIndex);
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
    tag: matchTag(isWave ? slot : layer.name),
    // importPsd returns PSD layers from front → back. Cubism draws a larger
    // drawOrder on top, so preserving the raw index reverses the artwork
    // (the back hair obscures the face, as seen in the first verification).
    drawOrder: assignment?.drawOrder ?? (kept.length - index),
    actionSwitch: participates ? {
      id: 'ParamActionWave',
      name: 'Action: Wave',
      state: isWave ? 'alternate' : 'base',
      // 0–0.35: base, 0.35–0.65: cross-fade, 0.65–1: wave.
      transitionStart: 0.35,
      transitionEnd: 0.65,
    } : null,
  });
}

const { cmo3 } = await generateCmo3({
  canvasW: parsed.width,
  canvasH: parsed.height,
  meshes,
  groups,
  actionSwitches: [{
    id: 'ParamActionWave',
    name: 'Action: Wave',
    variantId: wave.id,
    baseSlots: [...waveSlots],
  }],
  modelName: '动作替换首范例-挥手形态键',
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
  waveSlots: [...waveSlots],
}, null, 2));
