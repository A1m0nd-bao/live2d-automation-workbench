/** Vertical support-foot lock for the reviewed Ana MOC, not a rig/IK rewrite.
 * pixi-live2d-display 0.4.0 calls updateTransform AFTER Core.update, immediately
 * before draw. Correct its drawing matrix, never accumulate model.y offsets or
 * rewrite Core vertices/parameters. Drag, zoom, projection and pose remain intact.
 */
export const ANA_GROUNDING_HASH = '97f14b10bb8924ba03c25f6751352170303c6a448afc4e3f822db950ce849711';
const SHOES = ['ArtMesh17', 'ArtMesh18'];

export function supportCorrection(baseline, current) {
  if (baseline.length !== 2 || current.length !== 2 || ![...baseline, ...current].every(Number.isFinite)) {
    return { correction: 0, valid: false, residual: [] };
  }
  // Preserve the original one-pixel difference in sole height. Lowest relative
  // sole is the support; the other may lift slightly during a knee bend.
  const displacement = current.map((y, i) => y - baseline[i]);
  const correction = Math.min(...displacement);
  const valid = Math.abs(correction) <= 0.08;
  return { correction: valid ? correction : 0, valid,
    residual: displacement.map(y => y - (valid ? correction : 0)) };
}

export function installAnaGrounding(internal, mocHash) {
  // Mesh names alone do not identify shoes on another model.
  if (mocHash !== ANA_GROUNDING_HASH) return null;
  const core = internal.coreModel._model || internal.coreModel.getModel();
  const p = core.parameters, d = core.drawables;
  const indices = SHOES.map(id => d.ids.indexOf(id));
  if (indices.some(i => i < 0) || !internal.drawingMatrix || typeof internal.updateTransform !== 'function') return null;
  const soles = () => indices.map(i => {
    if (d.opacities[i] < 0.5) return NaN;
    let y = Infinity;
    const vertices = d.vertexPositions[i];
    for (let k = 1; k < vertices.length; k += 2) y = Math.min(y, vertices[k]);
    return y;
  });
  const saved = Float32Array.from(p.values);
  let baseline;
  try {
    p.values.set(p.defaultValues); core.update(); baseline = soles();
  } finally { p.values.set(saved); core.update(); }
  if (!baseline.every(Number.isFinite)) return null;
  let enabled = true;
  let status = { enabled, correction: 0, valid: true, residual: [0, 0] };
  const original = internal.updateTransform;
  function updateTransform(...args) {
    const result = original.apply(this, args);
    const measured = supportCorrection(baseline, soles());
    const correction = enabled ? measured.correction : 0;
    // Matrix maps Core (positive Y up) to the final viewport. Translation in
    // Core space must be transformed by both c and d (rotation/projection safe).
    const m = this.drawingMatrix;
    m.tx -= m.c * correction;
    m.ty -= m.d * correction;
    status = { ...measured, enabled, correction,
      residual: measured.residual.map(y => y + measured.correction - correction) };
    return result;
  }
  internal.updateTransform = updateTransform;
  return {
    setEnabled(value) { enabled = Boolean(value); },
    read() { return { ...status, residual: [...status.residual] }; },
    dispose() { if (internal.updateTransform === updateTransform) internal.updateTransform = original; },
  };
}
