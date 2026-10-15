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
    slotTargets: ['handwear-r', 'handwear-l'],
    direction: '仅改变双臂为轻微思考姿势；不得遮住脸，不得改变身体比例。',
  },
  {
    id: 'action_07_palm_up_arms_only', label: '托掌', kind: 'action',
    slotTargets: ['handwear-l', 'handwear-r'],
    direction: '仅改变一侧完整手臂为自然托掌；另一侧复用基础 PSD。',
  },
  {
    id: 'action_08_clenched_fist_arms_only', label: '握拳', kind: 'action',
    slotTargets: ['handwear-l', 'handwear-r'],
    direction: '仅改变一侧完整手臂为胸前握拳；另一侧复用基础 PSD。',
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
      '基础原图整理并拆层一次；已有分层 PSD 直接复用，不再生成基础图。',
      'psd-pose-variants：从基础 PSD 的原图层提取参考，仅生成完整肩—袖—肘—腕—手部件；不再生全身状态图或逐张 See-Through。',
      '按当前 PSD 的肩位和骨段长度对齐；单侧动作直接复用另一侧原层，不猜左右、不强拉伸。',
      '嘴部定位：沿用基础 PSD 独立 mouth 图层的原画布坐标；缺失、重复或 mouth_nose 合层进入人工确认，不自动删除鼻子或脸部。',
      '原生嘴部：从唯一独立 mouth 图层读取位置，绑定嘴线、口腔、舌头的张嘴 × 嘴型关键形态；闭嘴保留原画，缺失或合层则停止并提示修正。',
      '保留基础层、顺序和中立像素，将完整替换部件写入隐藏 action_* 组；表情与嘴部不进入该部件生成流程。',
      '对每个状态做合成、遮挡、缺件和锚点一致性检查。',
      '将通过质检的主 PSD 交给 Cubism 多状态导出。',
      '九向转头：生成并核查 AngleX × AngleY 的 3×3 关键形态，保留角色自身的头部和眼睛绑定。',
      'Pro 原生流程：嘴部绑定 → 九向核查 → CMO3/MOC3 编译 → 2700 组组合检查 → 统一预览，检查通过后仍需视觉验收。',
    ],
    acceptance: [
      '所有状态保持相同角色身份、服装结构、光源和透视。',
      '动作仅替换声明的目标槽位，未声明部件必须可复用基础层。',
      '每个状态与基础图画布一致，角色锚点与脚底基线一致。',
      '替换层命名为 <state id>__<slot>，并在 PSD 中默认隐藏。',
      '说话嘴部与表情状态只有一个最终控制入口，避免表情旧嘴叠加；闭口、双轴组合及头部跟随通过后，仍须原生导出验收。',
      '网页附加嘴部预览不等于已写入 CMO3/MOC3，原生包须重导出并逐项复核。',
    ],
  };
}

export function live2dProStatePrompt(state: ProState) {
  return [
    '以基础分层 PSD 的原画和手臂为权威参考，只生成完整肩袖手局部部件。',
    state.direction,
    '不要生成全身图；保持服装材质、袖型、手掌和骨段比例，真实透明背景。',
    '源 PSD 的其余图层不变，动作组默认隐藏，不再逐张拆件。',
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
