"""No paid calls: friendly gate, stable IDs, restart, pause and uncertainty."""
from worker.test_batch_queue import BatchTests, module, IMAGE
from fastapi import HTTPException
from pathlib import Path
import unittest

class FriendlyTests(BatchTests):
    def setUp(self):
        super().setUp()
        owner = self
        self.prep_calls = []
        self.preps = {}
        class FakePrep:
            root = Path(owner.temp.name) / 'prep'
            def get(self, job_id):
                if job_id not in owner.preps:
                    raise HTTPException(404, 'missing')
                return owner.preps[job_id]
            def create(self, job_id, name, provider, data):
                owner.prep_calls.append((job_id, provider, data))
                owner.preps[job_id] = dict(status='queued', message='friendly queued', quality=None)
                directory = self.root / job_id
                directory.mkdir(parents=True)
                (directory / 'output').write_bytes(IMAGE + b'friendly')
        self.prep = FakePrep()
        self.queue.prep = self.prep

    def friendly_ready(self):
        self.data.settings.friendly = True
        self.ready()

    async def test_default_is_friendly_and_missing_bridge_cannot_bypass(self):
        self.assertTrue(module.SplitSettings().friendly)
        self.data.settings.friendly = True
        self.queue.prep = None
        with self.assertRaises(HTTPException) as caught:
            self.queue.create(self.data)
        self.assertEqual(caught.exception.status_code, 503)
        self.assertEqual(self.calls, [])

    async def test_gate_uses_generated_image_and_stable_id_across_restart(self):
        self.friendly_ready()
        await self.queue.advance()
        await self.queue.advance()
        self.assertEqual(len(self.prep_calls), 1)
        self.assertEqual(self.calls, [])
        restarted = module.BatchQueue(Path(self.temp.name), self.queue.authorize, self.queue.split_create, self.jobs.get, self.prep)
        await restarted.advance()
        self.assertEqual(len(self.prep_calls), 1)
        pid = self.queue.prep_id('1'*32)
        self.preps[pid].update(status='succeeded', quality={'status':'passed'})
        await restarted.advance()
        self.assertEqual(self.calls[0][1], IMAGE + b'friendly')
        self.assertEqual(restarted.read(self.data.id)['friendly_succeeded'], 1)

    async def test_pause_does_not_split_completed_friendly_until_resumed(self):
        self.friendly_ready()
        await self.queue.advance()
        self.queue.control(self.data.id, 'pause')
        pid = self.queue.prep_id('1'*32)
        self.preps[pid].update(status='succeeded', quality={'status':'passed'})
        await self.queue.advance()
        self.assertEqual(self.calls, [])
        self.queue.control(self.data.id, 'start')
        await self.queue.advance()
        self.assertEqual(len(self.calls), 1)

    async def test_unknown_never_retries_or_submits_raw(self):
        self.friendly_ready()
        await self.queue.advance()
        pid = self.queue.prep_id('1'*32)
        self.preps[pid].update(status='uncertain')
        for _ in range(3):
            await self.queue.advance()
        self.assertEqual(len(self.prep_calls), 1)
        self.assertEqual(self.calls, [])
        self.assertEqual(self.queue.read(self.data.id)['uncertain'], 1)

    async def test_outdated_quality_is_blocked_and_failure_recorded(self):
        self.friendly_ready()
        await self.queue.advance()
        pid = self.queue.prep_id('1'*32)
        self.preps[pid].update(status='succeeded', quality={'status':'outdated'})
        self.assertEqual(self.queue.read(self.data.id)['items'][0]['status'], 'failed')
        await self.queue.advance()
        self.assertEqual(self.calls, [])
        self.assertEqual(len(self.prep_calls), 2)  # Failed item skipped, next source only.

if __name__ == '__main__': unittest.main()
