import asyncio
import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest
import zipfile

import httpx
from fastapi import FastAPI, HTTPException

spec = importlib.util.spec_from_file_location('batch_queue_test', Path(__file__).parent / 'app/batch_queue.py')
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)

IMAGE = b'\x89PNG\r\n\x1a\n' + bytes(32)


class BatchTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.jobs = {}
        self.calls = []
        def auth(relay, device):
            if device != 'test-device':
                raise HTTPException(401, 'unauthorized')
        def create(job_id, source, name, settings):
            self.calls.append((job_id, source.read_bytes(), settings))
            self.jobs[job_id] = dict(status='running', message='processing', error=None, output_psd=None)
        self.queue = module.BatchQueue(Path(self.temp.name), auth, create, self.jobs.get)
        self.data = module.BatchInput(id='b'*32, settings=module.SplitSettings(friendly=False), items=[module.BatchItem(id=str(i)*32, name='same.png', sha256=hashlib.sha256(IMAGE).hexdigest()) for i in (1, 2, 3)])

    def tearDown(self):
        self.temp.cleanup()

    def ready(self):
        self.queue.create(self.data)
        for item in self.data.items:
            self.queue.upload(self.data.id, item.id, IMAGE)
        self.queue.control(self.data.id, 'start')

    async def test_serial_failure_skip_pause_and_restart(self):
        self.ready()
        await self.queue.advance()
        await self.queue.advance()
        self.assertEqual(len(self.calls), 1)
        self.assertEqual(self.calls[0][2], dict(resolution=1024, seed=42, split_limbs=True))
        self.queue.control(self.data.id, 'pause')
        self.jobs['1'*32]['status'] = 'failed'
        await self.queue.advance()
        self.assertEqual(len(self.calls), 1)
        self.queue.control(self.data.id, 'start')
        restarted = module.BatchQueue(Path(self.temp.name), self.queue.authorize, self.queue.split_create, self.jobs.get)
        await restarted.advance()
        await restarted.advance()
        self.assertEqual([call[0] for call in self.calls], ['1'*32, '2'*32])
        self.assertEqual(restarted.read(self.data.id)['failed'], 1)

    async def test_backup_route_is_saved_and_passed_to_serial_splitter(self):
        self.data.settings.upstream_route='yangzxo'
        self.ready()
        await self.queue.advance()
        self.assertEqual(self.calls[0][2]['upstream_route'],'yangzxo')
        self.assertEqual(self.queue.read(self.data.id)['settings']['upstream_route'],'yangzxo')

    async def test_switch_route_only_before_split_and_never_starts_or_reuploads(self):
        self.ready()
        with self.assertRaises(HTTPException):
            self.queue.change_route(self.data.id, 'yangzxo')
        self.queue.control(self.data.id, 'pause')
        changed = self.queue.change_route(self.data.id, 'yangzxo')
        self.assertEqual(changed['state'], 'paused')
        self.assertEqual(changed['settings']['upstream_route'], 'yangzxo')
        self.assertTrue(all(item['uploaded'] for item in changed['items']))
        self.assertEqual(self.calls, [])
        with self.queue.db() as con:
            self.assertEqual(con.execute('SELECT before_route,after_route FROM route_changes').fetchone()[:], ('default', 'yangzxo'))
        self.queue.control(self.data.id, 'start')
        await self.queue.advance()
        self.assertEqual(self.calls[0][2]['upstream_route'], 'yangzxo')
        self.queue.control(self.data.id, 'pause')
        with self.assertRaises(HTTPException):
            self.queue.change_route(self.data.id, 'default')

    async def test_manifest_and_upload_are_idempotent(self):
        self.queue.create(self.data)
        self.queue.create(self.data)
        self.queue.upload(self.data.id, '1'*32, IMAGE)
        self.queue.upload(self.data.id, '1'*32, IMAGE)
        with self.assertRaises(HTTPException) as caught:
            self.queue.upload(self.data.id, '1'*32, IMAGE + b'changed')
        self.assertEqual(caught.exception.status_code, 409)
        with self.assertRaises(HTTPException):
            self.queue.control(self.data.id, 'start')
        changed = self.data.model_copy(update={'name': 'conflicting'})
        with self.assertRaises(HTTPException) as caught:
            self.queue.create(changed)
        self.assertEqual(caught.exception.status_code, 409)

    async def test_zip_has_all_successful_files_and_failed_manifest(self):
        self.ready()
        out = Path(self.temp.name) / 'model.psd'
        out.write_bytes(b'8BPS\x00\x01' + bytes(32))
        for i in (1, 2):
            self.jobs[str(i)*32] = dict(status='succeeded', message='done', error=None, output_psd=str(out))
        self.jobs['3'*32] = dict(status='failed', message='bad input', error='failure', output_psd=None)
        with zipfile.ZipFile(self.queue.archive(self.data.id)) as archive:
            self.assertEqual(archive.namelist(), ['001-same.psd', '002-same.psd', 'manifest.json'])
            self.assertIsNone(archive.testzip())
            manifest = json.loads(archive.read('manifest.json'))
            self.assertEqual(manifest['failed'], 1)
            self.assertEqual(manifest['state'], 'completed')

    async def test_api_auth_and_stable_uploads(self):
        app = FastAPI()
        app.include_router(self.queue.router)
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test') as client:
            self.assertEqual((await client.get('/batches')).status_code, 401)
            headers = {'X-Morph-Device-Token': 'test-device'}
            self.assertEqual((await client.post('/batches', json=self.data.model_dump(), headers=headers)).status_code, 200)
            self.assertEqual((await client.put('/batches/' + self.data.id + '/items/' + '1'*32, content=IMAGE, headers=headers)).status_code, 200)
            self.assertEqual((await client.get('/batches', headers=headers)).json()[0]['items'][0]['uploaded'], True)

    async def test_route_api_auth_validation_and_no_implicit_start(self):
        self.queue.create(self.data)
        app = FastAPI()
        app.include_router(self.queue.router)
        path = f'/batches/{self.data.id}/route'
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test') as client:
            self.assertEqual((await client.post(path, json={'upstream_route':'yangzxo'})).status_code, 401)
            headers = {'X-Morph-Device-Token':'test-device'}
            self.assertEqual((await client.post(path, json={'upstream_route':'untrusted'}, headers=headers)).status_code, 422)
            response = await client.post(path, json={'upstream_route':'yangzxo'}, headers=headers)
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.json()['state'], 'uploading')
            self.assertEqual(response.json()['settings']['upstream_route'], 'yangzxo')
            self.assertEqual(self.calls, [])

    async def test_policy_api_requires_auth_paused_batch_and_valid_policy(self):
        self.queue.create(self.data)
        app = FastAPI()
        app.include_router(self.queue.router)
        path = f'/batches/{self.data.id}/policy'
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test') as client:
            self.assertEqual((await client.post(path, json={'on_confirmed_failure':'skip'})).status_code, 401)
            headers = {'X-Morph-Device-Token':'test-device'}
            self.assertEqual((await client.post(path, json={'on_confirmed_failure':'skip'}, headers=headers)).status_code, 409)
            self.queue.control(self.data.id, 'pause')
            self.assertEqual((await client.post(path, json={'on_confirmed_failure':'ignore'}, headers=headers)).status_code, 422)
            response = await client.post(path, json={'on_confirmed_failure':'skip'}, headers=headers)
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.json()['state'], 'paused')
            self.assertEqual(response.json()['on_confirmed_failure'], 'skip')
            self.assertEqual(self.calls, [])

    async def test_failed_item_does_not_reenter_queue(self):
        self.ready()
        self.jobs['1'*32] = dict(status='failed', message='done', error='failure')
        await self.queue.advance()
        self.assertEqual(self.calls[0][0], '2'*32)


if __name__ == '__main__':
    unittest.main()
