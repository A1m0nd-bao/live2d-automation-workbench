import type { CleanupLayer } from './proPsdCleanup';

// Observed back-to-front order in seethrough_output (3).psd. This is an
// ordinary humanoid profile, NOT a universal ordering for props/front hair.
export const ORDINARY_PSD_STANDARD = {
  id: 'ana-ordinary-22-v1',
  order: ['handwear-r','handwear-l','footwear','legwear','back hair','bottomwear','topwear','neck','eyebrow-r','eyebrow-l','ears-r','face','mouth','ears-l','nose','eyelash-r','eyewhite-r','eyewhite-l','eyelash-l','irides-r','irides-l','front hair'],
};
const key=(s='')=>s.trim().toLowerCase().replace(/[ _-]/g,'');
function slot(s='') {const k=key(s);return /^(footwear|legwear)[lr]$/.test(k)?k.slice(0,-1):k;}
const isVariant=(s='')=>/^(action|expression)_/.test(s);
function overlap(a:CleanupLayer,b:CleanupLayer){
  return Math.max(a.left??0,b.left??0)<Math.min(a.right??0,b.right??0)&&Math.max(a.top??0,b.top??0)<Math.min(a.bottom??0,b.bottom??0);
}
export function applyPsdQuality(document:{width:number;height:number;children?:CleanupLayer[]},mode:'ordinary'|'pro'='ordinary',options:{preserveOrder?:boolean}={}) {
 const changed:string[]=[],warnings:string[]=[],issues:string[]=[];
 const rank=new Map(ORDINARY_PSD_STANDARD.order.map((s,i)=>[key(s),i]));
 let nonEmpty=0;const seen:string[]=[];
 function walk(items:CleanupLayer[],path:string){
  const ordinary=items.filter(l=>!isVariant(l.name));
  for(const l of ordinary){
   if(l.children){walk(l.children,`${path}/${l.name}`);continue;}
   const d=l.imageData;const pixels=d?.data;
   let occupied=false;if(pixels)for(let i=3;i<pixels.length;i+=4)if(pixels[i]>16){occupied=true;break;}
   if(!l.hidden&&occupied){nonEmpty++;seen.push(slot(l.name));}
   if(!occupied)issues.push(`${path}/${l.name}: 空图层，保留待修`);
   if(!rank.has(slot(l.name)))warnings.push(`${path}/${l.name}: 标准外部件，保留原层及顺序`);
   if((l.left??0)<0||(l.top??0)<0||(l.right??0)>document.width||(l.bottom??0)>document.height)issues.push(`${path}/${l.name}: 像素边界越界，保留待修`);
  }
  // Keep unknowns, folders and dependency-bearing layers as barriers; never
  // flatten a group or move a clipping base away from its consumers.
  const safe=ordinary.every(l=>l.imageData&&!l.children&&!l.hidden&&(l.opacity??1)===1&&(!l.blendMode||l.blendMode==='normal')&&!['mask','vectorMask','clipping','effects','adjustment','knockout'].some(k=>!!(l as unknown as Record<string,unknown>)[k]));
  const candidates=ordinary.filter(l=>rank.has(slot(l.name)));
  const duplicate=candidates.some((l,i)=>candidates.findIndex(x=>key(x.name)===key(l.name))!==i);
  if(duplicate){issues.push(`${path}: 重复语义层，保留待修`);return;}
  const edges: [CleanupLayer,CleanupLayer][]=[];
  for(let i=0;i<candidates.length;i++)for(let j=i+1;j<candidates.length;j++){
   const a=candidates[i],b=candidates[j];if(!overlap(a,b))continue;
   const ra=rank.get(slot(a.name))!,rb=rank.get(slot(b.name))!;
   if(ra!==rb)edges.push(ra<rb?[a,b]:[b,a]);
  }
  const inverted=edges.filter(([a,b])=>items.indexOf(a)>items.indexOf(b));
  if(!inverted.length)return;
  if(options.preserveOrder){warnings.push(`${path}: 模板排序建议与源 PSD 不同；已保留源顺序，需人工确认遮挡，不自动重排`);return;}
  if(!safe||candidates.length!==ordinary.length){issues.push(`${path}: 存在遮挡顺序冲突及复杂依赖，保留待修，不退回生成`);return;}
  const remaining=[...ordinary],sorted:CleanupLayer[]=[];
  while(remaining.length){const next=remaining.find(l=>!edges.some(([a,b])=>b===l&&remaining.includes(a)));if(!next){issues.push(`${path}: 排序关系冲突`);return;}sorted.push(next);remaining.splice(remaining.indexOf(next),1);}
  let cursor=0;for(let i=0;i<items.length;i++)if(!isVariant(items[i].name))items[i]=sorted[cursor++];
  for(const [a,b]of inverted)changed.push(`${path}: ${a.name} 在 ${b.name} 后方`);
 }
 walk(document.children??[],'base');
 for(const required of ['face','mouth','neck','topwear'])if(!seen.includes(required))issues.push(`缺少可见 ${required}：保留现有素材待修`);
 if(mode==='pro')for(const s of ['legwear','footwear'])if(seen.includes(s))warnings.push(`${s}: Pro 需确认左右可独立绑定；不因合层退回生成`);
 return {policy:ORDINARY_PSD_STANDARD.id,mode,changed,warnings,issues,nonEmptyLayers:nonEmpty,
  status:nonEmpty===0?'unusable':issues.length?'needs_repair':changed.length?'repaired':'structure_checked',
  automaticRegeneration:false,nativeRigVerified:false,visualOcclusionVerified:false};
}
