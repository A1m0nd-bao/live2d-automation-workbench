// Local batch entry; never overwrite source or an existing output directory.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),ts=require('typescript');
const {readPsd,writePsd,initializeCanvas}=require('ag-psd');
const [source,out,mode='ordinary']=process.argv.slice(2);
if(!source||!out||!['ordinary','pro'].includes(mode))throw Error('Usage: node scripts/quality-repair-psd.cjs SOURCE.psd NEW_OUTPUT_DIR [ordinary|pro]');
const exportsObject={};vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname,'../src/psdQuality.ts'),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports:exportsObject});
initializeCanvas(()=>{throw Error('Unexpected canvas access')},(w,h)=>({width:w,height:h,data:new Uint8ClampedArray(w*h*4)}));
const bytes=fs.readFileSync(source);
const doc=readPsd(bytes,{useImageData:true,skipCompositeImageData:true,skipThumbnail:true});
const report=exportsObject.applyPsdQuality(doc,mode);
const result=writePsd(doc,{noBackground:true,trimImageData:false});
// Validate serialization before creating a deliverable directory.
const check=readPsd(result,{useImageData:true,skipCompositeImageData:true});
if(check.width!==doc.width||check.height!==doc.height)throw Error('PSD round-trip failed');
fs.mkdirSync(out,{recursive:false});
fs.writeFileSync(path.join(out,'normalized.psd'),Buffer.from(result),{flag:'wx'});
fs.writeFileSync(path.join(out,'quality.json'),JSON.stringify({...report,source:path.resolve(source),sourceSha256:require('node:crypto').createHash('sha256').update(bytes).digest('hex'),output:'normalized.psd'},null,2),{flag:'wx'});
console.log(JSON.stringify(report,null,2));
