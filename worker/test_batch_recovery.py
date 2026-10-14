import asyncio
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import AsyncMock, patch

import httpx
from worker.psd_test_fixture import layered_psd

_import_root = tempfile.TemporaryDirectory()
with patch.dict(os.environ, {'MORPH_DATA_ROOT': _import_root.name}):
    spec = importlib.util.spec_from_file_location('batch_recovery_relay', Path(__file__).parent / 'app/main.py')
    relay = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = relay
    spec.loader.exec_module(relay)


class BatchRecoveryTests(unittest.TestCase):
    def exercise(self, checkpoint, fail_submit=False):
        requests = []
        def handler(request):
            requests.append(request)
            if request.url.path.endswith('/upload'):
                return httpx.Response(200, json=['/tmp/image.png'])
            if request.url.path.endswith('/call/inference'):
                if fail_submit:
                    raise httpx.ReadTimeout('unknown result', request=request)
                return httpx.Response(200, json={'event_id': 'original-event'})
            if request.url.path.endswith('/original-event'):
                if checkpoint == 'disconnect':
                    raise httpx.ReadTimeout('lost SSE', request=request)
                return httpx.Response(200, text='event: complete\ndata: [{"path":"/tmp/output.psd"}]\n\n')
            if '/file=' in request.url.path:
                return httpx.Response(200, content=layered_psd())
            raise AssertionError(str(request.url))
        client_type = httpx.AsyncClient
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with patch.object(relay, 'DATA_ROOT', root), patch.object(relay, 'DB_PATH', root / 'jobs.db'):
                relay.init_db()
                folder = root / ('a'*32)
                folder.mkdir()
                (folder / 'source').write_bytes(b'\x89PNG\r\n\x1a\n' + bytes(32))
                (folder / 'batch-options.json').write_text(json.dumps(dict(resolution=1280, seed=77, split_limbs=False)))
                if checkpoint is not None:
                    (folder / 'batch-inference.json').write_text(json.dumps({'event_id': None if checkpoint == 'unknown' else 'original-event'}))
                with relay.db() as con:
                    con.execute("INSERT INTO jobs (id,name,status,message) VALUES (?,'batch','queued','new')", ('a'*32,))
                with patch.object(relay.httpx, 'AsyncClient', side_effect=lambda **kw: client_type(transport=httpx.MockTransport(handler), **kw)), patch.object(relay.asyncio, 'sleep', new=AsyncMock()):
                    asyncio.run(relay.monitor('a'*32))
                return relay.get_job('a'*32), requests

    def test_recovery_reattaches_without_upload_or_inference(self):
        job, requests = self.exercise('known')
        self.assertEqual(job.status, 'succeeded')
        self.assertTrue(all(request.method == 'GET' for request in requests))

    def test_submission_timeout_never_replays_paid_call(self):
        job, requests = self.exercise(None, fail_submit=True)
        self.assertEqual(job.status, 'running')
        self.assertEqual(sum(request.url.path.endswith('/call/inference') for request in requests), 1)

    def test_stream_disconnect_keeps_original_event(self):
        job, requests = self.exercise('disconnect')
        self.assertEqual(job.status, 'running')
        self.assertEqual(len(requests), 3)
        self.assertTrue(all(request.method == 'GET' for request in requests))

    def test_settings_reach_inference(self):
        job, requests = self.exercise(None)
        call = next(request for request in requests if request.url.path.endswith('/call/inference'))
        self.assertEqual(json.loads(call.content)['data'][1:], [1280, 77, False])
        self.assertEqual(job.status, 'succeeded')


if __name__ == '__main__':
    unittest.main()
