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

    async def test_failed_item_does_not_reenter_queue(self):
        self.ready()
        self.jobs['1'*32] = dict(status='failed', message='done', error='failure')
        await self.queue.advance()
        self.assertEqual(self.calls[0][0], '2'*32)


if __name__ == '__main__':
    unittest.main()
