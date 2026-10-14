import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
function setup(supported=true){
 const values=new Map([['morph.direct-relay.v1',JSON.stringify({relayUrl:'http://127.0.0.1:7861',deviceToken:'test-device-key-only'})]]),calls=[],module={exports:{}};
 const code=ts.transpileModule(fs.readFileSync(new URL('../src/serviceBridge.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 vm.runInNewContext(code,{module,exports:module.exports,URL,URLSearchParams,Map,Error,FormData,AbortSignal,localStorage:{getItem:k=>values.get(k),setItem:(k,v)=>values.set(k,v)},fetch:async(url,options)=>{
  calls.push({url,options});return Response.json(url.endsWith('/health')?{ok:true,split_routes:supported?['default','yangzxo']:undefined}:{id:'a'.repeat(32),status:'queued'});
 }});return {api:module.exports,calls};
}
test('default stays unchanged; backup must be selected and supported before uploading',async()=>{
 const {api,calls}=setup();assert.equal(api.getSplitRoute(),'default');
 await api.serviceRequest('submit',{image:new Blob(['input']),name:'test.png'});
 assert.equal(calls.length,1);assert.doesNotMatch(calls[0].url,/route=/);
 api.saveSplitRoute('yangzxo');await api.serviceRequest('submit',{image:new Blob(['input']),name:'backup.png'});
 assert.ok(calls[1].url.endsWith('/health'));assert.match(calls[2].url,/route=yangzxo/);
 assert.throws(()=>api.saveSplitRoute('evil'));
});
test('legacy relay refuses backup before image submission; no silent default fallback',async()=>{
 const {api,calls}=setup(false);api.saveSplitRoute('yangzxo');
 await assert.rejects(api.serviceRequest('submit',{image:new Blob(['input'])}),/未上传图片/);
 assert.equal(calls.length,1);assert.ok(calls[0].url.endsWith('/health'));
});
