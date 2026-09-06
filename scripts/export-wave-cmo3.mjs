import fs from 'node:fs/promises';
import path from 'node:path';
import { initializeCanvas } from 'ag-psd';
import sharp from 'sharp';
import { importPsd, extractVariantManifest } from '../src/vendor/stretchystudio/io/psd.js';
import { generateCmo3 } from '../src/vendor/stretchystudio/io/live2d/cmo3writer.js';

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
const rectVertices = [0, 0, parsed.width, 0, parsed.width, parsed.height, 0, parsed.height];
const rectUvs = [0, 0, 1, 0, 1, 1, 0, 1];
const rectTriangles = [0, 1, 2, 0, 2, 3];

async function fullCanvasPng(layer) {
  const tile = await sharp(Buffer.from(layer.imageData.data), {
    raw: { width: layer.imageData.width, height: layer.imageData.height, channels: 4 },
  }).png().toBuffer();
  return sharp({
    create: { width: parsed.width, height: parsed.height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  }).composite([{ input: tile, left: layer.x, top: layer.y }]).png().toBuffer();
}

const meshes = [];
for (let index = 0; index < kept.length; index += 1) {
  const layer = kept[index];
  const isWave = waveNames.has(layer.name);
  const slot = isWave ? layer.name.slice(layer.name.indexOf('__') + 2) : layer.name;
  const participates = waveSlots.has(slot);
  meshes.push({
    name: layer.name,
    partId: `psd_${index}`,
    vertices: rectVertices,
    uvs: rectUvs,
    triangles: rectTriangles,
    pngData: await fullCanvasPng(layer),
    texWidth: parsed.width,
    texHeight: parsed.height,
    drawOrder: index,
    actionSwitch: participates ? {
      id: 'ParamActionWave',
      name: 'Action: Wave',
      state: isWave ? 'alternate' : 'base',
    } : null,
  });
}

const { cmo3 } = await generateCmo3({
  canvasW: parsed.width,
  canvasH: parsed.height,
  meshes,
  groups: [],
  actionSwitches: [{
    id: 'ParamActionWave',
    name: 'Action: Wave',
    variantId: wave.id,
    baseSlots: [...waveSlots],
  }],
  modelName: '动作替换首范例-挥手形态键',
  generateRig: false,
  generatePhysics: false,
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
