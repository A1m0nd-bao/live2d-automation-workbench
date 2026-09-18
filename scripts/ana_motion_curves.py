"""Lossless-in-time motion adaptation: scale all values/Bezier handles together."""
import copy

POLICY = {
    'bodyAmplitude': 0.35,
    'wholeLegLimitDegrees': 2,
    'wholeArmLimitDegrees': 10,
    'kneeLimitDegrees': 4,
    'note': 'Body XYZ amplitude reduced, not an isolated thigh deformer edit. Face, eyes and breath unchanged. Knee mapping is not v9 soft-knee geometry.',
}

def value_positions(segments):
    positions = [1]
    i = 2
    while i < len(segments):
        count = {0: 2, 1: 6, 2: 2, 3: 2}[segments[i]]
        positions.extend(range(i + 2, i + count + 1, 2))
        i += count + 1
    if i != len(segments):
        raise ValueError('Malformed motion segments')
    return positions

def adapt_curve(curve, target, bounds, default=0, scale=1):
    result = copy.deepcopy(curve)
    result['Id'] = target
    segments = result['Segments']
    positions = value_positions(segments)
    lo, hi = bounds
    if target in ('ParamRotation_leftArm', 'ParamRotation_rightArm'):
        lo, hi = max(lo, -POLICY['wholeArmLimitDegrees']), min(hi, POLICY['wholeArmLimitDegrees'])
    if target in ('ParamRotation_leftLeg', 'ParamRotation_rightLeg'):
        lo, hi = max(lo, -POLICY['wholeLegLimitDegrees']), min(hi, POLICY['wholeLegLimitDegrees'])
    if target in ('ParamBodyAngleX', 'ParamBodyAngleY', 'ParamBodyAngleZ'):
        scale *= POLICY['bodyAmplitude']
    # A single multiplier preserves the curve's shape (including Bezier tangents).
    deltas = [(segments[i] - default) * scale for i in positions]
    fit = 1.0
    for delta in deltas:
        if delta > 0:
            fit = min(fit, (hi - default) / delta)
        elif delta < 0:
            fit = min(fit, (lo - default) / delta)
    if fit < 0:
        raise ValueError('Default lies outside the safe range')
    for i, delta in zip(positions, deltas):
        segments[i] = default + delta * fit
    return result, {'scale': scale * fit, 'default': default, 'safeRange': [lo, hi], 'method': 'uniform amplitude scaling; times and segment types unchanged'}
