// Cross-sections measured in each drawing's bone coordinates. Both paintings
// map into the same interpolated envelope before the texture handover.
const clamp=v=>Math.max(0,Math.min(1,v));
const lerp=(a,b,t)=>a+(b-a)*t;
const frame=(a,b)=>{const length=Math.hypot(b.x-a.x,b.y-a.y);return {a,length,ux:(b.x-a.x)/length,uy:(b.y-a.y)/length};};
export function measureArmShape(layer,joints) {
  const frames=[frame(joints[0],joints[1]),frame(joints[1],joints[2])],points=[];
  const data=layer.imageData.data;
  const stride=Math.max(1,Math.ceil(Math.max(layer.width,layer.height)/400));
  let handLength=1;
  for(let y=0;y<layer.height;y+=stride)for(let x=0;x<layer.width;x+=stride){
    if(data[(y*layer.width+x)*4+3]<128)continue;
    const local=frames.map(f=>{const dx=layer.x+x+.5-f.a.x,dy=layer.y+y+.5-f.a.y;
      const along=dx*f.ux+dy*f.uy,across=-dx*f.uy+dy*f.ux;
      return {along,across,d:Math.hypot(across,Math.min(0,along),Math.max(0,along-f.length))};});
    // The forearm ray extends through the hand, including fingers near a shoulder.
    if(local[1].along>frames[1].length)local[1].d=Math.abs(local[1].across);
    const bone=local[0].d<local[1].d?0:1,p=local[bone];
    points.push({...p,bone});if(bone===1)handLength=Math.max(handLength,p.along-frames[1].length);
  }
  const bins=Array.from({length:3},()=>Array.from({length:33},()=>[]));
  for(const p of points){const hand=p.bone===1&&p.along>frames[1].length;
    const part=hand?2:p.bone,t=hand?(p.along-frames[1].length)/handLength:p.along/frames[p.bone].length;
    bins[part][Math.round(clamp(t)*32)].push(p.across);
  }
  let sections=bins.map(rows=>rows.map((row,i)=>{
    let values=row;
    for(let radius=1;values.length<3&&radius<rows.length;radius++)values=rows.slice(Math.max(0,i-radius),Math.min(rows.length,i+radius+1)).flat();
    // Preserve asymmetric contours; do not assume the joint line is centered.
    return [Math.min(-1,...values),Math.max(1,...values)];
  }));
  for(let pass=0;pass<3;pass++)sections=sections.map(rows=>rows.map((row,i)=>row.map((_,side)=>{
    const weights=[1,4,6,4,1];
    return weights.reduce((sum,w,k)=>sum+w*rows[Math.max(0,Math.min(32,i+k-2))][side],0)/16;
  })));
  sections[2][0]=[...sections[1][32]];
  return {handLength,sections};
}
function section(shape,bone,t){
  const k=clamp(t)*32,i=Math.min(31,Math.floor(k)),f=k-i;
  return shape.sections[bone][i].map((v,j)=>lerp(v,shape.sections[bone][i+1][j],f));
}
export function matchArmSection(point,a,b,source,other,bone,blend){
  if(!source||!other||blend===0)return point;
  const f=frame(a,b),dx=point.x-a.x,dy=point.y-a.y;
  let along=dx*f.ux+dy*f.uy,across=-dx*f.uy+dy*f.ux;
  const hand=bone===1&&along>f.length,part=hand?2:bone;
  const t=hand?(along-f.length)/source.handLength:along/f.length;
  const src=section(source,part,t),dst=section(other,part,t);
  const side=across<0?0:1;
  // Keep the joint capsule close to its original width. Cross-sections near
  // a folded elbow include pixels from both bones and are not reliable width
  // measurements; applying those widths creates a second bulge at handover.
  const jointDistance=bone===0?Math.abs(1-t):Math.abs(t);
  const jointFade=clamp(jointDistance/.22);
  const strength=hand?blend:blend*jointFade*jointFade*(3-2*jointFade);
  const ratio=lerp(1,Math.abs(dst[side]/src[side]),strength);
  across*=Math.max(.2,Math.min(5,ratio));
  if(hand)along=f.length+t*lerp(source.handLength,other.handLength,blend);
  return {x:a.x+along*f.ux-across*f.uy,y:a.y+along*f.uy+across*f.ux};
}
