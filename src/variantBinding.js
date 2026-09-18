/**
 * Resolve the parent for an authored Pro replacement layer.
 *
 * Most alternate PSD layers replace one canonical raster layer by its exact
 * slot name.  Arm poses are a deliberate exception: a state such as
 * `action_*__handwear` can be a single illustration containing both arms,
 * while the neutral pose is correctly split into `handwear-l` and
 * `handwear-r`.  It must follow the torso through a dedicated `bothArms`
 * group, rather than being guessed as either side (or rejected).
 */
export function resolveVariantLayerBinding({
  slot,
  layers,
  assignments,
  groupDefs,
  layerIndex,
}) {
  if (!slot) {
    return {
      assignmentIndex: layerIndex,
      parentGroupId: assignments.get(layerIndex)?.parentGroupId ?? null,
      semanticTag: null,
      combinedArmState: false,
    };
  }

  const assignmentIndex = layers.findIndex((part) => part.name === slot);
  if (assignmentIndex >= 0) {
    return {
      assignmentIndex,
      parentGroupId: assignments.get(assignmentIndex)?.parentGroupId ?? null,
      semanticTag: slot,
      combinedArmState: false,
    };
  }

  const hasSplitNeutralArms = ['handwear-l', 'handwear-r'].every((name) =>
    layers.some((part) => part.name === name),
  );
  const bothArms = groupDefs.find((group) => group.boneRole === 'bothArms');
  if (slot === 'handwear' && hasSplitNeutralArms && bothArms) {
    return {
      assignmentIndex: layerIndex,
      parentGroupId: bothArms.id,
      semanticTag: 'handwear',
      combinedArmState: true,
    };
  }

  return {
    assignmentIndex: -1,
    parentGroupId: null,
    semanticTag: slot,
    combinedArmState: false,
    error: `缺少对应基础图层 ${slot}，已拦截动作绑定`,
  };
}
