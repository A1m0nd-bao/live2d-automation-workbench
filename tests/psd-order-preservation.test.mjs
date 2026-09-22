import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';
import ts from 'typescript';
import vm from 'node:vm';
import path from 'node:path';
const require=createRequire(import.meta.url);
function load(file){
 const exports={};
 const code=ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 vm.runInNewContext(code,{exports,Blob,structuredClone,Uint8ClampedArray,require:n=>n.startsWith('.')?load(path.resolve(path.dirname(file),/\.(ts|js)$/.test(n)?n:n+'.ts')):require(n)});
 return exports;
}
const psd=require('ag-psd');
psd.initializeCanvas(()=>{throw Error('unexpected canvas')},(w,h)=>({width:w,height:h,data:new Uint8ClampedArray(w*h*4)}));
const {importPsd}=load(path.resolve('src/vendor/stretchystudio/io/psd.js'));
const {mergeLive2dProPsd}=load(path.resolve('src/live2dProMerge.ts'));
const layer=name=>({name,left:0,top:0,right:1,bottom:1,imageData:{width:1,height:1,data:new Uint8ClampedArray([100,30,20,255])}});
const leaves=items=>items.flatMap(l=>l.children?leaves(l.children):l.imageData&&l.right>l.left&&l.bottom>l.top?[l.name]:[]);
async function check(bytes){
 const original=psd.readPsd(bytes,{useImageData:true});
 const names=leaves(original.children);
 const imported=importPsd(bytes);
 assert.equal([...imported.layers].reverse().map(l=>l.name).join('\n'),names.join('\n'));
 assert.equal(imported.quality.changed.length,0);
 const merged=mergeLive2dProPsd(bytes,[]);
 const again=psd.readPsd(await merged.psd.arrayBuffer(),{useImageData:true});
 assert.equal(leaves(again.children).join('\n'),names.join('\n'));
 assert.equal(merged.report.cleanup.changed.length,0);
}
test('ordinary import and default Pro merge preserve artist order instead of template rank',async()=>{
 await check(psd.writePsd({width:1,height:1,children:[layer('neck'),layer('face'),layer('back hair')]},{noBackground:true}));
});
test('user long-hair PSD preserves order through actual importer and Pro roundtrip',{skip:!process.env.PSD_ORDER_FIXTURE},async()=>check(fs.readFileSync(process.env.PSD_ORDER_FIXTURE)));
