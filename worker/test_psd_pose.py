import asyncio
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import numpy as np
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from PIL import Image, ImageDraw
from psd_tools import PSDImage
from psd_tools.api.layers import PixelLayer

spec = importlib.util.spec_from_file_location('pose_queue_test', Path(__file__).parent/'app/pose_queue.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
pose = module.pose
WAVE = 'action_02_wave_arms_only'


def fixture(path):
    psd = PSDImage.new('RGBA', (200,300))
    body = Image.new('RGBA',psd.size)
    ImageDraw.Draw(body).rectangle((75,60,125,230),fill='#333333')
    PixelLayer.frompil(body,psd,'topwear')
    for name,x in [('handwear-r',55),('handwear-l',135)]:
        arm=Image.new('RGBA',psd.size)
        ImageDraw.Draw(arm).rectangle((x,60,x+10,150),fill='#dca090')
        PixelLayer.frompil(arm,psd,name)
    psd.save(path)
    return path.read_bytes()


def candidate():
    raw=Image.new('RGBA',(200,300))
    ImageDraw.Draw(raw).line([(60,65),(35,105),(25,65)],fill='#dca090',width=11)
    ImageDraw.Draw(raw).ellipse((18,45,32,70),fill='#dca090')
    return pose.png(raw)


def geometry():
    return {'shoulder':[.3,65/300],'elbow':[.175,.35],'wrist':[.125,65/300],
            'source_shoulder':[.3,65/300],'source_elbow':[.3,105/300],'source_wrist':[.3,145/300]}


class FakePrep:
    def __init__(self,root): self.root=root/'prep';self.root.mkdir();self.calls=[]
    def config(self,provider): return 'configured-test-key','test-model'
    def persist(self,jid,name,data):
        target=self.root/jid;target.mkdir(exist_ok=True);(target/name).write_bytes(data)
    async def generate(self,job,key):
        self.calls.append(job)
        return candidate()


class PoseTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory()
        self.root=Path(self.tmp.name)
        self.data=fixture(self.root/'source.psd')
        self.prep=FakePrep(self.root)
        self.queue=module.PoseQueue(self.root,self.prep,self.auth)
        self.queue.init()
    def tearDown(self): self.tmp.cleanup()
    @staticmethod
    def auth(relay,device):
        if device!='test': raise HTTPException(401,'Unauthorized')
    def create(self,states=None): return self.queue.create('a'*32,states or [WAVE],'image2',self.data)
    async def vision(self,key,instruction,images):
        checks=pose.PART_CHECKS if len(images)==3 else pose.PREVIEW_CHECKS
        return {'checks':{x:'pass' for x in checks},'reasons':[],'geometry':geometry()}

    async def test_full_flow_without_splitting_preserves_layers_pixels_alpha(self):
        run=self.create()
        with patch.object(pose,'vision',self.vision): await self.queue.advance(run)
        self.assertEqual(run['status'],'ready',run)
        self.assertEqual(len(self.prep.calls),1)
        self.assertEqual(self.prep.calls[0]['_options']['openai']['background'],'transparent')
        before=PSDImage.open(io.BytesIO(self.data))
        after=PSDImage.open(self.queue.root/run['id']/'merged.psd')
        self.assertEqual(pose.signature(list(before)),pose.signature(list(after)[:3]))
        self.assertTrue(np.array_equal(np.asarray(before.composite(force=True)),np.asarray(after.composite(force=True))))
        group=list(after)[-1]
        self.assertEqual(group.name,WAVE)
        self.assertFalse(group.visible)
        base=list(before)[-1];copied=list(group)[-1]
        self.assertEqual(base.bbox,copied.bbox)
        self.assertEqual([x.data for x in base._channels],[x.data for x in copied._channels])
        self.assertEqual(len(after._record.image_data.get_data(after._record.header)),4)
        group.visible=True
        for layer in after:
            if layer.name in ('handwear-l','handwear-r'): layer.visible=False
        preview=Image.open(self.queue.root/run['id']/run['states'][0]['generation_id']/'preview.png').convert('RGBA')
        self.assertTrue(np.array_equal(np.asarray(preview),np.asarray(after.composite(force=True).convert('RGBA'))))
        self.assertEqual((self.queue.root/run['id']/'source.psd').read_bytes(),self.data)
        # Reopening/recovering a ready run does not start a second generation.
        self.assertEqual(self.create()['status'],'ready')
        self.assertEqual(len(self.prep.calls),1)

    async def test_rejected_actual_preview_blocks_export(self):
        async def rejected(key,instruction,images):
            result=await self.vision(key,instruction,images)
            if len(images)!=3:
                result['checks']['no_duplicate_limbs']='fail';result['reasons']=['躯干层有残留旧袖']
            return result
        run=self.create()
        with patch.object(pose,'vision',rejected): await self.queue.advance(run)
        self.assertEqual(run['status'],'needs_attention')
        self.assertEqual(run['states'][0]['status'],'needs-review')
        self.assertFalse((self.queue.root/run['id']/'merged.psd').exists())
        old=run['states'][0]['generation_id']
        resumed=self.queue.retry(run['id'],WAVE,True)
        self.assertEqual(resumed['states'][0]['generation_id'],old)
        with patch.object(pose,'vision',self.vision): await self.queue.advance(resumed)
        self.assertEqual(len(self.prep.calls),1)

    async def test_restart_unknown_does_not_replay(self):
        run=self.create();run['states'][0]['status']='generating';self.queue.save(run)
        await self.queue.start()
        try:
            await asyncio.sleep(.01)
            saved=self.queue.get(run['id'])
            self.assertEqual(saved['states'][0]['status'],'uncertain')
            self.assertFalse(self.prep.calls)
        finally: await self.queue.stop()

    async def test_restart_saved_candidate_reuses_it(self):
        run=self.create();s=run['states'][0];s['status']='generating';self.queue.save(run)
        directory=self.queue.root/run['id']/s['generation_id'];directory.mkdir();(directory/'candidate.png').write_bytes(candidate())
        with patch.object(pose,'vision',self.vision):
            await self.queue.start()
            try:
                for _ in range(30):
                    if self.queue.get(run['id'])['status']=='ready': break
                    await asyncio.sleep(.03)
                self.assertEqual(self.queue.get(run['id'])['status'],'ready')
                self.assertFalse(self.prep.calls)
            finally: await self.queue.stop()

    async def test_uncertain_transport_and_explicit_retry(self):
        async def failed(job,key): raise httpx.ReadTimeout('test')
        import httpx
        run=self.create();old=run['states'][0]['generation_id']
        with patch.object(self.prep,'generate',failed): await self.queue.advance(run)
        self.assertEqual(run['states'][0]['status'],'uncertain')
        retry=self.queue.retry(run['id'],WAVE)
        self.assertNotEqual(retry['states'][0]['generation_id'],old)

    def test_api_auth_idempotence_and_validation(self):
        app=FastAPI();app.include_router(self.queue.router)
        with TestClient(app) as client:
            body={'job_id':'a'*32,'states':json.dumps([WAVE]),'provider':'image2'}
            self.assertEqual(client.post('/pro/pose-jobs',data=body,files={'psd':('source.psd',self.data)}).status_code,401)
            kwargs={'data':body,'files':{'psd':('source.psd',self.data)},'headers':{'X-Morph-Device-Token':'test'}}
            self.assertEqual(client.post('/pro/pose-jobs',**kwargs).status_code,202)
            self.assertEqual(client.post('/pro/pose-jobs',**kwargs).status_code,202)
            body['states']=json.dumps(['action_03_hand_on_hip_arms_only'])
            self.assertEqual(client.post('/pro/pose-jobs',**kwargs).status_code,409)
            self.assertEqual(client.get('/pro/pose-jobs/'+'a'*32+'/output',headers=kwargs['headers']).status_code,409)
        with self.assertRaises(HTTPException): self.queue.create('b'*32,['expression_02_soft_smile_face_controls'],'image2',self.data)

    def test_missing_names_and_bad_geometry_block(self):
        psd=PSDImage.open(io.BytesIO(self.data));psd[1].name='arm-left';psd.save(self.root/'bad.psd')
        with self.assertRaises(ValueError): pose.inspect(self.root/'bad.psd',self.root)
        with self.assertRaises(ValueError): pose.candidate_image(pose.png(Image.new('RGB',(200,300),'white')))
        info=pose.inspect(self.root/'source.psd',self.root)
        invalid=geometry();invalid['elbow']=[float('nan'),0]
        with self.assertRaises(ValueError): pose.assemble(self.root/'source.psd',self.root,WAVE,candidate(),invalid,info)


if __name__=='__main__': unittest.main()
