"""Exercise the real writer and graph merge on a fresh, character-free fixture."""
import importlib.util,json,math,subprocess,sys,tempfile,unittest
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'scripts/pro-rig'))
import archive
spec=importlib.util.spec_from_file_location('pro_integrate',ROOT/'scripts/pro-rig/integrate.py')
mod=importlib.util.module_from_spec(spec);spec.loader.exec_module(mod)
class ProRigGraphTests(unittest.TestCase):
 @classmethod
 def setUpClass(cls):
  cls.temp=tempfile.TemporaryDirectory();cls.root=Path(cls.temp.name)
  subprocess.run(['node',str(ROOT/'tests/fixtures/pro-rig.mjs'),str(cls.root/'base.cmo3')],check=True,capture_output=True)
  subprocess.run(['node',str(ROOT/'scripts/pro-rig/build-mouth.mjs'),str(cls.root/'donor')],check=True,capture_output=True)
 @classmethod
 def tearDownClass(cls):cls.temp.cleanup()
 def altered(self,name,edit):
  h,k,e,r=archive.archive(self.root/'base.cmo3');edit(r)
  p=self.root/(name+'.cmo3');p.write_bytes(archive.repack(h,k,e,r));return p
 def build(self,p,out):mod.build('pro',p,self.root/'donor',self.root/out)
 def test_merge_keeps_head_and_eyes_and_embeds_mouth(self):
  self.build(self.root/'base.cmo3','ok.cmo3')
  before=archive.archive(self.root/'base.cmo3')[3];after=archive.archive(self.root/'ok.cmo3')[3]
  def warps(r):return {archive.name(e):[archive.deep(f,'positions').text for f in archive.field(e,'keyforms')] for e in r.find('shared') if e.tag=='CWarpDeformerSource'}
  a,b=warps(before),warps(after)
  self.assertEqual(len(a['FaceParallax']),9)
  for key in a:
   if key!='mouth Warp':self.assertEqual(a[key],b[key],key)
  new=[e for e in after.find('shared') if e.tag=='CArtMeshSource' and archive.name(e).startswith('native.mouth.')]
  self.assertEqual(len(new),4)
  for e in new:self.assertEqual(len(archive.field(e,'keyforms')),12)
 def test_combined_mouth_nose_is_rejected(self):
  def edit(r):
   e=next(e for e in r.find('shared') if e.tag=='CArtMeshSource' and archive.name(e)=='mouth');archive.deep(e,'localName').text='mouth_nose'
  p=self.altered('combined',edit)
  with self.assertRaisesRegex(ValueError,'独立 mouth'):self.build(p,'bad.cmo3')
 def test_empty_nine_grid_is_rejected(self):
  def edit(r):
   e=next(e for e in r.find('shared') if e.tag=='CWarpDeformerSource' and archive.name(e)=='FaceParallax');fs=archive.field(e,'keyforms');rest=archive.deep(fs[4],'positions').text
   for f in fs:archive.deep(f,'positions').text=rest
  p=self.altered('empty',edit)
  with self.assertRaisesRegex(ValueError,'全部相同'):self.build(p,'empty-out.cmo3')
 def test_mouth_orientation_follows_authored_corners(self):
  slope=.2
  self.build(self.root/'base.cmo3','flat-out.cmo3')
  baseline=json.loads((self.root/'flat-out.integration.json').read_text())['mouthPlacement']['rotationDegrees']
  def edit(r):
   mouth=next(e for e in r.find('shared') if e.tag=='CArtMeshSource' and archive.name(e)=='mouth')
   form=archive.field(mouth,'keyforms')[0];p=list(map(float,archive.deep(form,'positions').text.split()))
   for i in range(0,len(p),2):p[i+1]+=slope*(p[i]-250)
   archive.deep(form,'positions').text=' '.join(map(str,p))
  source=self.altered('sloped-mouth',edit);self.build(source,'sloped-out.cmo3')
  report=json.loads((self.root/'sloped-out.integration.json').read_text())
  self.assertGreater(report['mouthPlacement']['rotationDegrees'],baseline+1)
if __name__=='__main__':unittest.main()
