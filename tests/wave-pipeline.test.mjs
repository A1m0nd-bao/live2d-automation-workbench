import test from 'node:test';
import assert from 'node:assert/strict';
import { readWaveLayers } from '../src/wave/psdWaveInput.js';
import { analyzeWaveInput, validateWaveProfile, buildArmWeightField } from '../src/wave/armPoseAnalyzer.js';
import { buildWaveAction, deformWaveVertices } from '../src/waveRig.js';
import { validateWaveGeometry } from '../src/wave/waveValidator.js';
import { phaseAtTime, sampleWaveMesh } from '../src/wave/waveRenderer.js';

function arm(name, points, scale=1, offset=0, mirror=false) {
  const transform=p=>({x:(mirror?220-p.x:p.x)*scale+offset,y:p.y*scale+offset});
  points=points.map(transform);
  const width=240*scale+offset*2,height=240*scale+offset*2,data=new Uint8ClampedArray(width*height*4),r=6*scale;
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){
    let d=Infinity;for(let j=1;j<points.length;j++){const a=points[j-1],b=points[j],dx=b.x-a.x,dy=b.y-a.y;
      const t=Math.max(0,Math.min(1,((x-a.x)*dx+(y-a.y)*dy)/(dx*dx+dy*dy)));
      d=Math.min(d,Math.hypot(x-a.x-t*dx,y-a.y-t*dy));}
    if(d<=r){const i=(y*width+x)*4;data[i]=220;data[i+1]=120;data[i+2]=100;data[i+3]=255;}
  }
  let minX=width,minY=height,maxX=0,maxY=0;
  for(let y=0;y<height;y++)for(let x=0;x<width;x++)if(data[(y*width+x)*4+3]){minX=Math.min(minX,x);minY=Math.min(minY,y);maxX=Math.max(maxX,x);maxY=Math.max(maxY,y);}
  const w=maxX-minX+1,h=maxY-minY+1,crop=new Uint8ClampedArray(w*h*4);
  for(let y=0;y<h;y++)crop.set(data.subarray(((y+minY)*width+minX)*4,((y+minY)*width+minX+w)*4),y*w*4);
  return {name,x:minX,y:minY,width:w,height:h,imageData:{width:w,height:h,data:crop}};
}

function fixture(scale=1,offset=0,mirror=false) {
  const right=[{x:75,y:30},{x:65,y:115},{x:60,y:200}];
  const wave=[{x:75,y:30},{x:60,y:135},{x:30,y:70},{x:20,y:30}];
  const left=[{x:175,y:30},{x:185,y:115},{x:190,y:200}];
  return {width:240*scale+offset*2,height:240*scale+offset*2,layers:[
    arm('handwear-r',right,scale,offset,mirror),arm('action_02_wave_arms_only__handwear-r',wave,scale,offset,mirror),
    arm('handwear-l',left,scale,offset,mirror),arm('action_02_wave_arms_only__handwear-l',left,scale,offset,mirror)]};
}

test('fixed names are required; missing, duplicate, and blank arms are not fabricated',()=>{
  const p=fixture();assert.equal(Object.keys(readWaveLayers(p).pairs).length,2);
  assert.throws(()=>readWaveLayers({...p,layers:p.layers.slice(1)}),/缺少/);
  assert.throws(()=>readWaveLayers({...p,layers:[...p.layers,p.layers[0]]}),/重复/);
  const blank=fixture();blank.layers[0].imageData.data.fill(0);
  assert.throws(()=>analyzeWaveInput(readWaveLayers(blank)),/过小/);
});

test('automatic profiles adapt to translated, scaled and mirrored people',()=>{
  const original=analyzeWaveInput(readWaveLayers(fixture()));
  assert.equal(original.slots['handwear-r'].active,true);assert.equal(original.slots['handwear-l'].active,false);
  for(const [scale,offset,mirror]of [[2,13,false],[1,25,true]]){
    const input=readWaveLayers(fixture(scale,offset,mirror)),profile=analyzeWaveInput(input);
    assert.equal(profile.slots['handwear-r'].active,true);
    for(const pose of ['neutral','raised'])for(let j=0;j<3;j++){
      const before=original.slots['handwear-r'][pose][j],after=profile.slots['handwear-r'][pose][j];
      const expectedX=(mirror?220-before.x:before.x)*scale+offset;
      assert.ok(Math.abs(after.x-expectedX)<12*scale,`${pose} x did not adapt`);
      assert.ok(Math.abs(after.y-(before.y*scale+offset))<12*scale,`${pose} y did not adapt`);
    }
    assert.equal(validateWaveProfile(profile,input),profile);
    assert.throws(()=>validateWaveProfile(original,input),/不属于/);
  }
});

test('pixel changes invalidate saved calibration, even with identical names and bounds',()=>{
  const p=fixture(),first=readWaveLayers(p),profile=analyzeWaveInput(first);
  p.layers[0].imageData.data[0]^=1;
  const second=readWaveLayers(p);assert.notEqual(first.sourceId,second.sourceId);
  assert.throws(()=>validateWaveProfile(profile,second),/不属于/);
  const bad=structuredClone(profile);bad.amplitude=NaN;assert.throws(()=>validateWaveProfile(bad,first),/幅度/);
  bad.amplitude=7;bad.slots['handwear-r'].raised[1]=bad.slots['handwear-r'].raised[0];
  assert.throws(()=>validateWaveProfile(bad,first),/重合/);
});

test('mask-based weights keep a bent hand on the forearm and pin the shoulder',()=>{
  const input=readWaveLayers(fixture()),profile=analyzeWaveInput(input),slot='handwear-r';
  const s=profile.slots[slot];s.raisedWeights=buildArmWeightField(input.pairs[slot].raised,s.raised);
  const shoulder=s.raised[0],tip={x:20,y:30},vertices=[shoulder.x,shoulder.y,tip.x,tip.y];
  const posed=deformWaveVertices(vertices,profile,slot,true,1.5);
  assert.ok(Math.hypot(posed[0]-shoulder.x,posed[1]-shoulder.y)<.01);
  assert.ok(Math.hypot(posed[2]-tip.x,posed[3]-tip.y)>3);
  const loop=deformWaveVertices(vertices,profile,slot,true,3);
  vertices.forEach((v,i)=>assert.ok(Math.abs(v-loop[i])<1e-6));
});

test('QA detects inversion and invalid data; healthy geometry still requires visual review',()=>{
  const input=readWaveLayers(fixture()),profile=analyzeWaveInput(input),vertices=[75,30,70,40,80,40];
  const action=buildWaveAction(vertices,profile,'handwear-r');
  const mesh={name:'handwear-r',vertices,triangles:[0,1,2],actionSwitch:action};
  const qa=validateWaveGeometry([mesh],profile);assert.equal(qa.visualReviewRequired,true);
  action.stateVertices[0]=[75,30,80,40,70,40];
  assert.ok(validateWaveGeometry([mesh],profile).entries[0].foldedAreaRatio>0);
  action.stateVertices[0]=[NaN,30,80,40,70,40];
  assert.equal(validateWaveGeometry([mesh],profile).status,'failed');
});

test('preview samples exported keyforms and playback returns to the neutral pose',()=>{
  const profile=analyzeWaveInput(readWaveLayers(fixture())),vertices=[75,30,65,115,60,200];
  const action=buildWaveAction(vertices,profile,'handwear-r');
  const mesh={vertices,actionSwitch:action};
  assert.deepEqual(sampleWaveMesh(mesh,.5).vertices,action.stateVertices[action.keys.indexOf(.5)]);
  assert.equal(phaseAtTime(0),0);assert.equal(phaseAtTime(1.25),1);
  assert.ok(Math.abs(phaseAtTime(2.45)-3)<1e-6);assert.equal(phaseAtTime(4.8),0);
  assert.equal(phaseAtTime(1.2,'wave'),1);
});
