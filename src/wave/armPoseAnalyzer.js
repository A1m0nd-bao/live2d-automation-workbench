import { ARM_SLOTS } from './psdWaveInput.js';

const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const lerp = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
const directions = [[-1,0],[1,0],[0,-1],[0,1],[-1,-1],[-1,1],[1,-1],[1,1]];

class Heap {
  values = [];
  push(item) {
    const a = this.values; a.push(item); let i = a.length - 1;
    while (i > 0) { const p = (i - 1) >> 1; if (a[p][0] <= item[0]) break; a[i] = a[p]; i = p; }
    a[i] = item;
  }
  pop() {
    const a = this.values, top = a[0], last = a.pop();
    if (a.length) { let i = 0; while (i * 2 + 1 < a.length) { let c = i * 2 + 1;
      if (c + 1 < a.length && a[c + 1][0] < a[c][0]) c++;
      if (a[c][0] >= last[0]) break; a[i] = a[c]; i = c;
    } a[i] = last; } return top;
  }
}

function layerGrid(layer) {
  const stride = Math.max(1, Math.ceil(Math.max(layer.width, layer.height) / 160));
  const w = Math.ceil(layer.width / stride) + 2, h = Math.ceil(layer.height / stride) + 2;
  const mask = new Uint8Array(w * h);
  for (let gy = 1; gy < h - 1; gy++) for (let gx = 1; gx < w - 1; gx++) {
    let found = false;
    for (let y = (gy - 1) * stride; y < Math.min(layer.height, gy * stride) && !found; y++)
      for (let x = (gx - 1) * stride; x < Math.min(layer.width, gx * stride); x++)
        if (layer.imageData.data[(y * layer.width + x) * 4 + 3] > 32) { found = true; break; }
    mask[gy * w + gx] = found ? 1 : 0;
  }
  const seen = new Uint8Array(mask.length); let largest = [];
  let total = 0;
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || seen[start]) continue;
    const component = [start]; seen[start] = 1;
    for (let q = 0; q < component.length; q++) {
      const p = component[q], x = p % w, y = Math.floor(p / w);
      for (const [dx, dy] of directions) {
        const nx = x + dx, ny = y + dy, n = ny * w + nx;
        if (nx >= 0 && ny >= 0 && nx < w && ny < h && mask[n] && !seen[n]) { seen[n] = 1; component.push(n); }
      }
    }
    total += component.length;
    if (component.length > largest.length) largest = component;
  }
  if (largest.length < 16) throw Error(`${layer.name} 的有效手臂区域过小。`);
  mask.fill(0); for (const p of largest) mask[p] = 1;
  const clearance = new Float64Array(mask.length);
  for (let i = 0; i < mask.length; i++) clearance[i] = mask[i] ? 1e6 : 0;
  for (let y = 1; y < h; y++) for (let x = 1; x < w; x++) {
    const i = y * w + x;
    clearance[i] = Math.min(clearance[i], clearance[i-1]+1, clearance[i-w]+1, clearance[i-w-1]+Math.SQRT2);
  }
  for (let y = h-2; y >= 0; y--) for (let x = w-2; x >= 0; x--) {
    const i = y*w+x;
    clearance[i] = Math.min(clearance[i], clearance[i+1]+1, clearance[i+w]+1, clearance[i+w+1]+Math.SQRT2);
  }
  const point = p => ({ x: Math.min(layer.x+layer.width-1,layer.x+(p%w-1+.5)*stride), y: Math.min(layer.y+layer.height-1,layer.y+(Math.floor(p/w)-1+.5)*stride) });
  return { mask, clearance, w, h, stride, largest, retained: largest.length / total, point };
}

function resample(path, count = 64) {
  const lengths = [0]; for (let i=1;i<path.length;i++) lengths.push(lengths[i-1]+distance(path[i-1],path[i]));
  const total=lengths.at(-1); let index=1;
  return Array.from({length:count},(_,i)=>{const d=total*i/(count-1);while(index<lengths.length-1&&lengths[index]<d)index++;
    return lerp(path[index-1],path[index],(d-lengths[index-1])/Math.max(1e-6,lengths[index]-lengths[index-1]));});
}

export function analyzeArm(layer, shoulderHint, bent) {
  const g=layerGrid(layer); const {mask,clearance,w,h,point}=g;
  let start=g.largest[0], best=Infinity;
  for(const i of g.largest){ const p=point(i);
    const score=distance(p,shoulderHint)+g.stride*5/(clearance[i]+.5);
    if(score<best){best=score;start=i;}}
  const costs=new Float64Array(mask.length).fill(Infinity), previous=new Int32Array(mask.length).fill(-1);
  const heap=new Heap(); costs[start]=0; heap.push([0,start]); let farthest=start;
  while(heap.values.length){const [cost,i]=heap.pop();if(cost!==costs[i])continue;
    if(cost>costs[farthest])farthest=i;
    const x=i%w,y=Math.floor(i/w);
    for(const [dx,dy] of directions){const nx=x+dx,ny=y+dy,n=ny*w+nx;if(nx<0||ny<0||nx>=w||ny>=h||!mask[n])continue;
      const next=cost+Math.hypot(dx,dy)*(1+2/(clearance[n]+1));
      if(next<costs[n]){costs[n]=next;previous[n]=i;heap.push([next,n]);}}
  }
  const path=[];for(let i=farthest;i!==-1;i=previous[i])path.push(point(i));path.reverse();
  if(path.length<6)throw Error(`${layer.name} 无法提取连续手臂路径。`);
  let line=resample(path); const a=line[0], b=line.at(-1);
  let elbowIndex=32,maxDeviation=0;
  for(let i=16;i<47;i++){const p=line[i];const deviation=Math.abs((b.x-a.x)*(a.y-p.y)-(a.x-p.x)*(b.y-a.y))/Math.max(1,distance(a,b));
    if(deviation>maxDeviation){maxDeviation=deviation;elbowIndex=i;}}
  // A nearly straight arm has no observable elbow in its silhouette.
  const inferredStraight=!bent||maxDeviation<distance(a,b)*.12;
  if(inferredStraight)elbowIndex=32;
  if (!inferredStraight) {
    // The shortest path can shortcut the thick, folded elbow. Locate its
    // outer bend in the silhouette, then centre the elbow inside that region.
    const deviations=g.largest.map(i=>{const p=point(i);return {p,d:Math.abs((b.x-a.x)*(a.y-p.y)-(a.x-p.x)*(b.y-a.y))/Math.max(1,distance(a,b))};});
    const maximum=Math.max(...deviations.map(v=>v.d));
    const region=deviations.filter(v=>v.d>maximum*.80);
    const elbow={x:region.reduce((s,v)=>s+v.p.x,0)/region.length,y:region.reduce((s,v)=>s+v.p.y,0)/region.length};
    line=resample([a,elbow,b]);
    elbowIndex=line.reduce((best,p,i)=>distance(p,elbow)<distance(line[best],elbow)?i:best,0);
  }
  const wristIndex=inferredStraight?57:47;
  const palmPoints=line.slice(wristIndex), radius=Math.max(g.stride*2, distance(line[wristIndex],b)*.5);
  const palm={x:Math.min(...palmPoints.map(p=>p.x))-radius,y:Math.min(...palmPoints.map(p=>p.y))-radius,
    width:Math.max(...palmPoints.map(p=>p.x))-Math.min(...palmPoints.map(p=>p.x))+radius*2,
    height:Math.max(...palmPoints.map(p=>p.y))-Math.min(...palmPoints.map(p=>p.y))+radius*2};
  const warnings=[];
  if(inferredStraight)warnings.push('直臂轮廓无法精确定位肘部，已按路径比例估计，请检查。');
  if(g.retained<.96)warnings.push('存在分离像素区域，关节分析仅使用最大连续区域。');
  return {joints:[a,line[elbowIndex],line[wristIndex]],path:line,palm,
    confidence:inferredStraight?'low':'medium',warnings,retained:g.retained};
}

export function analyzeWaveInput(input) {
  const slots={}, diagnostics={};
  for(const slot of ARM_SLOTS){const pair=input.pairs[slot];
    const base=pair.neutral;
    let sx=0,sy=0,count=0;
    const band=Math.max(2,Math.floor(base.height*.09));
    for(let y=0;y<band;y++)for(let x=0;x<base.width;x++)if(base.imageData.data[(y*base.width+x)*4+3]>64){sx+=base.x+x;sy+=base.y+y;count++;}
    const hint=count?{x:sx/count,y:sy/count}:{x:base.x+base.width*.5,y:base.y+base.height*.055};
    const neutral=analyzeArm(base,hint,false);
    const raised=analyzeArm(pair.raised,neutral.joints[0],true);
    const reach=distance(neutral.joints[0],neutral.joints[2]);
    const motion=distance(neutral.joints[2],raised.joints[2])/Math.max(1,reach);
    diagnostics[slot]={neutral,raised,motion};
    slots[slot]={neutral:neutral.joints,raised:raised.joints,
      neutralPath:neutral.path,raisedPath:raised.path,neutralPalm:neutral.palm,raisedPalm:raised.palm,
      active:motion>.2,confidence:raised.confidence};
  }
  if(!Object.values(slots).some(s=>s.active))throw Error('两套手臂姿态差异不足，未识别到抬手素材。请检查动作图层是否只是原姿态复制。');
  return {version:1,sourceId:input.sourceId,width:input.width,height:input.height,amplitude:7,
    method:'alpha-geodesic-v1',reviewed:false,slots,diagnostics};
}

// Propagate weights inside the alpha mask. Euclidean proximity alone assigns
// the thumb of a raised hand to the nearby shoulder across an empty gap.
export function buildArmWeightField(layer, joints) {
  const g=layerGrid(layer), {w,h,mask,clearance,point}=g;
  const nearest=p=>g.largest.reduce((best,i)=>distance(point(i),p)<distance(point(best),p)?i:best,g.largest[0]);
  const costsFrom=seed=>{
    const costs=new Float64Array(mask.length).fill(Infinity), heap=new Heap();costs[seed]=0;heap.push([0,seed]);
    while(heap.values.length){const [cost,i]=heap.pop();if(cost!==costs[i])continue;const x=i%w,y=Math.floor(i/w);
      for(const [dx,dy]of directions){const nx=x+dx,ny=y+dy,n=ny*w+nx;if(nx<0||ny<0||nx>=w||ny>=h||!mask[n])continue;
        const next=cost+Math.hypot(dx,dy)*(1+1/(clearance[n]+1));if(next<costs[n]){costs[n]=next;heap.push([next,n]);}}}
    return costs;
  };
  const shoulder=nearest(joints[0]),elbow=nearest(joints[1]),wrist=nearest(joints[2]);
  const upper=costsFrom(shoulder),lower=costsFrom(wrist),center=upper[elbow]-lower[elbow];
  const a=Math.atan2(joints[0].y-joints[1].y,joints[0].x-joints[1].x);
  const b=Math.atan2(joints[2].y-joints[1].y,joints[2].x-joints[1].x);
  const opening=Math.abs(Math.atan2(Math.sin(b-a),Math.cos(b-a)));
  // A straight source must distribute a large bend over more skin; a narrow
  // weight band folds its inner edge when the handover is close to the lift.
  const band=Math.max(4,upper[wrist]*(opening>2 ? .45 : .16));
  const values=Array.from(mask,(_,i)=>{
    if(!mask[i])return -1;const t=Math.max(0,Math.min(1,.5+(upper[i]-lower[i]-center)/band));return Math.round(t*t*(3-2*t)*255);
  });
  return {x:layer.x,y:layer.y,stride:g.stride,width:w,height:h,values};
}

export function validateWaveProfile(profile, input) {
  if(profile.version!==1||profile.sourceId!==input.sourceId||profile.width!==input.width||profile.height!==input.height)
    throw Error('配置不属于这份 PSD，不能直接套用其他人物的关节点。');
  if(!Number.isFinite(profile.amplitude)||profile.amplitude<1||profile.amplitude>15)throw Error('挥动幅度必须在 1–15 度之间。');
  for(const slot of ARM_SLOTS){const s=profile.slots?.[slot];if(!s)throw Error(`配置缺少 ${slot}`);
    for(const pose of ['neutral','raised']){
      const points=s[pose];if(!Array.isArray(points)||points.length!==3)throw Error('每套姿态必须包含肩、肘、腕三个关节点。');
      const layer=input.pairs[slot][pose];
      for(const p of points){if(!Number.isFinite(p.x)||!Number.isFinite(p.y)||p.x<0||p.y<0||p.x>=input.width||p.y>=input.height)throw Error('关节点必须位于画布内。');}
      if(distance(points[0],points[1])<3||distance(points[1],points[2])<3)throw Error('相邻关节点不能重合。');
      const path=s[`${pose}Path`];if(!Array.isArray(path)||path.length<2||path.length>256||path.some(p=>!Number.isFinite(p.x)||!Number.isFinite(p.y)))throw Error('配置的手臂路径无效。');
      if(points.some(p=>p.x<layer.x-20||p.x>layer.x+layer.width+20||p.y<layer.y-20||p.y>layer.y+layer.height+20))throw Error('关节点距离手臂素材过远，请重新校正。');
    }
  }
  if(!Object.values(profile.slots).some(s=>s.active))throw Error('至少启用一侧挥手手臂。');
  return profile;
}
