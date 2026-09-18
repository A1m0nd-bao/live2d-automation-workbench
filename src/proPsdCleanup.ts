import { applyPsdQuality } from './psdQuality';
/** Deterministic Pro cleanup. ag-psd children are ordered back to front. */
export type CleanupLayer = {
  name?: string; children?: CleanupLayer[]; hidden?: boolean; opacity?: number;
  blendMode?: string; left?: number; top?: number; right?: number; bottom?: number;
  imageData?: {width: number; height: number; data: Uint8Array | Uint8ClampedArray};
};
const semantic = (name = '') => name.trim().toLowerCase().replace(/[ _-]+/g, '');
const variant = (name = '') => /^(action|expression)_/.test(name);
function simple(layer: CleanupLayer) {
  const l = layer as CleanupLayer & Record<string, unknown>;
  return !!l.imageData && !l.children && !l.hidden && (l.opacity ?? 1) === 1 &&
    (!l.blendMode || l.blendMode === 'normal') &&
    !['mask','vectorMask','clipping','effects','adjustment','blendClippendElements', 'knockout']
      .some(k => !!l[k]);
}
export function cleanupProOrder(layers: CleanupLayer[] = []) {
  const result = applyPsdQuality({width:Infinity,height:Infinity,children:layers},'pro');
  return {...result, warnings:[...result.warnings,...result.issues]};
}
export function proBaseLeaves(layers: CleanupLayer[] = []): CleanupLayer[] {
  return layers.flatMap(l => variant(l.name) || l.hidden ? [] : l.children ? proBaseLeaves(l.children) : l.imageData ? [l] : []);
}
export function identicalProSlot(base: CleanupLayer[], candidate: CleanupLayer[]) {
  if (!base.length || base.length !== candidate.length) return false;
  return base.every((a,i) => {
    const b=candidate[i];
    if (!simple(a) || !simple(b) || a.name !== b.name) return false;
    if (['left','top','right','bottom'].some(k => a[k as keyof CleanupLayer] !== b[k as keyof CleanupLayer])) return false;
    const x=a.imageData!, y=b.imageData!;
    return x.width===y.width && x.height===y.height && x.data.length===y.data.length && x.data.every((v,j)=>v===y.data[j]);
  });
}
