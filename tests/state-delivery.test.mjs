import test from 'node:test';
import assert from 'node:assert/strict';
import { buildStateCatalog, buildStateAction } from '../src/stateDelivery.js';
import { stateMotions, motion } from '../scripts/runtime-delivery.mjs';
import { readFileSync } from 'node:fs';
const variant = (id, slots, kind='action') => ({id,kind,parts:slots.map(slot=>({name:`${id}__${slot}`,slot}))});

test('all pose slots share one mutually exclusive native selector, opposite arm remains visible',()=>{
  const variants=[variant('action_03_hip',['handwear-r']),variant('action_04_cross',['handwear'])];
  const catalog=buildStateCatalog(variants,null),project={stateCatalog:catalog};
  assert.equal(catalog[0].parameter,'ParamActionPose');
  const right=buildStateAction([1,2],project,'handwear-r');
  const left=buildStateAction([1,2],project,'handwear-l');
  const hip=buildStateAction([1,2],project,'action_03_hip__handwear-r');
  const cross=buildStateAction([1,2],project,'action_04_cross__handwear');
  for(const[value,expected]of[[0,[1,1,0,0]],[1,[0,1,1,0]],[2,[0,0,0,1]]]){
    assert.deepEqual([right,left,hip,cross].map(a=>a.stateOpacities[a.keys.indexOf(value)]),expected);
  }
  const clips=stateMotions(catalog);assert.equal(clips.length,2);
  assert.equal(clips[0].data.FadeInTime,0);
  assert.deepEqual(clips[1].data.Curves[0].Segments,[0,2,2,2.8,2,2,3,0]);
});

test('wave lane stays 0..3, other poses cannot fade the wrong wave arm',()=>{
  const variants=[variant('action_02_wave_arms_only',['handwear-r']),variant('action_03_hip',['handwear-r'])];
  const catalog=buildStateCatalog(variants,{});assert.equal(catalog[0].parameter,'ParamActionWave');
  assert.equal(catalog[0].states[1].value,4);assert.equal(catalog[0].max,4);
  // A measured profile is supplied by the arm analyzer in real modeling.
  const project={stateCatalog:catalog,waveRig:null};
  const left=buildStateAction([1,2],project,'handwear-l');assert.equal(left,null);
  const alt=buildStateAction([1,2],project,'action_02_wave_arms_only__handwear-r');
  assert.equal(alt.stateOpacities[alt.keys.indexOf(4)],0);
  assert.equal(stateMotions(catalog)[0].data.Curves[0].Segments.at(-1),0);
});

test('expression lane remains independent and duplicate kind ownership is blocked',()=>{
  const catalog=buildStateCatalog([variant('action_hip',['handwear-r']),variant('expression_happy',['mouth'],'expression')]);
  assert.equal(catalog[1].parameter,'ParamExpressionPose');
  assert.equal(buildStateAction([1,2],{stateCatalog:catalog},'mouth').stateOpacities.at(-1),0);
  const conflicting=buildStateCatalog([variant('action_face',['mouth']),variant('expression_face',['mouth'],'expression')]);
  assert.throws(()=>buildStateAction([1,2],{stateCatalog:conflicting},'mouth'),/独立语义/);
});

test('motion totals and strictly increasing timestamps are validated',()=>{
  const data=motion([{id:'P',keys:[[0,0],[1,1],[3,0]]},{id:'Q',keys:[[0,1],[3,1]],stepped:true}]);
  assert.equal(data.Meta.CurveCount,2);assert.equal(data.Meta.TotalPointCount,5);assert.equal(data.Meta.TotalSegmentCount,3);
  assert.throws(()=>motion([{id:'P',keys:[[0,0],[0,1],[3,0]]}]));
});
test('selector definitions cannot accidentally own every unqualified base mesh',()=>{
 const source=readFileSync(new URL('../src/vendor/stretchystudio/io/live2d/exporter.js',import.meta.url),'utf8');
 assert.match(source,/action\.variantId && part\.variant === action\.variantId/);
 const catalog=buildStateCatalog([variant('action_hip',['handwear-r'])]);
 for(const name of ['face','front hair','topwear','mouth']) assert.equal(buildStateAction([1,2],{stateCatalog:catalog},name),null);
});
