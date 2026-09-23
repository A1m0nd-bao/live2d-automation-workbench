// Native mouth donor: existing Ana artwork / source-matched restrained Miko lines.
// The source texture, authored key geometry and UVs remain separate.
import fs from 'node:fs/promises';
import path from 'node:path';
import {deflateSync} from 'node:zlib';
import {generateCmo3} from '../../src/vendor/stretchystudio/io/live2d/cmo3writer.js';
const [out]=process.argv.slice(2),character='pro';
if(!out)throw Error('Usage: node build-mouth.mjs NEW_DIR');
await fs.mkdir(out,{recursive:false});
const W=400,H=180,cols=64;
// Dependency-free PNG textures. All geometry is scaled to the source mouth.
function png(width,height,pixel){
 const crc=buf=>{let c=0xffffffff;for(const b of buf){c^=b;for(let j=0;j<8;j++)c=(c>>>1)^((c&1)?0xedb88320:0);}return (c^0xffffffff)>>>0;};
 const chunk=(type,data)=>{const t=Buffer.from(type),h=Buffer.alloc(4),c=Buffer.alloc(4);h.writeUInt32BE(data.length);c.writeUInt32BE(crc(Buffer.concat([t,data])));return Buffer.concat([h,t,data,c]);};
 const head=Buffer.alloc(13);head.writeUInt32BE(width);head.writeUInt32BE(height,4);head[8]=8;head[9]=6;
 const raw=Buffer.alloc((width*4+1)*height);
 for(let y=0;y<height;y++)for(let x=0;x<width;x++)raw.set(pixel(x,y),y*(width*4+1)+1+x*4);
 return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',head),chunk('IDAT',deflateSync(raw)),chunk('IEND',Buffer.alloc(0))]);
}
const pngs={};
for(const name of ['upper','lower'])pngs[name]=png(W,H,(x,y)=>{
 const thickness=name==='upper'?2.5:1.75;
 const a=Math.max(0,Math.min(1,thickness+.5-Math.abs(y-75)))*Math.max(0,Math.min(1,(x-62)/5,(338-x)/5));
 return [...(name==='upper'?[164,109,97]:[195,135,121]),Math.round(a*255)];
});
pngs.interior=png(W,H,(x,y)=>[Math.round(66+40*y/H),Math.round(32+21*y/H),Math.round(41+24*y/H),255]);
pngs.tongue=png(W,H,(x,y)=>[187,115,128,Math.round(255*Math.max(0,Math.min(1,(1-((x-200)/83)**2-((y-121)/21)**2)*12)))]);
const shapes=[],meshes=[];
for(const [idx,name]of ['interior','tongue','upper','lower'].entries()){
  const rows= name==='upper'||name==='lower'?2:8;
  const y0=rows===2?69:52,y1=rows===2?81:139;
  const vertices=[],uvs=[],triangles=[];
  for(let r=0;r<=rows;r++)for(let c=0;c<=cols;c++){let x=62+c/cols*276,y=y0+(y1-y0)*r/rows;vertices.push(x,y);uvs.push(x/W,y/H);}
  for(let r=0;r<rows;r++)for(let c=0;c<cols;c++){let a=r*(cols+1)+c;triangles.push(a,a+1,a+cols+1,a+1,a+cols+2,a+cols+1);}
  const forms=[];
  for(const opening of [0,.08,.4,1])for(const form of [-1,0,1]){
    const p=[];
    const width=276+form*20-opening*55;
    for(let r=0;r<=rows;r++)for(let c=0;c<=cols;c++){
      const t=c/cols,b=Math.sin(Math.PI*t),base=-7*form+(3+7*form)*b+0;
      const up=base-opening*23*b**1.2,lo=base+Math.max(.015,opening)*82*b**.72;
      const yy=name==='upper'?up+(y0+(y1-y0)*r/rows-75):name==='lower'?lo+(y0+(y1-y0)*r/rows-75):up+(lo-up)*r/rows;
      p.push(200+(t-.5)*width,75+yy);
    }
    let opacity=name==='upper'?1:Math.min(1,opening/.08);
    opacity=Math.min(1,opening/.08);
    forms.push({opening,form,positions:p,opacity});
  }
  const fullName='native.mouth.'+name;
  meshes.push({name:fullName,vertices,uvs,triangles,pngData:pngs[name],texWidth:W,texHeight:H,drawOrder:idx,tag:'mouth-material'});
  shapes.push({name:fullName,forms});
  await fs.writeFile(path.join(out,name+'.png'),pngs[name]);
}
const result=await generateCmo3({canvasW:W,canvasH:H,meshes,modelName:character+' native mouth',generateRig:false,generatePhysics:false,parameters:[{id:'ParamMouthForm',name:'Mouth Form',min:-1,max:1,default:0},{id:'ParamMouthOpenY',name:'Mouth Open',min:0,max:1,default:0}]});
await fs.writeFile(path.join(out,'donor.cmo3'),result.cmo3);
await fs.writeFile(path.join(out,'geometry.json'),JSON.stringify(shapes));
console.log(out);

