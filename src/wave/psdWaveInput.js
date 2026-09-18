import { importPsd } from '../vendor/stretchystudio/io/psd.js';

export const WAVE_GROUP = 'action_02_wave_arms_only';
export const ARM_SLOTS = ['handwear-l', 'handwear-r'];

// All coordinates stay in the original PSD canvas. Hidden alternate layers
// are intentional inputs, not discarded or replaced with neutral artwork.
export function readWaveLayers(parsed) {
  const byName = new Map();
  for (const layer of parsed.layers) {
    if (byName.has(layer.name) && (ARM_SLOTS.includes(layer.name) || layer.name.startsWith(`${WAVE_GROUP}__`)))
      throw Error(`图层名称重复：${layer.name}，请保留唯一的动作输入。`);
    byName.set(layer.name, layer);
  }
  const required = ARM_SLOTS.flatMap(slot => [slot, `${WAVE_GROUP}__${slot}`]);
  const missing = required.filter(name => !byName.has(name));
  if (missing.length) throw Error(`缺少挥手素材图层：${missing.join('、')}。不会用基础手臂复制冒充动作素材。`);
  const pairs = Object.fromEntries(ARM_SLOTS.map(slot => [slot, {
    neutral: byName.get(slot), raised: byName.get(`${WAVE_GROUP}__${slot}`),
  }]));
  for (const pair of Object.values(pairs)) for (const layer of Object.values(pair)) {
    if (!layer.imageData?.data || layer.width < 2 || layer.height < 2)
      throw Error(`图层没有有效像素：${layer.name}`);
    if (layer.x < 0 || layer.y < 0 || layer.x + layer.width > parsed.width || layer.y + layer.height > parsed.height)
      throw Error(`图层超出画布：${layer.name}。第一版需要手臂完整位于画布内。`);
  }
  // Bind profile to pixel data as well as names and dimensions. This is a
  // deterministic cache identity, not a cryptographic security primitive.
  let hash = 2166136261;
  const add = value => { hash = Math.imul(hash ^ value, 16777619) >>> 0; };
  for (const c of `${parsed.width}:${parsed.height}`) add(c.charCodeAt(0));
  for (const name of required) {
    const l = byName.get(name);
    for (const c of `${name}:${l.x}:${l.y}:${l.width}:${l.height}`) add(c.charCodeAt(0));
    for (const value of l.imageData.data) add(value);
  }
  return { width: parsed.width, height: parsed.height, pairs,
    sourceId: `wave-v1-${hash.toString(16)}`,
    layers: parsed.layers.filter(l => !l.name.includes('__') || required.includes(l.name)),
  };
}

export function readWavePsd(buffer) {
  const view = new DataView(buffer instanceof ArrayBuffer ? buffer : buffer.buffer, buffer.byteOffset ?? 0, buffer.byteLength);
  if (view.byteLength < 26 || view.getUint32(0) !== 0x38425053 || view.getUint16(4) !== 1)
    throw Error('请选择有效的 PSD 文件。');
  const width = view.getUint32(18), height = view.getUint32(14);
  if (width > 4096 || height > 4096 || width * height > 16_777_216)
    throw Error('第一版支持最大 4096 × 4096 画布，请先缩小测试副本。');
  return readWaveLayers(importPsd(buffer));
}
