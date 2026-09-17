import { getDWPoseSession, loadDWPoseSession, runDWPose } from '../vendor/stretchystudio/io/armatureOrganizer.js';
import { ARM_SLOTS, WAVE_GROUP } from './psdWaveInput.js';
import { analyzeWaveInput } from './armPoseAnalyzer.js';

const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const finitePoint = point => Number.isFinite(point?.x) && Number.isFinite(point?.y);

// DWPose sees a fully composited person, whereas the wave workbench needs the
// arm-only replacement layers.  Build the two complete pictures explicitly so
// hidden alternate arms cannot pollute the neutral pose inference.
export function wavePoseLayers(input, pose) {
  const alternate = name => `${WAVE_GROUP}__${name}`;
  return input.layers
    .filter((layer) => {
      if (layer.name.includes('__')) return pose === 'raised' && ARM_SLOTS.some(slot => layer.name === alternate(slot));
      return pose === 'neutral' || !ARM_SLOTS.includes(layer.name);
    })
    // importPsd keeps Photoshop's top-to-bottom list. Canvas must paint in
    // bottom-to-top order, the same order used by the normal auto-rig path.
    .slice()
    .reverse();
}

function distanceToBox(point, layer) {
  const right = layer.x + layer.width, bottom = layer.y + layer.height;
  return Math.hypot(
    Math.max(layer.x - point.x, 0, point.x - right),
    Math.max(layer.y - point.y, 0, point.y - bottom),
  );
}

function jointsForSide(skeleton, side) {
  const prefix = side === 'l' ? 'l' : 'r';
  return [`${prefix}Shoulder`, `${prefix}Elbow`, `${prefix}Wrist`].map(key => skeleton[key]);
}

function candidateScore(points, fallback, layer) {
  if (!points.every(finitePoint)) return Infinity;
  const reach = Math.max(24, distance(fallback[0], fallback[2]));
  const agreement = points.reduce((sum, point, index) => sum + distance(point, fallback[index]), 0) / (3 * reach);
  const outside = points.reduce((sum, point) => sum + distanceToBox(point, layer), 0) / (3 * reach);
  // The alpha path is a useful safety rail: the pose model may choose a
  // sleeve, handbag, or the other arm when the character is heavily occluded.
  return agreement + outside * 1.5;
}

function selectionForPose(skeleton, input, profile, pose) {
  const options = [
    { 'handwear-l': 'l', 'handwear-r': 'r' },
    { 'handwear-l': 'r', 'handwear-r': 'l' },
  ].map((assignment) => {
    const slots = Object.fromEntries(ARM_SLOTS.map((slot) => {
      const points = jointsForSide(skeleton, assignment[slot]);
      return [slot, {
        points,
        side: assignment[slot],
        score: candidateScore(points, profile.slots[slot][pose], input.pairs[slot][pose]),
      }];
    }));
    return { slots, score: ARM_SLOTS.reduce((sum, slot) => sum + slots[slot].score, 0) };
  });
  return options.sort((a, b) => a.score - b.score)[0];
}

function jointDiagnostic(points) {
  const values = points.map(point => Number.isFinite(point?.confidence) ? point.confidence : null);
  return {
    rawConfidence: values,
    minimumRawConfidence: values.every(value => value !== null) ? Math.min(...values) : null,
  };
}

/**
 * Apply DWPose endpoint proposals only when they agree with the paired PSD
 * arm artwork.  This function is deliberately DOM-free so the acceptance
 * gate can be tested with synthetic skeletons.
 */
export function applyDWPoseWaveAssistance(profile, input, neutralSkeleton, raisedSkeleton) {
  const next = structuredClone(profile);
  const choices = {
    neutral: selectionForPose(neutralSkeleton, input, next, 'neutral'),
    raised: selectionForPose(raisedSkeleton, input, next, 'raised'),
  };
  const rejected = [];
  // A score of one means the proposed joints are roughly one arm-length away
  // from the semantic PSD layer. Keep a deliberately conservative threshold;
  // rejected proposals retain the alpha-derived profile and remain editable.
  const MAX_SAFE_SCORE = 0.72;
  for (const pose of ['neutral', 'raised']) {
    for (const slot of ARM_SLOTS) {
      const choice = choices[pose].slots[slot];
      const accepted = Number.isFinite(choice.score) && choice.score <= MAX_SAFE_SCORE;
      if (accepted) next.slots[slot][pose] = choice.points.map(({ x, y }) => ({ x, y }));
      else rejected.push(`${pose}:${slot}`);
      next.slots[slot].poseAssist ??= {};
      next.slots[slot].poseAssist[pose] = {
        method: accepted ? 'dwpose+alpha-check' : 'alpha-fallback',
        side: choice.side,
        agreementScore: Number.isFinite(choice.score) ? Number(choice.score.toFixed(3)) : null,
        accepted,
        ...jointDiagnostic(choice.points),
      };
    }
  }
  next.version = 2;
  next.method = rejected.length ? 'dwpose-alpha-guarded-fallback-v1' : 'dwpose-alpha-guarded-v1';
  next.assistance = {
    provider: 'DWPose 133-point',
    status: rejected.length ? 'partial-fallback' : 'accepted',
    rejected,
    reviewed: false,
  };
  return next;
}

/**
 * The production entrypoint. A model/network failure is non-fatal: users get
 * the existing local alpha-geodesic estimate plus a precise reason to review,
 * rather than a blocked PSD workflow.
 */
export async function autoCalibrateWaveWithDWPose(input, onStatus = () => {}, localModelFile = null) {
  const fallback = analyzeWaveInput(input);
  onStatus('1 / 分析成对手臂图层…');
  try {
    let session;
    if (localModelFile) {
      if (localModelFile.size < 10 * 1024 * 1024) throw Error('选择的本地 DWPose 模型文件不完整。');
      onStatus('1 / 正在读取本地 DWPose 模型…');
      session = await loadDWPoseSession(await localModelFile.arrayBuffer());
    } else {
      onStatus('1 / 下载并初始化 DWPose 关节点模型…');
      session = await getDWPoseSession(onStatus);
    }
    onStatus('1 / 识别基础姿态的肩、肘、腕…');
    const neutral = await runDWPose(wavePoseLayers(input, 'neutral'), input.width, input.height, session, onStatus);
    onStatus('1 / 识别抬手姿态的肩、肘、腕…');
    const raised = await runDWPose(wavePoseLayers(input, 'raised'), input.width, input.height, session, onStatus);
    const profile = applyDWPoseWaveAssistance(fallback, input, neutral, raised);
    profile.assistance.provider = localModelFile ? 'DWPose 133-point (local ONNX)' : 'DWPose 133-point';
    onStatus(profile.assistance.status === 'accepted' ? '1 / DWPose 标定完成，已通过图层校验。' : '1 / DWPose 有低可信关节，已保留图层标定回退。');
    return profile;
  } catch (error) {
    const detail = error instanceof Error ? error.message : '未知错误';
    fallback.version = 2;
    fallback.method = 'alpha-geodesic-fallback-v1';
    fallback.assistance = { provider: 'DWPose 133-point', status: 'unavailable', error: detail, reviewed: false };
    onStatus('1 / DWPose 不可用，已使用本地图层标定。');
    return fallback;
  }
}
