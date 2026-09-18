const test=require('node:test'),assert=require('node:assert/strict');
const ts=require('typescript'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
function load(file){
 const exports={};const code=ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 vm.runInNewContext(code,{exports,Blob,structuredClone,Uint8ClampedArray,require:n=>n.startsWith('.')?load(path.resolve(path.dirname(file),n+'.ts')):require(n)});return exports;
}
const {cleanupProOrder,identicalProSlot,proBaseLeaves}=load(path.resolve('src/proPsdCleanup.ts'));
const layer=(name,value=255)=>({name,left:0,top:0,right:1,bottom:1,imageData:{width:1,height:1,data:new Uint8ClampedArray([value,0,0,255])}});
const {applyPsdQuality}=load(path.resolve('src/psdQuality.ts'));
test('both modes retain repairable inputs and never regenerate',()=>{
 for(const mode of ['ordinary','pro']){
  const children=[layer('mouth'),layer('face')];const r=applyPsdQuality({width:10,height:10,children},mode);
  assert.equal(r.status,'needs_repair');assert.equal(r.automaticRegeneration,false);
  assert.equal(children.length,2);assert.equal(children[0].name,'face');
 }
 assert.equal(applyPsdQuality({width:10,height:10,children:[]}).status,'unusable');
});
test('standard PSD unchanged; deliberately swapped mouth/face repaired without pixel loss', {skip:!fs.existsSync('/Users/baotianrong/Downloads/seethrough_output (3).psd')},()=>{
 const {readPsd,initializeCanvas}=require('ag-psd');initializeCanvas(()=>{throw Error('canvas')},(w,h)=>({width:w,height:h,data:new Uint8ClampedArray(w*h*4)}));
 const doc=readPsd(fs.readFileSync('/Users/baotianrong/Downloads/seethrough_output (3).psd'),{useImageData:true,skipCompositeImageData:true});
 assert.equal(applyPsdQuality(doc).changed.length,0);
 const before=doc.children.map(l=>[l.name,Buffer.from(l.imageData.data).toString('base64')]);
 const a=doc.children.findIndex(l=>l.name==='face'),b=doc.children.findIndex(l=>l.name==='mouth');
 [doc.children[a],doc.children[b]]=[doc.children[b],doc.children[a]];
 assert(applyPsdQuality(doc).changed.length>0);
 assert(doc.children.findIndex(l=>l.name==='face')<doc.children.findIndex(l=>l.name==='mouth'));
 for(const [name,pixels]of before)assert.equal(Buffer.from(doc.children.find(l=>l.name===name).imageData.data).toString('base64'),pixels);
 assert.equal(doc.children.length,22);
});
test('neck above back hair; idempotent; unrelated sibling relative order preserved',()=>{
 const a=[layer('neck'),layer('face'),layer('back hair')];
 assert.equal(cleanupProOrder(a).changed.length,2);
 assert.equal(a.map(l=>l.name).join(','),'back hair,neck,face');
 assert.equal(cleanupProOrder(a).changed.length,0);
});
test('mask, clipping, ambiguous names and groups never reordered',()=>{
 for(const extra of [{mask:{}},{clipping:true},{blendMode:'multiply'},{hidden:true}]){
  const a=[layer('neck'),{...layer('back hair'),...extra}];assert.equal(cleanupProOrder(a).changed.length,0);
 }
 const a=[layer('neck'),layer('neck'),layer('back hair')];assert(cleanupProOrder(a).warnings.some(s=>s.includes('重复语义层')));
});
test('only exact plain slots reused; shifted or changed layers retained',()=>{
 assert(identicalProSlot([layer('mouth')],[layer('mouth')]));
 for(const b of [layer('mouth',254),{...layer('mouth'),left:1},{...layer('mouth'),clipping:true},{...layer('mouth'),mask:{}}])assert(!identicalProSlot([layer('mouth')],[b]));
 assert(!identicalProSlot([] ,[]));
 assert.equal(proBaseLeaves([{name:'expression_smile',children:[layer('mouth')]},layer('neck')]).length,1);
});
test('Pro PSD round trip preserves input, reuses exact slots, keeps changed slot',async()=>{
 const psd=require('ag-psd');psd.initializeCanvas(()=>{throw Error('Unexpected canvas dependency')},(w,h)=>({width:w,height:h,data:new Uint8ClampedArray(w*h*4)}));
 const {mergeLive2dProPsd}=load(path.resolve('src/live2dProMerge.ts'));
 const base=psd.writePsd({width:1,height:1,children:[layer('neck'),layer('back hair'),layer('handwear-l'),layer('handwear-r')]},{noBackground:true});
 const before=Buffer.from(base).toString('hex');
 const source=psd.writePsd({width:1,height:1,children:[layer('handwear-l'),layer('handwear-r',120)]},{noBackground:true});
 const result=mergeLive2dProPsd(base,[{state:{id:'action_test',label:'test',kind:'action',slotTargets:['handwear-l','handwear-r']},data:source,filename:'state.psd'}]);
 assert.equal(result.report.states[0].reusedBaseSlots.join(','),'handwear-l');
 const parsed=psd.readPsd(await result.psd.arrayBuffer(),{useImageData:true,skipCompositeImageData:true});
 assert.equal(parsed.children.at(-1).children.length,1);
 assert.equal(parsed.children.at(-1).children[0].name,'action_test__handwear-r');
 assert.equal(Buffer.from(base).toString('hex'),before);
 const safe=mergeLive2dProPsd(base,[],{preserveOrder:true});
 const safeDoc=psd.readPsd(await safe.psd.arrayBuffer(),{useImageData:true,skipCompositeImageData:true});
 assert.equal(safeDoc.children.map(l=>l.name).join(','),'neck,back hair,handwear-l,handwear-r');
 assert.equal(safe.report.cleanup.changed.length,0);
 assert.equal(safe.report.cleanup.status,'needs_review');
});
test('Pro face anchor ignores transparent padding but rejects actual displacement',()=>{
 const psd=require('ag-psd');psd.initializeCanvas(()=>{throw Error('canvas')},(w,h)=>({width:w,height:h,data:new Uint8ClampedArray(w*h*4)}));
 const {mergeLive2dProPsd}=load(path.resolve('src/live2dProMerge.ts'));
 const pixels=new Uint8ClampedArray(64*64*4);
 for(let y=20;y<30;y++)for(let x=20;x<30;x++)pixels[(y*64+x)*4+3]=255;
 const base=psd.writePsd({width:64,height:64,children:[{name:'face',left:0,top:0,right:64,bottom:64,imageData:{width:64,height:64,data:pixels}},layer('handwear-l')]},{noBackground:true,trimImageData:false});
 const make=(left)=>psd.writePsd({width:64,height:64,children:[{name:'face',left,top:20,right:left+10,bottom:30,imageData:{width:10,height:10,data:new Uint8ClampedArray(400).fill(255)}},layer('handwear-l')]},{noBackground:true,trimImageData:false});
 const input=(data)=>[{state:{id:'action_test',label:'test',kind:'action',slotTargets:['handwear-l']},data,filename:'state.psd'}];
 assert.doesNotThrow(()=>mergeLive2dProPsd(base,input(make(20))));
 assert.throws(()=>mergeLive2dProPsd(base,input(make(40))),/脸部锚点偏移 20px/);
});
