/** Runtime gate: verify compiled Pro geometry, independent of any character. */
import fs from 'node:fs/promises';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const [corePath,baselinePath,modelPath,integrationPath,outputPath]=process.argv.slice(2);
const ctx={console,WebAssembly,performance,TextDecoder,TextEncoder,setTimeout,clearTimeout,URL,fetch,atob,btoa,document:{currentScript:{src:'file:///local/core.js'}}};
ctx.window=ctx;ctx.self=ctx;ctx.globalThis=ctx;
vm.createContext(ctx);vm.runInContext(await fs.readFile(corePath,'utf8'),ctx);
await new Promise(r=>setTimeout(r,200));
async function load(file){const b=await fs.readFile(file),moc=ctx.Live2DCubismCore.Moc.fromArrayBuffer(b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength));assert.ok(moc,'Invalid MOC');return {moc,model:ctx.Live2DCubismCore.Model.fromMoc(moc)};}
const spec=JSON.parse(await fs.readFile(integrationPath,'utf8'));
const a=await load(modelPath),b=await load(baselinePath),m=a.model,base=b.model,d=m.drawables;
const mouth=new Set(spec.newMouthIds),oldIds=new Map(base.drawables.ids.map((id,i)=>[id,i]));
for(const id of [...mouth,spec.originalMouthId])assert.ok(d.ids.includes(id),'Missing mouth '+id);
for(const id of ['ParamAngleX','ParamAngleY','ParamAngleZ','ParamMouthOpenY','ParamMouthForm','ParamEyeLOpen','ParamEyeROpen'])assert.ok(m.parameters.ids.includes(id),'Missing parameter '+id);
function pose(model,state){const p=model.parameters;p.values.set(p.defaultValues);for(const[k,v]of Object.entries(state)){let i=p.ids.indexOf(k);if(i>=0)p.values[i]=v;}model.update();}
function area(v,a,b,c,ppu){return ((v[b*2]-v[a*2])*(v[c*2+1]-v[a*2+1])-(v[b*2+1]-v[a*2+1])*(v[c*2]-v[a*2]))*ppu*ppu;}
const report={pipelineVersion:'pro-rig-v1',status:'passed',visualAcceptance:'pending',sampledCombinations:0,nonFiniteCoordinates:0,invertedMouthTriangles:0,maxPreservedDeltaPx:0,closedMouthExtraOpacity:0,neutralReturnDeltaPx:0,nineDirectionEffective:false,mouthEffective:false};
pose(m,{ParamMouthOpenY:.4});const signs=new Map();
for(let i=0;i<d.count;i++)if(mouth.has(d.ids[i])){const idx=d.indices[i];signs.set(i,Array.from({length:idx.length/3},(_,k)=>Math.sign(area(d.vertexPositions[i],idx[k*3],idx[k*3+1],idx[k*3+2],m.canvasinfo.PixelsPerUnit))));}
const snapshot=()=>d.vertexPositions.map(v=>Float32Array.from(v));
pose(m,{});const neutral=snapshot();
for(const axis of ['ParamAngleX','ParamAngleY']){
 pose(m,{[axis]:30});let delta=0;
 for(let i=0;i<d.count;i++)for(let k=0;k<d.vertexPositions[i].length;k++)delta=Math.max(delta,Math.abs(d.vertexPositions[i][k]-neutral[i][k])*m.canvasinfo.PixelsPerUnit);
 assert.ok(delta>.01,axis+' has no effective geometry');
}
report.nineDirectionEffective=true;
pose(m,{ParamMouthOpenY:1});
report.mouthEffective=[...mouth].some(id=>{let i=d.ids.indexOf(id);return d.opacities[i]>.9&&d.vertexPositions[i].some((v,k)=>Math.abs(v-neutral[i][k])*m.canvasinfo.PixelsPerUnit>.01);});
assert.ok(report.mouthEffective,'Mouth has no effective opening');
for(const x of [-30,-15,0,15,30])for(const y of [-30,-15,0,15,30])for(const z of [-20,0,20])for(const eye of [0,.5,1])for(const open of [0,.04,.4,1])for(const form of [-1,0,1]){
 const state={ParamAngleX:x,ParamAngleY:y,ParamAngleZ:z,ParamEyeLOpen:eye,ParamEyeROpen:eye,ParamMouthOpenY:open,ParamMouthForm:form};pose(m,state);pose(base,state);report.sampledCombinations++;
 for(let i=0;i<d.count;i++){
  const id=d.ids[i],v=d.vertexPositions[i],j=oldIds.get(id);
  for(const n of v)if(!Number.isFinite(n))report.nonFiniteCoordinates++;
  if(mouth.has(id)){
   const idx=d.indices[i];if(open>0)for(let k=0;k<idx.length;k+=3){const ar=area(v,idx[k],idx[k+1],idx[k+2],m.canvasinfo.PixelsPerUnit);if(Math.abs(ar)>1e-4&&Math.sign(ar)!==signs.get(i)[k/3])report.invertedMouthTriangles++;}
   if(open===0)report.closedMouthExtraOpacity=Math.max(report.closedMouthExtraOpacity,d.opacities[i]);
  }else if(j!==undefined && id!==spec.originalMouthId){
   const bv=base.drawables.vertexPositions[j];assert.equal(v.length,bv.length);
   for(let k=0;k<v.length;k++)report.maxPreservedDeltaPx=Math.max(report.maxPreservedDeltaPx,Math.abs(v[k]*m.canvasinfo.PixelsPerUnit-bv[k]*base.canvasinfo.PixelsPerUnit));
   assert.equal(d.opacities[i],base.drawables.opacities[j],id+' opacity changed');
  }
 }
}
pose(m,{});
for(let i=0;i<d.count;i++)for(let k=0;k<d.vertexPositions[i].length;k++)report.neutralReturnDeltaPx=Math.max(report.neutralReturnDeltaPx,Math.abs(neutral[i][k]-d.vertexPositions[i][k])*m.canvasinfo.PixelsPerUnit);
for(const k of ['nonFiniteCoordinates','invertedMouthTriangles','closedMouthExtraOpacity'])assert.equal(report[k],0,k);
assert.ok(report.maxPreservedDeltaPx<.002,'Unrelated geometry changed');assert.ok(report.neutralReturnDeltaPx<.001,'Neutral drift');
await fs.writeFile(outputPath,JSON.stringify(report,null,2));
m.release();a.moc._release();base.release();b.moc._release();console.log(JSON.stringify(report));

