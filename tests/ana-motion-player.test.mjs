import {test} from 'node:test';
import assert from 'node:assert/strict';
import {actions,ownedIds,sampleFrame,eyeOpen} from '../scripts/ana-motion-player.mjs';
const parameters=Object.fromEntries(ownedIds.map(id=>[id,{min:/Open|Breath|Wave/.test(id)?0:-5,max:/Open|Breath|Wave/.test(id)?1:5,default:/Open/.test(id)?1:0}]));
test('all action samples are finite, bounded, and return exactly to idle',()=>{
 for(const action of Object.keys(actions)){
  const duration=actions[action].duration;
  for(let t=0;t<duration+.2;t+=.017)for(const [id,v]of Object.entries(sampleFrame(t,parameters,{action,elapsed:t}))){assert.ok(Number.isFinite(v));assert.ok(v>=parameters[id].min&&v<=parameters[id].max);}
  for(const t of [0,duration,duration+.1])assert.deepEqual(sampleFrame(t,parameters,{action,elapsed:t}),sampleFrame(t,parameters));
 }
});
test('combined action includes both elbows and knees without wave impersonation',()=>{
 const v=sampleFrame(1,parameters,{action:'combined',elapsed:1});
 for(const id of ['ParamRotation_leftElbow','ParamRotation_rightElbow','ParamRotation_leftKnee','ParamRotation_rightKnee'])assert.notEqual(v[id],0);
 assert.equal(v.ParamActionWave,0);
});
test('blink closes and reopens; missing parameters are not fabricated',()=>{
 assert.equal(eyeOpen(.12),0);assert.equal(eyeOpen(.32),1);
 assert.deepEqual(sampleFrame(1,{}, {action:'combined',elapsed:1}),{});
 assert.equal(sampleFrame(.12,parameters,{action:'blink',elapsed:.12}).ParamEyeLOpen,0);
});
