/** Standalone material stage. Never imports learning assets or changes a model. */
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import sharp from 'sharp';
import {initializeCanvas,writePsd} from 'ag-psd';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const hash=async b=>(await import('node:crypto')).createHash('sha256').update(b).digest('hex');
const json=(p,v)=>fs.writeFile(p,JSON.stringify(v,null,2)+'\n');
const median=a=>a.sort((a,b)=>a-b)[Math.floor(a.length/2)];
function rect(r,m){if(!r||!['left','top','width','height'].every(k=>Number.isInteger(r[k]))||r.left<0||r.top<0||r.width<2||r.height<2||r.left+r.width>m.width||r.top+r.height>m.height)throw Error('ROI outside image or invalid');return r;}
export async function sampleSkin(input,roi){
 const m=await sharp(input).metadata();rect(roi,m);
 const {data}=await sharp(input).extract(roi).ensureAlpha().raw().toBuffer({resolveWithObject:true});
 const channels=[[],[],[]];for(let i=0;i<data.length;i+=4)if(data[i+3]>240)channels.forEach((a,c)=>a.push(data[i+c]));
 if(channels[0].length<16)throw Error('Skin ROI needs at least 16 opaque pixels');
 const rgb=channels.map(a=>median([...a]));
 const spread=Math.max(...channels.map((a,c)=>median(a.map(v=>Math.abs(v-rgb[c])))));
 return {rgb,hex:'#'+rgb.map(v=>v.toString(16).padStart(2,'0')).join(''),spread,needsReview:true,warning:spread>12?'ROI has substantial shading; flat covers are unsuitable':'Sample is only a color estimate, not automatic skin recognition'};
}
export async function prepare(config,dest){
 const raw=await fs.readFile(config.source),m=await sharp(raw).metadata();rect(config.face,m);rect(config.skin,m);
 const skin=await sampleSkin(raw,config.skin);
 await fs.mkdir(dest,{recursive:false});
 await sharp(raw).extract(config.face).png().toFile(path.join(dest,'face-reference.png'));
 const prompt=await fs.readFile(path.join(ROOT,'prompts/mouth-lines-v1.txt'),'utf8');
 await fs.writeFile(path.join(dest,'prompt.txt'),prompt);
 await json(path.join(dest,'job.json'),{version:1,status:'awaiting_generation',sourceSha256:await hash(raw),source:config.source,face:config.face,skinRegion:config.skin,skin,characterLock:{authority:'face-reference.png controls mouth style only',forbidden:['face/chin replacement','learning PSD/CMO reuse','style change']},sheet:{aspect:1,cells:2,layout:'vertical',background:'alpha preferred; white requires explicit conversion'},rigReady:false});
 await json(path.join(dest,'request.template.json'),{model:'${VOLCENGINE_ARK_MODEL}',prompt,image:['${FACE_REFERENCE_DATA_URL}'],size:'2048x2048',sequential_image_generation:'disabled',response_format:'b64_json',watermark:false});
 return {status:'awaiting_generation',directory:dest,skin};
}
export async function extractLines(input,{whiteBackground=false}={}){
 const m=await sharp(input).metadata();if(m.width!==m.height||m.width<512||m.width>4096)throw Error('Need square sheet, 512–4096 pixels');
 const {data,info}=await sharp(input).resize(1024,1024).ensureAlpha().raw().toBuffer({resolveWithObject:true});
 let transparent=0;for(let i=3;i<data.length;i+=4)if(data[i]<8)transparent++;
 if(transparent/(1024*1024)<.5){
  if(!whiteBackground)throw Error('No usable alpha. Explicit --white required for white-background extraction; checkerboard is not accepted.');
  let good=0,total=0;for(let y=0;y<1024;y+=4)for(let x=0;x<1024;x+=4){if(x>32&&x<992&&y>32&&y<992)continue;const i=(y*1024+x)*4;total++;if(Math.min(data[i],data[i+1],data[i+2])>245)good++;}
  if(good/total<.99)throw Error('Background is not uniform white');
  // White matte removal is approximate; all output remains review-required.
  for(let i=0;i<data.length;i+=4){const a=1-Math.min(data[i],data[i+1],data[i+2])/255;data[i+3]=Math.round(255*a);for(let c=0;c<3;c++)data[i+c]=a?Math.max(0,Math.min(255,(data[i+c]-255*(1-a))/a)):0;}
 }
 const layers=[];
 for(let cell=0;cell<2;cell++){
  let x0=1024,x1=-1,y0=1024,y1=-1,count=0;
  for(let y=cell*512;y<(cell+1)*512;y++)for(let x=0;x<1024;x++)if(data[(y*1024+x)*4+3]>24){x0=Math.min(x0,x);x1=Math.max(x1,x);y0=Math.min(y0,y);y1=Math.max(y1,y);count++;}
  if(count<100||x0<24||x1>999||y0<cell*512+24||y1>(cell+1)*512-25||x1-x0<350||y1-y0>150||count/((x1-x0+1)*(y1-y0+1))>.85)throw Error(`Cell ${cell+1}: not an isolated thin mouth line; regenerate`);
  const img=await sharp(data,{raw:info}).extract({left:x0,top:y0,width:x1-x0+1,height:y1-y0+1}).resize({width:640}).png().toBuffer();
  const meta=await sharp(img).metadata();
  layers.push({name:cell?'mouth.lower.line':'mouth.upper.line',png:img,left:192,top:Math.round(512-meta.height/2),sourceBounds:[x0,y0,x1,y1]});
 }
 return layers;
}
export function templateSvgs(skin){
 if(!/^#[0-9a-f]{6}$/i.test(skin))throw Error('Invalid skin color');
 const svg=body=>`<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">${body}</svg>`;
 return {
  'mouth.interior':svg('<ellipse cx="512" cy="520" rx="320" ry="160" fill="#49212d"/>'),
  'mouth.tongue':svg('<ellipse cx="512" cy="610" rx="200" ry="60" fill="#bd697c"/>'),
  'mouth.lower.cover':svg(`<path d="M170 510 Q512 530 854 510 L854 730 L170 730Z" fill="${skin}"/>`),
  'mouth.upper.cover':svg(`<path d="M170 290 H854 V514 Q512 530 170 514Z" fill="${skin}"/>`)
 };
}
export async function assemble(jobDir,sheet,dest,options={}){
 const job=JSON.parse(await fs.readFile(path.join(jobDir,'job.json'),'utf8'));
 if(job.version!==1||!job.skin?.hex)throw Error('Invalid prepared job');
 const raw=await fs.readFile(sheet),lines=await extractLines(raw,options);
 await fs.mkdir(dest,{recursive:false});await fs.writeFile(path.join(dest,'generated-original.png'),raw);
 const template=templateSvgs(job.skin.hex),layers=[];
 for(const name of ['mouth.interior','mouth.tongue','mouth.lower.cover','mouth.upper.cover']){
  const png=await sharp(Buffer.from(template[name])).png().toBuffer();layers.push({name,png,left:0,top:0});
 }
 layers.push(...lines);
 initializeCanvas((w,h)=>({width:w,height:h,getContext(){return {createImageData:(w,h)=>({width:w,height:h,data:new Uint8ClampedArray(w*h*4)})}}}),(w,h)=>({width:w,height:h,data:new Uint8ClampedArray(w*h*4)}));
 const children=[];
 for(const l of layers){await fs.writeFile(path.join(dest,l.name+'.png'),l.png);const {data,info}=await sharp(l.png).ensureAlpha().raw().toBuffer({resolveWithObject:true});children.push({name:l.name,left:l.left,top:l.top,imageData:{width:info.width,height:info.height,data:new Uint8ClampedArray(data)},clipping:l.name==='mouth.tongue'});}
 await fs.writeFile(path.join(dest,'mouth-materials.psd'),Buffer.from(writePsd({width:1024,height:1024,children},{noBackground:true,trimImageData:false})));
 await sharp({create:{width:1024,height:1024,channels:4,background:job.skin.hex}}).composite(layers.map(l=>({input:l.png,left:l.left,top:l.top}))).png().toFile(path.join(dest,'neutral-review.png'));
 const report={version:1,status:'needs_review',rigReady:false,sheetSha256:await hash(raw),sourceSha256:job.sourceSha256,backgroundConverted:!!options.whiteBackground,skin:job.skin,canvas:[1024,1024],anchor:[512,512],layers:layers.map(({png,...l})=>({...l,file:l.name+'.png'})),rigContract:{mouthForm:[-1,0,1],mouthOpen:[0,.4,1],keyformsPerLipMesh:9,implemented:false},checksRequired:['line identity/style and unwanted marks','closed lip seam and skin shading','old mouth removed from face','tongue clipping in Cubism','nine keyforms and head-angle combinations'],note:'Original procedural cavities/covers; no learning asset copied. Material pack only, not a rig or production acceptance.'};
 await json(path.join(dest,'manifest.json'),report);return report;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const [command,a,b,c,...flags]=process.argv.slice(2);
 try{if(command==='prepare')console.log(JSON.stringify(await prepare(JSON.parse(await fs.readFile(a,'utf8')),b),null,2));else if(command==='assemble')console.log(JSON.stringify(await assemble(a,b,c,{whiteBackground:flags.includes('--white')}),null,2));else throw Error('Usage: prepare config.json NEW_JOB_DIR | assemble JOB_DIR SHEET.png NEW_OUTPUT_DIR [--white]');}catch(e){console.error(e.message);process.exitCode=1;}
}
