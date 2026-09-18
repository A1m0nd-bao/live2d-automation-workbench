"""Pro endpoint identity, capability and failure gates (no external services)."""
import asyncio, importlib.util, json, os, tempfile, unittest
from pathlib import Path
from unittest.mock import patch
import httpx
from fastapi import FastAPI, HTTPException
sp=importlib.util.spec_from_file_location('pro_native',Path(__file__).parent/'app/native_export.py')
native=importlib.util.module_from_spec(sp);sp.loader.exec_module(native)
class ProNativeTests(unittest.IsolatedAsyncioTestCase):
 async def asyncSetUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name)
  def authorize(relay,device):
   if device!='test':raise HTTPException(401,'unauthorized')
  self.service=native.NativeExport(self.root,authorize)
  self.service.java=self.service.classes=self.service.libs=str(self.root)
  self.service.node='node';self.service.core=str(self.root/'core.js');Path(self.service.core).write_text('test')
  self.launched=[];self.service.launch=self.launched.append
  app=FastAPI();app.include_router(self.service.router)
  self.client=httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://test',headers={'X-Morph-Device-Token':'test'})
 async def asyncTearDown(self):await self.client.aclose();self.tmp.cleanup()
 async def submit(self,profile='pro-rig-v1'):return await self.client.post('/native-export/jobs?profile='+profile,content=b'CAFF-test')
 async def test_profile_has_separate_cache_and_idempotent_submission(self):
  a=(await self.submit()).json();b=(await self.submit()).json();s=(await self.submit('standard')).json()
  self.assertEqual(a['id'],b['id']);self.assertNotEqual(a['id'],s['id']);self.assertEqual(a['profile'],'pro-rig-v1')
  self.assertEqual((self.service.root/a['id']/'input.cmo3').read_bytes(),b'CAFF-test')
 async def test_old_or_unconfigured_bridge_cannot_claim_pro_completion(self):
  self.service.core='';self.assertEqual((await self.submit()).status_code,503)
  self.assertEqual((await self.submit('standard')).status_code,200)
  self.assertEqual((await self.submit('typo')).status_code,400)
 async def test_auth_and_output_gate(self):
  self.assertEqual((await self.client.post('/native-export/jobs',content=b'CAFF',headers={'X-Morph-Device-Token':'wrong'})).status_code,401)
  self.assertEqual((await self.client.post('/native-export/jobs',content=b'bad')).status_code,400)
  a=(await self.submit()).json()
  self.assertEqual((await self.client.get('/native-export/jobs/'+a['id']+'/output')).status_code,409)
 async def test_failed_binding_never_publishes_runtime(self):
  a=(await self.submit()).json()
  async def fail(*args):raise RuntimeError('missing independent mouth')
  self.service.command=fail
  await self.service.run(a['id']);self.assertEqual(self.service.read(a['id'])['status'],'failed')
  self.assertFalse((self.service.root/a['id']/'runtime.zip').exists())
 async def test_restart_resumes_same_profile_and_id(self):
  a=(await self.submit()).json();self.service.save(a['id'],'running','interrupted');self.launched.clear()
  await self.service.start();self.assertEqual(self.launched,[a['id']]);self.assertEqual(self.service.read(a['id'])['profile'],'pro-rig-v1')
if __name__=='__main__':unittest.main()
