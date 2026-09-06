import fs from 'node:fs/promises';
import path from 'node:path';
import { initializeCanvas } from 'ag-psd';
import sharp from 'sharp';
import { importPsd, extractVariantManifest } from '../src/vendor/stretchystudio/io/psd.js';

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
      createImageData: (width, height) => ({
        data: new Uint8ClampedArray(width * height * 4), width, height,
      }),
    };
  }
}

initializeCanvas(
  (width, height) => new MockCanvas(width, height),
  (width, height) => ({ data: new Uint8ClampedArray(width * height * 4), width, height }),
);

const source = process.argv[2] || '/Users/baotianrong/Downloads/00-cubism-import-free-v5.psd';
const output = process.argv[3] || path.resolve('outputs/variant-replacement-demo.mp4');
const buffer = await fs.readFile(source);
const parsed = importPsd(buffer);
const manifest = extractVariantManifest(buffer);
const variantByPart = new Map();
for (const variant of manifest.variants)
  for (const part of variant.parts) variantByPart.set(part.name, variant);
const layerPng = new Map();
for (const layer of parsed.layers) {
  layerPng.set(layer.name, await sharp(Buffer.from(layer.imageData.data), {
    raw: { width: layer.imageData.width, height: layer.imageData.height, channels: 4 },
  }).png().toBuffer());
}

const replaceMatches = (base, replacement) =>
  base === replacement || replacement === base.replace(/-[lr]$/, '');
const stateSlots = (state) => {
  const variants = state ? [state] : [];
  return new Set(variants.flatMap((id) => manifest.variants.find((v) => v.id === id)?.parts || []).map((p) => p.slot));
};
const actionStates = manifest.variants
  .filter((variant) => variant.kind === 'action')
  .map((variant) => ({ label: variant.id, id: variant.id, frames: 45 }));
// Each state is rendered atomically: base slots and replacement slots are
// resolved together for every frame, so no handless intermediate can appear.
const states = [{ label: '基础状态', id: '', frames: 30 }, ...actionStates, { label: '基础状态', id: '', frames: 30 }];
const frameDir = path.resolve('.variant-demo-frames');
await fs.rm(frameDir, { recursive: true, force: true });
await fs.mkdir(frameDir, { recursive: true });
let frame = 0;
for (const state of states) {
  const slots = stateSlots(state.id);
  const overlays = [];
  for (const layer of [...parsed.layers].reverse()) {
    const variant = variantByPart.get(layer.name);
    if (variant) {
      if (variant.id !== state.id || !layer.visible) continue;
    } else if (!layer.visible || [...slots].some((slot) => replaceMatches(layer.name, slot))) {
      continue;
    }
    overlays.push({ input: layerPng.get(layer.name), left: layer.x, top: layer.y });
  }
  for (let i = 0; i < state.frames; i++) {
    const framePng = await sharp({
      create: { width: parsed.width, height: parsed.height, channels: 4, background: { r: 246, g: 248, b: 252, alpha: 1 } },
    }).composite(overlays).png().toBuffer();
    await fs.writeFile(path.join(frameDir, `frame-${String(frame).padStart(4, '0')}.png`), framePng);
    frame++;
  }
}
await fs.mkdir(path.dirname(output), { recursive: true });
console.log(JSON.stringify({ source, output, width: parsed.width, height: parsed.height, frames: frame, states: states.map(({ label, frames }) => ({ label, frames })) }, null, 2));
