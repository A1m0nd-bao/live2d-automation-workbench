/** Native nine-direction face/front-hair/back-hair grids with shared rest domain. */
import { uuid } from '../xmlbuilder.js';
import { emitKfBinding } from './deformerEmit.js';
import { createHeadVolume } from './headVolume.js';
import { emitFaceParallax as emitLegacy } from './faceParallaxLegacy.js';

export function emitFaceParallax(x, ctx) {
  if (ctx.headVolume === 'legacy') return emitLegacy(x, ctx);
  const volume = createHeadVolume(ctx);
  const face = emitSurface(x, ctx, volume, 'face', 'FaceParallax');
  const tags = new Set(ctx.meshes.map((m) => m.tag));
  if (tags.has('front hair') || tags.has('headwear')) {
    const id = emitSurface(x, ctx, volume, 'front', 'HeadVolumeFront');
    ctx.hairParallaxGuids?.set('front hair', id);
    ctx.hairParallaxGuids?.set('headwear', id);
  }
  if (tags.has('back hair'))
    ctx.hairParallaxGuids?.set(
      'back hair',
      emitSurface(x, ctx, volume, 'back', 'HeadVolumeBack'),
    );
  if (ctx.rigDebugLog)
    ctx.rigDebugLog.faceParallax = {
      ...volume.profile,
      gridCols: 11,
      gridRows: 11,
      surfaces: ['face', ...Array.from(ctx.hairParallaxGuids?.keys() || [])],
    };
  return face;
}
function emitSurface(x, ctx, volume, surface, deformerName) {
  const {
    pidParamAngleX,
    pidParamAngleY,
    pidFaceRotGuid,
    faceUnionBbox,
    facePivotCx,
    facePivotCy,
    allDeformerSources,
    rootPart,
    pidPartGuid,
    pidCoord,
  } = ctx;
  if (!(pidParamAngleX && pidParamAngleY)) return null;
  const fpCol = 10,
    fpRow = 10,
    fpGW = 11,
    fpGH = 11,
    fpGridPts = 121;
  const fpAngleKeys = [-30, 0, 30],
    fpKeyCombos = [],
    fpFormGuids = [],
    fpGridPositions = [];
  for (const ax of fpAngleKeys)
    for (const ay of fpAngleKeys) {
      fpKeyCombos.push([ax, ay]);
      const pos = [];
      for (let r = 0; r < fpGH; r++)
        for (let c = 0; c < fpGW; c++) {
          const gx = faceUnionBbox.minX + (c * faceUnionBbox.W) / fpCol,
            gy = faceUnionBbox.minY + (r * faceUnionBbox.H) / fpRow;
          const [px, py] = volume.project(gx, gy, ax, ay, surface);
          pos.push(px - facePivotCx, py - facePivotCy);
        }
      fpGridPositions.push(pos);
      const [, id] = x.shared('CFormGuid', {
        uuid: uuid(),
        note: `${deformerName}_ax${ax}_ay${ay}`,
      });
      fpFormGuids.push(id);
    }
  // Emit the single FaceParallax deformer (CWarpDeformerSource) targeting Body X.
  const [, pidFpGuid] = x.shared('CDeformerGuid', {
    uuid: uuid(),
    note: deformerName,
  });

  // KeyformBindings — AngleY first, AngleX second (Hiyori convention).
  const [fpKfbY, pidFpKfbY] = x.shared('KeyformBindingSource');
  const [fpKfbX, pidFpKfbX] = x.shared('KeyformBindingSource');
  const [fpKfg, pidFpKfg] = x.shared('KeyformGridSource');
  const fpKfogList = x.sub(fpKfg, 'array_list', {
    'xs.n': 'keyformsOnGrid',
    count: String(fpKeyCombos.length),
  });
  for (let ki = 0; ki < fpKeyCombos.length; ki++) {
    const ax = fpKeyCombos[ki][0],
      ay = fpKeyCombos[ki][1];
    const xi = fpAngleKeys.indexOf(ax);
    const yi = fpAngleKeys.indexOf(ay);
    const kog = x.sub(fpKfogList, 'KeyformOnGrid');
    const ak = x.sub(kog, 'KeyformGridAccessKey', { 'xs.n': 'accessKey' });
    const kop = x.sub(ak, 'array_list', {
      'xs.n': '_keyOnParameterList',
      count: '2',
    });
    const konY = x.sub(kop, 'KeyOnParameter');
    x.subRef(konY, 'KeyformBindingSource', pidFpKfbY, { 'xs.n': 'binding' });
    x.sub(konY, 'i', { 'xs.n': 'keyIndex' }).text = String(yi);
    const konX = x.sub(kop, 'KeyOnParameter');
    x.subRef(konX, 'KeyformBindingSource', pidFpKfbX, { 'xs.n': 'binding' });
    x.sub(konX, 'i', { 'xs.n': 'keyIndex' }).text = String(xi);
    x.subRef(kog, 'CFormGuid', fpFormGuids[ki], { 'xs.n': 'keyformGuid' });
  }
  const fpKfbList = x.sub(fpKfg, 'array_list', {
    'xs.n': 'keyformBindings',
    count: '2',
  });
  x.subRef(fpKfbList, 'KeyformBindingSource', pidFpKfbY);
  x.subRef(fpKfbList, 'KeyformBindingSource', pidFpKfbX);
  emitKfBinding(
    x,
    fpKfbY,
    pidFpKfg,
    pidParamAngleY,
    fpAngleKeys.map((k) => k + '.0'),
    'ParamAngleY',
  );
  emitKfBinding(
    x,
    fpKfbX,
    pidFpKfg,
    pidParamAngleX,
    fpAngleKeys.map((k) => k + '.0'),
    'ParamAngleX',
  );

  // Emit the CWarpDeformerSource
  const [fpDf, pidFpDf] = x.shared('CWarpDeformerSource');
  allDeformerSources.push({ pid: pidFpDf, tag: 'CWarpDeformerSource' });
  const fpAcdfs = x.sub(fpDf, 'ACDeformerSource', { 'xs.n': 'super' });
  const fpAcpcs = x.sub(fpAcdfs, 'ACParameterControllableSource', {
    'xs.n': 'super',
  });
  x.sub(fpAcpcs, 's', { 'xs.n': 'localName' }).text = deformerName;
  x.sub(fpAcpcs, 'b', { 'xs.n': 'isVisible' }).text = 'true';
  x.sub(fpAcpcs, 'b', { 'xs.n': 'isLocked' }).text = 'false';
  x.subRef(fpAcpcs, 'CPartGuid', pidPartGuid, { 'xs.n': 'parentGuid' });
  x.subRef(fpAcpcs, 'KeyformGridSource', pidFpKfg, {
    'xs.n': 'keyformGridSource',
  });
  const fpMft = x.sub(fpAcpcs, 'KeyFormMorphTargetSet', {
    'xs.n': 'keyformMorphTargetSet',
  });
  x.sub(fpMft, 'carray_list', { 'xs.n': '_morphTargets', count: '0' });
  const fpBwc = x.sub(fpMft, 'MorphTargetBlendWeightConstraintSet', {
    'xs.n': 'blendWeightConstraintSet',
  });
  x.sub(fpBwc, 'carray_list', { 'xs.n': '_constraints', count: '0' });
  x.sub(fpAcpcs, 'carray_list', { 'xs.n': '_extensions', count: '0' });
  x.sub(fpAcpcs, 'null', { 'xs.n': 'internalColor_direct_argb' });
  x.sub(fpAcpcs, 'null', { 'xs.n': 'internalColor_indirect_argb' });
  x.subRef(fpAcdfs, 'CDeformerGuid', pidFpGuid, { 'xs.n': 'guid' });
  x.sub(fpAcdfs, 'CDeformerId', { 'xs.n': 'id', idstr: deformerName });
  // FaceParallax targets Face Rotation → Body X.  Coord scales:
  //   - Face Rotation pivot:  in Body X 0..1  (its parent is a warp)
  //   - FaceParallax grid:    in canvas-pixel OFFSETS from Face Rotation's pivot
  //                           (its parent is a rotation deformer — see WARP_DEFORMERS.md
  //                           "Rotation Deformer Local Frame" for the evidence).
  // At rest (ParamAngleZ=0) Face Rotation is identity, so the chain is transparent.
  // At ±30 (mapped to ±10° rotation) Face Rotation rotates FaceParallax's grid
  // around the face pivot, producing head tilt for all face rig warp descendants.
  x.subRef(fpAcdfs, 'CDeformerGuid', pidFaceRotGuid, {
    'xs.n': 'targetDeformerGuid',
  });
  x.sub(fpDf, 'i', { 'xs.n': 'col' }).text = String(fpCol);
  x.sub(fpDf, 'i', { 'xs.n': 'row' }).text = String(fpRow);
  x.sub(fpDf, 'b', { 'xs.n': 'isQuadTransform' }).text = 'false';
  const fpKfsList = x.sub(fpDf, 'carray_list', {
    'xs.n': 'keyforms',
    count: String(fpKeyCombos.length),
  });
  for (let ki = 0; ki < fpKeyCombos.length; ki++) {
    const wdf = x.sub(fpKfsList, 'CWarpDeformerForm');
    const wdfAdf = x.sub(wdf, 'ACDeformerForm', { 'xs.n': 'super' });
    const wdfAcf = x.sub(wdfAdf, 'ACForm', { 'xs.n': 'super' });
    x.subRef(wdfAcf, 'CFormGuid', fpFormGuids[ki], { 'xs.n': 'guid' });
    x.sub(wdfAcf, 'b', { 'xs.n': 'isAnimatedForm' }).text = 'false';
    x.sub(wdfAcf, 'b', { 'xs.n': 'isLocalAnimatedForm' }).text = 'false';
    x.subRef(wdfAcf, 'CWarpDeformerSource', pidFpDf, { 'xs.n': '_source' });
    x.sub(wdfAcf, 'null', { 'xs.n': 'name' });
    x.sub(wdfAcf, 's', { 'xs.n': 'notes' }).text = '';
    x.sub(wdfAdf, 'f', { 'xs.n': 'opacity' }).text = '1.0';
    x.sub(wdfAdf, 'CFloatColor', {
      'xs.n': 'multiplyColor',
      red: '1.0',
      green: '1.0',
      blue: '1.0',
      alpha: '1.0',
    });
    x.sub(wdfAdf, 'CFloatColor', {
      'xs.n': 'screenColor',
      red: '0.0',
      green: '0.0',
      blue: '0.0',
      alpha: '1.0',
    });
    x.subRef(wdfAdf, 'CoordType', pidCoord, { 'xs.n': 'coordType' });
    x.sub(wdf, 'float-array', {
      'xs.n': 'positions',
      count: String(fpGridPts * 2),
    }).text = Array.from(fpGridPositions[ki])
      .map((v) => v.toFixed(6))
      .join(' ');
  }
  rootPart.childGuidsNode.children.push(x.ref('CDeformerGuid', pidFpGuid));
  rootPart.childGuidsNode.attrs.count = String(
    rootPart.childGuidsNode.children.length,
  );

  return pidFpGuid;
}
