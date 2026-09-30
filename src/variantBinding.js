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

/** Keep the neutral arm when its wave alternate does not actually move. */
export function selectWaveVariantParts(manifest, layers, waveRig) {
  const byName = new Map(layers.map((layer) => [layer.name, layer]));
  const skipped = [];
  const variants = manifest.variants.map((variant) => ({
    ...variant,
    parts: variant.parts.filter((part) => {
      if (variant.id !== 'action_02_wave_arms_only' || !/^handwear-[lr]$/.test(part.slot)) return true;
      const base = byName.get(part.slot);
      const alternate = byName.get(part.name);
      const a = base?.imageData?.data;
      const b = alternate?.imageData?.data;
      let identical = Boolean(a && b && base.x === alternate.x && base.y === alternate.y
        && base.width === alternate.width && base.height === alternate.height
        && base.opacity === alternate.opacity && a.length === b.length);
      if (identical) for (let i = 0; i < a.length; i += 1) {
        if (a[i] !== b[i]) { identical = false; break; }
      }
      if (!identical && waveRig?.slots?.[part.slot]?.active !== false) return true;
      skipped.push({ name: part.name, reason: identical ? 'identical' : 'inactive' });
      return false;
    }),
  })).filter((variant) => variant.parts.length > 0);
  return { manifest: { ...manifest, variants }, skipped };
}
