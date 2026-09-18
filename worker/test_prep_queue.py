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
        self.proxy_lookup = patch.object(prep, 'getproxies', return_value={})
        self.proxy_lookup.start()
        self.addCleanup(self.proxy_lookup.stop)
        def auth(relay, device):
            if device != 'test-device':
                raise HTTPException(401, 'unauthorized')
        self.queue = prep.PrepQueue(Path(self.directory.name), auth)
        self.queue.init()
        self.review_mock = patch.object(prep, 'review', new=AsyncMock(return_value={'version': prep.VERSION, 'status': 'passed', 'reasons': []})).start()
        self.addCleanup(patch.stopall)
        self.app = FastAPI()
        self.app.include_router(self.queue.router)

    def create(self):
        return self.queue.create(JOB, 'test', 'image2', PNG)

    async def test_providers_snapshot_independent_prompts(self):
        with patch.object(self.queue, 'config', return_value=('test-key-not-real', 'test-model')):
            for provider, job_id in [('doubao', 'd' * 32), ('image2', 'e' * 32)]:
                self.queue.create(job_id, 'style-check', provider, PNG)
                saved = (self.queue.root / job_id / 'prompt.txt').read_text()
                self.assertEqual(saved, prep.neutral_prompt())
                self.assertIn('80%', saved)
                self.assertIn('三维渲染', saved)
                with patch.dict(prep.PROMPTS, {provider: 'future prompt'}):
                    self.queue.create(job_id, 'same-job', provider, PNG)
                    self.assertEqual((self.queue.root / job_id / 'prompt.txt').read_text(), saved)


    async def test_failed_quality_retries_once_then_stops(self):
        self.create()
        self.review_mock.return_value = {'version': prep.VERSION, 'status':'rejected', 'reasons':['脚被截断']}
        with patch.object(self.queue, 'generate', new=AsyncMock(return_value=PNG)) as generate:
            await self.queue.run(JOB)
            self.assertEqual(generate.await_count, 2)
        self.assertEqual(self.queue.get(JOB)['status'], 'needs-review')
        self.assertTrue((self.queue.root / JOB / 'candidate-1').exists())
        self.assertTrue((self.queue.root / JOB / 'candidate-2').exists())
        self.assertEqual((self.queue.root / JOB / 'source').read_bytes(), PNG)

    async def test_review_unavailable_does_not_regenerate_or_pass(self):
        self.create()
        self.review_mock.side_effect = RuntimeError('Review unavailable')
        with patch.object(self.queue, 'generate', new=AsyncMock(return_value=PNG)) as generate:
            await self.queue.run(JOB)
            self.assertEqual(generate.await_count, 1)
        self.assertEqual(self.queue.get(JOB)['status'], 'needs-review')

    async def test_legacy_review_is_not_current_acceptance(self):
        self.create()
        self.queue.persist(JOB, 'quality.json', b'{"version":"image-quality-v1","status":"passed"}')
        self.assertEqual(self.queue.get(JOB)['quality']['status'], 'outdated')

    async def test_canvas_cleanup_cannot_hide_semantic_failures(self):
        self.create()
        for failed in ('full_body', 'identity', 'outfit', 'style', 'anatomy', 'pose'):
            checks = dict.fromkeys(prep._quality.CHECKS, 'pass')
            checks.update({failed: 'fail', 'frame_margin': 'fail'})
            result = {'status': 'rejected', 'checks': checks}
            with patch.object(prep.asyncio, 'create_subprocess_exec', new=AsyncMock()) as launch:
                self.assertEqual(await self.queue.normalize_candidate(JOB, result, 1), result)
                launch.assert_not_awaited()

    async def test_background_cleanup_preserves_canvas_and_rechecks(self):
        self.create()
        self.queue.persist(JOB, 'output', PNG)
        target = self.queue.root / JOB / 'normalized-1'
        target.mkdir()
        (target / 'submission.png').write_bytes(PNG)
        from types import SimpleNamespace
        process = SimpleNamespace(returncode=0, wait=AsyncMock(return_value=0))
        checks = dict.fromkeys(prep._quality.CHECKS, 'pass')
        checks['background'] = 'fail'
        with patch.object(prep.asyncio, 'create_subprocess_exec', new=AsyncMock(return_value=process)) as launch:
            result = await self.queue.normalize_candidate(JOB, {'status':'rejected','checks':checks}, 1)
            self.assertEqual(launch.call_args.args[-2:], ('--padding-ratio', '0'))
        self.assertEqual(result['status'], 'passed')
        self.review_mock.assert_awaited_once()
        self.assertEqual((self.queue.root / JOB / 'raw-1').read_bytes(), PNG)

    async def test_interrupted_retry_does_not_recover_older_candidate(self):
        self.create()
        self.queue.update(JOB, status='running')
        self.queue.persist(JOB, 'output', PNG)
        self.queue.persist(JOB, 'generation-state.json', b'{"attempt":2,"pending":true}')
        await self.queue.start()
        await self.queue.stop()
        self.assertEqual(self.queue.get(JOB)['status'], 'uncertain')
        self.review_mock.assert_not_awaited()

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

    async def test_400_identifies_parameter_without_leaking_or_retrying(self):
        self.create()
        calls = []
        def handler(request):
            calls.append(request)
            return httpx.Response(400, json={'error': {
                'param': 'size', 'message': 'secret-key private-image-data',
            }})
        client = httpx.AsyncClient
        with patch.object(prep.httpx, 'AsyncClient', side_effect=lambda **kw: client(transport=httpx.MockTransport(handler), **kw)):
            await self.queue.run(JOB)
            await self.queue.run(JOB)
        record = self.queue.get(JOB)
        self.assertEqual(record['status'], 'failed')
        self.assertIn('输出尺寸', record['message'])
        self.assertNotIn('secret-key', str(record))
        self.assertNotIn('private-image-data', str(record))
        self.assertEqual(len(calls), 1)

    def test_rejection_detail_handles_nested_policy_and_untrusted_fields(self):
        response = httpx.Response(400, json={'error': {'cause': {
            'code': 'content_policy_violation', 'message': 'private content',
        }}})
        self.assertEqual(prep.rejection_detail(response), '上游内容安全检查拒绝了本次请求')
        for payload in (None, [], {'error': {'param': ['size']}},
                        {'error': {'param': 'secret-key', 'code': []}}):
            self.assertEqual(prep.rejection_detail(httpx.Response(400, json=payload)), '')
        self.assertEqual(prep.rejection_detail(httpx.Response(400, text='private body')), '')

    def test_gateway_safety_rejection_with_object_param(self):
        for payload in (
            {'error': {'type': 'AI_APICallError', 'message':
                'Your request was rejected by the safety system. private-request-id safety_violations=[sexual].',
                'param': {'statusCode': 400}}},
            {'error': {'param': {'message':
                'Your request was rejected by the safety system. safety_violations=[sexual].'}}},
        ):
            detail = prep.rejection_detail(httpx.Response(400, json=payload))
            self.assertEqual(detail, '上游内容安全检查拒绝了本次请求（性内容标记）')
            self.assertNotIn('private-request-id', detail)


if __name__ == '__main__':
    unittest.main()
