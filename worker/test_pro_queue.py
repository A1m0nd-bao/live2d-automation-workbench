import tempfile
import unittest
from pathlib import Path
from fastapi import HTTPException
import importlib.util
spec = importlib.util.spec_from_file_location('pro_queue_test', Path(__file__).parent / 'app/pro_queue.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
ProQueue, STATES, state_prompt = module.ProQueue, module.STATES, module.state_prompt

class FakePrep:
    def __init__(self, root):
        self.root, self.jobs, self.calls = root, {}, []
    def mime(self, data):
        if not data.startswith(b'\x89PNG'):
            raise ValueError()
    def create(self, jid, name, provider, data, *, prompt=None):
        if jid not in self.jobs:
            self.calls.append((jid, data, prompt))
            (self.root / jid).mkdir()
            (self.root / jid / 'output').write_bytes(data)
            self.jobs[jid] = {'status': 'queued', 'message': 'waiting'}
        return self.jobs[jid]
    def get(self, jid):
        if jid not in self.jobs:
            raise HTTPException(404)
        return self.jobs[jid]

class ProTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.prep = FakePrep(self.root)
        self.splits = {'base': {'status': 'succeeded'}}
        self.queue = ProQueue(self.root, self.prep, lambda *a: None, self.split, lambda j: self.splits[j], lambda j: self.root / j)
        self.queue.init()
        self.ids = list(STATES)[:2]
    def tearDown(self):
        self.tmp.cleanup()
    def split(self, jid, source, name):
        self.splits.setdefault(jid, {'status': 'running', 'message': 'split'})
    def create(self):
        return self.queue.create('a'*32, 'base', self.ids, 'doubao', b'\x89PNGbase')
    async def test_resume_and_no_duplicate_generation(self):
        run = self.create()
        self.assertEqual(run, self.create())
        await self.queue.advance(run)
        await self.queue.advance(self.queue.get(run['id']))
        self.assertEqual(len(self.prep.calls), 1)
        for state in run['states']:
            self.prep.jobs[state['prep_id']] = {'status': 'succeeded', 'message': 'ok'}
            self.splits[state['split_id']] = {'status': 'succeeded', 'message': 'ok'}
        await self.queue.advance(self.queue.get(run['id']))
        await self.queue.advance(self.queue.get(run['id']))
        self.assertEqual(self.queue.get(run['id'])['status'], 'ready')
        self.assertTrue(all(c[1] == b'\x89PNGbase' for c in self.prep.calls))
    async def test_uncertain_never_replayed(self):
        run = self.create()
        await self.queue.advance(run)
        first = run['states'][0]
        self.prep.jobs[first['prep_id']] = {'status': 'uncertain', 'message': 'unknown'}
        await self.queue.advance(run)
        second = run['states'][1]
        self.prep.jobs[second['prep_id']] = {'status': 'succeeded', 'message': 'ok'}
        self.splits[second['split_id']] = {'status': 'succeeded', 'message': 'ok'}
        await self.queue.advance(run)
        self.assertEqual(run['status'], 'needs_attention')
        old = first['prep_id']
        retry = self.queue.retry(run['id'], first['id'])
        self.assertNotEqual(retry['states'][0]['prep_id'], old)
        self.assertEqual(retry['states'][1]['prep_id'], second['prep_id'])
    async def test_split_retry_reuses_image(self):
        run = self.create()
        for state in run['states']:
            self.prep.jobs[state['prep_id']] = {'status': 'succeeded', 'message': 'ok'}
            self.splits[state['split_id']] = {'status': 'failed', 'message': 'fail'}
        await self.queue.advance(run)
        await self.queue.advance(run)
        retry = self.queue.retry(run['id'], self.ids[0])
        self.assertEqual(retry['states'][0]['prep_id'], run['states'][0]['prep_id'])
        self.assertNotEqual(retry['states'][0]['split_id'], run['states'][0]['split_id'])
    def test_conflict_and_validation(self):
        self.create()
        with self.assertRaises(HTTPException) as e:
            self.queue.create('a'*32, 'base', self.ids[:1], 'doubao', b'\x89PNGbase')
        self.assertEqual(e.exception.status_code, 409)
        with self.assertRaises(HTTPException):
            self.queue.create('b'*32, 'base', ['bad'], 'doubao', b'\x89PNGbase')
        self.assertIn('挥手', state_prompt(self.ids[0]))
        self.assertNotIn('A 字站姿', state_prompt(self.ids[0]))

    def test_expressions_rejected(self):
        with self.assertRaises(HTTPException) as e:
            self.queue.create('b'*32, 'base', ['expression_02_soft_smile_face_controls'], 'doubao', b'\x89PNGbase')
        self.assertEqual(e.exception.status_code, 400)

    async def test_shared_slot_blocks_generation(self):
        import asyncio
        prep_spec = importlib.util.spec_from_file_location('prep_serial_test', Path(__file__).parent / 'app/prep_queue.py')
        prep_module = importlib.util.module_from_spec(prep_spec)
        prep_spec.loader.exec_module(prep_module)
        slots = asyncio.Semaphore(1)
        queue = prep_module.PrepQueue(self.root, lambda *a: None, slots)
        queue.init()
        with queue.db() as c:
            c.execute("INSERT INTO prep_jobs (id,name,provider,model,fingerprint,status,message,created_at,updated_at) VALUES ('job','test','doubao','test','test','queued','test',0,0)")
        called = asyncio.Event()
        async def run(jid):
            called.set()
            await asyncio.sleep(10)
        queue.run = run
        await slots.acquire()  # Simulate a split holding the shared slot.
        task = asyncio.create_task(queue.loop())
        try:
            await asyncio.sleep(.03)
            self.assertFalse(called.is_set())
            slots.release()
            await asyncio.wait_for(called.wait(), 1)
        finally:
            task.cancel()
            try: await task
            except asyncio.CancelledError: pass

if __name__ == '__main__':
    unittest.main()
