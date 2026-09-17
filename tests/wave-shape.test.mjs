import test from 'node:test';
import assert from 'node:assert/strict';
import {measureArmShape,matchArmSection} from '../src/wave/armShape.js';
import {buildWaveAction,WAVE_KEYS} from '../src/waveRig.js';
import {phaseAtTime,sampleWaveMesh} from '../src/wave/waveRenderer.js';
const shape=(width,length)=>({handLength:length,sections:Array.from({length:3},()=>Array.from({length:33},()=>[-width,width]))});
const a={x:0,y:0},b={x:0,y:100};
const near=(x,y)=>assert.ok(Math.abs(x-y)<1e-7,`${x} != ${y}`);
test('cross-section morph reaches a shared hand envelope from both drawings',()=>{
 const first=shape(10,20),second=shape(20,40);
 for(const t of [0,.1,.5,.9,1]){
  const u=matchArmSection({x:10,y:110},a,b,first,second,1,t);
  const v=matchArmSection({x:20,y:120},a,b,second,first,1,1-t);
  near(u.x,v.x);near(u.y,v.y);
 }
});
test('shape measurement is finite for empty parts and follows material scale',()=>{
 const make=scale=>{const w=20*scale,h=100*scale,data=new Uint8ClampedArray(w*h*4);data.fill(255);
  return measureArmShape({x:0,y:0,width:w,height:h,imageData:{data}},[{x:10*scale,y:0},{x:10*scale,y:40*scale},{x:10*scale,y:80*scale}]);};
 const first=make(1),second=make(2);
 assert.ok(first.sections.flat(2).every(Number.isFinite));
 assert.ok(Math.abs(second.handLength-first.handLength*2)<2);
 assert.ok(Math.abs(second.sections[0][16][1]-first.sections[0][16][1]*2)<2);
});
test('full raise, wave and lower sequence preserves endpoints and coverage',()=>{
 const profile={amplitude:7,slots:{arm:{neutral:[a,b,{x:0,y:200}],raised:[a,b,{x:20,y:20}],neutralShape:shape(10,20),raisedShape:shape(15,35)}}};
 const vertices=[0,0,0,100,0,200,10,210];
 const base={vertices,actionSwitch:buildWaveAction(vertices,profile,'arm')};
 const alt={vertices,actionSwitch:buildWaveAction(vertices,profile,'action_02_wave_arms_only__arm')};
 let minimum=1;
 for(let i=0;i<=150;i++){
  const phase=phaseAtTime(i/30),u=sampleWaveMesh(base,phase),v=sampleWaveMesh(alt,phase);
  assert.ok(u.vertices.concat(v.vertices).every(Number.isFinite));
  minimum=Math.min(minimum,v.opacity+u.opacity*(1-v.opacity));
 }
 assert.ok(minimum>.89);
 assert.deepEqual(sampleWaveMesh(base,phaseAtTime(0)),sampleWaveMesh(base,phaseAtTime(4.8)));
 assert.deepEqual(sampleWaveMesh(alt,1),sampleWaveMesh(alt,3));
 for(const phase of [.2,.5,.8])near(phaseAtTime(4.65-phase),phaseAtTime(.25+phase));
 const index=WAVE_KEYS.indexOf(.8125),t=.82;
 const expected=base.actionSwitch.stateVertices[index][0]+(base.actionSwitch.stateVertices[index+1][0]-base.actionSwitch.stateVertices[index][0])*(t-.8125)/(.84375-.8125);
 near(sampleWaveMesh(base,t).vertices[0],expected);
});
