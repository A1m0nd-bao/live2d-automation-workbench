import type { CleanupLayer } from './proPsdCleanup';

export const SEMANTIC_ORDER_POLICY = 'neutral-semantic-order-20261015-v1';
const families = ['', '-r', '-l'].map(s => ['eyewhite' + s, 'irides' + s]).concat([['topwear', 'neck', 'face']]);
const relevant = new Set(families.flat());
type SemanticNode = { name?: string; children?: SemanticNode[] };

export function semanticOrderReport(layers: SemanticNode[]) {
  const names = layers.map(l => l.name ?? '');
  const errors: string[] = [], constraints: Array<{ behind: string; front: string }> = [];
  const walk = (items: SemanticNode[]) => {
    for (const layer of items) {
      if (layer.name?.startsWith('action_')) continue;
      if (relevant.has(layer.name ?? '')) errors.push(`语义层嵌套需复核：${layer.name}`);
      if (layer.children) walk(layer.children);
    }
  };
  for (const layer of layers) if (layer.children && !layer.name?.startsWith('action_')) walk(layer.children);
  for (const family of families) {
    if (!family.some(name => names.includes(name))) continue;
    const invalid = family.filter(name => names.filter(n => n === name).length !== 1);
    if (invalid.length) { errors.push(`语义层缺失或重复：${invalid.join('、')}`); continue; }
    for (let i = 1; i < family.length; i++) {
      const [behind, front] = [family[i - 1], family[i]];
      constraints.push({ behind, front });
      if (names.indexOf(behind) >= names.indexOf(front)) errors.push(`顺序错误：${front} 必须在 ${behind} 上方`);
    }
  }
  return { policy: SEMANTIC_ORDER_POLICY, beforeBackToFront: names, constraints, errors };
}

function retainedSubsets(family: string[], count: number): string[][] {
  if (!count) return [[]];
  return family.flatMap((name, index) => retainedSubsets(family.slice(index + 1), count - 1).map(tail => [name, ...tail]));
}

export function repairSemanticOrder(layers: CleanupLayer[]) {
  const report = semanticOrderReport(layers);
  const initialErrors = report.errors.filter(e => !e.startsWith('顺序错误：'));
  const before = [...layers], movedLayers: string[] = [];
  let planned = [...layers];
  if (!initialErrors.length) for (const family of families) {
    if (!planned.some(l => family.includes(l.name ?? ''))) continue;
    let keep: string[] = [];
    for (let count = family.length; count > 0; count--) {
      const candidate = retainedSubsets(family, count).find(retained => planned.filter(l => retained.includes(l.name ?? '')).map(l => l.name).join('|') === retained.join('|'));
      if (candidate) { keep = candidate; break; }
    }
    const moving = family.filter(name => !keep.includes(name));
    planned = planned.filter(l => !moving.includes(l.name ?? ''));
    for (const [index, name] of family.entries()) {
      if (!moving.includes(name)) continue;
      const following = family.slice(index + 1).find(n => planned.some(l => l.name === n));
      const previous = family.slice(0, index).reverse().find(n => planned.some(l => l.name === n));
      const at = following ? planned.findIndex(l => l.name === following) : planned.findIndex(l => l.name === previous) + 1;
      planned.splice(at, 0, before.find(l => l.name === name)!);
      movedLayers.push(name);
    }
  }
  if (movedLayers.length) {
    if (before.some(l => /^(action|expression)_/.test(l.name ?? ''))) initialErrors.push('已有动作/表情组，纠正中立排序前需复核其遮挡槽位');
    if (before.some(layer => {
      const value = layer as CleanupLayer & Record<string, unknown>;
      return !!layer.children || (layer.opacity ?? 1) !== 1 || (layer.blendMode && layer.blendMode !== 'normal') ||
        ['mask', 'vectorMask', 'clipping', 'effects', 'adjustment', 'knockout'].some(k => !!value[k]);
    })) initialErrors.push('存在分组、遮罩、剪贴或混合依赖，保留原顺序待复核');
  }
  if (!initialErrors.length) layers.splice(0, layers.length, ...planned);
  const after = semanticOrderReport(layers);
  return { ...report, errors: [...new Set([...initialErrors, ...after.errors])],
    afterBackToFront: layers.map(l => l.name ?? ''), movedLayers: initialErrors.length ? [] : movedLayers,
    changed: !initialErrors.length && movedLayers.length > 0, artworkUnchanged: true,
    neutralBaseline: !initialErrors.length && movedLayers.length ? 'order_corrected_working_copy' : 'source',
    visualAcceptance: 'pending_human_review' };
}
