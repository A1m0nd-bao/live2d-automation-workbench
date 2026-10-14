import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from PIL import Image
from psd_tools import PSDImage
from worker.psd_test_fixture import layered_psd

spec=importlib.util.spec_from_file_location('test_psd_delivery_module',Path(__file__).parent/'app/psd_delivery.py')
delivery=importlib.util.module_from_spec(spec)
spec.loader.exec_module(delivery)


class DeliveryTests(unittest.TestCase):
    def test_real_alpha_colors_layers_and_source_survive(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder); source=root/'source.psd'; source.write_bytes(layered_psd())
            raw=source.read_bytes(); psd=PSDImage.open(source)
            expected=psd.composite(force=True,apply_icc=False).convert('RGBA')
            report=delivery.finalize(source,root/'fixed.psd')
            check=PSDImage.open(root/'fixed.psd')
            self.assertEqual(source.read_bytes(),raw)
            self.assertEqual(delivery.layer_digest(check),delivery.layer_digest(psd))
            self.assertEqual(check.topil().mode,'RGBA')
            self.assertEqual(check.topil().getchannel('A').tobytes(),expected.getchannel('A').tobytes())
            self.assertLessEqual(max(abs(a-b) for a,b in zip(check.topil().getpixel((4,10)),expected.getpixel((4,10)))),2)
            self.assertTrue(report['stored_merged_verified'])
            self.assertEqual(report['visual_acceptance'],'pending_human_review')

    def test_existing_paths_are_never_overwritten(self):
        with tempfile.TemporaryDirectory() as folder:
            source=Path(folder)/'source.psd'; source.write_bytes(layered_psd())
            with self.assertRaises(ValueError): delivery.finalize(source,source)
            dest=Path(folder)/'existing.psd'; dest.write_bytes(b'user file')
            with self.assertRaises(ValueError): delivery.finalize(source,dest)
            self.assertEqual(dest.read_bytes(),b'user file')

    def test_download_is_idempotent_and_checks_both_hashes(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder); data=layered_psd()
            output=delivery.finalize_download(data,root)
            self.assertEqual(delivery.finalize_download(data,root),output)
            self.assertEqual((root/'upstream-output.psd').read_bytes(),data)
            self.assertTrue(json.loads((root/'psd-delivery.json').read_text())['layers_unchanged'])
            with self.assertRaises(ValueError): delivery.finalize_download(data+b'changed',root)
            output.write_bytes(b'changed output')
            with self.assertRaises(ValueError): delivery.finalize_download(data,root)

    def test_truncated_psd_cannot_be_a_success(self):
        with tempfile.TemporaryDirectory() as folder:
            with self.assertRaises(Exception): delivery.finalize_download(b'8BPS\x00\x01'+bytes(32),folder)
            self.assertFalse((Path(folder)/'psd-delivery.json').exists())

    def test_unreviewed_existing_output_is_kept_and_blocked(self):
        with tempfile.TemporaryDirectory() as folder:
            output=Path(folder)/'output.psd'; output.write_bytes(b'partial file')
            with self.assertRaises(ValueError): delivery.finalize_download(layered_psd(),folder)
            self.assertEqual(output.read_bytes(),b'partial file')


if __name__=='__main__': unittest.main()
