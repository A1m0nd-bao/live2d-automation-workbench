import { readWavePsd, ARM_SLOTS, WAVE_GROUP } from './psdWaveInput.js';
import { analyzeWaveInput, validateWaveProfile, buildArmWeightField } from './armPoseAnalyzer.js';
import { generateMesh } from '../vendor/stretchystudio/mesh/generate.js';
import { buildWaveAction, buildWaveMotions, WAVE_MESH_OPTIONS, trimWaveMesh, WAVE_PARAMETER } from '../waveRig.js';
import { generateWithAmplitudeSearch } from './waveValidator.js';
import { renderWave } from './waveRenderer.js';
import { measureArmShape } from './armShape.js';

const tick=()=>new Promise(r=>setTimeout(r,0));
const makeCanvas=(w,h)=>{const canvas=document.createElement('canvas');canvas.width=w;canvas.height=h;return canvas;};
const blobOf=canvas=>new Promise((resolve,reject)=>canvas.toBlob(blob=>blob?resolve(blob):reject(Error('图片编码失败')),'image/png'));

export async function loadWaveFile(file) {
  if(!/\.psd$/i.test(file.name)||file.size>100*1024*1024)throw Error('请选择不超过 100 MB 的 PSD 文件。');
  const input=readWavePsd(await file.arrayBuffer());
  const profile=analyzeWaveInput(input);
  return {input,profile,filename:file.name};
}

// Keep only original body artwork and the active waving arm's alternate.
// Both alternatives retain the canonical arm's draw order to avoid a random
// jump in front of hair/clothes caused by PSD group placement.
export async function buildWaveMeshes(input,progress=()=>{}) {
  const base=[...input.layers].reverse().filter(l=>!l.name.includes('__'));
  const ordered=base.flatMap(l=>ARM_SLOTS.includes(l.name)?[l,input.pairs[l.name].raised]:[l]);
  const meshes=[];
  const canvas=makeCanvas(input.width,input.height),ctx=canvas.getContext('2d');
  for(const [i,layer]of ordered.entries()){
    progress(`建立网格 ${i+1}/${ordered.length} · ${layer.name}`);await tick();
    const tile=makeCanvas(layer.width,layer.height);tile.getContext('2d').putImageData(layer.imageData,0,0);
    ctx.clearRect(0,0,input.width,input.height);ctx.drawImage(tile,layer.x,layer.y);
    const pixels=ctx.getImageData(0,0,input.width,input.height).data;
    const slot=layer.name.split('__').at(-1),isArm=ARM_SLOTS.includes(slot);
    const generated=generateMesh(pixels,input.width,input.height,{alphaThreshold:1,seed:i+1,...(isArm?WAVE_MESH_OPTIONS:{gridSpacing:18,edgePadding:2})});
    if(isArm)trimWaveMesh(generated,pixels,input.width);
    if(!generated.triangles.length)throw Error(`图层无法建立有效网格：${layer.name}`);
    const vertices=generated.vertices.flatMap(v=>[v.restX,v.restY]);
    meshes.push({name:layer.name,slot,tag:slot,partId:`wave_mesh_${i}`,parentGroupId:null,drawOrder:i,
      x:layer.x,y:layer.y,image:tile,vertices,triangles:generated.triangles.flat(),
      uvs:vertices.map((v,j)=>v/(j%2?input.height:input.width)),
      pngData:new Uint8Array(await (await blobOf(canvas)).arrayBuffer()),texWidth:input.width,texHeight:input.height});
  }
  return meshes;
}

export function bindWaveMeshes(input, profile, sourceMeshes) {
  validateWaveProfile(profile,input);
  profile=structuredClone(profile);
  for(const slot of ARM_SLOTS) for(const pose of ['neutral','raised']) {
    profile.slots[slot][`${pose}Weights`]=buildArmWeightField(input.pairs[slot][pose],profile.slots[slot][pose]);
    profile.slots[slot][`${pose}Shape`]=measureArmShape(input.pairs[slot][pose],profile.slots[slot][pose]);
  }
  const build=p=>sourceMeshes.filter(m=>!m.name.includes('__')||p.slots[m.slot]?.active).map(m=>({...m,
    actionSwitch:buildWaveAction(m.vertices,p,m.name)}));
  const result=generateWithAmplitudeSearch(build,structuredClone(profile));
  return {...result,width:input.width,height:input.height,sourceId:input.sourceId};
}

export async function exportWavePackage(input, result, progress=()=>{}) {
  if(result.sourceId!==input.sourceId)throw Error('预览不属于当前 PSD，请重新生成。');
  if(result.report.errors.length)throw Error('存在无效网格，请校正后重新生成。');
  progress('写入 CMO3 工程和动作曲线…');await tick();
  const [{generateCmo3},{default:JSZip}]=await Promise.all([
    import('../vendor/stretchystudio/io/live2d/cmo3writer.js'),import('jszip')]);
  const {cmo3}=await generateCmo3({canvasW:input.width,canvasH:input.height,meshes:result.meshes,
    modelName:'wave-model',groups:[],generateRig:false,generatePhysics:false,
    actionSwitches:[{id:WAVE_PARAMETER,name:'Raise and wave',min:0,max:3,defaultVal:0}]});
  const zip=new JSZip();zip.file('wave-model.cmo3',cmo3);
  zip.file('wave-profile.json',JSON.stringify(result.profile,null,2));
  zip.file('wave-qa.json',JSON.stringify(result.report,null,2));
  for(const [name,motion]of Object.entries(buildWaveMotions()))zip.file(`motions/${name}.motion3.json`,JSON.stringify(motion,null,2));
  const preview=makeCanvas(input.width,input.height);
  for(const phase of [0,.25,.5,.56,.75,.8,.85,.9,1,1.5,2.5]){renderWave(preview.getContext('2d'),result,phase);zip.file(`preview/phase-${phase}.png`,await blobOf(preview));}
  zip.file('README.txt',`挥手第一版\n来源：${input.sourceId}\nParamActionWave：0–1 抬手，1–3 小幅挥动，1–0 放下。\n本包包含 CMO3 工程、动作曲线、人物配置和预览；不包含已经编译好的 MOC3。\n两套手指形态不同，中段可能重影；请结合 wave-qa.json 和预览检查。\n通过 Cubism 原生导出后，再在播放器注册并播放 motions 中的动作曲线。\n`);
  return zip.generateAsync({type:'blob'});
}
