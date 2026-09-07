export type ProStateKind = 'action' | 'expression';

export type ProState = {
  id: string;
  label: string;
  kind: ProStateKind;
  slotTargets: string[];
  direction: string;
};

/**
 * The first production preset deliberately matches the PSD protocol already
 * proven in Cubism: small social arm replacements plus small face deltas.
 * Full-body poses are excluded because they need their own complete layer map.
 */
export const LIVE2D_PRO_STATES: ProState[] = [
  {
    id: 'action_02_wave_arms_only', label: '挥手', kind: 'action',
    slotTargets: ['handwear-l', 'handwear-r'],
    direction: '仅改变左右手臂为自然挥手；头、脸、躯干、服装、双腿与镜头保持不变。',
  },
  {
    id: 'action_03_hand_on_hip_arms_only', label: '叉腰', kind: 'action',
    slotTargets: ['handwear-l', 'handwear-r'],
    direction: '仅改变左右手臂为自然叉腰；躯干、服装轮廓、头脸与镜头保持不变。',
  },
  {
    id: 'action_04_arms_crossed_crossed_arms', label: '抱臂', kind: 'action',
    slotTargets: ['handwear'],
    direction: '仅改变双臂为胸前自然抱臂；手臂必须完整，位于上衣前方。',
  },
  {
    id: 'action_05_thinking_arms_only', label: '思考', kind: 'action',
    slotTargets: ['handwear'],
    direction: '仅改变双臂为轻微思考姿势；不得遮住脸，不得改变身体比例。',
  },
  {
    id: 'expression_02_soft_smile_face_controls', label: '微笑', kind: 'expression',
    slotTargets: ['face', 'eyes', 'brows', 'mouth_nose', 'front_hair'],
    direction: '仅改变轻微微笑相关的脸、眼、眉、口鼻与必要的前发遮挡；身体姿势不变。',
  },
  {
    id: 'expression_04_embarrassed_face_controls', label: '脸红', kind: 'expression',
    slotTargets: ['face', 'eyes', 'brows', 'mouth_nose', 'front_hair'],
    direction: '仅增加克制脸红与羞赧表情；不得改变角色年龄感、服装或镜头。',
  },
  {
    id: 'expression_07_surprised_face_controls', label: '惊讶', kind: 'expression',
    slotTargets: ['face', 'eyes', 'brows', 'mouth_nose', 'front_hair'],
    direction: '仅改变为轻度惊讶；保持同一发型、面部比例与角色气质。',
  },
];

export type Live2DProManifest = {
  version: 1;
  mode: 'live2d-pro';
  sourceName: string;
  selectedStates: ProState[];
  requiredPipeline: string[];
  acceptance: string[];
};

export function selectedProStates(ids: string[]) {
  const selected = new Set(ids);
  return LIVE2D_PRO_STATES.filter((state) => selected.has(state.id));
}

export function buildLive2DProManifest(sourceName: string, stateIds: string[]): Live2DProManifest {
  const selectedStates = selectedProStates(stateIds);
  return {
    version: 1,
    mode: 'live2d-pro',
    sourceName,
    selectedStates,
    requiredPipeline: [
      'Persona Lock：固定身份、服装、画风、镜头与光源。',
      '生成中立全身主图与每个选中状态图；每张图保持相同画布和比例。',
      '每张图分别提交 See-Through，保存对应 PSD。',
      '按 slotTargets 做语义差分，写入 action_*__slot 或 expression_*__slot。',
      '对每个状态做合成、遮挡、缺件和锚点一致性检查。',
      '将通过质检的主 PSD 交给 Cubism 多状态导出。',
    ],
    acceptance: [
      '所有状态保持相同角色身份、服装结构、光源和透视。',
      '动作仅替换声明的目标槽位，未声明部件必须可复用基础层。',
      '每个状态与基础图画布一致，角色锚点与脚底基线一致。',
      '替换层命名为 <state id>__<slot>，并在 PSD 中默认隐藏。',
    ],
  };
}

export function live2dProStatePrompt(state: ProState) {
  return [
    '以 Persona Lock 和中立主图为唯一角色设定，生成同一角色的 Live2D Pro 状态图。',
    state.direction,
    '保持正面或近正面全身构图、相同焦距、相同画布比例、相同光源、相同服装和配饰。',
    '不要裁切四肢，不要新增道具、背景、角色或服装变化，不要改动角色身份。',
  ].join('');
}

export type ProLayerProbe = {
  name: string;
  bounds: [number, number, number, number];
};

export type ProDiffPlan = {
  stateId: string;
  replacements: Array<{ sourceLayer: string; targetSlot: string; outputLayer: string }>;
  warnings: string[];
  ready: boolean;
};

const candidateNames = (slot: string) => ({
  handwear: ['handwear', 'handwear-l', 'handwear-r'],
  eyes: ['eyes', 'eyewhite-l', 'eyewhite-r', 'eyelash-l', 'eyelash-r', 'irides-l', 'irides-r'],
  brows: ['brows', 'eyebrow-l', 'eyebrow-r'],
  mouth_nose: ['mouth_nose', 'mouth', 'nose'],
  // See-Through commonly retains the source Photoshop spacing here, while
  // the merged PSD protocol uses an underscore. Treat both as one slot.
  front_hair: ['front_hair', 'front hair', 'fronthair'],
}[slot] ?? [slot]);

/**
 * Create the deterministic part of a multi-PSD merge before pixels are
 * written. This makes missing semantic slots and camera drift visible before
 * destructive PSD composition. A later writer can consume `replacements`
 * directly to create hidden `state__slot` layers in the base PSD.
 */
export function planLive2DProDiff(
  state: ProState,
  baseLayers: ProLayerProbe[],
  stateLayers: ProLayerProbe[],
): ProDiffPlan {
  const baseNames = new Set(baseLayers.map((layer) => layer.name));
  const stateNames = new Set(stateLayers.map((layer) => layer.name));
  const replacements: ProDiffPlan['replacements'] = [];
  const warnings: string[] = [];
  for (const slot of state.slotTargets) {
    const candidates = candidateNames(slot);
    const sourceLayer = candidates.find((name) => stateNames.has(name));
    const baseExists = candidates.some((name) => baseNames.has(name));
    if (!baseExists) warnings.push(`基础 PSD 缺少 ${slot} 的规范槽位。`);
    if (!sourceLayer) warnings.push(`${state.label} PSD 缺少可用于 ${slot} 的图层。`);
    if (sourceLayer && baseExists) {
      replacements.push({
        sourceLayer,
        targetSlot: slot,
        outputLayer: `${state.id}__${slot}`,
      });
    }
  }
  const baseFace = baseLayers.find((layer) => layer.name === 'face');
  const stateFace = stateLayers.find((layer) => layer.name === 'face');
  if (baseFace && stateFace && !state.slotTargets.includes('face')) {
    const [bx1, by1, bx2, by2] = baseFace.bounds;
    const [sx1, sy1, sx2, sy2] = stateFace.bounds;
    const drift = Math.max(
      Math.abs(bx1 - sx1), Math.abs(by1 - sy1),
      Math.abs(bx2 - sx2), Math.abs(by2 - sy2),
    );
    if (drift > 12)
      warnings.push(`检测到脸部锚点偏移 ${drift}px；该状态不应移动脸部，建议重新生成。`);
  }
  return { stateId: state.id, replacements, warnings, ready: warnings.length === 0 };
}
