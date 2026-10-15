import asyncio
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch, AsyncMock

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
    for name,box in [('neck',(90,45,110,70)),('face',(80,10,120,50))]:
        part=Image.new('RGBA',psd.size)
        ImageDraw.Draw(part).rectangle(box,fill='#dca090')
        PixelLayer.frompil(part,psd,name)
    psd.save(path)
    return path.read_bytes()


def candidate():
    raw=Image.new('RGBA',(200,300))
    ImageDraw.Draw(raw).line([(60,65),(35,105),(25,65)],fill='#dca090',width=11)
    ImageDraw.Draw(raw).ellipse((18,45,32,70),fill='#dca090')
    return pose.png(raw)


def geometry():
    return {'shoulder':[.3,65/300],'elbow':[.175,.35],'wrist':[.125,65/300],
            'source_shoulder':[.3,65/300],'source_elbow':[.3,105/300],'source_wrist':[.3,145/300],
            'draw_slot': {'after': 'handwear-l', 'before': None}}


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
    async def vision(self,key,instruction,images,**kwargs):
        checks=pose.PART_CHECKS if len(images)==3 else pose.PREVIEW_CHECKS
        return {'checks':{x:'pass' for x in checks},'reasons':[],'geometry':geometry(), 'draw_slot': geometry()['draw_slot']}

    async def test_full_flow_without_splitting_preserves_layers_pixels_alpha(self):
        run=self.create()
        with patch.object(pose,'vision',self.vision): await self.queue.advance(run)
        self.assertEqual(run['status'],'ready',run)
        self.assertEqual(len(self.prep.calls),1)
        self.assertNotIn('openai', self.prep.calls[0]['_options'])
        prompt=(self.prep.root/run['states'][0]['generation_id']/'prompt.txt').read_text()
        self.assertIn('uniform flat neutral gray',prompt)
        self.assertNotIn('Output actual RGBA transparency',prompt)
        settings=json.loads((self.prep.root/run['states'][0]['generation_id']/'request-settings.json').read_text())
        self.assertEqual(settings['background_strategy'],'local_cutout')
        before=PSDImage.open(io.BytesIO(self.data))
        after=PSDImage.open(self.queue.root/run['id']/'merged.psd')
        self.assertEqual(pose.signature(list(before)),pose.signature([l for l in after if l.name!=WAVE]))
        self.assertTrue(np.array_equal(np.asarray(before.composite(force=True)),np.asarray(after.composite(force=True))))
        group=next(l for l in after if l.name==WAVE)
        self.assertEqual(group.name,WAVE)
        self.assertFalse(group.visible)
        base=next(l for l in before if l.name=='handwear-l');copied=list(group)[-1]
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
        async def rejected(key,instruction,images,**kwargs):
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

    async def test_opaque_part_is_cut_out_locally_then_reviewed_and_exported(self):
        async def opaque(job,key):
            self.prep.calls.append(job)
            arm=Image.open(io.BytesIO(candidate())).convert('RGBA')
            return pose.png(Image.alpha_composite(Image.new('RGBA',arm.size,'#d0d0d0'),arm).convert('RGB'))
        async def cutout(*args,**kwargs):
            self.assertTrue(args[1].endswith('foreground.py'))
            self.assertEqual(args[-2:],('--padding-ratio','0'))
            target=Path(args[3]);target.mkdir()
            (target/'foreground.png').write_bytes(candidate())
            process=AsyncMock();process.returncode=0
            return process
        async def checked(key,instruction,images,**kwargs):
            if len(images)==3:
                self.assertIn('A',Image.open(io.BytesIO(images[-1])).getbands())
            return await self.vision(key,instruction,images)
        run=self.create()
        with patch.object(self.prep,'generate',opaque), patch.object(module.asyncio,'create_subprocess_exec',cutout), patch.object(pose,'vision',checked):
            await self.queue.advance(run)
            await self.queue.advance(run)
        self.assertEqual(run['status'],'ready',run)
        self.assertEqual(len(self.prep.calls),1)

    async def test_provider_rejection_keeps_diagnostics_and_never_retries(self):
        async def rejected(job,key):
            self.prep.calls.append(job)
            job['_update'](status='failed',message='HTTP 400；上游指出需检查：背景设置；未自动重试。')
            return None
        run=self.create()
        with patch.object(self.prep,'generate',rejected):
            await self.queue.advance(run)
            await self.queue.advance(run)
        self.assertEqual(run['status'],'needs_attention')
        self.assertIn('背景设置',run['states'][0]['message'])
        self.assertEqual(len(self.prep.calls),1)
        self.assertFalse((self.queue.root/run['id']/'merged.psd').exists())

    async def test_402_stops_other_characters_and_remaining_states(self):
        async def rejected(job,key):
            self.prep.calls.append(job)
            job['_update'](status='failed',message='HTTP 402；未自动重试')
            return None
        first = self.create([WAVE,'action_05_thinking_arms_only'])
        second = self.queue.create('b'*32,[WAVE],'image2',self.data)
        with patch.object(self.prep,'generate',rejected):
            await self.queue.advance(first)
            await self.queue.advance(first)
            await self.queue.advance(second)
        self.assertEqual(len(self.prep.calls),1)
        self.assertEqual(self.queue.service_blocker()['status'],402)
        self.assertEqual(first['states'][1]['status'],'queued')
        self.queue.resume_service()
        self.assertEqual(self.queue.get(first['id'])['states'][0]['status'],'failed')
        self.assertEqual(len(self.prep.calls),1)

    async def test_thinking_exports_independent_arms_and_stored_alpha(self):
        run=self.create(['action_05_thinking_arms_only'])
        with patch.object(pose,'vision',self.vision): await self.queue.advance(run)
        self.assertEqual(run['status'],'ready',run)
        path=self.queue.root/run['id']/'merged.psd'
        check=PSDImage.open(path)
        group=next(layer for layer in check if layer.name=='action_05_thinking_arms_only')
        self.assertEqual([part.name for part in group], [group.name+'__handwear-r',group.name+'__handwear-l'])
        pose.gates.validate_merged_preview(check,check.composite(force=True).convert('RGBA'))

    def test_missing_draw_slot_stops_export(self):
        info=pose.inspect(self.root/'source.psd',self.root)
        points=geometry();points.pop('draw_slot')
        with self.assertRaisesRegex(ValueError,'draw slot'):
            pose.assemble(self.root/'source.psd',self.root/'no-slot',WAVE,candidate(),points,info)

    async def test_visual_review_requires_strict_schema_and_rejects_refusal(self):
        import httpx
        calls=[]
        def handler(request):
            body=json.loads(request.content);calls.append(body)
            schema=body['response_format']['json_schema']
            self.assertTrue(schema['strict'])
            self.assertEqual(set(schema['schema']['properties']['checks']['required']),set(pose.PART_CHECKS))
            return httpx.Response(200,json={'choices':[{'finish_reason':'stop','message':{'refusal':'private text'}}]})
        client=httpx.AsyncClient
        with patch.object(pose,'getproxies',return_value={}), patch.object(pose.httpx,'AsyncClient',side_effect=lambda **kw:client(transport=httpx.MockTransport(handler),**kw)):
            with self.assertRaisesRegex(RuntimeError,'拒绝'):
                await pose.vision('test','test',[candidate()],checks=pose.PART_CHECKS,geometry_fields=('shoulder',))
        self.assertEqual(len(calls),1)
        with self.assertRaises(ValueError): pose.validate_checks({'checks':{x:'pass' for x in pose.PART_CHECKS[:-1]},'reasons':[]},pose.PART_CHECKS)

    async def test_only_explicit_retry_uses_saved_visual_feedback(self):
        async def rejected(key,instruction,images,**kwargs):
            result=await self.vision(key,instruction,images)
            result['checks']['anatomy']='fail';result['reasons']=['手掌过大']
            return result
        run=self.create()
        with patch.object(pose,'vision',rejected): await self.queue.advance(run)
        self.assertEqual(len(self.prep.calls),1)
        retry=self.queue.retry(run['id'],WAVE)
        self.assertEqual(retry['states'][0]['correction_reasons'],['手掌过大'])
        with patch.object(pose,'vision',self.vision): await self.queue.advance(retry)
        self.assertEqual(len(self.prep.calls),2)
        prompt=(self.prep.root/retry['states'][0]['generation_id']/'prompt.txt').read_text()
        self.assertIn('手掌过大',prompt)
        self.assertIn('explicitly requested correction',prompt)

    def test_mirrored_wave_is_corrected_without_swapping_semantic_arm(self):
        info=pose.inspect(self.root/'source.psd',self.root)
        canonical=pose.assemble(self.root/'source.psd',self.root/'canonical',WAVE,candidate(),geometry(),info)
        raw=Image.open(io.BytesIO(candidate()))
        mirrored=raw.transpose(Image.Transpose.FLIP_LEFT_RIGHT)
        points=geometry()
        for name in ('shoulder','elbow','wrist'):
            points[name][0]=(raw.width-1)/raw.width-points[name][0]
        report=pose.assemble(self.root/'source.psd',self.root/'mirrored',WAVE,pose.png(mirrored),points,info)
        self.assertTrue(report['orientationCorrected'])
        self.assertFalse(canonical['orientationCorrected'])
        self.assertEqual(canonical['scale'],report['scale'])
        self.assertTrue(np.array_equal(np.asarray(Image.open(self.root/'canonical/replacement.png')),np.asarray(Image.open(self.root/'mirrored/replacement.png'))))

    async def test_alignment_does_not_convert_rejected_normalized_part_into_success(self):
        async def reject_aligned(key,instruction,images,**kwargs):
            result=await self.vision(key,instruction,images)
            if len(images)==3 and not kwargs.get('geometry_fields'):
                self.assertEqual(Image.open(io.BytesIO(images[1])).size,Image.open(io.BytesIO(images[2])).size)
                result['checks']['anatomy']='fail';result['reasons']=['对齐后仍不合格']
            return result
        run=self.create()
        with patch.object(pose,'vision',reject_aligned): await self.queue.advance(run)
        self.assertEqual(run['status'],'needs_attention')
        self.assertIn('对齐后仍不合格',run['states'][0]['message'])
        self.assertFalse((self.queue.root/run['id']/'merged.psd').exists())

    async def test_select_saved_first_candidate_never_regenerates(self):
        run=self.create()
        with patch.object(pose,'vision',self.vision): await self.queue.advance(run)
        state=run['states'][0];first=state['generation_id']
        run['status']='needs_attention';state['status']='needs-review';self.queue.save(run)
        retry=self.queue.retry(run['id'],WAVE)
        retry['status']='needs_attention';retry['states'][0]['status']='failed';self.queue.save(retry)
        selected=self.queue.select_candidate(run['id'],WAVE,first)
        with patch.object(pose,'vision',self.vision): await self.queue.advance(selected)
        self.assertEqual(selected['status'],'ready')
        self.assertEqual(selected['states'][0]['generation_id'],first)
        self.assertEqual(len(self.prep.calls),1)
        selected['status']='needs_attention';self.queue.save(selected)
        with self.assertRaises(HTTPException): self.queue.select_candidate(run['id'],WAVE,'b'*32)

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
            self.assertEqual(client.post('/pro/pose-jobs/provider/resume').status_code,401)
            body={'job_id':'a'*32,'states':json.dumps([WAVE]),'provider':'image2'}
            self.assertEqual(client.post('/pro/pose-jobs',data=body,files={'psd':('source.psd',self.data)}).status_code,401)
            self.assertEqual(client.post('/pro/pose-jobs/'+'a'*32+'/states/'+WAVE+'/select/'+'b'*32).status_code,401)
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
