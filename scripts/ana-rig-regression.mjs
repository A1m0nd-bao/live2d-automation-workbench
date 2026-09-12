// Reproducible authoring fixture: real PSD → production normalization, mesh,
// binding helpers and CMO writer. No image API call and no source overwrite.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { initializeCanvas } from 'ag-psd';
import { importPsd, extractVariantManifest } from '../src/vendor/stretchystudio/io/psd.js';
import { cleanRigLayer, calibratePose, bindLimbMesh, assertRigMesh } from '../src/autoRigPreflight.js';
import { normalizePsdRigLayers } from '../src/psdRigNormalization.js';
import { matchTag, estimateSkeletonFromBounds, analyzeGroups, buildArmatureNodes } from '../src/vendor/stretchystudio/io/armatureOrganizer.js';
import { generateMesh } from '../src/vendor/stretchystudio/mesh/generate.js';
import { generateCmo3 } from '../src/vendor/stretchystudio/io/live2d/cmo3writer.js';

initializeCanvas((width, height) => ({width, height, getContext: () => ({
  createImageData: (w, h) => ({width:w, height:h, data:new Uint8ClampedArray(w*h*4)}), putImageData() {},
})}), (width, height) => ({width, height, data:new Uint8ClampedArray(width*height*4)}));
const [source, output] = process.argv.slice(2);
if (!source || !output) throw Error('Usage: node scripts/ana-rig-regression.mjs SOURCE.psd NEW_OUTPUT_DIR');
await fs.mkdir(output, {recursive:false});
const raw = await fs.readFile(source);
const buffer = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
const parsed = importPsd(buffer), {width:W, height:H} = parsed;
const wave = extractVariantManifest(buffer).variants.find(v=>v.id==='action_02_wave_arms_only');
assert.ok(wave, 'fixture must include the wave arm alternates');
const byName = new Map(wave.parts.map(p=>[p.name,p]));
const norm = normalizePsdRigLayers(parsed.layers.filter(l=>!l.name.includes('__') || byName.has(l.name)).map(l=>cleanRigLayer(l).layer));
const layers = norm.layers, neutral = layers.filter(l=>!byName.has(l.name));
const {skeleton} = calibratePose(estimateSkeletonFromBounds(neutral,W,H),{},neutral,W,H);
const ids = layers.map((_,i)=>`part${i}`);
const {groupDefs, assignments} = buildArmatureNodes(skeleton,analyzeGroups(Object.fromEntries(neutral.map(l=>[matchTag(l.name),l]))),layers,ids,()=>crypto.randomUUID(),norm);
const meshes = [];
for (const [i, layer] of layers.entries()) {
  const pixels = new Uint8ClampedArray(W*H*4);
  for(let y=0;y<layer.height;y++) pixels.set(layer.imageData.data.subarray(y*layer.width*4,(y+1)*layer.width*4),((layer.y+y)*W+layer.x)*4);
  const mesh=generateMesh(pixels,W,H,{alphaThreshold:1,gridSpacing:Math.max(6,Math.min(24,Math.min(layer.width,layer.height)/5)),edgePadding:Math.min(8,Math.min(layer.width,layer.height)/8),seed:i+1});
  assertRigMesh(mesh,layer,W,H);
  const alternate=byName.get(layer.name), tag=matchTag(alternate?.slot ?? layer.name);
  if(!alternate) bindLimbMesh(mesh,tag,skeleton,groupDefs);
  const baseIndex=alternate ? layers.findIndex(l=>l.name===alternate.slot) : i;
  const switches=alternate || wave.parts.some(p=>p.slot===layer.name);
  const joint=groupDefs.find(g=>g.id===mesh.jointBoneId);
  meshes.push({name:layer.name,tag,partId:ids[i],parentGroupId:assignments.get(baseIndex)?.parentGroupId,
    vertices:mesh.vertices.flatMap(v=>[v.x,v.y]), triangles:mesh.triangles.flat(), uvs:Array.from(mesh.uvs),
    pngData:await sharp(Buffer.from(pixels),{raw:{width:W,height:H,channels:4}}).png().toBuffer(),texWidth:W,texHeight:H,
    jointBoneId:mesh.jointBoneId,boneWeights:mesh.boneWeights,jointPivotX:mesh.jointPivot?.x ?? joint?.pivotX,jointPivotY:mesh.jointPivot?.y ?? joint?.pivotY,
    drawOrder:layers.length-1-i,
    actionSwitch:switches ? {id:'ParamActionWave',name:'Action: Wave',state:alternate?'alternate':'base'} : null,
  });
}
const result=await generateCmo3({canvasW:W,canvasH:H,meshes,
  groups:groupDefs.map(g=>({id:g.id,name:g.name,parent:g.parentId,boneRole:g.boneRole,transform:{pivotX:g.pivotX,pivotY:g.pivotY}})),
  actionSwitches:[{id:'ParamActionWave',name:'Action: Wave'}],rigAnchors:{head:skeleton.headBase},
  generateRig:true,generatePhysics:true,strictRigPreflight:true,modelName:'ana-rig-fixed'});
const audit=result.rigDebugLog.bindingAudit;
assert.ok(!audit.parameters.some(p=>p.id==='ParamOpacity'),'no dummy Opacity parameter');
for(const side of ['l','r']) {
  const role=side==='l'?'left':'right';
  const arm=audit.meshes.find(m=>m.name==='handwear-'+side);
  assert.ok(arm.parameters.includes('ParamActionWave') && arm.parameters.includes(`ParamRotation_${role}Elbow`),'action and elbow must coexist');
  assert.equal(arm.parameterVariation[`ParamRotation_${role}Elbow`].geometry,true);
  assert.deepEqual(arm.parameterVariation.ParamActionWave,{geometry:false,opacity:true});
  const leg=audit.meshes.find(m=>m.name==='legwear-'+side), shoe=audit.meshes.find(m=>m.name==='footwear-'+side);
  assert.deepEqual(shoe.chain,leg.chain,'shoe and leg need the same ancestor transforms');
  assert.ok(shoe.parameters.includes(`ParamRotation_${role}Knee`) && leg.parameters.includes(`ParamRotation_${role}Knee`));
}
await fs.writeFile(path.join(output,'ana-rig-fixed.cmo3'),result.cmo3);
await fs.writeFile(path.join(output,'audit.json'),JSON.stringify({source,normalization:norm.audit,skeleton,audit},null,2));
console.log(JSON.stringify({output,meshes:meshes.length,structuralChecks:'passed',nativeVisualCheck:'pending'}));
