"""Minimal neutral-stack corrections on new working copies only."""
import hashlib
import importlib.util
from itertools import combinations
from pathlib import Path

spec = importlib.util.spec_from_file_location('morph_semantic_gates', Path(__file__).with_name('psd_export_gates.py'))
gates = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gates)
POLICY = 'neutral-semantic-order-20261015-v1'
FAMILIES = [('eyewhite'+s, 'irides'+s) for s in ('', '-r', '-l')] + [('topwear', 'neck', 'face')]


def artwork(layer):
    """Encoded record/channel identity, independent of root stack position."""
    layers = [layer, *(layer.descendants() if layer.is_group() else [])]
    return [(hashlib.sha256(l._record.tobytes()).hexdigest(),
             tuple(hashlib.sha256(c.data).hexdigest() for c in l._channels)) for l in layers]


def repair(psd):
    before = list(psd)
    report = gates.semantic_order_report(psd)
    structural = [e for e in report['errors'] if not e.startswith('semantic order: ')]
    if structural:
        raise ValueError('中立语义层需人工确认：' + '; '.join(structural))
    planned = list(before)
    moves = []
    # The longest already-correct subsequence stays put. Only the other
    # semantic parts move; unrelated layers never change their mutual order.
    for family in FAMILIES:
        members = [l for l in before if l.name in family]
        if not members:
            continue
        keep = None
        for count in range(len(family), 0, -1):
            for retained in combinations(family, count):
                if [l.name for l in planned if l.name in retained] == list(retained):
                    keep = set(retained)
                    break
            if keep is not None:
                break
        moving = [name for name in family if name not in keep]
        movable = {l.name:l for l in members}
        planned = [l for l in planned if l.name not in moving]
        for index, name in enumerate(family):
            if name not in moving:
                continue
            following = next((n for n in family[index+1:] if any(l.name == n for l in planned)), None)
            previous = next((n for n in reversed(family[:index]) if any(l.name == n for l in planned)), None)
            position = next(i for i,l in enumerate(planned) if l.name == following) if following else next(i for i,l in enumerate(planned) if l.name == previous)+1
            planned.insert(position, movable[name])
            moves.append(name)
    signatures = {id(l):artwork(l) for l in before}
    if moves:
        # An action draw slot was reviewed against the previous body stack.
        # Do not relocate that state as a side effect of neutral correction.
        if any(l.name.startswith(('action_', 'expression_')) for l in before):
            raise ValueError('中立顺序需纠正但已有动作/表情组；需复核其遮挡位置，未重排')
        for layer in before:
            if (layer.is_group() or layer.has_mask() or layer.clipping or layer.has_effects() or
                layer.opacity != 255 or layer.blend_mode.name != 'NORMAL'):
                raise ValueError('中立顺序涉及分组/遮罩/剪贴/混合依赖；需人工复核，未重排')
        for layer in list(psd):
            psd.remove(layer)
        for layer in planned:
            psd.append(layer)
        if any(artwork(l) != signatures[id(l)] for l in psd):
            raise ValueError('语义排序改动了图层记录或像素，未放行')
        psd._update_record()
    verified = gates.validate_semantic_order(psd)
    return {'policy':POLICY, 'changed':bool(moves), 'moved_layers':moves,
            'before_back_to_front':[l.name for l in before],
            'after_back_to_front':[l.name for l in psd],
            'artwork_unchanged':True, 'semantic_order_verified':True,
            'checked_constraints':verified['checked_constraints'],
            'neutral_baseline':'order_corrected_working_copy' if moves else 'source',
            'visual_acceptance':'pending_human_review'}
