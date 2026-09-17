import fs from 'node:fs/promises';
import path from 'node:path';
import { initializeCanvas } from 'ag-psd';
import sharp from 'sharp';
import { importPsd } from '../src/vendor/stretchystudio/io/psd.js';
import { generateMesh } from '../src/vendor/stretchystudio/mesh/generate.js';
import { generateCmo3 } from '../src/vendor/stretchystudio/io/live2d/cmo3writer.js';
import { matchTag } from '../src/vendor/stretchystudio/io/armatureOrganizer.js';
import { resolveWaveProfile, buildWaveAction, buildWaveMotions, WAVE_PARAMETER, WAVE_VARIANT, WAVE_MESH_OPTIONS, trimWaveMesh } from '../src/waveRig.js';

initializeCanvas((w, h) => ({ width: w, height: h, getContext: () => ({
  createImageData: (width, height) => ({ width, height, data: new Uint8ClampedArray(width * height * 4) }),
  putImageData: () => {},
}) }));
const source = process.argv[2];
if (!source) throw Error('Usage: node scripts/build-wave-demo.mjs source.psd [output-directory]');
const out = path.resolve(process.argv[3] ?? 'outputs/wave-v5');
const parsed = importPsd(await fs.readFile(source));
const { width, height } = parsed;
const profile = resolveWaveProfile(parsed.layers, width, height);
if (!profile) throw Error('This asset needs a calibrated wave profile; no guessed joint positions were applied.');
await fs.mkdir(out, { recursive: true });
const layers = [...parsed.layers].reverse().filter(l => !l.name.includes('__') || l.name === `${WAVE_VARIANT}__handwear-r`);
const meshes = [], visual = [];
for (const [index, layer] of layers.entries()) {
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < layer.height; y++) pixels.set(layer.imageData.data.subarray(y * layer.width * 4, (y + 1) * layer.width * 4), ((y + layer.y) * width + layer.x) * 4);
  const mesh = generateMesh(pixels, width, height, { alphaThreshold: 1, ...WAVE_MESH_OPTIONS, seed: index + 1 });
  if (layer.name.includes('handwear-r')) trimWaveMesh(mesh, pixels, width);
  const vertices = mesh.vertices.flatMap(v => [v.restX, v.restY]);
  const actionSwitch = buildWaveAction(vertices, profile, layer.name);
  const png = await sharp(Buffer.from(pixels), { raw: { width, height, channels: 4 } }).png().toBuffer();
  meshes.push({ name: layer.name, tag: matchTag(layer.name), partId: `mesh_${index}`, parentGroupId: null,
    vertices, triangles: mesh.triangles.flat(), uvs: vertices.map((v, i) => v / (i % 2 ? height : width)),
    pngData: png, texWidth: width, texHeight: height, drawOrder: index, actionSwitch });
  visual.push({ name: layer.name, vertices, triangles: mesh.triangles, action: actionSwitch, png: `data:image/png;base64,${png.toString('base64')}`, pixels });
}
const { cmo3, rigDebugLog } = await generateCmo3({ canvasW: width, canvasH: height, meshes, groups: [], generateRig: true,
  generatePhysics: false, modelName: 'wave-v5', actionSwitches: [{ id: WAVE_PARAMETER, name: 'Raise and wave', min: 0, max: 3, defaultVal: 0 }] });
await fs.writeFile(path.join(out, 'wave-v5.cmo3'), cmo3);
await fs.writeFile(path.join(out, 'wave-v5.rig.log.json'), JSON.stringify(rigDebugLog, null, 2));
await fs.writeFile(path.join(out, 'wave-rig-profile.json'), JSON.stringify(profile, null, 2));
for (const [name, motion] of Object.entries(buildWaveMotions())) await fs.writeFile(path.join(out, `${name}.motion3.json`), JSON.stringify(motion, null, 2));

// Interpolate the exact exported keyforms, rather than a different preview rig.
function stateAt(layer, phase) {
  if (!layer.action) return { vertices: layer.vertices, opacity: 1 };
  const { keys, stateVertices, stateOpacities } = layer.action;
  let i = 0; while (i < keys.length - 2 && keys[i + 1] <= phase) i++;
  const t = (phase - keys[i]) / (keys[i + 1] - keys[i]);
  return { vertices: stateVertices[i].map((v, j) => v + (stateVertices[i + 1][j] - v) * t), opacity: stateOpacities[i] + (stateOpacities[i + 1] - stateOpacities[i]) * t };
}

// CPU rasterizer for repeatable visual QA without Editor or a GPU.
function raster(layer, phase) {
  const { vertices: dst, opacity } = stateAt(layer, phase);
  if (opacity <= 0) return null;
  if (!layer.action) return Buffer.from(layer.pixels);
  const result = Buffer.alloc(width * height * 4);
  for (const tri of layer.triangles) {
    const [a, b, c] = tri.map(i => ({ x: dst[i * 2], y: dst[i * 2 + 1], u: layer.vertices[i * 2], v: layer.vertices[i * 2 + 1] }));
    const det = (b.y - c.y) * (a.x - c.x) + (c.x - b.x) * (a.y - c.y);
    if (Math.abs(det) < 1e-8) continue;
    for (let y = Math.max(0, Math.floor(Math.min(a.y, b.y, c.y))); y <= Math.min(height - 1, Math.ceil(Math.max(a.y, b.y, c.y))); y++) {
      for (let x = Math.max(0, Math.floor(Math.min(a.x, b.x, c.x))); x <= Math.min(width - 1, Math.ceil(Math.max(a.x, b.x, c.x))); x++) {
        const wa = ((b.y - c.y) * (x + .5 - c.x) + (c.x - b.x) * (y + .5 - c.y)) / det;
        const wb = ((c.y - a.y) * (x + .5 - c.x) + (a.x - c.x) * (y + .5 - c.y)) / det;
        const wc = 1 - wa - wb;
        if (Math.min(wa, wb, wc) < -1e-6) continue;
        const u = Math.floor(wa * a.u + wb * b.u + wc * c.u), v = Math.floor(wa * a.v + wb * b.v + wc * c.v);
        if (u < 0 || v < 0 || u >= width || v >= height) continue;
        const si = (v * width + u) * 4, di = (y * width + x) * 4;
        result[di] = layer.pixels[si]; result[di + 1] = layer.pixels[si + 1]; result[di + 2] = layer.pixels[si + 2]; result[di + 3] = Math.round(layer.pixels[si + 3] * opacity);
      }
    }
  }
  return result;
}
const samples = [0, .25, .5, .75, 1, 1.5, 2.5];
const thumbs = [];
for (const [i, phase] of samples.entries()) {
  const inputs = visual.map(l => raster(l, phase)).filter(Boolean).map(input => ({ input, raw: { width, height, channels: 4 } }));
  const frame = await sharp({ create: { width, height, channels: 4, background: '#edece8' } }).composite(inputs).png().toBuffer();
  await fs.writeFile(path.join(out, `phase-${phase}.png`), frame);
  thumbs.push({ input: await sharp(frame).extract({ left: 260, top: 130, width: 410, height: 460 }).resize(246, 276).png().toBuffer(), left: i * 246, top: 0 });
}
await sharp({ create: { width: 246 * samples.length, height: 276, channels: 4, background: '#edece8' } }).composite(thumbs).png().toFile(path.join(out, 'contact-sheet.png'));
const data = JSON.stringify({ width, height, layers: visual.map(({ pixels, ...l }) => l) });
const html = `<!doctype html><meta charset="utf-8"><title>挥手动作预览</title>
<style>body{font:16px system-ui;background:#edece8;color:#222;margin:24px}canvas{height:80vh;max-width:100%;object-fit:contain}input{width:320px}button{padding:8px 16px}p{max-width:800px}</style>
<h2>抬手 → 小幅挥动 → 放下</h2><p>本页预览与 CMO3 相同的网格关键形态。0–1 抬手，1–3 挥手；手掌朝向保持不变。中段素材融合仍需人工审查。</p>
<button id="play">暂停</button> <input id="phase" aria-label="动作进度" type="range" min="0" max="3" step="0.005" value="0"> <output id="value">0</output><br><canvas id="canvas"></canvas>
<script>const DATA=${data};const stateAt=${stateAt.toString()};
const canvas=document.getElementById('canvas'),ctx=canvas.getContext('2d'),slider=document.getElementById('phase');canvas.width=DATA.width;canvas.height=DATA.height;
let playing=true,start=performance.now();document.getElementById('play').onclick=()=>{playing=!playing;start=performance.now();document.getElementById('play').textContent=playing?'暂停':'播放'};slider.oninput=()=>{playing=false;document.getElementById('play').textContent='播放'};
function drawTriangle(image,src,dst,tri){const [i,j,k]=tri;const x0=src[2*i],y0=src[2*i+1],x1=src[2*j],y1=src[2*j+1],x2=src[2*k],y2=src[2*k+1];const X0=dst[2*i],Y0=dst[2*i+1],X1=dst[2*j],Y1=dst[2*j+1],X2=dst[2*k],Y2=dst[2*k+1];const det=(x1-x0)*(y2-y0)-(x2-x0)*(y1-y0);if(Math.abs(det)<1e-8)return;const a=((X1-X0)*(y2-y0)-(X2-X0)*(y1-y0))/det,b=((Y1-Y0)*(y2-y0)-(Y2-Y0)*(y1-y0))/det,c=((X2-X0)*(x1-x0)-(X1-X0)*(x2-x0))/det,d=((Y2-Y0)*(x1-x0)-(Y1-Y0)*(x2-x0))/det;ctx.save();ctx.beginPath();ctx.moveTo(X0,Y0);ctx.lineTo(X1,Y1);ctx.lineTo(X2,Y2);ctx.closePath();ctx.clip();ctx.setTransform(a,b,c,d,X0-a*x0-c*y0,Y0-b*x0-d*y0);ctx.drawImage(image,0,0);ctx.restore();}
Promise.all(DATA.layers.map(l=>new Promise(resolve=>{l.image=new Image;l.image.onload=resolve;l.image.src=l.png}))).then(()=>{function draw(now){if(playing){const t=(now-start)/1000%5;slider.value=t<1.25?Math.max(0,(t-.25)):t<3.65?1+(t-1.25)/.6<=3?1+(t-1.25)/.6:3-(t-2.45)/.6:t<4.65?4.65-t:0;}const phase=Number(slider.value);document.getElementById('value').textContent=phase.toFixed(2);ctx.clearRect(0,0,canvas.width,canvas.height);for(const l of DATA.layers){const s=stateAt(l,phase);if(s.opacity<=0)continue;ctx.globalAlpha=s.opacity;if(!l.action)ctx.drawImage(l.image,0,0);else for(const tri of l.triangles)drawTriangle(l.image,l.vertices,s.vertices,tri);}ctx.globalAlpha=1;requestAnimationFrame(draw)}requestAnimationFrame(draw)});</script>`;
await fs.writeFile(path.join(out, 'preview.html'), html);
console.log(JSON.stringify({ output: out, meshes: meshes.length, parameter: WAVE_PARAMETER, range: [0, 3], samples }, null, 2));
