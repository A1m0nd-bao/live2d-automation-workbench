"""Reusable PSD pose gates. No image generation or implicit landmark guessing."""
from pathlib import Path
import argparse
import json
import math
import numpy as np
from PIL import Image
from scipy.ndimage import label
from psd_tools import PSDImage
from psd_tools.api.layers import Group, PixelLayer
from psd_tools.api.pil_io import get_transparency_index
from psd_tools.constants import Resource

THINKING = 'action_05_thinking_arms_only'
SIDES = ('handwear-r', 'handwear-l')


def require(condition, message):
    if not condition:
        raise ValueError(message)


def semantic_order_report(psd):
    """Audit neutral semantic layers without changing the document.

    Photoshop's Layers panel is front-to-back; psd-tools iterates the reverse.
    Absent semantic families are not certified (e.g. an isolated arm fixture).
    Present families must have unique, root-level members; do not guess aliases
    or flatten nested parts, masks or clipping groups automatically.
    """
    names = [layer.name for layer in psd]
    report = {'root_order_back_to_front': names, 'checked_constraints': [], 'errors': []}
    relevant = {'face', 'neck', 'topwear'}
    for suffix in ('', '-r', '-l'):
        relevant.update(('eyewhite' + suffix, 'irides' + suffix))

    def nested_parts(group):
        for child in group:
            if child.name.startswith('action_'):
                continue
            if child.name in relevant:
                report['errors'].append('semantic order needs reviewed root-level parts: ' + child.name)
            if child.is_group():
                nested_parts(child)

    for layer in psd:
        if layer.is_group() and not layer.name.startswith('action_'):
            nested_parts(layer)

    def family(parts):
        if not any(name in names for name in parts):
            return
        invalid = [name for name in parts if names.count(name) != 1]
        if invalid:
            report['errors'].append('semantic order requires unique root layers: ' + ', '.join(invalid))
            return
        for behind, front in zip(parts, parts[1:]):
            report['checked_constraints'].append({'behind': behind, 'front': front})
            if names.index(behind) >= names.index(front):
                report['errors'].append('semantic order: ' + front + ' must be above ' + behind)

    for suffix in ('', '-r', '-l'):
        family(('eyewhite' + suffix, 'irides' + suffix))
    family(('topwear', 'neck', 'face'))
    return report


def validate_semantic_order(psd):
    report = semantic_order_report(psd)
    require(not report['errors'], '; '.join(report['errors']))
    return report


def check_arm(image):
    image = image.convert('RGBA')
    alpha = np.asarray(image.getchannel('A'))
    require(np.any(alpha > 50), 'empty arm artwork')
    labels, _ = label(alpha > 50)
    areas = np.bincount(labels.ravel())[1:]
    substantial = areas[areas >= max(100, int((alpha > 50).sum() * .10))]
    require(len(substantial) == 1, 'one arm layer contains multiple substantial pieces; inspect/split before export')
    return image


def distance_to_ink(image, point):
    yy, xx = np.where(np.asarray(image.getchannel('A')) > 50)
    require(len(xx) > 0, 'empty arm artwork')
    return float(np.sqrt(((xx - point[0]) ** 2 + (yy - point[1]) ** 2).min()))


def fit_arm(image, canvas, placement):
    """Align an explicitly annotated shoulder, preserving each side independently.

    Landmarks use the input image's pixel coordinates, NOT its alpha bbox origin.
    Scale is explicit; never derive it from a bent arm's visible height.
    """
    image = check_arm(image)
    require('source_shoulder' in placement and 'target_shoulder' in placement,
            'explicit source_shoulder and target_shoulder are required; refusing bbox guess')
    source = tuple(map(float, placement['source_shoulder']))
    target = tuple(map(float, placement['target_shoulder']))
    scale = float(placement.get('scale', 1))
    require(len(source) == len(target) == 2 and all(math.isfinite(v) for v in source + target), 'invalid shoulder coordinates')
    require(math.isfinite(scale) and scale > 0, 'invalid uniform scale')
    tolerance = float(placement.get('shoulder_tolerance', 12))
    require(math.isfinite(tolerance) and tolerance >= 0, 'invalid shoulder tolerance')
    require(distance_to_ink(image, source) <= tolerance, 'annotated source shoulder is detached from artwork')
    box = image.getchannel('A').getbbox()
    piece = image.crop(box)
    piece = piece.resize((max(1, round(piece.width * scale)), max(1, round(piece.height * scale))), Image.Resampling.LANCZOS)
    left = round(target[0] - (source[0] - box[0]) * scale)
    top = round(target[1] - (source[1] - box[1]) * scale)
    require(left >= 0 and top >= 0 and left + piece.width <= canvas[0] and top + piece.height <= canvas[1],
            'arm would be cropped outside canvas; revise placement/artwork')
    result = Image.new('RGBA', canvas)
    result.alpha_composite(piece, (left, top))
    require(distance_to_ink(result, target) <= tolerance + 1, 'placed shoulder misses target')
    if 'source_hand' in placement:
        require('target_hand' in placement and 'hand_tolerance' in placement, 'hand contact needs target and tolerance')
        hand = tuple(map(float, placement['source_hand']))
        expected = tuple(map(float, placement['target_hand']))
        actual = (left + (hand[0] - box[0]) * scale, top + (hand[1] - box[1]) * scale)
        require(distance_to_ink(image, hand) <= tolerance, 'annotated hand is detached from artwork')
        require(math.dist(actual, expected) <= float(placement['hand_tolerance']), 'hand misses intended chin/cheek contact')
    for landmark in placement.get('extra_landmarks', []):
        point = tuple(map(float, landmark['source']))
        expected = tuple(map(float, landmark['target']))
        actual = (left + (point[0] - box[0]) * scale, top + (point[1] - box[1]) * scale)
        require(distance_to_ink(image, point) <= tolerance, 'extra landmark detached from artwork')
        require(math.dist(actual, expected) <= float(landmark['tolerance']),
                'extra landmark misses target: ' + landmark.get('role', 'unspecified'))
    return result


def place_group(psd, group, slot):
    """psd-tools iteration order is back-to-front. Base layers are not reordered."""
    require(slot and (slot.get('after') or slot.get('before')), 'explicit reviewed draw slot is required')
    base = [l for l in psd if l is not group]
    names = [l.name for l in base]
    for key in ('after', 'before'):
        if slot.get(key):
            require(names.count(slot[key]) == 1, 'draw anchor must exist uniquely: ' + slot[key])
            require(not slot[key].startswith('action_'), 'draw anchors must be stable base layers, not other actions')
    low = names.index(slot['after']) + 1 if slot.get('after') else 0
    high = names.index(slot['before']) if slot.get('before') else len(base)
    require(low <= high, 'conflicting draw slot; do not reorder the neutral body to force it')
    index = low if slot.get('after') else high
    for side in SIDES:
        require(side in names and names.index(side) < index, 'action must be above replaced neutral arm: ' + side)
    psd.insert(index, group)


def validate_fitted_parts(parts, placements):
    """Gate batch export against the reviewed target points, not just filenames."""
    for part, image in parts.items():
        plan = placements if part == 'handwear' else placements[part]
        require('target_shoulder' in plan, 'reviewed target shoulder is missing')
        tolerance = float(plan.get('shoulder_tolerance', 12))
        require(math.isfinite(tolerance) and tolerance >= 0, 'invalid target tolerance')
        require(distance_to_ink(image, plan['target_shoulder']) <= tolerance + 1,
                'fitted arm is detached from reviewed shoulder: ' + part)
        if part == 'handwear':
            require(any(p.get('role') == 'opposite_shoulder' for p in plan.get('extra_landmarks', [])),
                    'cross requires both reviewed shoulder targets')
        for point in plan.get('extra_landmarks', []):
            require(distance_to_ink(image, point['target']) <= float(point['tolerance']) + 1,
                    'fitted artwork misses extra target: ' + point.get('role', 'unspecified'))
        if 'target_hand' in plan:
            require(distance_to_ink(image, plan['target_hand']) <= float(plan['hand_tolerance']) + 1,
                    'fitted artwork misses hand contact target')


def add_action(psd, name, parts, slot, replace=False):
    require(name.startswith('action_'), 'invalid action name')
    if name == THINKING:
        require(set(parts) == set(SIDES), 'thinking requires separate handwear-r and handwear-l')
    existing = [l for l in psd if l.name == name]
    require(len(existing) <= 1, 'duplicate action group')
    require(not existing or replace, 'action already exists; explicit replace required on a working copy')
    # Validate before removing an existing in-memory state.
    for part, image in parts.items():
        require(image.size == psd.size, 'part must preserve shared canvas/offsets')
        if part in SIDES:
            check_arm(image)
        require(image.getchannel('A').getbbox() is not None, 'empty action child')
    if existing:
        psd.remove(existing[0])
    # psd-tools 1.11 converts frompil() to parent.pil_mode; an RGB-only
    # header would discard the new PNG's alpha before layer encoding.
    if psd._record.header.channels == 3:
        psd._record.header.channels = 4
    group = Group.new(psd, name)
    for part, image in parts.items():
        box = image.getchannel('A').getbbox()
        PixelLayer.frompil(image.crop(box), group, name + '__' + part, left=box[0], top=box[1])
    group.visible = False
    place_group(psd, group, slot)
    return group


def action_preview(psd, group):
    visibility = [(l, l.visible) for l in psd]
    try:
        for l in psd:
            if l.name.startswith('action_') or l.name in SIDES:
                l.visible = l is group
        return psd.composite(force=True, apply_icc=False).convert('RGBA')
    finally:
        for layer, visible in visibility:
            layer.visible = visible


def save_compatible(psd, path):
    """Write a genuine merged-alpha plane; never call the old RGB-dropping save path.

    Preserve auxiliary channels when they can be identified and decoded. Unknown
    auxiliary-channel layouts are blocked instead of silently discarded.
    """
    path = Path(path)
    require(not path.exists(), 'refusing to overwrite output: ' + str(path))
    validate_semantic_order(psd)
    header = psd._record.header
    require(header.depth == 8 and int(header.color_mode) == 3, 'export helper supports only 8-bit RGB PSD')
    require(header.channels >= 3, 'invalid RGB channel count')
    alpha_ids = psd.image_resources.get_data(Resource.ALPHA_IDENTIFIERS)
    require(not alpha_ids or 0 in alpha_ids, 'unidentified auxiliary alpha channels; use native Photoshop export')
    old_channels = None
    try:
        old_channels = psd._record.image_data.get_data(header)
    except (AssertionError, ValueError):
        require(header.channels <= 4, 'cannot preserve corrupt auxiliary channels')
    rgba = psd.composite(force=True, apply_icc=False).convert('RGBA')
    # PSD's merged RGB is white-matted even when a separate transparency plane
    # exists. Straight RGB here darkens semitransparent hair when decoded.
    matte = Image.alpha_composite(Image.new('RGBA', rgba.size, 'white'), rgba).convert('RGB')
    rgb = [matte.getchannel(c).tobytes() for c in 'RGB']
    if header.channels > 4:
        require(old_channels is not None, 'missing auxiliary channel data')
        index = get_transparency_index(psd)
        require(index >= 3, 'missing identifiable merged transparency channel')
        channels = rgb + old_channels[3:]
        channels[index] = rgba.getchannel('A').tobytes()
    else:
        header.channels = 4
        channels = rgb + [rgba.getchannel('A').tobytes()]
    require(len(channels) == header.channels, 'merged channel count mismatch')
    psd._record.layer_and_mask_information.layer_info.layer_count = -abs(
        psd._record.layer_and_mask_information.layer_info.layer_count)
    psd._record.image_data.set_data(channels, header)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open('xb') as stream:
        psd._record.write(stream)
    reopened = PSDImage.open(path)
    validate_semantic_order(reopened)
    decoded = reopened._record.image_data.get_data(reopened._record.header)
    require(len(decoded) == reopened.channels, 'exported merged image is truncated')
    require(reopened.topil(apply_icc=False).mode == 'RGBA', 'exported merged transparency is unavailable')
    after = reopened.composite(force=True, apply_icc=False).convert('RGBA')
    require(np.array_equal(np.asarray(after), np.asarray(rgba)), 'export changed default layered composite')
    validate_merged_preview(reopened, rgba)
    return reopened


def validate_merged_preview(psd, expected):
    stored = psd.topil(apply_icc=False)
    require(stored.mode == 'RGBA', 'merged transparency is not declared')
    require(stored.getchannel('A').tobytes() == expected.getchannel('A').tobytes(),
            'stored merged alpha disagrees with visible layers')
    for color in ('black', 'white'):
        base = Image.new('RGBA', expected.size, color)
        left = np.asarray(Image.alpha_composite(base, stored)).astype(np.int16)
        right = np.asarray(Image.alpha_composite(base, expected)).astype(np.int16)
        require(int(np.abs(left-right).max()) <= 2, 'stored merged colors disagree with visible layers')


def inspect(path, strict_thinking=True, require_thinking=True):
    result = {'file': str(path), 'errors': []}
    try:
        psd = PSDImage.open(path)
        result['semantic_order'] = semantic_order_report(psd)
        result['errors'].extend(result['semantic_order']['errors'])
        channels = psd._record.image_data.get_data(psd._record.header)
        require(len(channels) == psd.channels, 'merged image channel count mismatch')
        require(psd.depth == 8 and all(len(c) == psd.width*psd.height for c in channels),
                'merged image plane size/depth mismatch')
        psd.topil()
        result['merged_channels'] = len(channels)
        validate_merged_preview(psd, psd.composite(force=True, apply_icc=False).convert('RGBA'))
        groups = [l for l in psd if l.name == THINKING]
        if not require_thinking and not groups:
            result['passed'] = not result['errors']
            result['scope'] = 'neutral_merged_export_and_present_semantic_order'
            result['visual_approval'] = 'not_automatically_proven'
            return result
        require(len(groups) == 1, 'missing/duplicate thinking group')
        group = groups[0]
        result['thinking_children'] = [l.name for l in group]
        if strict_thinking:
            require(set(result['thinking_children']) == {THINKING + '__' + s for s in SIDES} and len(group) == 2,
                    'thinking must have exactly two uniquely named left/right arm layers')
            for child in group:
                require(not child.is_group() and child.width > 0 and child.height > 0, 'empty/non-pixel thinking child')
                check_arm(child.topil())
    except Exception as exc:
        result['errors'].append(str(exc))
    result['passed'] = not result['errors']
    result['visual_approval'] = 'not_automatically_proven'
    return result


def main():
    parser = argparse.ArgumentParser()
    commands = parser.add_subparsers(dest='command', required=True)
    validate = commands.add_parser('validate')
    validate.add_argument('files', nargs='+', type=Path)
    validate.add_argument('--report', type=Path)
    validate.add_argument('--neutral', action='store_true', help='Base PSD export checks; does not require a thinking action')
    args = parser.parse_args()
    results = [inspect(p, require_thinking=not args.neutral) for p in args.files]
    payload = json.dumps(results, ensure_ascii=False, indent=2)
    if args.report:
        args.report.write_text(payload)
    print(payload)
    raise SystemExit(0 if all(r['passed'] for r in results) else 1)


if __name__ == '__main__':
    main()
