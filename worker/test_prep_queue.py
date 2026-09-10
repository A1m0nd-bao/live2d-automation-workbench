import asyncio
import base64
import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch, AsyncMock

from fastapi import FastAPI, HTTPException
import httpx

spec = importlib.util.spec_from_file_location('prep_test', Path(__file__).parent / 'app/prep_queue.py')
prep = importlib.util.module_from_spec(spec)
spec.loader.exec_module(prep)
PNG = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9V8AAAAASUVORK5CYII=')
JOB = 'a' * 32


class PrepTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.keys = patch.dict('os.environ', {'AI_GATEWAY_API_KEY': 'test-key-not-real', 'MORPH_USE_KEYCHAIN': '0'})
        self.keys.start()
        self.addCleanup(self.keys.stop)
        def auth(relay, device):
            if device != 'test-device':
                raise HTTPException(401, 'unauthorized')
        self.queue = prep.PrepQueue(Path(self.directory.name), auth)
        self.queue.init()
        self.app = FastAPI()
        self.app.include_router(self.queue.router)

    def create(self):
        return self.queue.create(JOB, 'test', 'image2', PNG)

    async def test_persistent_idempotency_and_conflict(self):
        first = self.create()
        second = self.create()
        self.assertEqual(first, second)
        with self.assertRaises(HTTPException) as error:
            self.queue.create(JOB, 'other', 'image2', PNG + b'other')
        self.assertEqual(error.exception.status_code, 409)
        other = prep.PrepQueue(Path(self.directory.name), lambda *_: None)
        self.assertEqual(other.get(JOB)['status'], 'queued')

    async def test_disconnect_does_not_cancel_server_and_can_download(self):
        self.create()
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=self.app), base_url='http://test') as client:
            response = await client.get('/prep/jobs/' + JOB, headers={'X-Morph-Device-Token': 'test-device'})
            self.assertEqual(response.json()['status'], 'queued')
        # No HTTP client remains connected while the scheduler executes.
        with patch.object(self.queue, 'generate', new=AsyncMock(return_value=PNG)) as generate:
            await self.queue.run(JOB)
            await self.queue.run(JOB)
            self.assertEqual(generate.await_count, 1)
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=self.app), base_url='http://test') as client:
            response = await client.get('/prep/jobs/' + JOB + '/output', headers={'X-Morph-Device-Token': 'test-device'})
            self.assertEqual(response.content, PNG)

    async def test_queued_recovers_but_running_not_replayed(self):
        self.create()
        self.queue.update(JOB, status='running')
        with patch.object(self.queue, 'generate', new=AsyncMock(return_value=PNG)) as generate:
            await self.queue.start()
            await asyncio.sleep(0)
            await self.queue.stop()
            generate.assert_not_awaited()
        self.assertEqual(self.queue.get(JOB)['status'], 'uncertain')
        self.queue.update(JOB, status='queued')
        with patch.object(self.queue, 'generate', new=AsyncMock(return_value=PNG)):
            await self.queue.start()
            for _ in range(20):
                if self.queue.get(JOB)['status'] == 'succeeded':
                    break
                await asyncio.sleep(.01)
            await self.queue.stop()
        self.assertEqual(self.queue.get(JOB)['status'], 'succeeded')

    async def test_saved_output_recovers_after_db_commit_interruption(self):
        self.create()
        self.queue.update(JOB, status='running')
        self.queue.persist(JOB, 'output', PNG)
        await self.queue.start()
        await self.queue.stop()
        self.assertEqual(self.queue.get(JOB)['status'], 'succeeded')

    async def test_timeout_does_not_retry_or_claim_success(self):
        self.create()
        with patch.object(self.queue, 'generate', new=AsyncMock(side_effect=httpx.ReadTimeout('private details'))) as generate:
            await self.queue.run(JOB)
            await self.queue.run(JOB)
            self.assertEqual(generate.await_count, 1)
        record = self.queue.get(JOB)
        self.assertEqual(record['status'], 'uncertain')
        self.assertNotIn('private details', record['message'])

    async def test_gateway_wire_format_and_image_saved_before_frontend_qa(self):
        self.create()
        calls = []
        def handler(request):
            import json
            body = json.loads(request.content)
            calls.append(body)
            self.assertEqual(str(request.url), 'https://ai-gateway.vercel.sh/v4/ai/image-model')
            self.assertEqual(request.headers['ai-model-id'], 'openai/gpt-image-2')
            self.assertEqual(base64.b64decode(body['files'][0]['data']), PNG)
            self.assertEqual(body['n'], 1)
            return httpx.Response(200, json={'images': [base64.b64encode(PNG).decode()]})
        client = httpx.AsyncClient
        with patch.object(prep.httpx, 'AsyncClient', side_effect=lambda **kw: client(transport=httpx.MockTransport(handler), **kw)):
            await self.queue.run(JOB)
        self.assertEqual(len(calls), 1)
        self.assertEqual(self.queue.get(JOB)['status'], 'succeeded')
        self.assertEqual((self.queue.root / JOB / 'output').read_bytes(), PNG)

    async def test_auth_input_validation_and_missing_key(self):
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=self.app), base_url='http://test') as client:
            for path in ['/prep/health', '/prep/jobs', '/prep/jobs/' + JOB, '/prep/jobs/' + JOB + '/output']:
                self.assertEqual((await client.get(path)).status_code, 401)
            headers = {'X-Morph-Device-Token': 'test-device'}
            response = await client.post('/prep/jobs', headers=headers, data={'job_id': JOB, 'provider': 'image2'}, files={'image': ('bad.png', b'html')})
            self.assertEqual(response.status_code, 415)
            with patch.dict('os.environ', {'AI_GATEWAY_API_KEY': ''}):
                response = await client.post('/prep/jobs', headers=headers, data={'job_id': JOB, 'provider': 'image2'}, files={'image': ('input.png', PNG)})
                self.assertEqual(response.status_code, 503)
                self.assertIn('AI_GATEWAY_API_KEY', response.json()['detail'])

    async def test_4xx_errors_are_terminal_and_do_not_leak_raw_bodies(self):
        self.create()
        client = httpx.AsyncClient
        with patch.object(prep.httpx, 'AsyncClient', side_effect=lambda **kw: client(transport=httpx.MockTransport(lambda _: httpx.Response(402, text='test-key-not-real')), **kw)):
            await self.queue.run(JOB)
        result = self.queue.get(JOB)
        self.assertEqual(result['status'], 'failed')
        self.assertIn('402', result['message'])
        self.assertNotIn('test-key-not-real', str(result))


if __name__ == '__main__':
    unittest.main()
