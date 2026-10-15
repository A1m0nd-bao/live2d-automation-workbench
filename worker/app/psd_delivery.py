"""Checked, non-destructive neutral PSD delivery using the pose skill's gates.

The upstream PSD is immutable. The new copy may correct only the mandatory
neutral semantic order; encoded layer records and pixels are preserved.
"""
import hashlib
import importlib.util
from pathlib import Path

from psd_tools import PSDImage

_spec = importlib.util.spec_from_file_location('morph_psd_export_gates', Path(__file__).with_name('psd_export_gates.py'))
gates = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(gates)
_order_spec = importlib.util.spec_from_file_location('morph_delivery_semantic', Path(__file__).with_name('psd_semantic_order.py'))
order = importlib.util.module_from_spec(_order_spec)
_order_spec.loader.exec_module(order)


def layer_digest(psd):
    info = psd._record.layer_and_mask_information.layer_info
    return hashlib.sha256(info.layer_records.tobytes() + info.channel_image_data.tobytes()).hexdigest()


def finalize(source, destination):
    source, destination = Path(source), Path(destination)
    if source.resolve() == destination.resolve() or destination.exists():
        raise ValueError('Refusing to overwrite source or existing PSD delivery')
    original = source.read_bytes()
    psd = PSDImage.open(source)
    original_layers = list(psd)
    before = layer_digest(psd)
    artwork_before = [order.artwork(l) for l in psd]
    if not len(psd):
        raise ValueError('Layered PSD required; flattened image is not a split result')
    correction = order.repair(psd)
    saved = gates.save_compatible(psd, destination)
    expected = [order.artwork(l) for l in original_layers]
    actual_by_name = {l.name:order.artwork(l) for l in saved}
    if correction['changed'] and (expected != artwork_before or any(actual_by_name[l.name] != sig for l,sig in zip(original_layers,artwork_before))):
        raise ValueError('Semantic correction changed layer artwork, offsets or metadata')
    if not correction['changed'] and layer_digest(saved) != before:
        raise ValueError('Layer order, metadata or encoded pixels changed during delivery')
    check = gates.inspect(destination, require_thinking=False)
    if not check['passed']:
        raise ValueError('Merged preview validation failed: ' + '; '.join(check['errors']))
    return {'version':'psd-delivery-v2', 'source_sha256':hashlib.sha256(original).hexdigest(),
            'output_sha256':hashlib.sha256(destination.read_bytes()).hexdigest(),
            'layer_digest':layer_digest(saved), 'layers_unchanged':not correction['changed'],
            'source_artwork_unchanged':True, 'neutral_pixels_unchanged':not correction['changed'],
            'neutral_matches_corrected_baseline':True, 'semantic_order':correction,
            'stored_merged_verified':True, 'native_photoshop_validation':'not_performed',
            'visual_acceptance':'pending_human_review', 'scope':'neutral_psd_only'}


def finalize_download(data, directory):
    """Idempotent local completion, without repeating upload/inference calls."""
    import json
    directory = Path(directory)
    source = directory / 'upstream-output.psd'
    destination = directory / 'output.psd'
    report = directory / 'psd-delivery.json'
    if source.exists():
        if source.read_bytes() != data:
            raise ValueError('Upstream PSD changed for an existing inference result')
    else:
        with source.open('xb') as handle:
            handle.write(data)
    if destination.exists():
        if not report.exists():
            raise ValueError('Existing output has no completed delivery validation; kept for inspection')
        payload = json.loads(report.read_text())
        if payload.get('output_sha256') != hashlib.sha256(destination.read_bytes()).hexdigest():
            raise ValueError('Existing checked delivery changed')
        if payload.get('source_sha256') != hashlib.sha256(data).hexdigest():
            raise ValueError('Existing checked delivery belongs to another upstream PSD')
        # Historical/user-edited deliveries are never silently rewritten.
        gates.validate_semantic_order(PSDImage.open(destination))
        return destination
    payload = finalize(source, destination)
    report.write_text(json.dumps(payload, ensure_ascii=False, indent=2))
    return destination
