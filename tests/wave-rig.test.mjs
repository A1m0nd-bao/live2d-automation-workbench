import { WAVE_V5_PROFILE as profile } from './fixtures/wave-v5-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { WAVE_KEYS, buildWaveAction, deformWaveVertices, wavePose, resolveWaveProfile, buildWaveMotions } from '../src/waveRig.js';
import { generateCmo3 } from '../src/vendor/stretchystudio/io/live2d/cmo3writer.js';

const near = (a, b) => { assert.equal(a.length, b.length); a.forEach((v, i) => assert.ok(Math.abs(v - b[i]) < 1e-7, `${i}: ${v} != ${b[i]}`)); };
const name = 'action_02_wave_arms_only__handwear-r';
const raised = [456, 232, 440, 260, 431, 341, 402, 253, 390, 190, 425, 215];

test('neutral and raised endpoints preserve their original artwork exactly', () => {
  near(deformWaveVertices(raised, profile, 'handwear-r', true, 1), raised);
  const neutral = [456, 232, 441, 384, 414, 520, 412, 540];
  near(deformWaveVertices(neutral, profile, 'handwear-r', false, 0), neutral);
});

test('wave fixes the shoulder and upper arm, moves fingers, and closes its loop', () => {
  const rest = deformWaveVertices(raised, profile, 'handwear-r', true, 1);
  const swing = deformWaveVertices(raised, profile, 'handwear-r', true, 1.5);
  near(swing.slice(0, 4), rest.slice(0, 4));
  assert.ok(Math.hypot(swing[8] - rest[8], swing[9] - rest[9]) > 10);
  near(deformWaveVertices(raised, profile, 'handwear-r', true, 3), rest);
  const before = deformWaveVertices(raised, profile, 'handwear-r', true, 1 - 1e-6);
  assert.ok(Math.max(...before.map((v, i) => Math.abs(v - rest[i]))) < .001);
});

test('both paintings share wrist and elbow trajectories during the lift', () => {
  for (const phase of WAVE_KEYS) {
    const target = wavePose(profile, 'handwear-r', phase);
    for (const alternate of [false, true]) {
      const wrist = profile.slots['handwear-r'][alternate ? 'raised' : 'neutral'][2];
      near(deformWaveVertices([wrist.x, wrist.y], profile, 'handwear-r', alternate, phase), [target[2].x, target[2].y]);
    }
  }
  const base = buildWaveAction(raised, profile, 'handwear-r');
  const alt = buildWaveAction(raised, profile, name);
  base.stateOpacities.forEach((v, i) => { const b=alt.stateOpacities[i]; assert.ok(b+v*(1-b)>=.91); });
  assert.equal(buildWaveAction(raised, profile, 'face'), null);
  assert.equal(resolveWaveProfile([], 1024, 1024), null);
  assert.throws(() => wavePose(profile, 'handwear-r', NaN));
});

test('motion curves stay in range and metadata matches segment encoding', () => {
  for (const motion of Object.values(buildWaveMotions())) {
    const s = motion.Curves[0].Segments;
    assert.equal(motion.Meta.TotalSegmentCount, (s.length - 2) / 3);
    assert.equal(motion.Meta.Duration, s.at(-2));
    let previous = s[0];
    for (let i = 2; i < s.length; i += 3) {
      assert.ok(s[i + 1] > previous); previous = s[i + 1];
      assert.ok(s[i + 2] >= 0 && s[i + 2] <= 3);
    }
  }
});

test('folded artwork is not unfolded at mid-lift and the handover adapts to joint angles', () => {
  const make = degrees => ({amplitude:7,slots:{arm:{
    neutral:[{x:0,y:0},{x:0,y:100},{x:0,y:200}],
    raised:[{x:0,y:0},{x:0,y:100},{x:100*Math.sin(degrees*Math.PI/180),y:100+100*Math.cos(degrees*Math.PI/180)}],
  }}});
  const large=make(150),small=make(30);
  const opacity=p=>buildWaveAction([0,100],p,'action_02_wave_arms_only__arm').stateOpacities;
  const big=opacity(large),little=opacity(small);
  assert.equal(big[WAVE_KEYS.indexOf(.5)],0);
  assert.ok(little[WAVE_KEYS.indexOf(.5)]>big[WAVE_KEYS.indexOf(.5)]);
  assert.equal(big[0],0);assert.equal(big[WAVE_KEYS.indexOf(1)],1);
  big.forEach((n,i)=>{if(i)assert.ok(n>=big[i-1]);});
  const transformed=structuredClone(large);
  for(const pose of ['neutral','raised'])transformed.slots.arm[pose]=large.slots.arm[pose].map(p=>({x:500-2*p.x,y:80+2*p.y}));
  near(opacity(transformed),big);
});

test('weight-grid cell boundaries do not create jumps in elbow geometry', () => {
  const p={amplitude:7,slots:{arm:{
    neutral:[{x:0,y:0},{x:0,y:10},{x:0,y:20}],
    raised:[{x:0,y:0},{x:0,y:10},{x:10,y:10}],
    neutralWeights:{x:0,y:9,stride:1,width:4,height:4,values:Array.from({length:16},(_,i)=>(i%4)*85)},
  }}};
  const v=deformWaveVertices([1-1e-5,10,1+1e-5,10],p,'arm',false,.5);
  assert.ok(Math.hypot(v[2]-v[0],v[3]-v[1])<.001);
});

// Read the actual serialized XML from CAFF, independent of writer diagnostics.
async function readXml(bytes) {
  const b = Buffer.from(bytes), key = b.readInt32BE(14), mask = (BigInt(key) << 32n) | BigInt(key);
  let offset = 54;
  const i32 = () => { const v = b.readInt32BE(offset) ^ key; offset += 4; return v; };
  const str = () => { let size = 0, digit; do { digit = b[offset++] ^ key; size = (size << 7) | (digit & 127); } while (digit & 128); const data = b.subarray(offset, offset + size); offset += size; return Buffer.from(data, 0, data.length).map(v => v ^ key).toString(); };
  const count = i32();
  for (let i = 0; i < count; i++) {
    const file = str(); str();
    const start = Number(b.readBigUInt64BE(offset) ^ mask); offset += 8;
    const size = i32(); const obfuscated = (b[offset++] ^ key) !== 0;
    const compression = b[offset++] ^ key; offset += 8;
    if (file !== 'main.xml') continue;
    const data = Buffer.from(b.subarray(start, start + size)).map(v => obfuscated ? v ^ key : v);
    if (compression === 16) return data.toString();
    return (await JSZip.loadAsync(data)).file('contents').async('string');
  }
  throw Error('main.xml missing');
}

test('CMO3 serializes sampled geometry with fractional keys and rejects malformed arrays', async () => {
  const vertices = [390, 200, 420, 210, 400, 250];
  const action = buildWaveAction(vertices, profile, name);
  const input = { canvasW: 1024, canvasH: 1024, generateRig: false,
    actionSwitches: [{ id: action.id, min: 0, max: 3 }],
    meshes: [{ name, tag: 'handwear-r', vertices, triangles: [0, 1, 2], uvs: [0, 0, 1, 0, 0, 1], pngData: new Uint8Array([137,80,78,71]), texWidth: 1024, texHeight: 1024, actionSwitch: action }] };
  const { cmo3 } = await generateCmo3(input);
  const xml = await readXml(cmo3);
  assert.match(xml, /ParamActionWave/);
  assert.match(xml, /0\.125/);
  // More than one distinct position array proves geometry was exported, not just opacity.
  const arrays = [...xml.matchAll(/<float-array[^>]*xs.n="positions"[^>]*>([^<]+)</g)].map(m => m[1]);
  assert.ok(new Set(arrays).size >= 10);
  input.meshes[0].actionSwitch = { ...action, keys: [0, 1] };
  await assert.rejects(generateCmo3(input), /Invalid sampled action/);
});
