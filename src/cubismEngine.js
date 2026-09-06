import JSZip from 'jszip';
import thirdPartyLicense from './vendor/stretchystudio/LICENSE?raw';
import { extractVariantManifest, importPsd } from './vendor/stretchystudio/io/psd.js';
import { splitLayerLR } from './vendor/stretchystudio/io/splitLR.js';
import {
  matchTag,
  analyzeGroups,
  estimateSkeletonFromBounds,
  buildArmatureNodes,
} from './vendor/stretchystudio/io/armatureOrganizer.js';
import { generateMesh } from './vendor/stretchystudio/mesh/generate.js';
import { exportLive2D, exportLive2DProject } from './vendor/stretchystudio/io/live2d/exporter.js';
import {
  saveProject,
  loadProject,
} from './vendor/stretchystudio/io/projectFile.js';

export const ENGINE_VERSION = 'stretchy-24a83a2-morph-compat-v1';
const transform = () => ({
  x: 0,
  y: 0,
  rotation: 0,
  scaleX: 1,
  scaleY: 1,
  pivotX: 0,
  pivotY: 0,
});
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const png = (canvas) =>
  new Promise((resolve, reject) =>
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('纹理编码失败'))),
      'image/png',
    ),
  );

const replacementMatches = (base, replacement) =>
  base === replacement || replacement === base.replace(/-[lr]$/, '');

function buildVariantAnimations(variants, layers, ids) {
  const layerIds = new Map(layers.map((layer, index) => [layer.name, ids[index]]));
  const tracksForVariant = (variant) => {
    const slots = variant.parts.map((part) => part.slot);
    const sameKind = variants.filter((candidate) => candidate.kind === variant.kind);
    const sameKindParts = new Set(
      sameKind.flatMap((candidate) => candidate.parts.map((part) => part.name)),
    );
    const tracks = [];
    for (let index = 0; index < layers.length; index++) {
      const layer = layers[index];
      const variantPart = variant.parts.find((part) => part.name === layer.name);
      const selected = Boolean(variantPart);
      const otherVariantPart = sameKindParts.has(layer.name) && !selected;
      const replaces = slots.some((slot) => replacementMatches(layer.name, slot));
      if (!selected && !otherVariantPart && !replaces) continue;
      tracks.push({
        nodeId: ids[index],
        property: 'opacity',
        keyframes: [
          // A state clip should apply atomically when playback starts.  A
          // stepped hold avoids the transparent, no-hand intermediate state.
          { time: 0, value: selected ? 1 : 0 },
          { time: 120, value: selected ? 1 : 0, easing: 'stepped' },
        ],
      });
    }
    return tracks;
  };
  return variants.map((variant) => ({
    name: variant.id,
    duration: 120,
    fps: 30,
    loop: false,
    tracks: tracksForVariant(variant),
    layerIds: variant.parts.map((part) => layerIds.get(part.name)).filter(Boolean),
  }));
}

export function validatePsdHeader(buffer) {
  if (buffer.byteLength < 26) throw new Error('PSD 文件不完整。');
  const view = new DataView(buffer);
  if (view.getUint32(0) !== 0x38425053 || view.getUint16(4) !== 1)
    throw new Error('请选择有效的 PSD 文件（不支持 PSB）。');
  const height = view.getUint32(14),
    width = view.getUint32(18);
  if (!width || !height || width > 4096 || height > 4096)
    throw new Error('当前浏览器生成支持最大 4096×4096 的 PSD。');
}

/** Preserve the source project; deliberately choose the verified standard-rig path. */
export function compatibilityProject(project) {
  return {
    ...project,
    nodes: project.nodes.filter((node) => node.type !== 'warpDeformer'),
  };
}

export async function generateCubism(
  file,
  name,
  onProgress = (_message) => {},
) {
  if (file.size > 100 * 1024 * 1024)
    throw new Error('当前支持最大 100 MB 的工程文件。');
  const urls = [];
  const images = new Map();
  const warnings = [];
  const safeName =
    name.replace(/[^\p{L}\p{N}_-]/gu, '_').slice(0, 80) || 'character';
  let project;
  let preview;
  try {
    onProgress('读取文件…');
    await tick();
    if (file.name?.toLowerCase().endsWith('.stretch')) {
      ({ project } = await loadProject(file));
      for (const texture of project.textures) urls.push(texture.source);
      if (project.nodes.some((node) => node.type === 'warpDeformer'))
        warnings.push(
          '已采用标准绑定兼容路径；原工程的手工变形器不会无损保留。',
        );
      project = compatibilityProject(project);
    } else {
      const buffer = await file.arrayBuffer();
      validatePsdHeader(buffer);
      const parsed = importPsd(buffer);
      const variantManifest = extractVariantManifest(buffer);
      const { width, height } = parsed;
      if (!parsed.layers.length || parsed.layers.length > 120)
        throw new Error('PSD 需要包含 1–120 个有效图层。');
      // Keep hidden PSD layers: they are alternate action/expression parts.
      const layers = [...parsed.layers];
      const candidates = [
        'handwear',
        'footwear',
        'irides',
        'eyebrow',
        'eyewhite',
        'eyelash',
        'ears',
      ];
      for (const base of candidates) {
        const index = layers.findIndex(
          (layer) => matchTag(layer.name) === base,
        );
        if (
          index < 0 ||
          layers.some((layer) =>
            [base + '-l', base + '-r'].includes(matchTag(layer.name)),
          )
        )
          continue;
        const layer = layers[index];
        const parts = splitLayerLR(layer, width, height);
        if (parts.left && parts.right)
          layers.splice(
            index,
            1,
            ...['right', 'left'].map((side) => ({
              ...layer,
              ...parts[side],
              name: base + (side === 'right' ? '-r' : '-l'),
            })),
          );
      }
      const variantByPart = new Map();
      for (const variant of variantManifest.variants)
        for (const part of variant.parts) variantByPart.set(part.name, variant);
      // Treat the unqualified PSD layers as the canonical, neutral pose.
      // A production file must never boot with alternate action/expression
      // groups visible just because an artist last previewed one in Photoshop.
      // In particular, the source PSD intentionally has the neutral arms
      // hidden while an action group is open; we restore the neutral layer
      // set here and keep every qualified replacement hidden until selected.
      const isInitiallyVisible = (layer) => !variantByPart.has(layer.name);
      const ids = layers.map(() => crypto.randomUUID());
      const tags = Object.fromEntries(
        layers.map((layer) => [matchTag(layer.name), layer]),
      );
      if (layers.filter((layer) => matchTag(layer.name)).length < 4)
        throw new Error(
          '图层名称无法识别。请使用 See-Through 命名的分层 PSD，或导入 .stretch 工程。',
        );
      const { groupDefs, assignments } = buildArmatureNodes(
        estimateSkeletonFromBounds(layers, width, height),
        analyzeGroups(tags),
        layers,
        ids,
        () => crypto.randomUUID(),
      );
      project = {
        version: 1,
        canvas: { width, height },
        textures: [],
        parameters: [],
        animations: buildVariantAnimations(variantManifest.variants, layers, ids),
        physics_groups: [],
        nodes: groupDefs.map((group) => ({
          id: group.id,
          type: 'group',
          name: group.name,
          parent: group.parentId,
          boneRole: group.boneRole,
          opacity: 1,
          visible: true,
          transform: {
            ...transform(),
            pivotX: group.pivotX,
            pivotY: group.pivotY,
          },
        })),
      };
      const composite = document.createElement('canvas');
      composite.width = width;
      composite.height = height;
      // PSD parser gives top-to-bottom layers; composite bottom-to-top for reference QA.
      for (const layer of [...layers].reverse()) {
        if (!isInitiallyVisible(layer)) continue;
        const tile = document.createElement('canvas');
        tile.width = layer.width;
        tile.height = layer.height;
        tile.getContext('2d').putImageData(layer.imageData, 0, 0);
        composite.getContext('2d').globalAlpha = layer.opacity;
        composite.getContext('2d').drawImage(tile, layer.x, layer.y);
      }
      preview = await png(composite);
      for (let i = 0; i < layers.length; i++) {
        const layer = layers[i];
        onProgress(`生成网格与纹理 ${i + 1}/${layers.length} · ${layer.name}`);
        await tick();
        if (layer.opacity !== 1 || layer.blendMode !== 'normal')
          warnings.push(
            `${layer.name} 含非标准混合/透明度，需要在 Cubism 中核查。`,
          );
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const tile = document.createElement('canvas');
        tile.width = layer.width;
        tile.height = layer.height;
        tile.getContext('2d').putImageData(layer.imageData, 0, 0);
        canvas.getContext('2d').drawImage(tile, layer.x, layer.y);
        const mesh = generateMesh(
          canvas.getContext('2d').getImageData(0, 0, width, height).data,
          width,
          height,
        );
        if (!mesh.triangles.length)
          throw new Error(`${layer.name} 无法生成有效网格。`);
        const source = URL.createObjectURL(await png(canvas));
        urls.push(source);
        project.textures.push({ id: ids[i], source });
        project.nodes.push({
          id: ids[i],
          type: 'part',
          name: layer.name,
          textureId: ids[i],
          parent: assignments.get(i)?.parentGroupId ?? null,
          draw_order: assignments.get(i)?.drawOrder ?? layers.length - 1 - i,
          visible: true,
          opacity: isInitiallyVisible(layer) ? layer.opacity : 0,
          transform: transform(),
          mesh,
          imageWidth: width,
          imageHeight: height,
          variant: variantManifest.variants.find((variant) =>
            variant.parts.some((part) => part.name === layer.name),
          )?.id,
        });
      }
    }
    for (const texture of project.textures) {
      const image = new Image();
      await new Promise((resolve, reject) => {
        image.onload = resolve;
        image.onerror = () => reject(new Error('纹理载入失败'));
        image.src = texture.source;
      });
      images.set(texture.id, image);
    }
    onProgress('生成 Cubism 标准参数、变形器与物理数据…');
    await tick();
    // The CMO3 writer is the conservative editor path.  Until an alternate
    // state has real Cubism keyform bindings, omit it here rather than
    // attempting to encode a zero-opacity initial form. Cubism otherwise
    // treats the handwritten ArtMesh state inconsistently and can open a
    // blank model. The untouched `project` below still feeds the web/runtime
    // exporter, where the variant manifest remains available.
    const cmoProject = {
      ...project,
      nodes: project.nodes.map((node) =>
        node.type === 'part' && node.variant
          ? { ...node, visible: false }
          : node,
      ),
    };
    const result = await exportLive2DProject(cmoProject, images, {
      modelName: safeName,
      generateRig: true,
      generatePhysics: true,
      onProgress: (message) => onProgress(message),
    });
    onProgress('生成运行时 .moc3 与 motion3…');
    const runtime = await exportLive2D(project, images, {
      modelName: safeName,
      exportMotions: true,
      onProgress: (message) => onProgress(message),
    });
    const header = new Uint8Array(await result.slice(0, 4).arrayBuffer());
    let cmo;
    let bundle;
    if (header[0] === 80 && header[1] === 75) {
      bundle = await JSZip.loadAsync(result);
      cmo = await bundle.file(`${safeName}.cmo3`)?.async('blob');
    } else {
      cmo = result;
      bundle = new JSZip();
      bundle.file(`${safeName}.cmo3`, cmo);
    }
    if (
      !cmo ||
      new TextDecoder().decode(await cmo.slice(0, 4).arrayBuffer()) !== 'CAFF'
    )
      throw new Error('导出文件不是有效的 Cubism 工程容器。');
    const stretch = await saveProject(project);
    const report = {
      engine: ENGINE_VERSION,
      source: file.name,
      meshCount: project.nodes.filter((node) => node.type === 'part').length,
      warnings,
      validation: '已生成，待 Cubism 动作验收；不代表动作或运行时编译通过。',
    };
    bundle.file('morph-report.json', JSON.stringify(report, null, 2));
    const runtimeBundle = runtime;
    bundle.file('StretchyStudio-LICENSE.txt', thirdPartyLicense);
    bundle.file(`${safeName}.stretch`, stretch);
    return {
      cmo,
      stretch,
      preview,
      bundle: await bundle.generateAsync({ type: 'blob' }),
      runtimeBundle,
      runtimeFile: `${safeName}-runtime.zip`,
      report,
      name: safeName,
    };
  } finally {
    urls.forEach((url) => URL.revokeObjectURL(url));
  }
}
