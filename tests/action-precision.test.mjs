import test from 'node:test';
import assert from 'node:assert/strict';
import {XmlBuilder} from '../src/vendor/stretchystudio/io/live2d/xmlbuilder.js';
import {generateCmo3} from '../src/vendor/stretchystudio/io/live2d/cmo3writer.js';
test('fractional action keyforms retain fractional parameter precision',async t=>{
 let xml;const original=XmlBuilder.prototype.serialize;
 t.mock.method(XmlBuilder.prototype,'serialize',function(...args){return xml=original.apply(this,args);});
 await generateCmo3({canvasW:100,canvasH:100,generateRig:false,generatePhysics:false,
 actionSwitches:[{id:'ParamActionWave',name:'Action: Wave'}],
 meshes:[{name:'wave',partId:'wave',vertices:[10,10,20,10,20,20],triangles:[0,1,2],uvs:[0,0,1,0,1,1],pngData:new Uint8Array([137,80,78,71,13,10,26,10]),texWidth:100,texHeight:100,actionSwitch:{id:'ParamActionWave',state:'alternate'}}]});
 const parameters=[...xml.matchAll(/<CParameterSource>(.*?)<\/CParameterSource>/gs)].map(m=>m[1]);
 assert.equal(parameters.length,1);
 assert.match(parameters[0],/<i xs.n="decimalPlaces">2<\/i>/);
 assert.ok(xml.includes('0.3500')&&xml.includes('0.6500'));
});
