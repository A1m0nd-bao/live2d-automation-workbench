import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import {readPsd} from 'ag-psd';
import {prepare,assemble,extractLines,sampleSkin,templateSvgs} from '../scripts/mouth-materials.mjs';

const fixture=bg=>sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024">${bg?'<rect width="1024" height="1024" fill="white"/>':''}<path d="M205 250 Q512 278 819 250 M205 762 Q512 790 819 762" fill="none" stroke="#493c42" stroke-width="12"/></svg>`)).png().toBuffer();
test('single sheet to six layer PSD, no rig approval, originals preserved',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'mouth-material-test-'));
 const source=path.join(dir,'face.png');await sharp({create:{width:128,height:128,channels:4,background:'#eac4b2'}}).png().toFile(source);
 const config={source,face:{left:0,top:0,width:128,height:128},skin:{left:16,top:16,width:32,height:32}};
 const job=path.join(dir,'job');await prepare(config,job);
 const sheet=path.join(dir,'sheet.png'),raw=await fixture(false);await fs.writeFile(sheet,raw);
 const out=path.join(dir,'out'),report=await assemble(job,sheet,out);
 assert.equal(report.status,'needs_review');assert.equal(report.rigReady,false);assert.equal(report.layers.length,6);
 assert.equal(report.skin.hex,'#eac4b2');assert.deepEqual(await fs.readFile(sheet),raw);
 const psd=readPsd(await fs.readFile(path.join(out,'mouth-materials.psd')),{skipLayerImageData:true,skipCompositeImageData:true,skipThumbnail:true});
 assert.equal(psd.children.length,6);assert.equal(psd.children[1].clipping,true);
 await assert.rejects(assemble(job,sheet,out));
});
test('white matte requires explicit opt-in',async()=>{
 const data=await fixture(true);await assert.rejects(extractLines(data),/alpha/);
 assert.equal((await extractLines(data,{whiteBackground:true})).length,2);
});
test('reject empty, dense, nonsquare and invalid skin region',async()=>{
 const blank=await sharp({create:{width:1024,height:1024,channels:4,background:{r:0,g:0,b:0,alpha:0}}}).png().toBuffer();
 await assert.rejects(extractLines(blank),/thin mouth/);
 const small=await sharp({create:{width:128,height:64,channels:4,background:'white'}}).png().toBuffer();
 await assert.rejects(extractLines(small),/square/);await assert.rejects(sampleSkin(small,{left:120,top:0,width:50,height:50}),/ROI/);
 assert.throws(()=>templateSvgs('bad'),/color/);
});
