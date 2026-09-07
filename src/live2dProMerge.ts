import { readPsd, writePsd } from 'ag-psd';
import {
  type ProLayerProbe,
  type ProState,
  planLive2DProDiff,
} from './live2dPro';

type PsdLayer = {
  name?: string;
  left?: number;
  top?: number;
  right?: number;
  bottom?: number;
  hidden?: boolean;
  opacity?: number;
  blendMode?: string;
  imageData?: { data: Uint8ClampedArray | Uint8Array; width: number; height: number };
  children?: PsdLayer[];
};
type PsdDocument = {
  width: number;
  height: number;
  children?: PsdLayer[];
  [key: string]: unknown;
};

export type ProMergeInput = { state: ProState; data: ArrayBuffer; filename: string };
export type ProMergeReport = {
  version: 1;
  baseCanvas: [number, number];
  states: Array<{
    id: string;
    source: string;
    outputLayers: string[];
    warnings: string[];
  }>;
};

const aliases = (slot: string) => ({
  handwear: ['handwear', 'handwear-l', 'handwear-r'],
  eyes: ['eyes', 'eyewhite-l', 'eyewhite-r', 'eyelash-l', 'eyelash-r', 'irides-l', 'irides-r'],
  brows: ['brows', 'eyebrow-l', 'eyebrow-r'],
  mouth_nose: ['mouth_nose', 'mouth', 'nose'],
  front_hair: ['front_hair', 'front hair', 'fronthair'],
}[slot] ?? [slot]);

function leaves(layers: PsdLayer[] | undefined, output: PsdLayer[] = []) {
  for (const layer of layers || []) {
    if (layer.children?.length) leaves(layer.children, output);
    else if (layer.imageData) output.push(layer);
  }
  return output;
}

function bounds(layer: PsdLayer): [number, number, number, number] {
  return [layer.left || 0, layer.top || 0, layer.right || 0, layer.bottom || 0];
}

function probe(layer: PsdLayer): ProLayerProbe {
  return { name: layer.name || '', bounds: bounds(layer) };
}

function cloneImage(layer: PsdLayer, name: string): PsdLayer {
  if (!layer.imageData) throw new Error(`图层 ${layer.name || name} 没有可写入的像素数据。`);
  const [left, top, right, bottom] = bounds(layer);
  return {
    name,
    left,
    top,
    right,
    bottom,
    opacity: layer.opacity,
    blendMode: layer.blendMode,
    imageData: {
      width: layer.imageData.width,
      height: layer.imageData.height,
      data: new Uint8ClampedArray(layer.imageData.data),
    },
  };
}

function composite(layers: PsdLayer[], name: string): PsdLayer {
  if (layers.length === 1) return cloneImage(layers[0], name);
  const left = Math.min(...layers.map((layer) => bounds(layer)[0]));
  const top = Math.min(...layers.map((layer) => bounds(layer)[1]));
  const right = Math.max(...layers.map((layer) => bounds(layer)[2]));
  const bottom = Math.max(...layers.map((layer) => bounds(layer)[3]));
  const width = right - left;
  const height = bottom - top;
  const data = new Uint8ClampedArray(width * height * 4);

  // PSD children are painted in source order. Composite the small semantic
  // pieces into one canonical slot so Cubism receives one replaceable layer.
  for (const layer of layers) {
    if (!layer.imageData) continue;
    const source = layer.imageData;
    const [sourceLeft, sourceTop] = bounds(layer);
    const opacity = layer.opacity ?? 1;
    for (let y = 0; y < source.height; y += 1)
      for (let x = 0; x < source.width; x += 1) {
        const targetX = sourceLeft - left + x;
        const targetY = sourceTop - top + y;
        if (targetX < 0 || targetY < 0 || targetX >= width || targetY >= height) continue;
        const sourceOffset = (y * source.width + x) * 4;
        const targetOffset = (targetY * width + targetX) * 4;
        const sourceAlpha = (source.data[sourceOffset + 3] / 255) * opacity;
        if (!sourceAlpha) continue;
        const destinationAlpha = data[targetOffset + 3] / 255;
        const alpha = sourceAlpha + destinationAlpha * (1 - sourceAlpha);
        for (let channel = 0; channel < 3; channel += 1) {
          const sourceColor = source.data[sourceOffset + channel] / 255;
          const destinationColor = data[targetOffset + channel] / 255;
          data[targetOffset + channel] = Math.round(
            ((sourceColor * sourceAlpha + destinationColor * destinationAlpha * (1 - sourceAlpha)) / alpha) * 255,
          );
        }
        data[targetOffset + 3] = Math.round(alpha * 255);
      }
  }
  return { name, left, top, right, bottom, imageData: { data, width, height } };
}

function removeExistingVariant(document: PsdDocument, id: string) {
  const remove = (layers: PsdLayer[] | undefined): PsdLayer[] =>
    (layers || [])
      .filter((layer) => layer.name !== id)
      .map((layer) => ({
        ...layer,
        children: layer.children ? remove(layer.children) : undefined,
      }));
  document.children = remove(document.children);
}

/**
 * Merge separately decomposed state PSDs into a base PSD. It intentionally
 * writes hidden variant groups only; base layers remain untouched. The caller
 * must review the report before passing the file to Cubism.
 */
export function mergeLive2dProPsd(base: ArrayBuffer, inputs: ProMergeInput[]) {
  const document = readPsd(base, { useImageData: true, skipCompositeImageData: true }) as unknown as PsdDocument;
  const baseLayers = leaves(document.children).map(probe);
  const report: ProMergeReport = {
    version: 1,
    baseCanvas: [document.width, document.height],
    states: [],
  };
  for (const input of inputs) {
    const source = readPsd(input.data, { useImageData: true, skipCompositeImageData: true }) as unknown as PsdDocument;
    if (source.width !== document.width || source.height !== document.height)
      throw new Error(`${input.state.label} PSD 画布为 ${source.width}×${source.height}，与基础 PSD ${document.width}×${document.height} 不一致。`);
    const stateLayers = leaves(source.children);
    const plan = planLive2DProDiff(input.state, baseLayers, stateLayers.map(probe));
    if (!plan.ready)
      throw new Error(`${input.state.label} 无法合并：${plan.warnings.join('；')}`);

    const children: PsdLayer[] = [];
    for (const slot of input.state.slotTargets) {
      const names = new Set(aliases(slot));
      const sources = stateLayers.filter((layer) => names.has(layer.name || ''));
      if (!sources.length) throw new Error(`${input.state.label} 缺少 ${slot} 的像素图层。`);
      children.push(composite(sources, `${input.state.id}__${slot}`));
    }
    removeExistingVariant(document, input.state.id);
    (document.children ||= []).push({ name: input.state.id, hidden: true, opened: false, children });
    report.states.push({
      id: input.state.id,
      source: input.filename,
      outputLayers: children.map((layer) => layer.name || ''),
      warnings: plan.warnings,
    });
  }
  const data = writePsd(document as never, { noBackground: true, trimImageData: false });
  return { psd: new Blob([data], { type: 'image/vnd.adobe.photoshop' }), report };
}
