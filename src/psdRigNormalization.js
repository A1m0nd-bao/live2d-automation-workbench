// Non-destructive PSD normalization for the last PSD → CMO3 stage.
//
// The original artist PSD is never written here.  Instead, we normalize the
// flattened *working* layers that are about to become Cubism art meshes, and
// save every decision in morph-report.json.  This is important because a
// pretty PSD with merged feet can still produce a formally valid but unusable
// leg rig.
import { matchTag } from './vendor/stretchystudio/io/armatureOrganizer.js';
import { splitLayerLR } from './vendor/stretchystudio/io/splitLR.js';

const ALPHA = 10;
const imageData = (data, width, height) =>
  typeof ImageData === 'function'
    ? new ImageData(data, width, height)
    : { data, width, height };

const alphaMass = (layer) => {
  let mass = 0;
  for (let i = 3; i < layer.imageData.data.length; i += 4) mass += layer.imageData.data[i];
  return mass;
};

const alphaBounds = (layer) => {
  const { data } = layer.imageData;
  let minX = layer.width, minY = layer.height, maxX = -1, maxY = -1, pixels = 0;
  for (let y = 0; y < layer.height; y += 1) for (let x = 0; x < layer.width; x += 1) {
    if (data[(y * layer.width + x) * 4 + 3] < ALPHA) continue;
    pixels += 1;
    minX = Math.min(minX, x); minY = Math.min(minY, y);
    maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
  }
  return maxX < 0 ? null : { x: layer.x + minX, y: layer.y + minY, width: maxX - minX + 1, height: maxY - minY + 1, pixels };
};

function cropLayer(layer, pixels) {
  let minX = layer.width, minY = layer.height, maxX = -1, maxY = -1;
  for (let y = 0; y < layer.height; y += 1) for (let x = 0; x < layer.width; x += 1) {
    if (pixels[(y * layer.width + x) * 4 + 3] < ALPHA) continue;
    minX = Math.min(minX, x); minY = Math.min(minY, y);
    maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
  }
  if (maxX < minX) return null;
  const width = maxX - minX + 1, height = maxY - minY + 1;
  const cropped = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const source = ((y + minY) * layer.width + x + minX) * 4;
    cropped.set(pixels.subarray(source, source + 4), (y * width + x) * 4);
  }
  return { ...layer, x: layer.x + minX, y: layer.y + minY, width, height, imageData: imageData(cropped, width, height) };
}

function pairIsUsable(pair, original) {
  if (!pair.left || !pair.right) return false;
  const total = Math.max(1, alphaMass(original));
  const left = alphaMass({ ...original, ...pair.left });
  const right = alphaMass({ ...original, ...pair.right });
  const leftBox = alphaBounds({ ...original, ...pair.left });
  const rightBox = alphaBounds({ ...original, ...pair.right });
  if (!leftBox || !rightBox) return false;
  // Do not turn a stray button or a tiny highlight into a "limb".  Both
  // resulting halves need meaningful ink and a substantial vertical extent.
  return left / total >= 0.12 && right / total >= 0.12 &&
    leftBox.height >= Math.max(12, original.height * 0.22) &&
    rightBox.height >= Math.max(12, original.height * 0.22);
}

// A shoe pair is occasionally one connected component because both soles
// touch in the source drawing.  A vertical alpha-minimum seam preserves the
// neutral image exactly while giving each side its own drawable.  It is only
// allowed after a true left/right leg pair is available, and is reported as a
// derived split so an artist can replace it with hand-authored layers later.
function splitByCenterSeam(layer, seamCanvasX) {
  const { data } = layer.imageData;
  const W = layer.width, H = layer.height;
  const anchor = Math.max(Math.floor(W * 0.2), Math.min(Math.ceil(W * 0.8), Math.round(seamCanvasX - layer.x)));
  const range = Math.max(3, Math.round(W * 0.18));
  const seam = new Int32Array(H);
  let previous = anchor;
  for (let y = 0; y < H; y += 1) {
    let bestX = anchor, bestEnergy = Infinity;
    for (let x = Math.max(0, anchor - range); x <= Math.min(W - 1, anchor + range); x += 1) {
      const alpha = data[(y * W + x) * 4 + 3] / 255;
      // Prefer transparent valleys but avoid a zig-zag cut through a shoe.
      const energy = alpha + Math.abs(x - anchor) / Math.max(1, range) * 0.035 + Math.abs(x - previous) * 0.08;
      if (energy < bestEnergy) { bestEnergy = energy; bestX = x; }
    }
    seam[y] = bestX;
    previous = bestX;
  }
  const right = new Uint8ClampedArray(data.length);
  const left = new Uint8ClampedArray(data.length);
  for (let y = 0; y < H; y += 1) for (let x = 0; x < W; x += 1) {
    const i = (y * W + x) * 4;
    (x <= seam[y] ? right : left).set(data.subarray(i, i + 4), i);
  }
  const pair = { right: cropLayer(layer, right), left: cropLayer(layer, left) };
  return { ...pair, usable: pairIsUsable(pair, layer), seam: Array.from(seam) };
}

const tagAt = (layer) => matchTag(layer.name);

function stableNeckOrder(layers) {
  const neckIndices = layers.map((layer, index) => tagAt(layer) === 'neck' ? index : -1).filter(index => index >= 0);
  const topwearIndices = layers.map((layer, index) => tagAt(layer) === 'topwear' ? index : -1).filter(index => index >= 0);
  if (!neckIndices.length || !topwearIndices.length) return { layers, action: null };

  // PSD import order is top → bottom.  The neck must sit behind facial art,
  // but in front of the torso garment.  Reorder only these semantic layers;
  // unrelated accessories keep their painter order.
  const headTags = new Set(['front hair', 'face', 'irides', 'irides-l', 'irides-r', 'eyebrow', 'eyebrow-l', 'eyebrow-r', 'eyewhite', 'eyewhite-l', 'eyewhite-r', 'eyelash', 'eyelash-l', 'eyelash-r', 'ears', 'ears-l', 'ears-r', 'nose', 'mouth']);
  const relevant = layers.map((layer, index) => ({ layer, index, tag: tagAt(layer) }))
    .filter(item => headTags.has(item.tag) || item.tag === 'neck' || item.tag === 'topwear');
  const desired = [
    // Front hair has to remain on top of the face even when an upstream PSD
    // saved the flattened group in a different painter order.
    ...relevant.filter(item => item.tag === 'front hair'),
    ...relevant.filter(item => headTags.has(item.tag) && item.tag !== 'front hair'),
    ...relevant.filter(item => item.tag === 'neck'),
    ...relevant.filter(item => item.tag === 'topwear'),
  ];
  const current = relevant.map(item => item.index).join(',');
  const target = desired.map(item => item.index).join(',');
  if (current === target) return { layers, action: null };
  const first = Math.min(...relevant.map(item => item.index));
  const chosen = new Set(relevant.map(item => item.index));
  const rest = layers.filter((_, index) => !chosen.has(index));
  const insertAt = layers.slice(0, first).filter((_, index) => !chosen.has(index)).length;
  const ordered = [...rest.slice(0, insertAt), ...desired.map(item => item.layer), ...rest.slice(insertAt)];
  return { layers: ordered, action: { kind: 'stack-order', message: '已规范 neck：位于脸/前发之后、topwear 之前', before: current, after: target } };
}

function neckVisibility(layers) {
  const index = layers.findIndex(layer => tagAt(layer) === 'neck');
  if (index < 0) return null;
  const neck = layers[index];
  let total = 0, visible = 0, hairBlocked = 0;
  for (let y = 0; y < neck.height; y += 1) for (let x = 0; x < neck.width; x += 1) {
    const alpha = neck.imageData.data[(y * neck.width + x) * 4 + 3] / 255;
    if (alpha <= 0) continue;
    total += alpha;
    let remaining = 1, hairRemaining = 1;
    const canvasX = neck.x + x, canvasY = neck.y + y;
    for (let i = 0; i < index; i += 1) {
      const above = layers[i];
      const localX = canvasX - above.x, localY = canvasY - above.y;
      if (localX < 0 || localY < 0 || localX >= above.width || localY >= above.height) continue;
      const cover = (above.imageData.data[(localY * above.width + localX) * 4 + 3] / 255) * (above.opacity ?? 1);
      remaining *= 1 - cover;
      if (tagAt(above) === 'front hair') hairRemaining *= 1 - cover;
    }
    visible += alpha * remaining;
    hairBlocked += alpha * (1 - hairRemaining);
  }
  return { visibleFraction: total ? visible / total : 0, foregroundHairOverlap: total ? hairBlocked / total : 0 };
}

/**
 * Normalize the working PSD layers for a safe lower-body and neck rig.
 * @returns {{layers:Array, lowerBodyRigReady:boolean, audit:Object}}
 */
export function normalizePsdRigLayers(sourceLayers) {
  let layers = [...sourceLayers];
  const actions = [], warnings = [];
  const neckOrder = stableNeckOrder(layers);
  layers = neckOrder.layers;
  if (neckOrder.action) actions.push(neckOrder.action);

  const splitPair = (base, allowSeam = false, seamCanvasX = null) => {
    const index = layers.findIndex(layer => tagAt(layer) === base);
    const existingLeft = layers.some(layer => tagAt(layer) === `${base}-l`);
    const existingRight = layers.some(layer => tagAt(layer) === `${base}-r`);
    if (existingLeft && existingRight) return { ready: true, mode: 'source' };
    if (index < 0 || existingLeft || existingRight) return { ready: false, mode: 'incomplete-source' };
    const original = layers[index];
    const components = splitLayerLR(original);
    let pair = components;
    let mode = 'connected-components';
    if (!pairIsUsable(pair, original) && allowSeam && Number.isFinite(seamCanvasX)) {
      pair = splitByCenterSeam(original, seamCanvasX);
      mode = 'center-seam';
    }
    if (!pairIsUsable(pair, original)) return { ready: false, mode: 'unsplittable', componentCount: components.componentCount };
    layers.splice(index, 1,
      { ...original, ...pair.right, name: `${base}-r` },
      { ...original, ...pair.left, name: `${base}-l` },
    );
    actions.push({ kind: 'derived-lr-split', layer: base, mode, componentCount: components.componentCount, message: `${base} 已拆为左右工作图层` });
    return { ready: true, mode, pair };
  };

  const legs = splitPair('legwear');
  let shoeSeam = null;
  if (legs.ready) {
    const right = layers.find(layer => tagAt(layer) === 'legwear-r');
    const left = layers.find(layer => tagAt(layer) === 'legwear-l');
    shoeSeam = ((right.x + right.width) + left.x) / 2;
  }
  const feet = splitPair('footwear', legs.ready, shoeSeam);
  const lowerBodyRigReady = legs.ready && feet.ready;
  if (!lowerBodyRigReady && (legs.ready || feet.ready)) {
    warnings.push('下肢或鞋未形成完整的左右配对，已禁用左右腿/屈膝绑定，避免鞋随腿脱离。请在 PSD 中提供 legwear-l/r 与 footwear-l/r，或让拆分服务重新生成。');
  }
  const visibility = neckVisibility(layers);
  if (visibility && visibility.visibleFraction < 0.12) {
    warnings.push(visibility.foregroundHairOverlap > 0.45
      ? 'neck 在前发遮挡后几乎不可见；这不是单纯层级问题，需由拆分服务补出可见颈部像素。'
      : 'neck 在规范层级后仍几乎不可见；请检查 neck 原始图层是否缺失或被衣领完全覆盖。');
  }
  return {
    layers,
    lowerBodyRigReady,
    audit: {
      version: 1,
      policy: 'non-destructive-working-layer-normalization',
      lowerBodyRigReady,
      neckVisibility: visibility,
      actions,
      warnings,
    },
  };
}
