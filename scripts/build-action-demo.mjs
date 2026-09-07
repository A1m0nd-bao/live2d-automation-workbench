import fs from 'node:fs/promises';
import path from 'node:path';
import { initializeCanvas } from 'ag-psd';
import sharp from 'sharp';
import { importPsd, extractVariantManifest } from '../src/vendor/stretchystudio/io/psd.js';

class MockCanvas {
  constructor(width, height) { this.width = width; this.height = height; this.data = new Uint8ClampedArray(width * height * 4); }
  getContext() {
    return {
      getImageData: () => ({ data: this.data, width: this.width, height: this.height }),
      putImageData: (imageData) => this.data.set(imageData.data),
      createImageData: (width, height) => ({ data: new Uint8ClampedArray(width * height * 4), width, height }),
    };
  }
}
initializeCanvas((w, h) => new MockCanvas(w, h), (w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }));

const source = process.argv[2] || '/Users/baotianrong/Downloads/00-cubism-import-free-v5.psd';
const output = process.argv[3] || '/Users/baotianrong/Downloads/动作替换首范例-播放A点击演示.html';
const raw = await fs.readFile(source);
const parsed = importPsd(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
const manifest = extractVariantManifest(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
const ids = ['action_02_wave_arms_only', 'action_03_hand_on_hip_arms_only', 'action_04_arms_crossed_crossed_arms', 'action_05_thinking_arms_only'];
const variants = manifest.variants.filter((v) => ids.includes(v.id));
const variantParts = new Map(variants.flatMap((v) => v.parts.map((p) => [p.name, { ...p, state: v.id }])));
const layers = [];
for (const layer of parsed.layers) {
  if (layer.name.includes('__') && !variantParts.has(layer.name)) continue;
  const png = await sharp(Buffer.from(layer.imageData.data), { raw: { width: layer.imageData.width, height: layer.imageData.height, channels: 4 } }).png().toBuffer();
  layers.push({ name: layer.name, x: layer.x, y: layer.y, width: layer.imageData.width, height: layer.imageData.height, png: png.toString('base64') });
}
const payload = { width: parsed.width, height: parsed.height, layers, variants: variants.map((v) => ({ id: v.id, parts: v.parts })) };
const html = `<!doctype html><meta charset="utf-8"><title>Live2D 播放模式 A · 动作演示</title>
<style>body{margin:0;background:#101522;color:#eef3ff;font:14px system-ui,sans-serif;display:grid;place-items:center;min-height:100vh}.app{width:min(920px,96vw);display:grid;grid-template-columns:240px 1fr;gap:18px;background:#182033;border:1px solid #33415e;border-radius:18px;padding:18px;box-sizing:border-box}.panel{display:flex;flex-direction:column;gap:10px}.title{font-size:18px;font-weight:700}.hint{color:#aebbd4;line-height:1.5}.state{background:#222e47;color:#dbe7ff;border:1px solid #405277;border-radius:9px;padding:10px;text-align:left;cursor:pointer}.state.active{background:#5875bd;border-color:#a9c2ff;color:white}.stage{display:grid;place-items:center;min-height:680px;background:linear-gradient(135deg,#e9eef6,#cbd5e5);border-radius:12px;overflow:hidden;position:relative}.stage canvas{width:min(100%,560px);height:auto;max-height:82vh;object-fit:contain;cursor:pointer}.badge{position:absolute;right:12px;top:12px;background:#19233aee;border:1px solid #5875bd;border-radius:99px;padding:7px 10px;color:#dce8ff}.footer{grid-column:1/-1;color:#9facca;font-size:12px}@media(max-width:680px){.app{grid-template-columns:1fr}.stage{min-height:72vh}.footer{grid-column:auto}}</style>
<div class="app"><div class="panel"><div class="title">播放模式 A · 动作演示</div><div class="hint">持续轻微晃动与自动眨眼。点击角色或按钮触发动作，过渡约 520ms。</div><div id="buttons"></div><div class="hint">当前状态：<b id="current">默认</b></div></div><div class="stage"><span class="badge">A · idle physics demo</span><canvas id="view"></canvas></div><div class="footer">这是交互演示层；可编辑工程仍使用旁边的 CMO3 文件。动作资产来自同一 PSD 的默认、挥手、扶腰、抱臂、思考图层。</div></div>
<script>
const DATA=${JSON.stringify(payload)};
const stateNames=['默认','挥手','扶腰','抱臂','思考'];
const stateIds=['',...DATA.variants.map(v=>v.id)];
const targets=(slot)=>({handwear:['handwear-l','handwear-r'],eyes:['irides-l','irides-r','eyelash-l','eyelash-r','eyewhite-l','eyewhite-r'],brows:['eyebrow-l','eyebrow-r'],mouth_nose:['mouth','nose']}[slot]||[slot]);
const canvas=document.querySelector('#view'),ctx=canvas.getContext('2d');canvas.width=DATA.width;canvas.height=DATA.height;
const imgs=new Map(DATA.layers.map(l=>{const i=new Image();i.src='data:image/png;base64,'+l.png;return[l.name,i]}));
let state=0, previous=0, transitionStart=performance.now(), blinkUntil=0, nextBlink=performance.now()+2500;
const buttons=document.querySelector('#buttons'); stateNames.forEach((name,i)=>{const b=document.createElement('button');b.className='state';b.textContent=i+' · '+name;b.onclick=()=>select(i);b.dataset.i=i;buttons.appendChild(b)});
function select(i){if(i===state)return;previous=state;state=i;transitionStart=performance.now();document.querySelector('#current').textContent=stateNames[i];document.querySelectorAll('.state').forEach(b=>b.classList.toggle('active',+b.dataset.i===i))}
function opacityFor(layer,stateIndex){const selected=stateIds[stateIndex];const v=DATA.variants.flatMap(x=>x.parts.map(p=>({...p,state:x.id}))).find(p=>p.name===layer.name);if(v)return v.state===selected?1:0;if(selected){const variant=DATA.variants.find(x=>x.id===selected);if(variant?.parts.some(p=>targets(p.slot).includes(layer.name)))return 0}return 1}
function draw(now){if(now>=nextBlink){blinkUntil=now+150;nextBlink=now+2700+Math.random()*2300}const blend=Math.min(1,(now-transitionStart)/520);const eased=blend*blend*(3-2*blend);ctx.clearRect(0,0,DATA.width,DATA.height);const sway=Math.sin(now/1250)*0.012;ctx.save();ctx.translate(DATA.width/2,DATA.height*.72);ctx.rotate(sway);ctx.translate(-DATA.width/2,-DATA.height*.72);for(const layer of [...DATA.layers].reverse()){const a0=opacityFor(layer,previous),a1=opacityFor(layer,state);let a=a0+(a1-a0)*eased;if(/^(irides|eyewhite)/.test(layer.name)&&now<blinkUntil)a=0;ctx.globalAlpha=Math.max(0,Math.min(1,a));ctx.drawImage(imgs.get(layer.name),layer.x,layer.y)}ctx.restore();ctx.globalAlpha=1;requestAnimationFrame(draw)}
canvas.onclick=()=>select((state+1)%stateNames.length);select(0);requestAnimationFrame(draw);
</script>`;
await fs.mkdir(path.dirname(output), { recursive: true }); await fs.writeFile(output, html);
console.log(JSON.stringify({ output, states: ['默认', '挥手', '扶腰', '抱臂', '思考'], layers: layers.length, bytes: Buffer.byteLength(html) }, null, 2));
