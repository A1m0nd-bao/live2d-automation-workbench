import JSZip from 'jszip';
import thirdPartyLicense from './vendor/stretchystudio/LICENSE?raw';
import { extractVariantManifest, importPsd } from './vendor/stretchystudio/io/psd.js';
import { splitLayerLR } from './vendor/stretchystudio/io/splitLR.js';
import {
  matchTag,
  analyzeGroups,
  estimateSkeletonFromBounds,
  getDWPoseSession,
  runDWPose,
  buildArmatureNodes,
} from './vendor/stretchystudio/io/armatureOrganizer.js';
import { generateMesh } from './vendor/stretchystudio/mesh/generate.js';
import { cleanRigLayer, calibratePose, assertRigMesh, limbWeights } from './autoRigPreflight.js';
import { normalizePsdRigLayers } from './psdRigNormalization.js';
import { exportLive2D, exportLive2DProject } from './vendor/stretchystudio/io/live2d/exporter.js';
import {
  saveProject,
  loadProject,
} from './vendor/stretchystudio/io/projectFile.js';

export const ENGINE_VERSION = 'stretchy-24a83a2-morph-rig-normalization-v3';
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
const stableAsciiName = (value) => {
  const source = String(value ?? 'character');
  let hash = 2166136261;
  for (const char of source) {
    hash ^= char.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  const stem = source
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48) || 'live2d_model';
  return `${stem}_${(hash >>> 0).toString(36)}`;
};
const png = (canvas) =>
  new Promise((resolve, reject) =>
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('纹理编码失败'))),
      'image/png',
    ),
  );

const replacementMatches = (base, replacement) =>
  base === replacement || replacement === base.replace(/-[lr]$/, '');

// PSD layer names are still the source of truth for parenting. DWPose refines
// the anatomical pivots from the rendered character, while the bounds-based
// skeleton remains a safe fallback for points the model cannot return.
// These are deliberately modest, one-directional production controls.  They
// are not pose synthesis: a three-state mesh keyform only flexes the limb
// below the detected elbow/knee, leaving the neutral illustration intact.
function buildAutoLimbBends(skeleton, width, height) {
  const validPoint = (point) =>
    point && Number.isFinite(point.x) && Number.isFinite(point.y) &&
    point.x >= 0 && point.y >= 0 && point.x <= width && point.y <= height;
  const specs = [
    ['handwear-l', 'ParamArmLBend', 'Arm L Bend', 'arm', skeleton.lElbow, skeleton.lWrist, 7],
    ['handwear-r', 'ParamArmRBend', 'Arm R Bend', 'arm', skeleton.rElbow, skeleton.rWrist, 7],
    ['legwear-l', 'ParamLegLBend', 'Leg L Bend', 'leg', skeleton.lKnee, skeleton.lAnkle, 5],
    ['legwear-r', 'ParamLegRBend', 'Leg R Bend', 'leg', skeleton.rKnee, skeleton.rAnkle, 5],
  ];
  return specs
    .filter(([, , , , pivot, endpoint]) => validPoint(pivot) && validPoint(endpoint))
    .map(([tag, id, name, kind, pivot, endpoint, maxAngle]) => ({
      tag, id, name, kind, pivot, endpoint, maxAngle,
    }));
}

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
  { variantIds } = {},
) {
  if (file.size > 100 * 1024 * 1024)
    throw new Error('当前支持最大 100 MB 的工程文件。');
  const urls = [];
  const images = new Map();
  const warnings = [];
  // Runtime bundle paths must be portable across Cubism Viewer, web hosts,
  // and ZIP extractors. Keep the UI task name separate from this ASCII-only
  // model identifier.
  const safeName = stableAsciiName(name);
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
      const sourceVariantManifest = extractVariantManifest(buffer);
      // A Pro PSD can contain a library of action/expression alternates.  A
      // production run must only materialise the states selected for this
      // delivery, otherwise unrequested alternates silently leak into the
      // CMO3 and its runtime package.
      const selectedVariantIds = Array.isArray(variantIds) && variantIds.length
        ? new Set(variantIds)
        : null;
      const variantManifest = selectedVariantIds
        ? {
          ...sourceVariantManifest,
          variants: sourceVariantManifest.variants.filter((variant) =>
            selectedVariantIds.has(variant.id),
          ),
        }
        : sourceVariantManifest;
      const activeVariantPartNames = new Set(
        variantManifest.variants.flatMap((variant) =>
          variant.parts.map((part) => part.name),
        ),
      );
      const { width, height } = parsed;
      if (!parsed.layers.length || parsed.layers.length > 120)
        throw new Error('PSD 需要包含 1–120 个有效图层。');
      // Keep hidden PSD layers: they are alternate action/expression parts.
      onProgress('清理工作副本的透明噪点并计算有效图层边界…');
      const cleaned = parsed.layers
        .filter((layer) => {
          const sourceVariant = sourceVariantManifest.variants.find((variant) =>
            variant.parts.some((part) => part.name === layer.name),
          );
          return !sourceVariant || activeVariantPartNames.has(layer.name);
        })
        .map(layer => cleanRigLayer(layer));
      let layers = cleaned.map(entry => entry.layer);
      const candidates = [
        'handwear',
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
      // This is the final PSD → CMO3 safety gate.  It never mutates the
      // uploaded PSD: the working layer stack gains a canonical neck order
      // and, only when safe, semantic left/right lower-limb layers.
      const normalization = normalizePsdRigLayers(layers);
      layers = normalization.layers;
      warnings.push(...normalization.audit.warnings);
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
      const neutralLayers = layers.filter(isInitiallyVisible);
      const boundsSkeleton = estimateSkeletonFromBounds(neutralLayers, width, height);
      let calibration = calibratePose(boundsSkeleton, {}, neutralLayers, width, height);
      let skeleton = calibration.skeleton;
      let poseDiagnostics = { method: 'bounds', boundsSkeleton, skeleton, decisions: calibration.decisions };
      try {
        const session = await getDWPoseSession(onProgress);
        // Alternate expression/action layers must not be visible to the pose
        // model; its anchors should describe the neutral production pose only.
        // The same bottom-to-top painter order as the reference and draw_order.
        const poseLayers = [...neutralLayers].reverse();
        const poseSkeleton = await runDWPose(
          poseLayers,
          width,
          height,
          session,
          onProgress,
        );
        calibration = calibratePose(
          boundsSkeleton,
          poseSkeleton,
          neutralLayers,
          width,
          height,
        );
        skeleton = calibration.skeleton;
        poseDiagnostics = { method: 'dwpose', boundsSkeleton, detectedSkeleton: poseSkeleton, skeleton, decisions: calibration.decisions };
        warnings.push('已使用 DWPose 并按有效图层位置校验左右肢体；头部枢轴采用有效脸/颈区域。');
      } catch (error) {
        // Model delivery and WASM support vary by browser/network. Exporting a
        // usable CMO3 is more important than making the pipeline wait forever.
        const detail = error instanceof Error ? error.message : '未知错误';
        warnings.push(`AI 姿态辅助未完成，已回退为图层边界骨架：${detail}`);
      }
      const { groupDefs, assignments } = buildArmatureNodes(
        skeleton,
        analyzeGroups(tags),
        layers,
        ids,
        () => crypto.randomUUID(),
        { lowerBodyRigReady: normalization.lowerBodyRigReady },
      );
      project = {
        version: 1,
        canvas: { width, height },
        autoRigDiagnostics: poseDiagnostics,
        autoRigPreflight: { version: 3, layers: cleaned.map(entry => entry.audit), normalization: normalization.audit, meshes: [] },
        autoRigAnchors: { head: skeleton.headBase },
        textures: [],
        parameters: [],
        // The generated CMO3 receives four optional, bounded controls:
        // 0 (neutral), 0.5 (subtle), 1 (small flex).  They are only emitted
        // when the PSD has separately named left/right limb layers.
        // Never emit a fallback leg-bend parameter when the matching shoes
        // were not proven to follow that leg.  A parameter with only thigh
        // targets recreates the detached-shoe failure even without leg bones.
        autoLimbBends: buildAutoLimbBends(skeleton, width, height)
          .filter((definition) => definition.kind !== 'leg' || normalization.lowerBodyRigReady),
        // Discrete production states are exported as Cubism parameters rather
        // than interpolated mesh poses.  Start with the safest useful case:
        // base arms ↔ action_02 wave arms.  Both endpoint states contain a
        // complete pair of arms, so the switch never exposes a no-hand pose.
        actionSwitches: variantManifest.variants
          .filter((variant) => variant.id === 'action_02_wave_arms_only')
          .map((variant) => ({
            id: 'ParamActionWave',
            name: 'Action: Wave',
            variantId: variant.id,
            baseSlots: variant.parts.map((part) => part.slot),
          })),
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
          { alphaThreshold: 1, gridSpacing: Math.max(6, Math.min(24, Math.min(layer.width, layer.height) / 5)), edgePadding: Math.min(8, Math.min(layer.width, layer.height) / 8), seed: i + 1 },
        );
        assertRigMesh(mesh, layer, width, height);
        const tag = matchTag(layer.name);
        const limb = tag === 'handwear-l' ? { side: 'l', joint: 'leftElbow', pivot: 'Elbow', endpoint: 'Wrist', label: '肘部' }
          : tag === 'handwear-r' ? { side: 'r', joint: 'rightElbow', pivot: 'Elbow', endpoint: 'Wrist', label: '肘部' }
          : tag === 'legwear-l' ? { side: 'l', joint: 'leftKnee', pivot: 'Knee', endpoint: 'Ankle', label: '膝部' }
          : tag === 'legwear-r' ? { side: 'r', joint: 'rightKnee', pivot: 'Knee', endpoint: 'Ankle', label: '膝部' }
          : tag === 'footwear-l' ? { side: 'l', joint: 'leftKnee', pivot: 'Knee', endpoint: 'Ankle', label: '膝部（鞋随小腿）' }
          : tag === 'footwear-r' ? { side: 'r', joint: 'rightKnee', pivot: 'Knee', endpoint: 'Ankle', label: '膝部（鞋随小腿）' }
          : null;
        if (limb && isInitiallyVisible(layer)) {
          const joint = groupDefs.find(group => group.boneRole === limb.joint);
          if (joint) {
            mesh.jointBoneId = joint.id;
            mesh.boneWeights = limbWeights(mesh.vertices, skeleton[limb.side + limb.pivot], skeleton[limb.side + limb.endpoint]);
            const minWeight = Math.min(...mesh.boneWeights);
            const maxWeight = Math.max(...mesh.boneWeights);
            // Shoes are wholly below the knee/ankle segment, so every vertex
            // should follow that segment.  A leg/arm mesh instead needs a
            // spread of weights across its joint to make an actual bend.
            const isFootwear = tag === 'footwear-l' || tag === 'footwear-r';
            if (isFootwear ? minWeight < 0.8 : minWeight > 0.15 || maxWeight < 0.75)
              throw Error(`${layer.name} ${limb.label}权重没有同时覆盖关节两侧，已拦截导出`);
          }
        }
        project.autoRigPreflight.meshes.push({ name:layer.name, tag, vertices:mesh.vertices.length, triangles:mesh.triangles.length, bounds:{x:layer.x,y:layer.y,width:layer.width,height:layer.height}, jointBoneId:mesh.jointBoneId ?? null, weightRange: mesh.boneWeights ? { min:Math.min(...mesh.boneWeights), max:Math.max(...mesh.boneWeights) } : null });
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
    // CMO3 uses a real, discrete ParamActionWave binding. Keep only the wave
    // alternates plus canonical parts in this first authoring pass; other
    // alternates remain hidden until their own bindings exist.
    const cmoProject = {
      ...project,
      nodes: project.nodes.map((node) =>
        node.type === 'part' && node.variant && node.variant !== 'action_02_wave_arms_only'
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
    const rigLogFile = Object.values(bundle.files).find(entry => entry.name.endsWith('.rig.log.json'));
    const rigLog = rigLogFile ? JSON.parse(await rigLogFile.async('string')) : null;
    const ineffective = rigLog?.bindingAudit?.parameters.filter(p => p.status !== 'structural-variation' && p.id !== 'ParamOpacity') ?? [];
    if (ineffective.length) warnings.push(`以下参数未通过有效目标检查，不计作可用动作：${ineffective.map(p=>p.id).join('、')}`);
    if (project.autoRigPreflight) warnings.push('此 CMO3 的绑定尚未由浏览器运行时编译器编入 moc3；运行包仅作静态预览，正式运行需 Cubism 原生导出。');
    const stretch = await saveProject(project);
    const report = {
      engine: ENGINE_VERSION,
      source: file.name,
      meshCount: project.nodes.filter((node) => node.type === 'part').length,
      autoRigDiagnostics: project.autoRigDiagnostics ?? null,
      autoRigPreflight: project.autoRigPreflight ?? null,
      bindingAudit: rigLog?.bindingAudit ?? null,
      runtimeBindingStatus: project.autoRigPreflight ? 'not-compiled-use-cubism-native-export' : 'unverified',
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
