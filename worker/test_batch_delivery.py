import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest
import zipfile

from fastapi import FastAPI, HTTPException
import httpx

spec = importlib.util.spec_from_file_location('batch_delivery_test_queue', Path(__file__).parent/'app/batch_queue.py')
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
WAVE = 'action_02_wave_arms_only'


class FakePoses:
    def __init__(self, root):
        import asyncio
        self.root = root/'poses'
        self.root.mkdir()
        self.input_slot = asyncio.Semaphore(1)
        self.runs, self.calls, self.blocker = {}, [], None
    def service_blocker(self): return self.blocker
    def get(self, jid):
        if jid not in self.runs: raise HTTPException(404)
        return self.runs[jid]
    def create(self, jid, states, provider, data):
        if jid not in self.runs:
            self.calls.append((jid, states, provider, data))
            self.runs[jid] = {'id':jid, 'status':'running', 'message':'working'}
        return self.runs[jid]
    def ready(self, jid):
        self.runs[jid].update(status='ready', message='checked')
        directory = self.root/jid
        directory.mkdir()
        (directory/'merged.psd').write_bytes(b'8BPS-multi-state')
        (directory/'report.json').write_text(json.dumps({'sourceLayersUnchanged':True,'neutralPixelsUnchanged':True,
            'outputSha256':hashlib.sha256(b'8BPS-multi-state').hexdigest(),'requestedStates':[WAVE]}))


class BatchDeliveryTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.jobs, self.split_calls = {}, []
        self.poses = FakePoses(self.root)
        def auth(relay, device):
            if device != 'test': raise HTTPException(401)
        self.batch = module.BatchQueue(self.root, auth, lambda *args:self.split_calls.append(args), self.jobs.get, poses=self.poses)
        self.bid = 'a'*32
        data = b'\x89PNG\r\n\x1a\n' + bytes(32)
        self.batch.create(module.BatchInput(id=self.bid, settings=module.SplitSettings(friendly=False), items=[
            module.BatchItem(id=str(i)*32, name=f'character-{i}.png', sha256=hashlib.sha256(data).hexdigest()) for i in (1,2)]))
        for i in (1,2):
            self.batch.upload(self.bid, str(i)*32, data)
    def tearDown(self): self.tmp.cleanup()
    def base_ready(self, i):
        source = self.root/f'base-{i}.psd'; source.write_bytes(b'8BPS-base-'+str(i).encode())
        self.jobs[str(i)*32] = {'status':'succeeded', 'message':'base only', 'output_psd':str(source)}
    def plan(self, start=True): return self.batch.delivery.configure(self.bid,[WAVE],'image2',start)

    async def test_opt_in_and_paused_plans_do_not_submit(self):
        self.base_ready(1)
        await self.batch.delivery.advance()
        self.assertFalse(self.poses.calls)
        self.plan(False)
        await self.batch.delivery.advance()
        self.assertFalse(self.poses.calls)

    async def test_ready_bases_hand_off_serially_and_only_once(self):
        self.base_ready(1); self.base_ready(2); self.plan()
        await self.batch.delivery.advance(); await self.batch.delivery.advance()
        self.assertEqual(len(self.poses.calls),1)
        jid = self.poses.calls[0][0]
        self.assertEqual(self.poses.calls[0][1:3],([WAVE],'image2'))
        self.poses.ready(jid)
        await self.batch.delivery.advance()
        self.assertEqual(len(self.poses.calls),2)
        self.assertFalse(self.split_calls)
        self.poses.ready(self.poses.calls[1][0])
        await self.batch.delivery.advance()
        status=self.batch.read(self.bid)
        self.assertEqual(status['succeeded'],2)
        self.assertEqual(status['delivery']['ready'],2)
        self.assertEqual(status['delivery']['state'],'completed')

    async def test_not_ready_base_is_never_regenerated_or_submitted(self):
        self.plan(); await self.batch.delivery.advance()
        self.assertFalse(self.poses.calls); self.assertFalse(self.split_calls)

    async def test_global_provider_circuit_stops_new_children(self):
        self.base_ready(1); self.plan()
        self.poses.blocker={'status':402,'message':'HTTP 402'}
        await self.batch.delivery.advance()
        self.assertFalse(self.poses.calls)
        self.assertEqual(self.batch.read(self.bid)['delivery']['state'],'blocked')
        self.batch.delivery.control(self.bid,'start')
        self.assertIsNotNone(self.poses.blocker)

    async def test_failed_child_not_retried_and_stops_next_character(self):
        self.base_ready(1); self.base_ready(2); self.plan()
        await self.batch.delivery.advance()
        self.poses.runs[self.poses.calls[0][0]].update(status='needs_attention', message='bad anatomy')
        await self.batch.delivery.advance(); await self.batch.delivery.advance()
        self.assertEqual(len(self.poses.calls),1)
        self.assertEqual(self.batch.read(self.bid)['delivery']['ready'],0)

    async def test_crash_window_recovers_same_child_id(self):
        self.base_ready(1); self.plan()
        jid=hashlib.sha256(('batch-psd-poses-v1:'+self.bid+':'+'1'*32).encode()).hexdigest()[:32]
        with self.batch.db() as con:
            con.execute("INSERT INTO pose_delivery_items VALUES (?,?,?,'preparing','saved')",(self.bid,'1'*32,jid))
        await self.batch.delivery.advance(); await self.batch.delivery.advance()
        self.assertEqual(len(self.poses.calls),1)
        self.assertEqual(self.poses.calls[0][0],jid)

    async def test_configuration_is_immutable_and_idempotent(self):
        self.plan(False); self.plan(False)
        with self.assertRaises(HTTPException): self.batch.delivery.configure(self.bid,[WAVE],'doubao')
        with self.assertRaises(HTTPException): self.batch.delivery.configure(self.bid,['expression_02_soft_smile_face_controls'],'image2')
        with self.assertRaises(HTTPException): self.batch.delivery.configure(self.bid,[WAVE,WAVE],'image2')

    async def test_no_fallback_to_base_psd_in_multistate_archive(self):
        self.base_ready(1); self.plan()
        with self.assertRaises(HTTPException): self.batch.delivery.archive(self.bid)
        await self.batch.delivery.advance(); self.poses.ready(self.poses.calls[0][0])
        with zipfile.ZipFile(self.batch.delivery.archive(self.bid)) as archive:
            self.assertEqual(archive.read('multi-state/001-character-1.psd'),b'8BPS-multi-state')
            manifest=json.loads(archive.read('manifest.json'))
            self.assertTrue(manifest['partial']); self.assertEqual(manifest['delivered'],1)
            self.assertFalse(manifest['mouthModified'])

    async def test_api_auth_and_stage_specific_output(self):
        app=FastAPI(); app.include_router(self.batch.router)
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://test') as client:
            path=f'/batches/{self.bid}/delivery'
            self.assertEqual((await client.post(path,json={'states':[WAVE]})).status_code,401)
            headers={'X-Morph-Device-Token':'test'}
            response=await client.post(path,json={'states':[WAVE]},headers=headers)
            self.assertEqual(response.status_code,200)
            self.assertEqual(response.json()['state'],'paused')
            self.assertEqual((await client.get(path+'/output',headers=headers)).status_code,409)
            self.assertFalse(self.poses.calls)

    async def test_changed_multistate_output_is_not_deliverable(self):
        self.base_ready(1);self.plan();await self.batch.delivery.advance()
        jid=self.poses.calls[0][0];self.poses.ready(jid)
        (self.poses.root/jid/'merged.psd').write_bytes(b'8BPS-base-not-multi')
        with self.assertRaises(HTTPException):self.batch.delivery.archive(self.bid)

    async def test_recovery_mapping_deduplicates_same_base_without_changing_failed_original(self):
        self.base_ready(1)
        self.jobs['2'*32]={'status':'failed','message':'previous failure','output_psd':None}
        self.batch.delivery.configure(self.bid,[WAVE],'image2',True,{'2'*32:'1'*32})
        await self.batch.delivery.advance(); self.poses.ready(self.poses.calls[0][0])
        await self.batch.delivery.advance(); await self.batch.delivery.advance()
        self.assertEqual(len(self.poses.calls),1)
        snapshot=self.batch.read(self.bid)
        self.assertEqual(snapshot['failed'],1)
        self.assertEqual(snapshot['delivery']['ready'],2)
        self.assertEqual(snapshot['delivery']['resolved_base_count'],2)
        with self.assertRaises(HTTPException):
            self.batch.delivery.configure(self.bid,[WAVE],'image2',False,{'2'*32:'f'*32})

    async def test_real_layered_psd_reaches_checked_multistate_archive_without_network(self):
        from unittest.mock import patch
        from worker.test_psd_pose import module as pose_module, fixture, candidate, geometry
        class Prep:
            def __init__(self, root): self.root=root/'prep';self.root.mkdir();self.calls=[]
            def config(self, provider): return 'test-key','test-model'
            def persist(self,jid,name,data):
                folder=self.root/jid;folder.mkdir(exist_ok=True);(folder/name).write_bytes(data)
            async def generate(self,job,key): self.calls.append(job);return candidate()
        prep=Prep(self.root)
        queue=pose_module.PoseQueue(self.root,prep,lambda *_:None);queue.init()
        self.batch.delivery.poses=queue
        path=self.root/'real.psd'; original=fixture(path)
        self.jobs['1'*32]={'status':'succeeded','message':'base saved','output_psd':str(path)}
        self.batch.delivery.configure(self.bid,[WAVE,'action_05_thinking_arms_only'],'image2',True)
        await self.batch.delivery.advance()
        child=self.batch.read(self.bid)['delivery']['items'][0]
        async def reviewed(key,instruction,images,**kwargs):
            return {'checks':{k:'pass' for k in kwargs['checks']},'reasons':[],
                    'geometry':geometry(),'draw_slot':geometry()['draw_slot']}
        with patch.object(pose_module.pose,'vision',reviewed):
            run=queue.get(child['run_id']);await queue.advance(run);await queue.advance(run)
        self.assertEqual(run['status'],'ready',run)
        self.assertEqual(len(prep.calls),2)
        self.assertEqual(path.read_bytes(),original)
        self.assertFalse(self.split_calls)
        with zipfile.ZipFile(self.batch.delivery.archive(self.bid)) as archive:
            from psd_tools import PSDImage
            import io
            result=PSDImage.open(io.BytesIO(archive.read('multi-state/001-character-1.psd')))
            actions=[l for l in result if l.name.startswith('action_')]
            self.assertEqual(len(actions),2)
            self.assertTrue(all(not l.visible for l in actions))
            self.assertEqual(json.loads(archive.read('manifest.json'))['scope'],'multi-state-action-psds')


if __name__=='__main__': unittest.main()
