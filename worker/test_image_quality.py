import importlib.util
from pathlib import Path
import unittest
import io
from PIL import Image
s=importlib.util.spec_from_file_location('quality_test',Path(__file__).parent/'app/image_quality.py')
m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
class QualityTests(unittest.TestCase):
    def test_review_images_share_scale_without_changing_production_bytes(self):
        sizes=[]
        for size in [(100, 200), (200, 400)]:
            raw=io.BytesIO();Image.new('RGB',size,'white').save(raw,'PNG')
            original=raw.getvalue()
            checked=m.inspection_image(original)
            sizes.append(Image.open(io.BytesIO(checked)).size)
            self.assertEqual(Image.open(io.BytesIO(original)).size,size)
        self.assertEqual(sizes,[(768,1536),(768,1536)])
    def test_all_checks_required(self):
        with self.assertRaises(ValueError):m.validate_review({'checks':{'full_body':'pass'},'reasons':[]})
        with self.assertRaises(ValueError):m.validate_review({'checks':dict.fromkeys(m.CHECKS,True),'reasons':[]})
    def test_fail_and_uncertainty_cannot_be_overridden(self):
        for value in ['fail','uncertain']:
            checks=dict.fromkeys(m.CHECKS,'pass');checks['style']=value
            self.assertEqual(m.validate_review({'checks':checks,'reasons':['画风变化'],'status':'passed'})['status'],'rejected')
    def test_pass_still_pending_human(self):
        r=m.validate_review({'checks':dict.fromkeys(m.CHECKS,'pass'),'reasons':[]})
        self.assertEqual(r['status'],'passed');self.assertEqual(r['visualAcceptance'],'pending_human_review')
