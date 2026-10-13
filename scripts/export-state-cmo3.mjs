/** Headless regression path using the workbench's importer, bindings and writer. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { initializeCanvas } from 'ag-psd';
import sharp from 'sharp';
import { importPsd, extractVariantManifest } from '../src/vendor/stretchystudio/io/psd.js';
import { generateCmo3 } from '../src/vendor/stretchystudio/io/live2d/cmo3writer.js';
import { matchTag, analyzeGroups, estimateSkeletonFromBounds, buildArmatureNodes } from '../src/vendor/stretchystudio/io/armatureOrganizer.js';
import { generateMesh } from '../src/vendor/stretchystudio/mesh/generate.js';
import { cleanRigLayer, calibratePose, bindLimbMesh, assertRigMesh } from '../src/autoRigPreflight.js';
import { normalizePsdRigLayers } from '../src/psdRigNormalization.js';
import { resolveVariantLayerBinding, selectWaveVariantParts } from '../src/variantBinding.js';
import { buildStateCatalog, buildStateAction } from '../src/stateDelivery.js';
import { resolveWaveProfile, WAVE_VARIANT, WAVE_MESH_OPTIONS, trimWaveMesh } from '../src/waveRig.js';

class Canvas {
  constructor(w,h){this.width=w;this.height=h;this.data=new Uint8ClampedArray(w*h*4);}
  getContext(){return {getImageData:()=>({data:this.data,width:this.width,height:this.height}),
    putImageData:im=>this.data.set(im.data),createImageData:(w,h)=>({data:new Uint8ClampedArray(w*h*4),width:w,height:h})};}
}
initializeCanvas((w,h)=>new Canvas(w,h),(w,h)=>({data:new Uint8ClampedArray(w*h*4),width:w,height:h}));
const [source,target]=process.argv.slice(2);if(!source||!target)throw Error('Usage: export-state-cmo3.mjs SOURCE.psd OUTPUT.cmo3');
const bytes=await fs.readFile(source),buffer=bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength);
const parsed=importPsd(buffer),{width,height}=parsed;
if(parsed.layers.some(l=>l.variantGroup&&!l.name.startsWith(`${l.variantGroup}__`)))throw Error('Unqualified variant child');
const waveRig=resolveWaveProfile(parsed.layers,width,height);
const {manifest}=selectWaveVariantParts(extractVariantManifest(buffer),parsed.layers,waveRig);
const names=new Set(manifest.variants.flatMap(v=>v.parts.map(p=>p.name)));
let layers=parsed.layers.filter(l=>!l.variantGroup||names.has(l.name)).map(l=>cleanRigLayer(l).layer);
// Split combined neutral facial/limb layers in the same original painter slot.
const {splitLayerLR}=await import('../src/vendor/stretchystudio/io/splitLR.js');
for(const base of ['handwear','irides','eyebrow','eyewhite','eyelash','ears']){
  const i=layers.findIndex(l=>matchTag(l.name)===base);
  if(i<0||layers.some(l=>[`${base}-l`,`${base}-r`].includes(matchTag(l.name))))continue;
  const layer=layers[i],pair=splitLayerLR(layer,width,height);
  if(pair.left&&pair.right)layers.splice(i,1,...['right','left'].map(side=>({...layer,...pair[side],name:`${base}-${side==='right'?'r':'l'}`})));
}
const normalized=normalizePsdRigLayers(layers);layers=normalized.layers;
const neutral=layers.filter(l=>!names.has(l.name));
const skeleton=calibratePose(estimateSkeletonFromBounds(neutral,width,height),{},neutral,width,height).skeleton;
const ids=layers.map((_,i)=>`layer_${i}`);
const {groupDefs,assignments}=buildArmatureNodes(skeleton,analyzeGroups(Object.fromEntries(layers.map(l=>[matchTag(l.name),l]))),layers,ids,()=>crypto.randomUUID(),{
  lowerBodyRigReady:normalized.lowerBodyRigReady,combinedArmAlternates:manifest.variants.some(v=>v.parts.some(p=>p.slot==='handwear'))});
const groups=groupDefs.map(g=>({id:g.id,name:g.name,parent:g.parentId,boneRole:g.boneRole,transform:{x:0,y:0,rotation:0,scaleX:1,scaleY:1,pivotX:g.pivotX,pivotY:g.pivotY}}));
const stateCatalog=buildStateCatalog(manifest.variants,waveRig),project={stateCatalog,waveRig},meshes=[];
for(let i=0;i<layers.length;i++){
  const l=layers[i],pixels=new Uint8ClampedArray(width*height*4);
  for(let y=0;y<l.height;y++)pixels.set(l.imageData.data.subarray(y*l.width*4,(y+1)*l.width*4),((l.y+y)*width+l.x)*4);
  const slot=l.name.startsWith(`${WAVE_VARIANT}__`)?l.name.slice(WAVE_VARIANT.length+2):l.name;
  const active=waveRig?.slots[slot]?.active===true;
  const mesh=generateMesh(pixels,width,height,{alphaThreshold:1,gridSpacing:Math.max(6,Math.min(24,Math.min(l.width,l.height)/5)),edgePadding:Math.min(8,Math.min(l.width,l.height)/8),seed:i+1,...(active?WAVE_MESH_OPTIONS:{})});
  if(active)trimWaveMesh(mesh,pixels,width);assertRigMesh(mesh,l,width,height);
  const variant=manifest.variants.find(v=>v.parts.some(p=>p.name===l.name));
  const binding=resolveVariantLayerBinding({slot:variant?.parts.find(p=>p.name===l.name)?.slot,layers,assignments,groupDefs,layerIndex:i});
  if(binding.error)throw Error(binding.error);
  const tag=matchTag(binding.semanticTag??l.name);
  if(!variant)bindLimbMesh(mesh,tag,skeleton,groupDefs);
  const vertices=mesh.vertices.flatMap(v=>[v.restX??v.x,v.restY??v.y]);
  const joint=groupDefs.find(g=>g.id===mesh.jointBoneId);
  meshes.push({name:l.name,partId:ids[i],tag,parentGroupId:binding.parentGroupId,
    drawOrder:assignments.get(binding.assignmentIndex)?.drawOrder??layers.length-1-i,
    vertices,triangles:mesh.triangles.flat(),uvs:vertices.map((v,k)=>v/(k%2?height:width)),
    boneWeights:mesh.boneWeights,jointBoneId:mesh.jointBoneId,
    jointPivotX:mesh.jointPivot?.x??joint?.pivotX,jointPivotY:mesh.jointPivot?.y??joint?.pivotY,
    pngData:await sharp(Buffer.from(pixels),{raw:{width,height,channels:4}}).png().toBuffer(),texWidth:width,texHeight:height,
    actionSwitch:buildStateAction(vertices,project,l.name)});
}
const {cmo3}=await generateCmo3({canvasW:width,canvasH:height,meshes,groups,stateCatalog,
  actionSwitches:stateCatalog.map(l=>({id:l.parameter,name:l.name,min:0,max:l.max})),
  modelName:path.basename(source,'.psd'),generateRig:true,generatePhysics:true,rigAnchors:{head:skeleton.headBase}});
await fs.mkdir(path.dirname(target),{recursive:true});await fs.writeFile(target,cmo3);
console.log(JSON.stringify({source,target,meshes:meshes.length,stateCatalog:stateCatalog.map(l=>({parameter:l.parameter,states:l.states.map(s=>s.id)})),normalization:normalized.audit.policy}));
