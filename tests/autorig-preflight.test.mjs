import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanRigLayer, calibratePose, assertRigMesh, limbWeights } from '../src/autoRigPreflight.js';
import { generateMesh } from '../src/vendor/stretchystudio/mesh/generate.js';
import { generateCmo3 } from '../src/vendor/stretchystudio/io/live2d/cmo3writer.js';

function layer(name='face',width=100,height=100) {
  return {name,x:0,y:0,width,height,imageData:{width,height,data:new Uint8ClampedArray(width*height*4)}};
}
function pixel(l,x,y,a){const i=(y*l.width+x)*4;l.imageData.data.set([120,130,140,a],i);}
test('alpha preflight removes distant haze and crops in canvas coordinates without mutating source',()=>{
  const l=layer();l.x=20;l.y=10;
  for(let y=30;y<50;y++)for(let x=40;x<60;x++)pixel(l,x,y,255);
  pixel(l,0,0,12);pixel(l,99,99,12);pixel(l,39,32,8);
  const {layer:c,audit}=cleanRigLayer(l);
  assert.equal(audit.removedPixels,2);assert.equal(c.x,59);assert.equal(c.y,40);
  assert.equal(c.width,21);assert.equal(c.height,20);assert.equal(l.imageData.data[3],12);
  assert.equal(c.imageData.data[(2*21)*4+3],8);
});
test('detached real details and uniformly translucent parts survive',()=>{
  const l=layer('headwear');pixel(l,10,10,240);pixel(l,90,90,220);
  assert.equal(cleanRigLayer(l).audit.removedPixels,0);
  const faint=layer('veil');for(let y=20;y<50;y++)for(let x=20;x<50;x++)pixel(faint,x,y,20);
  const c=cleanRigLayer(faint);assert.equal(c.audit.removedPixels,0);assert.equal(c.audit.translucent,true);
});
test('large ambiguous alpha deletion is blocked rather than silently erasing art',()=>{
  const l=layer();for(let y=0;y<100;y++)for(let x=0;x<100;x++)pixel(l,x,y,20);pixel(l,50,50,255);
  assert.throws(()=>cleanRigLayer(l),/15%/);
});
test('full-canvas near-zero haze and isolated edge specks do not enlarge a small feature',()=>{
  const l=layer('nose');
  for(let y=0;y<100;y++)for(let x=0;x<100;x++)pixel(l,x,y,2);
  for(let y=45;y<55;y++)for(let x=47;x<53;x++)pixel(l,x,y,255);
  pixel(l,0,0,40);
  const {layer:c,audit}=cleanRigLayer(l);
  assert.deepEqual(audit.bounds,{x:44,y:42,width:12,height:16});
  assert.equal(audit.rejectedBorderSeeds,1);
  assert.equal(audit.visibleRemovedFraction,0);
  assert.ok(audit.removedAlphaFraction>0.4);
  assert.equal(c.imageData.data[((45-c.y)*c.width+47-c.x)*4+3],255);
  assert.equal(l.imageData.data[3],40);
});
test('spatial matching corrects mirrored producers and rejects unrelated joints',()=>{
  const layers=[{name:'handwear-l',x:60,y:20,width:20,height:70},{name:'handwear-r',x:10,y:20,width:20,height:70}];
  const b={lShoulder:{x:70,y:20},lElbow:{x:70,y:50},lWrist:{x:70,y:80},rShoulder:{x:20,y:20},rElbow:{x:20,y:50},rWrist:{x:20,y:80}};
  const d={lShoulder:b.rShoulder,lElbow:b.rElbow,lWrist:b.rWrist,rShoulder:b.lShoulder,rElbow:b.lElbow,rWrist:b.lWrist};
  const a=calibratePose(b,d,layers,100,100);assert.deepEqual(a.skeleton.lElbow,b.lElbow);assert.ok(a.decisions.every(x=>x.swapped));
  assert.deepEqual(calibratePose(b,b,layers,100,100).skeleton,b);
  const bad=calibratePose(b,{...d,lElbow:{x:0,y:0},rElbow:{x:99,y:0}},layers,100,100);
  assert.ok(bad.decisions.every(x=>x.method==='clean-bounds-fallback'));
});
test('head anchor is shared with effective neck; corrupt face bounds fail closed',()=>{
  const ls=[{name:'face',x:40,y:10,width:20,height:20},{name:'neck',x:45,y:25,width:10,height:10}];
  assert.deepEqual(calibratePose({}, {headBase:{x:50,y:100}},ls,100,100).skeleton.headBase,{x:50,y:35});
  assert.throws(()=>calibratePose({}, {},[{name:'face',x:0,y:0,width:100,height:100}],100,100),/脸部/);
});
test('cleaned geometry is bounded and reproducible',()=>{
  const l=layer();for(let y=25;y<80;y++)for(let x=30;x<60;x++)pixel(l,x,y,255);
  const opts={alphaThreshold:1,gridSpacing:10,seed:7};
  const a=generateMesh(l.imageData.data,100,100,opts),b=generateMesh(l.imageData.data,100,100,opts);
  assert.deepEqual(a.vertices,b.vertices);
  assertRigMesh(a,{name:'arm',x:30,y:25,width:30,height:55},100,100);
  assert.throws(()=>assertRigMesh({...a,vertices:[{x:500,y:40}]},{name:'arm',x:30,y:25,width:30,height:55},100,100),/越出/);
});
test('elbow weights pin upper arm and engage forearm',()=>{
  assert.deepEqual(limbWeights([{x:50,y:10},{x:50,y:50},{x:50,y:75},{x:50,y:100}],{x:50,y:50},{x:50,y:100}),[0,0,0.5,1]);
});
test('serialized rig reaches arms and headwear, with actual elbow keyform variation',async()=>{
  const rect=(name,tag,box,parent,extra={})=>({name,tag,partId:name,parentGroupId:parent,drawOrder:1,
    vertices:[box[0],box[1],box[2],box[1],box[2],box[3],box[0],box[3]],triangles:[0,1,2,0,2,3],
    uvs:[0,0,1,0,1,1,0,1],pngData:new Uint8Array([137,80,78,71,13,10,26,10]),texWidth:100,texHeight:200,...extra});
  const group=(id,parent,boneRole,x,y)=>({id,name:id,parent,boneRole,transform:{x:0,y:0,rotation:0,scaleX:1,scaleY:1,pivotX:x,pivotY:y}});
  const {rigDebugLog}=await generateCmo3({canvasW:100,canvasH:200,generateRig:true,generatePhysics:false,strictRigPreflight:true,rigAnchors:{head:{x:50,y:50}},
    groups:[group('root',null,'root',50,110),group('head','root','head',50,50),group('leftArm','root','leftArm',70,55),group('leftElbow','leftArm','leftElbow',75,85)],
    meshes:[rect('face','face',[40,15,60,45],'head'),rect('headwear','headwear',[40,5,60,10],'head'),rect('topwear','topwear',[30,50,70,110],'root'),
      rect('handwear-l','handwear-l',[70,55,85,125],'leftArm',{jointBoneId:'leftElbow',jointPivotX:75,jointPivotY:85,boneWeights:[0,0,1,1]})]});
  assert.equal(rigDebugLog.facePivot.cy,50);
  const audit=rigDebugLog.bindingAudit;assert.deepEqual(audit.errors,[]);
  assert.ok(audit.meshes.find(m=>m.name==='headwear').chain.includes('Face Rotation'));
  const arm=audit.meshes.find(m=>m.name==='handwear-l');assert.ok(arm.chain.includes('leftArm'));assert.ok(arm.hasVariation);
  assert.equal(audit.parameters.find(p=>p.id==='ParamRotation_leftElbow').status,'structural-variation');
});
