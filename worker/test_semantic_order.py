import importlib.util
import itertools
from pathlib import Path
import tempfile
import unittest

from PIL import Image, ImageDraw
from psd_tools import PSDImage
from psd_tools.api.layers import PixelLayer, Group

spec=importlib.util.spec_from_file_location('semantic_delivery_tests',Path(__file__).parent/'app/psd_delivery.py')
delivery=importlib.util.module_from_spec(spec);spec.loader.exec_module(delivery)
order=delivery.order


def document(names):
    psd=PSDImage.new('RGBA',(48,48))
    for index,name in enumerate(names):
        img=Image.new('RGBA',psd.size)
        color='green' if name.startswith('irides') else 'white' if name.startswith('eyewhite') else (index*19%255,60,80,255)
        ImageDraw.Draw(img).rectangle((10,10,30,35),fill=color)
        PixelLayer.frompil(img,psd,name)
    return psd


class SemanticOrderTests(unittest.TestCase):
    def test_every_body_permutation_repaired_minimally_and_keeps_artwork(self):
        for permutation in itertools.permutations(('topwear','neck','face')):
            with self.subTest(permutation=permutation):
                psd=document([permutation[0],'accessory-a',permutation[1],'accessory-b',permutation[2]])
                before=list(psd);signature={id(l):order.artwork(l) for l in psd}
                report=order.repair(psd)
                self.assertEqual([l.name for l in psd if l.name in permutation],['topwear','neck','face'])
                self.assertEqual([l.name for l in psd if l.name.startswith('accessory')],['accessory-a','accessory-b'])
                self.assertTrue(all(order.artwork(l)==signature[id(l)] for l in psd))
                longest=max(len(c) for count in range(1,4) for c in itertools.combinations(permutation,count) if list(c)==sorted(c,key=('topwear','neck','face').index))
                self.assertEqual(len(report['moved_layers']),3-longest)
                self.assertFalse(order.repair(psd)['changed'])

    def test_each_matching_eye_pair_only_and_saved_composite_is_corrected(self):
        psd=document(['topwear','neck','face','irides-r','eyewhite-r','eyewhite-l','irides-l'])
        self.assertEqual(psd.composite(force=True).getpixel((20,20))[:3],(0,128,0))
        with tempfile.TemporaryDirectory() as folder:
            source=Path(folder)/'source.psd';psd.save(source);raw=source.read_bytes()
            result=delivery.finalize(source,Path(folder)/'corrected.psd')
            self.assertEqual(source.read_bytes(),raw)
            self.assertEqual(result['semantic_order']['moved_layers'],['irides-r'])
            self.assertFalse(result['layers_unchanged'])
            self.assertFalse(result['neutral_pixels_unchanged'])
            self.assertTrue(result['source_artwork_unchanged'])
            self.assertTrue(result['neutral_matches_corrected_baseline'])
            self.assertFalse(delivery.gates.inspect(Path(folder)/'corrected.psd',require_thinking=False)['errors'])

    def test_unsafe_or_incomplete_inputs_are_unchanged_and_blocked_before_export(self):
        for names in [('face','neck'),('face','neck','topwear','action_02_wave_arms_only'),('face','face','neck','topwear')]:
            psd=document(names);before=[(id(l),order.artwork(l)) for l in psd]
            with self.assertRaises(ValueError):order.repair(psd)
            self.assertEqual([(id(l),order.artwork(l)) for l in psd],before)
        psd=document(['face','neck','topwear']);psd[1].clipping=True
        names=[l.name for l in psd]
        with self.assertRaises(ValueError):order.repair(psd)
        self.assertEqual(names,[l.name for l in psd])

    def test_nested_semantic_parts_and_wrong_eye_pairs_are_not_guessed(self):
        psd=document(['topwear','neck','face','irides-r','eyewhite-l'])
        with self.assertRaises(ValueError):order.repair(psd)
        psd=document(['topwear','neck','face']);group=Group.new(psd,'eye group')
        PixelLayer.frompil(Image.new('RGBA',(10,10),'green'),group,'irides-r')
        with self.assertRaises(ValueError):order.repair(psd)

    def test_old_deliveries_are_not_silently_rewritten(self):
        import hashlib,json
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);psd=document(['face','neck','topwear']);output=root/'output.psd';psd.save(output)
            raw=output.read_bytes();(root/'upstream-output.psd').write_bytes(raw)
            sha=hashlib.sha256(raw).hexdigest();(root/'psd-delivery.json').write_text(json.dumps({'source_sha256':sha,'output_sha256':sha}))
            with self.assertRaises(ValueError):delivery.finalize_download(raw,root)
            self.assertEqual(output.read_bytes(),raw)


if __name__=='__main__':unittest.main()
