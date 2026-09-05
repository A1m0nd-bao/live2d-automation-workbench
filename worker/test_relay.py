import asyncio
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch, AsyncMock

import httpx

spec = importlib.util.spec_from_file_location('relay_test_module', Path(__file__).parent / 'app/main.py')
relay = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = relay
spec.loader.exec_module(relay)


class RelayTests(unittest.TestCase):
    def exercise(self, event, download=b'8BPS\x00\x01' + bytes(30)):
        requests = []
        def handler(request):
            requests.append(request)
            path = request.url.path
            if path.endswith('/upload'):
                return httpx.Response(200, json=['/tmp/gradio/input.png'])
            if path.endswith('/call/inference'):
                return httpx.Response(200, json={'event_id': 'test-event'})
            if path.endswith('/test-event'):
                return httpx.Response(200, text=event, headers={'content-type': 'text/event-stream'})
            if '/file=' in path:
                return httpx.Response(200, content=download)
            raise AssertionError(str(request.url))
        client_type = httpx.AsyncClient
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with patch.object(relay, 'DATA_ROOT', root), patch.object(relay, 'DB_PATH', root / 'jobs.db'), patch.object(relay, 'MODELSCOPE_TOKEN', 'test-secret'):
                relay.init_db()
                (root / 'test').mkdir()
                (root / 'test/source').write_bytes(b'input')
                with relay.db() as db:
                    db.execute("INSERT INTO jobs (id,name,status,message) VALUES ('test','test','queued','new')")
                with patch.object(relay.httpx, 'AsyncClient', side_effect=lambda **kw: client_type(transport=httpx.MockTransport(handler), **kw)), patch.object(relay.asyncio, 'sleep', new=AsyncMock()):
                    asyncio.run(relay.monitor('test'))
                job = relay.get_job('test')
                events = (root / 'test/events.jsonl').read_text()
                return job, events, requests

    def test_null_error_is_terminal_not_heartbeat(self):
        job, events, _ = self.exercise('event: heartbeat\ndata: null\n\nevent: error\ndata: null\n\n')
        self.assertEqual(job.status, 'failed')
        self.assertIn('listen: See-Through emitted error: null', job.error)
        self.assertIn('"event": "error"', events)

    def test_file_download_uses_api_origin(self):
        data = [{'path': '/tmp/gradio/test/output.psd', 'url': 'https://ljsabc-see-through.ms.show/gradio_api/file=/tmp/gradio/test/output.psd'}, []]
        job, _, requests = self.exercise('event: complete\ndata: ' + json.dumps(data) + '\n\n')
        self.assertEqual(job.status, 'succeeded')
        self.assertEqual(job.attempts, 1)
        self.assertTrue(all(r.url.host == 'studio-ljsabc-see-through.api-inference.modelscope.net' for r in requests))

    def test_html_download_is_not_success(self):
        job, _, _ = self.exercise('event: complete\ndata: [{"path":"/tmp/test.psd"}]\n\n', b'<html>login required</html>')
        self.assertEqual(job.status, 'failed')
        self.assertIn('download:', job.error)

    def test_null_complete_is_failure(self):
        job, _, _ = self.exercise('event: complete\ndata: null\n\n')
        self.assertEqual(job.status, 'failed')
        self.assertIn('without a PSD output: null', job.error)

    def test_rejects_external_download(self):
        with self.assertRaises(RuntimeError):
            relay.upstream_file_url('https://untrusted.example/test.psd')
        self.assertEqual(relay.upstream_file_url('https://ljsabc-see-through.ms.show/gradio_api/file=/tmp/a%20b.psd'), relay.UPSTREAM + '/gradio_api/file=/tmp/a%20b.psd')


if __name__ == '__main__':
    unittest.main()
