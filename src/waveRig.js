import { readWaveLayers } from './wave/psdWaveInput.js';
import { analyzeWaveInput, validateWaveProfile, buildArmWeightField } from './wave/armPoseAnalyzer.js';
import { measureArmShape, matchArmSection } from './wave/armShape.js';
// Shared canvas-space keyforms. No DOM, Cubism, or image-generation dependency.
export const WAVE_VARIANT = 'action_02_wave_arms_only';
export const WAVE_PARAMETER = 'ParamActionWave';
export const WAVE_KEYS = [
  ...Array.from({ length: 33 }, (_, i) => i / 32),
  ...Array.from({ length: 16 }, (_, i) => 1 + (i + 1) / 8),
];
export const WAVE_MESH_OPTIONS = { gridSpacing: 6, numEdgePoints: 300, edgePadding: 0 };
const clamp = (v) => Math.max(0, Math.min(1, v));
const smooth = (v) => { const t = clamp(v); return t * t * (3 - 2 * t); };
const mix = (a, b, t) => a + (b - a) * t;
const pointMix = (a, b, t) => ({ x: mix(a.x, b.x, t), y: mix(a.y, b.y, t) });
const angle = (a, b) => Math.atan2(b.y - a.y, b.x - a.x);
const length = (a, b) => Math.hypot(b.x - a.x, b.y - a.y);
const angleMix = (a, b, t) => a + Math.atan2(Math.sin(b - a), Math.cos(b - a)) * t;

export function trimWaveMesh(mesh, pixels, width) {
  mesh.triangles = mesh.triangles.filter(tri => {
    const x = Math.floor(tri.reduce((sum, i) => sum + mesh.vertices[i].restX, 0) / 3);
    const y = Math.floor(tri.reduce((sum, i) => sum + mesh.vertices[i].restY, 0) / 3);
    return pixels[(y * width + x) * 4 + 3] > 1;
  });
  return mesh;
}

export function resolveWaveProfile(layers, width, height, supplied) {
  const required = ['handwear-l', 'handwear-r'].flatMap(slot => [slot, `${WAVE_VARIANT}__${slot}`]);
  if (!required.every(name => layers.some(l => l.name === name))) return null;
  const input = readWaveLayers({ layers, width, height });
  const profile = supplied ? structuredClone(validateWaveProfile(supplied, input)) : analyzeWaveInput(input);
  for (const slot of Object.keys(profile.slots)) for (const pose of ['neutral', 'raised']) {
    profile.slots[slot][`${pose}Weights`] = buildArmWeightField(input.pairs[slot][pose], profile.slots[slot][pose]);
    profile.slots[slot][`${pose}Shape`] = measureArmShape(input.pairs[slot][pose], profile.slots[slot][pose]);
  }
  return profile;
}

// Nearest position along the measured arm centreline. This distinguishes a
// folded forearm from the nearby shoulder without an asset-specific cut line.
export function pathPosition(point, path) {
  let best = Infinity, position = 0, total = 0, cumulative = 0;
  for (let i = 1; i < path.length; i++) total += length(path[i - 1], path[i]);
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1], b = path[i], dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy);
    const t = clamp(((point.x - a.x) * dx + (point.y - a.y) * dy) / Math.max(1e-9, len * len));
    const d = Math.hypot(point.x - a.x - t * dx, point.y - a.y - t * dy);
    if (d < best) { best = d; position = cumulative + t * len; }
    cumulative += len;
  }
  return position / Math.max(1e-9, total);
}

function fieldWeight(p, field) {
  const fx=(p.x-field.x)/field.stride+.5,fy=(p.y-field.y)/field.stride+.5;
  const x0=Math.floor(fx),y0=Math.floor(fy);
  let sum=0,total=0;
  for(let y=y0;y<=y0+1;y++)for(let x=x0;x<=x0+1;x++){
    if(x<0||y<0||x>=field.width||y>=field.height)continue;
    const value=field.values[y*field.width+x],w=(1-Math.abs(x-fx))*(1-Math.abs(y-fy));
    if(value>=0){sum+=value*w;total+=w;}
  }
  if(total>1e-9)return sum/total/255;
  const gx=Math.round(fx),gy=Math.round(fy);
  for(let radius=0;radius<=4;radius++){
    let best=Infinity,value=null;
    for(let y=gy-radius;y<=gy+radius;y++)for(let x=gx-radius;x<=gx+radius;x++){
      if(x<0||y<0||x>=field.width||y>=field.height)continue;
      const v=field.values[y*field.width+x],d=(x-gx)**2+(y-gy)**2;
      if(v>=0&&d<best){best=d;value=v/255;}
    }
    if(value!==null)return value;
  }
  return null;
}

export function wavePose(profile, slot, phase) {
  if (!Number.isFinite(phase) || phase < 0 || phase > 3) throw Error('Wave phase must be between 0 and 3');
  const def = profile.slots[slot];
  const t = smooth(phase);
  const [a, b] = [def.neutral, def.raised];
  const shoulder = pointMix(a[0], b[0], t);
  const upperAngle = angleMix(angle(a[0], a[1]), angle(b[0], b[1]), t);
  const upperLength = mix(length(a[0], a[1]), length(b[0], b[1]), t);
  const elbow = { x: shoulder.x + Math.cos(upperAngle) * upperLength, y: shoulder.y + Math.sin(upperAngle) * upperLength };
  const sway = phase > 1 ? Math.sin((phase - 1) * Math.PI) * profile.amplitude * Math.PI / 180 : 0;
  const foreAngle = angleMix(angle(a[1], a[2]), angle(b[1], b[2]), t) + sway;
  const foreLength = mix(length(a[1], a[2]), length(b[1], b[2]), t);
  return [shoulder, elbow, { x: elbow.x + Math.cos(foreAngle) * foreLength, y: elbow.y + Math.sin(foreAngle) * foreLength }];
}

function segmentDistance(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const t = clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy));
  return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
}

function mapSegment(p, a, b, c, d) {
  const l = length(a, b), theta = angle(a, b), target = angle(c, d);
  if (l < 1 || length(c, d) < 1) throw Error('Wave joint segment is too short');
  const along = ((p.x - a.x) * Math.cos(theta) + (p.y - a.y) * Math.sin(theta)) / l;
  const across = -(p.x - a.x) * Math.sin(theta) + (p.y - a.y) * Math.cos(theta);
  return { x: c.x + along * (d.x - c.x) - across * Math.sin(target), y: c.y + along * (d.y - c.y) + across * Math.cos(target) };
}

export function deformWaveVertices(vertices, profile, slot, alternate, phase) {
  const source = profile.slots[slot][alternate ? 'raised' : 'neutral'];
  const target = wavePose(profile, slot, phase);
  const band = length(source[0], source[1]) * 0.09;
  const output = [];
  const def=profile.slots[slot],blend=waveHandoff(def,phase);
  const sourceShape=def[alternate?'raisedShape':'neutralShape'];
  const otherShape=def[alternate?'neutralShape':'raisedShape'];
  for (let i = 0; i < vertices.length; i += 2) {
    const p = { x: vertices[i], y: vertices[i + 1] };
    const du = segmentDistance(p, source[0], source[1]);
    // Extend the forearm through the fingertips: the wrist is not the end
    // of the influenced region, especially when the arm folds upward.
    const handEnd = { x: source[1].x + (source[2].x - source[1].x) * 2,
      y: source[1].y + (source[2].y - source[1].y) * 2 };
    const df = segmentDistance(p, source[1], handEnd);
    let weight = smooth(0.5 + (du - df) / (2 * band));
    const centerline = profile.slots[slot][alternate ? 'raisedPath' : 'neutralPath'];
    const field = profile.slots[slot][alternate ? 'raisedWeights' : 'neutralWeights'];
    const propagated = field ? fieldWeight(p, field) : null;
    if (propagated !== null) {
      weight = propagated;
    } else if (centerline) {
      const elbowAt = pathPosition(source[1], centerline);
      const wristAt = pathPosition(source[2], centerline);
      const width = Math.max(.035, Math.min(.12, (wristAt - elbowAt) * .25));
      weight = smooth(.5 + (pathPosition(p, centerline) - elbowAt) / (2 * width));
    } else if (alternate) {
      // A calibrated separator through the empty gap between the raised
      // forearm and upper arm. A continuous field also handles padding vertices.
      const line = profile.slots[slot].separator;
      let boundary = source[1].x;
      if (line) {
        const next = line.findIndex(([y]) => y >= p.y);
        if (next === 0) boundary = line[0][1];
        else if (next < 0) boundary = line.at(-1)[1];
        else boundary = mix(line[next - 1][1], line[next][1], (p.y - line[next - 1][0]) / (line[next][0] - line[next - 1][0]));
      }
      weight = smooth(0.5 + (boundary - p.x) / 6);
    }
    const u=matchArmSection(p,source[0],source[1],sourceShape,otherShape,0,alternate?1-blend:blend);
    const v=matchArmSection(p,source[1],source[2],sourceShape,otherShape,1,alternate?1-blend:blend);
    const upper = mapSegment(u, source[0], source[1], target[0], target[1]);
    const lower = mapSegment(v, source[1], source[2], target[1], target[2]);
    output.push(mix(upper.x, lower.x, weight), mix(upper.y, lower.y, weight));
  }
  return output;
}

export function waveHandoff(def, phase) {
  // Avoid unfolding the painted, tightly folded elbow through a large angle.
  // Use the straight arm for the lift and hand over only once the target is
  // close to the raised drawing. Thresholds are angular, not character pixels.
  const turn = Math.max(...[0, 1].map(i => {
    const a = angle(def.neutral[i], def.neutral[i + 1]);
    const b = angle(def.raised[i], def.raised[i + 1]);
    return Math.abs(angleMix(a, b, 1) - a);
  }));
  const start = Math.min(Math.PI / 6, turn * .65);
  const end = Math.min(Math.PI / 22.5, turn * .15);
  const remaining = turn * (1 - smooth(phase));
  return turn > 1e-6 ? smooth((start - remaining) / (start - end)) : smooth(phase);
}

export function buildWaveAction(vertices, profile, name) {
  const alternate = name.startsWith(`${WAVE_VARIANT}__`);
  const slot = alternate ? name.slice(WAVE_VARIANT.length + 2) : name;
  if (!profile?.slots[slot] || profile.slots[slot].active === false) return null;
  const def = profile.slots[slot];
  return {
    id: WAVE_PARAMETER, name: 'Raise and wave', keys: WAVE_KEYS,
    stateVertices: WAVE_KEYS.map(phase => deformWaveVertices(vertices, profile, slot, alternate, phase)),
    // Both paintings still follow the same joints; only the handoff timing
    // changes. Small-angle assets use a proportional transition as well.
    stateOpacities: WAVE_KEYS.map(phase => {
      const blend = waveHandoff(def,phase);
      // Two complementary opacities produce only 75% coverage at mid-fade.
      // Retain more underlay during the handover, then remove it completely;
      // matched opaque regions retain at least ~92% coverage at keyforms.
      return alternate ? blend : 1-blend**4;
    }),
  };
}

export function buildWaveMotions() {
  const make = (keys, loop) => ({
    Version: 3,
    Meta: { Duration: keys.at(-1)[0], Fps: 30, Loop: loop, AreBeziersRestricted: true,
      CurveCount: 1, TotalSegmentCount: keys.length - 1, TotalPointCount: keys.length, UserDataCount: 0, TotalUserDataSize: 0 },
    Curves: [{ Target: 'Parameter', Id: WAVE_PARAMETER, Segments: [...keys[0], ...keys.slice(1).flatMap(([t, v]) => [0, t, v])] }],
  });
  return {
    wave_only: make([[0, 1], [0.6, 2], [1.2, 3]], true),
    raise_wave_lower: make([[0, 0], [0.25, 0], [1.25, 1], [1.85, 2], [2.45, 3], [3.05, 2], [3.65, 1], [4.65, 0], [5, 0]], false),
  };
}
