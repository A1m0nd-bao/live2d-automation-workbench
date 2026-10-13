import { buildWaveAction, WAVE_VARIANT, WAVE_PARAMETER, WAVE_KEYS } from './waveRig.js';

// One mutually-exclusive selector per kind. Wave keeps its measured 0..3
// phase lane; other poses occupy integer slots after it, never independent
// booleans that can accidentally hide the opposite hand.
export function buildStateCatalog(variants, waveRig) {
  return ['action', 'expression'].flatMap(kind => {
    const entries = variants.filter(v => v.kind === kind && v.parts.length);
    if (!entries.length) return [];
    const wave = kind === 'action' && entries.find(v => v.id === WAVE_VARIANT);
    const measuredWave = !!wave && !!waveRig;
    const endWave = measuredWave ? 3 : wave ? 1 : 0;
    let value = endWave;
    const states = entries.map(v => ({ ...v, value: v === wave ? endWave : ++value }));
    return [{ kind, parameter: wave ? WAVE_PARAMETER : kind === 'action' ? 'ParamActionPose' : 'ParamExpressionPose',
      name: kind === 'action' ? '动作状态（0＝基础）' : '表情状态（0＝基础）',
      max: value, measuredWave, states }];
  });
}

export function replacementTargets(slot) {
  return ({ handwear: ['handwear', 'handwear-l', 'handwear-r'],
    eyes: ['irides-l', 'irides-r', 'eyelash-l', 'eyelash-r', 'eyewhite-l', 'eyewhite-r'],
    brows: ['eyebrow-l', 'eyebrow-r'], mouth_nose: ['mouth', 'nose'] })[slot] ?? [slot];
}

export function buildStateAction(vertices, project, name) {
  const owners = (project.stateCatalog ?? []).filter(lane => lane.states.some(s =>
    s.parts.some(p => p.name === name || replacementTargets(p.slot).includes(name))));
  if (owners.length > 1) throw Error(`${name} 同时被动作和表情替换，需分开独立语义部件后再绑定`);
  const lane = owners[0];
  if (!lane) return buildWaveAction(vertices, project.waveRig, name);
  const wave = lane.states.find(s => s.id === WAVE_VARIANT);
  const waveEnd = lane.measuredWave ? 3 : wave ? 1 : 0;
  const sampledWave = lane.measuredWave ? buildWaveAction(vertices, project.waveRig, name) : null;
  const keys = lane.measuredWave ? [...WAVE_KEYS] : wave ? [0, .35, .65, 1] : [0];
  for (let i = waveEnd + 1; i <= lane.max; i++) keys.push(i - .5001, i - .4999, i);
  const isAlternate = lane.states.some(s => s.parts.some(p => p.name === name));
  const opacity = key => {
    if (wave && key <= waveEnd) {
      if (sampledWave) return sampledWave.stateOpacities[sampledWave.keys.indexOf(key)];
      const belongs = wave.parts.some(p => p.name === name);
      const replaces = wave.parts.some(p => replacementTargets(p.slot).includes(name));
      const blend = key <= .35 ? 0 : key >= .65 ? 1 : (key - .35) / .3;
      return belongs ? blend : isAlternate ? 0 : replaces ? 1 - blend : 1;
    }
    const selected = lane.states.find(s => s.value === Math.floor(key + .5));
    if (isAlternate) return selected?.parts.some(p => p.name === name) ? 1 : 0;
    return selected?.parts.some(p => replacementTargets(p.slot).includes(name)) ? 0 : 1;
  };
  return { id: lane.parameter, name: lane.name, keys,
    stateOpacities: keys.map(opacity),
    ...(sampledWave ? { stateVertices: keys.map((key, i) => key <= waveEnd
      ? sampledWave.stateVertices[i] : vertices) } : {}),
  };
}
